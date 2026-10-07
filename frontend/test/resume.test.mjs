import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChunkPlan,
  buildManifestPayload,
  createRecord,
  fingerprintRegions,
  isoToMicros,
  listRecords,
  loadRecord,
  microsToIso,
  planChunkActions,
  reconcileRecord,
  removeRecord,
  saveRecord,
  verifyFileIdentity,
} from '../src/upload/resume.js'

// ---------------------------------------------------------------------------
// 工具

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

function makeExpected(count, overrides = {}) {
  return Array.from({ length: count }, (_, sequence) => ({
    sequence,
    sha256: `${sequence}`.padStart(64, '0'),
    byte_offset: sequence * 1000,
    byte_length: 1000,
    sample_count: 300,
    sample_rate: 6000,
    channels: ['Va', 'Vb', 'Vc'],
    start_time: '2026-10-01T00:00:00',
    end_time: '2026-10-01T00:00:00.049833',
    encoding: 'float32le-interleaved',
    ...overrides,
  }))
}

// ---------------------------------------------------------------------------
// 文件身份

test('fingerprintRegions：小文件整体采样，大文件头/中/尾三段', () => {
  assert.deepEqual(fingerprintRegions(0), [])
  assert.deepEqual(fingerprintRegions(100), [{ offset: 0, length: 100 }])
  const size = 10 * (1 << 20)
  const regions = fingerprintRegions(size)
  assert.equal(regions.length, 3)
  assert.deepEqual(regions[0], { offset: 0, length: 1 << 20 })
  assert.deepEqual(regions[2], { offset: size - (1 << 20), length: 1 << 20 })
  for (const region of regions) {
    assert.ok(region.offset >= 0 && region.offset + region.length <= size)
  }
  // 三段互不重叠
  assert.ok(regions[0].offset + regions[0].length <= regions[1].offset)
  assert.ok(regions[1].offset + regions[1].length <= regions[2].offset)
})

test('verifyFileIdentity：同名不同内容的文件被拒绝', () => {
  const saved = { name: 'rec.bin', size: 1 << 20, lastModified: 1727740800000, fingerprint: 'a'.repeat(64) }
  const same = { ...saved }
  assert.deepEqual(verifyFileIdentity(same, saved), { ok: true, mismatches: [] })

  // 同名、同大小、同修改时间，但内容指纹不同 —— 必须拒绝
  const replaced = { ...saved, fingerprint: 'b'.repeat(64) }
  const result = verifyFileIdentity(replaced, saved)
  assert.equal(result.ok, false)
  assert.ok(result.mismatches.includes('fingerprint'))

  assert.equal(verifyFileIdentity({ ...saved, size: saved.size + 1 }, saved).ok, false)
  assert.equal(verifyFileIdentity({ ...saved, name: 'other.bin' }, saved).ok, false)
  assert.equal(verifyFileIdentity(same, null).ok, false)
})

// ---------------------------------------------------------------------------
// 补缺计划

test('planChunkActions：乱序上传中断后只补缺块', () => {
  const expected = makeExpected(5)
  // 服务端已按乱序收到 3、0、2 三块（模拟中断现场）
  const server = [3, 0, 2].map((sequence) => ({ sequence, sha256: `${sequence}`.padStart(64, '0') }))
  const plan = planChunkActions(expected, server)
  const uploads = plan.actions.filter((item) => item.action === 'upload').map((item) => item.sequence)
  assert.deepEqual(uploads, [1, 4])
  assert.equal(plan.confirmed, 3)
  assert.equal(plan.pending, 2)
  assert.equal(plan.complete, false)

  const done = planChunkActions(expected, expected.map((chunk) => ({ sequence: chunk.sequence, sha256: chunk.sha256 })))
  assert.equal(done.complete, true)
  assert.equal(done.pending, 0)
})

test('planChunkActions：服务端摘要不符与清单外块都阻断完成', () => {
  const expected = makeExpected(2)
  const server = [
    { sequence: 0, sha256: 'f'.repeat(64) }, // 与清单不符
    { sequence: 1, sha256: expected[1].sha256 },
    { sequence: 9, sha256: 'e'.repeat(64) }, // 清单之外
  ]
  const plan = planChunkActions(expected, server)
  assert.equal(plan.actions[0].action, 'error')
  assert.equal(plan.actions[0].reason, 'server_digest_mismatch')
  assert.equal(plan.actions[1].action, 'done')
  assert.deepEqual(plan.unexpected, [9])
  assert.equal(plan.complete, false)
})

// ---------------------------------------------------------------------------
// 清单构造

test('buildChunkPlan：字节偏移连续、采样时间轴连续（后端容差 1µs 内）', () => {
  const channels = ['Va', 'Vb', 'Vc']
  const sampleRate = 6000
  const chunkSamples = 300
  const chunks = buildChunkPlan({
    fileSize: 1000 * 4 * channels.length, // 1000 采样 → 300+300+300+100
    sampleRate,
    channels,
    startTimeIso: '2026-10-01T08:30:00',
    chunkSamples,
  })
  assert.equal(chunks.length, 4)
  assert.equal(chunks[3].sampleCount, 100)

  let byteOffset = 0
  for (const [index, chunk] of chunks.entries()) {
    assert.equal(chunk.sequence, index)
    assert.equal(chunk.byteOffset, byteOffset)
    assert.equal(chunk.byteLength, chunk.sampleCount * 4 * channels.length)
    byteOffset += chunk.byteLength
    // 块内时长 == (sampleCount-1)/fs，误差 ≤ 1µs
    const duration = Number(isoToMicros(chunk.endTime) - isoToMicros(chunk.startTime)) / 1e6
    assert.ok(Math.abs(duration - (chunk.sampleCount - 1) / sampleRate) <= 1e-6, `chunk ${index} duration`)
  }
  // 相邻块：下一块起点 == 上一块终点 + 一个采样周期，误差 ≤ 1µs
  for (let index = 1; index < chunks.length; index += 1) {
    const gap = Number(isoToMicros(chunks[index].startTime) - isoToMicros(chunks[index - 1].endTime)) / 1e6
    assert.ok(Math.abs(gap - 1 / sampleRate) <= 1e-6, `gap before chunk ${index}`)
  }
  assert.equal(byteOffset, 1000 * 4 * channels.length)
})

