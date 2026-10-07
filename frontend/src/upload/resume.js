// 断点续传的纯逻辑层：不依赖浏览器 API（storage 可注入），方便用 node:test 单测。
//
// 本地记录（localStorage，key = pq-resume:{manifestId}）把"待上传文件 ↔ 清单 ↔ 块序号"
// 关联起来：文件身份（名称/大小/修改时间/采样指纹）、清单 digest、每块序号与摘要。
// 刷新或换机重进页面后，先查服务端清单与已收块，再决定补哪些块。

export const RECORD_VERSION = 1
export const STORAGE_PREFIX = 'pq-resume:'

// ---------------------------------------------------------------------------
// 文件身份

// 数 GB 文件不做整体哈希：头/中/尾各采 1 MiB，加上名称/大小/修改时间一起进指纹。
// 同名同大小但内容不同的文件几乎必然在采样中暴露。
export function fingerprintRegions(size, sampleSize = 1 << 20) {
  if (!Number.isSafeInteger(size) || size <= 0) return []
  if (size <= 3 * sampleSize) return [{ offset: 0, length: size }]
  const middle = Math.floor(size / 2) - Math.floor(sampleSize / 2)
  return [
    { offset: 0, length: sampleSize },
    { offset: middle, length: sampleSize },
    { offset: size - sampleSize, length: sampleSize },
  ]
}

// 重新选择文件时的身份核对。任何一项不符都拒绝继续——宁可让技术员重选，
// 也不能把别的文件的字节送进不可变清单。
export function verifyFileIdentity(fileMeta, savedFile) {
  if (!savedFile) return { ok: false, mismatches: ['no_saved_identity'] }
  const mismatches = []
  if (fileMeta.name !== savedFile.name) mismatches.push('name')
  if (fileMeta.size !== savedFile.size) mismatches.push('size')
  if (fileMeta.lastModified !== savedFile.lastModified) mismatches.push('lastModified')
  if (fileMeta.fingerprint !== savedFile.fingerprint) mismatches.push('fingerprint')
  return { ok: mismatches.length === 0, mismatches }
}

// ---------------------------------------------------------------------------
// 时间戳：微秒精度的 naive ISO（与后端 datetime.fromisoformat 解析的清单一致）。
// 全程按 UTC 分量解释，不经过浏览器时区，保证"用户输入的墙钟时间 == 清单时间"。

export function isoToMicros(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?/.exec(String(iso).trim())
  if (!match) throw new Error(`invalid timestamp: ${iso}`)
  const [, year, month, day, hour, minute, second = '0', fraction = ''] = match
  const micros = Number((fraction + '000000').slice(0, 6))
  return BigInt(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)) * 1000n + BigInt(micros)
}

export function microsToIso(micros) {
  if (micros < 0n) throw new Error('negative timestamps are not supported')
  const epochMs = micros / 1000n
  const remMicros = micros % 1000n
  const date = new Date(Number(epochMs))
  const base = date.toISOString().slice(0, 19)
  const millis = String(date.getUTCMilliseconds()).padStart(3, '0')
  return `${base}.${millis}${remMicros.toString().padStart(3, '0')}`
}

// 采样序号 -> 时间戳：独立四舍五入到微秒。相邻块边界各舍一次，误差最多 1 µs，
// 仍在后端 TIME_TOLERANCE_SECONDS（1e-6 s，严格大于才判错）之内。
export function sampleOffsetMicros(offsetSamples, sampleRate) {
  return BigInt(Math.round((offsetSamples * 1e6) / sampleRate))
}

// ---------------------------------------------------------------------------
// 清单构造

// 把文件按固定采样数切块，生成带连续字节偏移与连续采样时间轴的块计划。
// 摘要在浏览器里逐块算完后由 buildManifestPayload 填入。
export function buildChunkPlan({ fileSize, sampleRate, channels, startTimeIso, chunkSamples }) {
  if (!Array.isArray(channels) || channels.length === 0) throw new Error('通道列表不能为空')
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) throw new Error('文件大小无效')
  if (!(sampleRate > 0)) throw new Error('采样率必须为正数')
  if (!Number.isSafeInteger(chunkSamples) || chunkSamples <= 0) throw new Error('每块采样数必须为正整数')
  const bytesPerSample = 4 * channels.length
  if (fileSize % bytesPerSample !== 0) {
    throw new Error(`文件大小 ${fileSize} 不是 ${bytesPerSample} 字节（${channels.length} 通道 float32）的整数倍`)
  }
  const totalSamples = fileSize / bytesPerSample
  const startMicros = isoToMicros(startTimeIso)
  const chunks = []
  let offsetSamples = 0
  let byteOffset = 0
  while (offsetSamples < totalSamples) {
    const sampleCount = Math.min(chunkSamples, totalSamples - offsetSamples)
    const start = startMicros + sampleOffsetMicros(offsetSamples, sampleRate)
    const end = startMicros + sampleOffsetMicros(offsetSamples + sampleCount - 1, sampleRate)
    chunks.push({
      sequence: chunks.length,
      byteOffset,
      byteLength: sampleCount * bytesPerSample,
      sampleCount,
      sampleRate,
      channels: [...channels],
      startTime: microsToIso(start),
      endTime: microsToIso(end),
      encoding: 'float32le-interleaved',
    })
    offsetSamples += sampleCount
    byteOffset += sampleCount * bytesPerSample
  }
  return chunks
}

