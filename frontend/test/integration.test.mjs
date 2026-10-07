// 端到端验收：用真实的 resume/fileHash 模块驱动一个模拟服务端契约的 mock
// （语义对齐 backend/app/routers/manifests.py：PUT 校验摘要、重传幂等、
// finalize 原子完成且重复调用返回 already_completed），覆盖三条验收标准：
//   1. 乱序上传中断后只补缺块；
//   2. 换成同名不同内容文件被拒绝继续；
//   3. 完成后再次点击不重复发布清单。

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { computeFileFingerprint, hashChunk } from '../src/upload/fileHash.js'
import {
  buildChunkPlan,
  buildManifestPayload,
  createRecord,
  loadRecord,
  planChunkActions,
  saveRecord,
  verifyFileIdentity,
} from '../src/upload/resume.js'

function memoryStorage() {
  const map = new Map()
  return {
    get length() { return map.size },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

// 模拟服务端：与 FastAPI 后端相同的不可变块/原子完成语义
function mockServer() {
  const manifests = new Map()
  const received = new Map()
  const putLog = []
  return {
    putLog,
    createManifest(payload) {
      const id = `m${manifests.size + 1}`
      manifests.set(id, { ...payload, status: 'open' })
      received.set(id, new Map())
      return { id, ...payload }
    },
    async putChunk(id, sequence, blob) {
      const manifest = manifests.get(id)
      assert.equal(manifest.status, 'open', 'completed 后拒绝上传')
      const expected = manifest.expected_chunks.find((chunk) => chunk.sequence === sequence)
      assert.ok(expected, `sequence ${sequence} 在清单中`)
      const existing = received.get(id).get(sequence)
      if (existing) return existing // 重传幂等，直接返回已有块
      const digest = createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex')
      assert.equal(digest, expected.sha256, '服务端拒绝摘要不符的块')
      const record = { sequence, sha256: digest }
      received.get(id).set(sequence, record)
      putLog.push(sequence)
      return record
    },
    listChunks: (id) => [...received.get(id).values()],
    finalize(id) {
      const manifest = manifests.get(id)
      if (manifest.status === 'completed') {
        return { completed: false, already_completed: true, manifest_id: id }
      }
      const missing = manifest.expected_chunks.filter((chunk) => !received.get(id).has(chunk.sequence))
      if (missing.length) {
        const error = new Error('manifest_validation_failed')
        error.status = 422
        throw error
      }
      manifest.status = 'completed'
      return { completed: true, already_completed: false, manifest_id: id, warnings: [] }
    },
  }
}

// 与 UploadPanel 相同的补缺循环：只传 plan 里仍然缺失的块
async function uploadMissing(server, manifestId, file, plan) {
  for (const item of plan.actions) {
    if (item.action !== 'upload') continue
    const blob = file.slice(item.expected.byte_offset, item.expected.byte_offset + item.expected.byte_length)
    await server.putChunk(manifestId, item.sequence, blob)
  }
}

function makeRecordingFile(name, lastModified, seed) {
  const samples = 1000
  const channels = 3
  const data = new Float32Array(samples * channels)
  for (let index = 0; index < data.length; index += 1) {
    data[index] = Math.sin(index / 10 + seed) * 300
  }
  return new File([new Uint8Array(data.buffer)], name, { lastModified })
}

test('断点续传端到端：乱序中断 → 身份核对 → 只补缺块 → 完成不重复发布', async () => {
  const server = mockServer()
  const storage = memoryStorage()
  const channels = ['Va', 'Vb', 'Vc']
  const file = makeRecordingFile('line-a.bin', 1727740800000, 0)

  // 1. 新建上传：算摘要、建清单、写本地记录
  const chunkPlan = buildChunkPlan({
    fileSize: file.size, sampleRate: 6000, channels, startTimeIso: '2026-10-01T08:00:00', chunkSamples: 300,
  })
  assert.equal(chunkPlan.length, 4) // 300+300+300+100
  const digests = []
  for (const chunk of chunkPlan) digests.push(await hashChunk(file, chunk.byteOffset, chunk.byteLength))
  const payload = buildManifestPayload({ name: 'line-a', nominalSampleRate: 6000, chunkPlan, digests })
  const manifest = server.createManifest(payload)
  const fingerprint = await computeFileFingerprint(file)
  saveRecord(storage, createRecord({
    manifestId: manifest.id,
    manifestDigest: 'digest-placeholder',
    name: 'line-a',
    file: { name: file.name, size: file.size, lastModified: file.lastModified, fingerprint },
    chunks: payload.expected_chunks,
  }))

  // 2. 乱序上传 2、0 两块后"中断"（页面关闭）
  await server.putChunk(manifest.id, 2, file.slice(chunkPlan[2].byteOffset, chunkPlan[2].byteOffset + chunkPlan[2].byteLength))
  await server.putChunk(manifest.id, 0, file.slice(chunkPlan[0].byteOffset, chunkPlan[0].byteOffset + chunkPlan[0].byteLength))
  server.putLog.length = 0

  // 3. 重新进页面：恢复本地记录，先查服务端状态
  const record = loadRecord(storage, manifest.id)
  assert.ok(record, '本地记录应存在')
  const serverChunks = server.listChunks(manifest.id)
  const plan = planChunkActions(manifest.expected_chunks, serverChunks)
  assert.deepEqual(
    plan.actions.filter((item) => item.action === 'upload').map((item) => item.sequence),
    [1, 3],
    '乱序中断后只缺 1、3 两块')

  // 4. 同名不同内容的文件：身份核对必须拒绝
  const impostor = makeRecordingFile('line-a.bin', 1727740800000, 999)
  assert.equal(impostor.size, file.size)
  const impostorMeta = {
    name: impostor.name,
    size: impostor.size,
    lastModified: impostor.lastModified,
    fingerprint: await computeFileFingerprint(impostor),
  }
  const rejected = verifyFileIdentity(impostorMeta, record.file)
  assert.equal(rejected.ok, false)
  assert.ok(rejected.mismatches.includes('fingerprint'))

  // 5. 重新选择原文件：核对通过，只补 1、3 两块
  const reselected = makeRecordingFile('line-a.bin', 1727740800000, 0)
  const reselectedMeta = {
    name: reselected.name,
    size: reselected.size,
    lastModified: reselected.lastModified,
    fingerprint: await computeFileFingerprint(reselected),
  }
  assert.deepEqual(verifyFileIdentity(reselectedMeta, record.file), { ok: true, mismatches: [] })
  await uploadMissing(server, manifest.id, reselected, plan)
  assert.deepEqual(server.putLog, [1, 3], '缺块以外的块不得重传')

  // 6. 全部确认后才允许完成；完成后重复调用不重复发布
  const finalPlan = planChunkActions(manifest.expected_chunks, server.listChunks(manifest.id))
  assert.equal(finalPlan.complete, true)
  const first = server.finalize(manifest.id)
  assert.deepEqual(first, { completed: true, already_completed: false, manifest_id: manifest.id, warnings: [] })
  const second = server.finalize(manifest.id)
  assert.deepEqual(second, { completed: false, already_completed: true, manifest_id: manifest.id })
})

test('finalize 门控：缺块时服务端拒绝完成，清单保持 open', async () => {
  const server = mockServer()
  const file = makeRecordingFile('partial.bin', 1727740800000, 1)
  const chunkPlan = buildChunkPlan({
    fileSize: file.size, sampleRate: 6000, channels: ['Va', 'Vb', 'Vc'], startTimeIso: '2026-10-01T09:00:00', chunkSamples: 500,
  })
  const digests = []
  for (const chunk of chunkPlan) digests.push(await hashChunk(file, chunk.byteOffset, chunk.byteLength))
  const manifest = server.createManifest(buildManifestPayload({ name: 'partial', chunkPlan, digests }))
  await server.putChunk(manifest.id, 0, file.slice(0, chunkPlan[0].byteLength))
  const plan = planChunkActions(manifest.expected_chunks, server.listChunks(manifest.id))
  assert.equal(plan.complete, false, '缺块时不允许完成')
  assert.throws(() => server.finalize(manifest.id), /manifest_validation_failed/)
})