test('buildChunkPlan：非法输入直接拒绝', () => {
  const base = { fileSize: 120, sampleRate: 6000, channels: ['Va'], startTimeIso: '2026-10-01T00:00', chunkSamples: 10 }
  assert.throws(() => buildChunkPlan({ ...base, fileSize: 122 }), /整数倍/) // 不是 4 字节整数倍
  assert.throws(() => buildChunkPlan({ ...base, channels: [] }), /通道/)
  assert.throws(() => buildChunkPlan({ ...base, sampleRate: 0 }), /采样率/)
  assert.throws(() => buildChunkPlan({ ...base, chunkSamples: 0 }), /采样数/)
  assert.throws(() => buildChunkPlan({ ...base, startTimeIso: 'not-a-time' }), /timestamp/)
})

test('buildManifestPayload：snake_case 字段与摘要顺序', () => {
  const chunks = buildChunkPlan({
    fileSize: 24, sampleRate: 6000, channels: ['Va'], startTimeIso: '2026-10-01T00:00', chunkSamples: 3,
  })
  const digests = chunks.map((_, index) => `${index}`.padStart(64, '0'))
  const payload = buildManifestPayload({ name: 'line-1', nominalSampleRate: 6000, chunkPlan: chunks, digests })
  assert.equal(payload.name, 'line-1')
  assert.equal(payload.expected_chunks.length, 2)
  assert.deepEqual(Object.keys(payload.expected_chunks[0]).sort(), [
    'byte_length', 'byte_offset', 'channels', 'encoding', 'end_time',
    'sample_count', 'sample_rate', 'sequence', 'sha256', 'start_time',
  ].sort())
  assert.equal(payload.expected_chunks[1].sha256, digests[1])
  assert.throws(() => buildManifestPayload({ name: 'x', chunkPlan: chunks, digests: digests.slice(1) }), /不一致/)
})

// ---------------------------------------------------------------------------
// 时间戳

test('isoToMicros / microsToIso 往返一致（naive 墙钟，不经浏览器时区）', () => {
  for (const iso of ['2026-10-01T00:00:00', '2026-10-01T08:30:15.123456', '2026-02-28T23:59:59.999999']) {
    assert.equal(microsToIso(isoToMicros(iso)), iso.includes('.') ? iso : `${iso}.000000`)
  }
  // 采样序号偏移：6000 Hz 下第 1 个采样 = 166.667µs（四舍五入）
  const start = isoToMicros('2026-10-01T00:00:00')
  assert.equal(microsToIso(start + 166667n), '2026-10-01T00:00:00.166667')
})

// ---------------------------------------------------------------------------
// 本地记录

test('记录读写：保存/加载/列举/删除，坏数据安全返回 null', () => {
  const storage = memoryStorage()
  const record = createRecord({
    manifestId: 'm1',
    manifestDigest: 'd'.repeat(64),
    name: 'rec',
    file: { name: 'a.bin', size: 10, lastModified: 1, fingerprint: 'f'.repeat(64) },
    chunks: [{ sequence: 0, sha256: '0'.repeat(64), byte_offset: 0, byte_length: 10 }],
  })
  saveRecord(storage, record)
  const loaded = loadRecord(storage, 'm1')
  assert.equal(loaded.manifestId, 'm1')
  assert.equal(loaded.chunks[0].byteOffset, 10 - 10) // byte_offset 0
  assert.equal(loaded.chunks[0].byteLength, 10)
  assert.deepEqual(listRecords(storage).map((item) => item.manifestId), ['m1'])

  storage.setItem('pq-resume:broken', '{not json')
  assert.equal(loadRecord(storage, 'broken'), null)
  storage.setItem('pq-resume:old', JSON.stringify({ version: 999 }))
  assert.equal(loadRecord(storage, 'old'), null)

  removeRecord(storage, 'm1')
  assert.equal(loadRecord(storage, 'm1'), null)
})

test('reconcileRecord：清单被替换或摘要变化时拒绝继续', () => {
  const record = createRecord({
    manifestId: 'm1',
    manifestDigest: 'a'.repeat(64),
    name: 'rec',
    file: { name: 'a.bin', size: 10, lastModified: 1, fingerprint: 'f'.repeat(64) },
    chunks: [{ sequence: 0, sha256: '0'.repeat(64), byteOffset: 0, byteLength: 10 }],
  })
  const manifest = {
    manifest_digest: 'a'.repeat(64),
    expected_chunks: [{ sequence: 0, sha256: '0'.repeat(64) }],
  }
  assert.deepEqual(reconcileRecord(record, manifest), { ok: true, problems: [] })
  assert.equal(reconcileRecord(record, null).ok, false)
  assert.ok(reconcileRecord(record, { ...manifest, manifest_digest: 'b'.repeat(64) }).problems.includes('manifest_digest_changed'))
  const tampered = { ...manifest, expected_chunks: [{ sequence: 0, sha256: '9'.repeat(64) }] }
  assert.ok(reconcileRecord(record, tampered).problems.some((problem) => problem.includes('digest_changed')))
})