export function buildManifestPayload({ name, nominalSampleRate, chunkPlan, digests }) {
  if (!name) throw new Error('清单名称不能为空')
  if (digests.length !== chunkPlan.length) throw new Error('摘要数量与块数不一致')
  return {
    name,
    nominal_sample_rate: nominalSampleRate ?? chunkPlan[0]?.sampleRate ?? null,
    expected_chunks: chunkPlan.map((chunk, index) => ({
      sequence: chunk.sequence,
      sha256: digests[index],
      byte_offset: chunk.byteOffset,
      byte_length: chunk.byteLength,
      sample_count: chunk.sampleCount,
      sample_rate: chunk.sampleRate,
      channels: chunk.channels,
      start_time: chunk.startTime,
      end_time: chunk.endTime,
      encoding: chunk.encoding,
    })),
  }
}

// ---------------------------------------------------------------------------
// 补缺计划：对比清单声明与服务端已收块，只补缺失或摘要不符的块。

export function planChunkActions(expectedChunks, serverChunks) {
  const serverBySequence = new Map((serverChunks || []).map((chunk) => [chunk.sequence, chunk]))
  const expectedSequences = new Set()
  const actions = (expectedChunks || []).map((expected) => {
    expectedSequences.add(expected.sequence)
    const server = serverBySequence.get(expected.sequence)
    if (!server) {
      return { sequence: expected.sequence, action: 'upload', reason: 'missing_on_server', expected }
    }
    if (server.sha256 !== expected.sha256) {
      // 服务端块与清单摘要不符：原始块不可变，前端绝不覆盖，报出让后端 finalize 裁决。
      return { sequence: expected.sequence, action: 'error', reason: 'server_digest_mismatch', expected, server }
    }
    return { sequence: expected.sequence, action: 'done', reason: 'confirmed', expected, server }
  })
  const unexpected = (serverChunks || [])
    .filter((chunk) => !expectedSequences.has(chunk.sequence))
    .map((chunk) => chunk.sequence)
  const pending = actions.filter((item) => item.action === 'upload').length
  const failed = actions.filter((item) => item.action === 'error').length
  return {
    actions,
    unexpected,
    pending,
    failed,
    confirmed: actions.length - pending - failed,
    complete: pending === 0 && failed === 0 && unexpected.length === 0,
  }
}

// ---------------------------------------------------------------------------
// 本地记录

export function createRecord({ manifestId, manifestDigest, name, file, chunks }) {
  return {
    version: RECORD_VERSION,
    manifestId,
    manifestDigest,
    name,
    file, // { name, size, lastModified, fingerprint }
    chunks: chunks.map((chunk) => ({
      sequence: chunk.sequence,
      sha256: chunk.sha256,
      byteOffset: chunk.byteOffset ?? chunk.byte_offset,
      byteLength: chunk.byteLength ?? chunk.byte_length,
    })),
    uploaded: {}, // sequence -> 服务端已确认的 sha256
    state: 'uploading', // uploading | completed
    updatedAt: new Date().toISOString(),
  }
}

// 本地记录与服务端清单对账：清单被删重建或内容变化时拒绝继续，防止把字节
// 送进错误的不可变清单。
export function reconcileRecord(record, manifest) {
  if (!manifest) return { ok: false, problems: ['manifest_missing_on_server'] }
  const problems = []
  if (record.manifestDigest && manifest.manifest_digest && record.manifestDigest !== manifest.manifest_digest) {
    problems.push('manifest_digest_changed')
  }
  const expectedBySequence = new Map(manifest.expected_chunks.map((chunk) => [chunk.sequence, chunk.sha256]))
  for (const chunk of record.chunks) {
    const digest = expectedBySequence.get(chunk.sequence)
    if (digest === undefined) problems.push(`chunk_${chunk.sequence}_not_in_manifest`)
    else if (digest !== chunk.sha256) problems.push(`chunk_${chunk.sequence}_digest_changed`)
  }
  return { ok: problems.length === 0, problems }
}

function recordKey(manifestId) {
  return `${STORAGE_PREFIX}${manifestId}`
}

export function loadRecord(storage, manifestId) {
  const raw = storage.getItem(recordKey(manifestId))
  if (!raw) return null
  try {
    const record = JSON.parse(raw)
    if (record.version !== RECORD_VERSION) return null
    return record
  } catch {
    return null
  }
}

export function saveRecord(storage, record) {
  record.updatedAt = new Date().toISOString()
  storage.setItem(recordKey(record.manifestId), JSON.stringify(record))
  return record
}

export function removeRecord(storage, manifestId) {
  storage.removeItem(recordKey(manifestId))
}

export function listRecords(storage) {
  const records = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue
    const record = loadRecord(storage, key.slice(STORAGE_PREFIX.length))
    if (record) records.push(record)
  }
  return records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}
