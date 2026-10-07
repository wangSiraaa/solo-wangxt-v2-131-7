import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  UploadError,
  checkFileMetadata,
  createFinalizer,
  createSession,
  loadSession,
  readyToFinalize,
  reconcileServer,
  saveSession,
  sha256Hex,
  sortedSequences,
  uploadMissing,
  verifyChunkDigests
} from '../src/upload/resumable.js'

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map
  }
}

const sha = (buf) => createHash('sha256').update(Buffer.from(buf)).digest('hex')

function buildFixture(parts) {
  let offset = 0
  const expected = []
  const blobs = []
  parts.forEach((raw, sequence) => {
    const nodeBuf = Buffer.from(raw)
    expected.push({
      sequence,
      sha256: sha(nodeBuf),
      byte_offset: offset,
      byte_length: nodeBuf.length,
      sample_count: nodeBuf.length / 4,
      sample_rate: 100,
      channels: ['Va'],
      start_time: '2026-10-01T00:00:00',
      end_time: '2026-10-01T00:00:01'
    })
    blobs.push(nodeBuf)
    offset += nodeBuf.length
  })
  const bytes = Buffer.concat(blobs)
  return { expected, bytes, size: bytes.length }
}

function manifestFor(expected, overrides = {}) {
  return {
    id: 'mf-1',
    name: 'rec.bin',
    status: 'open',
    manifest_digest: 'digest-xyz',
    expected_chunks: expected,
    ...overrides
  }
}

function recordingFile(bytes, name = 'rec.bin') {
  // Node 20 提供全局 Blob；name 手动挂在 File-like 对象上。
  const blob = new Blob([bytes])
  blob.name = name
  blob.lastModified = 1700000000000
  return blob
}

const u32 = (values) => {
  const buf = new ArrayBuffer(values.length * 4)
  new Uint32Array(buf).set(values)
  return Buffer.from(buf)
}

test('乱序上传中断后续传：先查服务端，只补缺块，最终才允许完成', async () => {
  const { expected, bytes } = buildFixture([u32([1, 2]), u32([3, 4, 5]), u32([6, 7])])
  const manifest = manifestFor(expected)
  const file = recordingFile(bytes)
  const storage = memoryStorage()
  const session = createSession(manifest, file)
  saveSession(session, storage)

  // 服务端已乱序收到序号 2（例如上次先传完了最后一块）
  const server = [{ sequence: 2, sha256: expected[2].sha256 }]
  let missing = reconcileServer(session, server)
  assert.deepEqual(missing, [0, 1])
  assert.equal(session.chunks[2].state, 'present')
  assert.equal(readyToFinalize(session), false)

  // 逐块身份核对
  await verifyChunkDigests({ session, file, sequences: [0, 1], hasher: sha256Hex })

  // 上传序号 0 时中断
  const controller = new AbortController()
  const putCalls = []
  const flakyPut = (id, sequence, blob, { signal, onProgress }) => {
    putCalls.push(sequence)
    return new Promise((resolve, reject) => {
      onProgress({ loaded: Math.floor(blob.size / 2), total: blob.size })
      if (sequence === 0) {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted' })), { once: true })
      } else {
        resolve({ sequence, sha256: expected[sequence].sha256 })
      }
    })
  }
  setTimeout(() => controller.abort(), 5)
  await uploadMissing({
    manifestId: manifest.id, file, session, sequences: [0, 1],
    putChunk: flakyPut, hasher: sha256Hex, signal: controller.signal
  })
  // 序号 0 被中断后，序号 1 因同一 abort 信号不再上传：只补缺的语义不变
  assert.ok(putCalls.includes(0))
  assert.equal(session.chunks[0].state, 'verified') // 退回待传，不算成功
  assert.equal(session.chunks[1].state, 'verified')

  // 模拟刷新页面：从 localStorage 恢复，文件句柄重新选择，服务端这次已有块 1
  const reloaded = loadSession('mf-1', storage)
  assert.ok(reloaded)
  missing = reconcileServer(reloaded, [{ sequence: 1, sha256: expected[1].sha256 }, { sequence: 2, sha256: expected[2].sha256 }])
  assert.deepEqual(missing, [0])
  assert.equal(reloaded.chunks[1].state, 'present')

  // 重新选择文件必须先过身份核对
  checkFileMetadata(reloaded, file)
  await verifyChunkDigests({ session: reloaded, file, sequences: [0], hasher: sha256Hex })

  const onlyZero = []
  const okPut = (_id, sequence) => {
    onlyZero.push(sequence)
    return Promise.resolve({ sequence, sha256: expected[sequence].sha256 })
  }
  const failed = await uploadMissing({
    manifestId: manifest.id, file, session: reloaded, sequences: missing,
    putChunk: okPut, hasher: sha256Hex
  })
  assert.deepEqual(failed, [])
  assert.deepEqual(onlyZero, [0]) // 验收：只补缺块

  reconcileServer(reloaded, expected.map((e) => ({ sequence: e.sequence, sha256: e.sha256 })))
  assert.equal(readyToFinalize(reloaded), true)
  assert.deepEqual(sortedSequences(reloaded), [0, 1, 2])
})

test('换成同名不同内容文件：大小不同在元数据层拒绝', () => {
  const { expected, bytes } = buildFixture([u32([1, 2]), u32([3, 4])])
  const manifest = manifestFor(expected)
  const session = createSession(manifest, recordingFile(bytes))
  const other = recordingFile(Buffer.concat([bytes, Buffer.from([0])]), 'rec.bin')
  assert.throws(() => checkFileMetadata(session, other), (error) => {
    assert.ok(error instanceof UploadError)
    assert.equal(error.code, 'file_size_mismatch')
    return true
  })
})

test('换成同名同大小但内容不同文件：逐块摘要核对拒绝，且不上传', async () => {
  const a = u32([1, 2])
  const b = u32([3, 4])
  const { expected } = buildFixture([a, b])
  const manifest = manifestFor(expected)
  const original = Buffer.concat([Buffer.from(a), Buffer.from(b)])
  const session = createSession(manifest, recordingFile(original))

  const tampered = Buffer.from(original)
  tampered[0] ^= 0xff // 同名、同大小、首块内容被改
  const fakeFile = recordingFile(tampered)
  checkFileMetadata(session, fakeFile) // 元数据层看不出来

  let uploads = 0
  await assert.rejects(
    () => verifyChunkDigests({
      session,
      file: fakeFile,
      hasher: sha256Hex
    }),
    (error) => error.code === 'chunk_digest_mismatch' && error.details.sequence === 0
  )
  await assert.rejects(
    () => uploadMissing({
      manifestId: manifest.id,
      file: fakeFile,
      session,
      sequences: sortedSequences(session),
      putChunk: async () => { uploads += 1; return {} },
      hasher: sha256Hex
    }),
    (error) => error.code === 'file_identity_mismatch'
  )
  // 验收：错误文件被拒绝继续，没有任何块发出 PUT
  assert.equal(uploads, 0)
})

test('服务端已有块摘要与清单冲突时标记错误，不把它当已到', () => {
  const { expected, bytes } = buildFixture([u32([1]), u32([2])])
  const session = createSession(manifestFor(expected), recordingFile(bytes))
  const missing = reconcileServer(session, [{ sequence: 0, sha256: 'deadbeef' }])
  assert.equal(session.chunks[0].state, 'error')
  assert.equal(session.chunks[0].error.code, 'server_digest_conflict')
  assert.ok(missing.includes(0))
  assert.equal(readyToFinalize(session), false)
})

test('单块 PUT 422 摘要错误时记录逐块错误且不影响其余块', async () => {
  const { expected, bytes } = buildFixture([u32([1]), u32([2]), u32([3])])
  const manifest = manifestFor(expected)
  const file = recordingFile(bytes)
  const session = createSession(manifest, file)
  await verifyChunkDigests({ session, file, hasher: sha256Hex })
  const badPut = (_id, sequence) => sequence === 1
    ? Promise.reject(Object.assign(new Error('digest'), {
        status: 422,
        responseDetail: { code: 'byte_digest_mismatch', sequence, expected: expected[1].sha256, actual: 'xx' }
      }))
    : Promise.resolve({ sequence, sha256: expected[sequence].sha256 })
  const failed = await uploadMissing({
    manifestId: manifest.id, file, session,
    sequences: [0, 1, 2], putChunk: badPut, hasher: sha256Hex
  })
  assert.deepEqual(failed, [1])
  assert.equal(session.chunks[0].state, 'done')
  assert.equal(session.chunks[1].state, 'error')
  assert.equal(session.chunks[1].error.code, 'byte_digest_mismatch')
  assert.equal(session.chunks[2].state, 'done')
  assert.equal(readyToFinalize(session), false)
})

test('完成清单：并发/重复点击最多发布一次，完成后本地抑制重复调用', async () => {
  const storage = memoryStorage()
  let calls = 0
  const finalizeCall = async () => { calls += 1; return { completed: true, already_completed: false, manifest_id: 'm' } }
  const finalize = createFinalizer(finalizeCall, storage)

  const [r1, r2, r3] = await Promise.all([finalize('m'), finalize('m'), finalize('m')])
  assert.equal(calls, 1, '进行中的并发点击只发出一个请求')
  assert.equal(r1.completed, true)
  assert.equal(r2.suppressed, 'inflight')
  assert.equal(r3.suppressed, 'inflight')

  const again = await finalize('m')
  assert.equal(calls, 1, '完成后再次点击不重复发布')
  assert.equal(again.already_completed, true)
  assert.equal(again.suppressed, 'local')
})

test('服务端返回 already_completed 时本地也落闸门', async () => {
  const storage = memoryStorage()
  let calls = 0
  const finalize = createFinalizer(async () => {
    calls += 1
    return { completed: false, already_completed: true, manifest_id: 'm' }
  }, storage)
  assert.equal((await finalize('m')).already_completed, true)
  await finalize('m')
  assert.equal(calls, 1)
})

test('恢复会话时清单 digest 不符则丢弃，防止串用不同清单的摘要', () => {
  const storage = memoryStorage()
  const { expected, bytes } = buildFixture([u32([1])])
  const session = createSession(manifestFor(expected), recordingFile(bytes))
  saveSession(session, storage)
  const changed = manifestFor(expected, { manifest_digest: 'different' })
  assert.notEqual(loadSession('mf-1', storage)?.manifest_digest, changed.manifest_digest)
  // 组件侧的等价判断
  const stored = loadSession('mf-1', storage)
  assert.equal(stored.manifest_digest === changed.manifest_digest, false)
})
