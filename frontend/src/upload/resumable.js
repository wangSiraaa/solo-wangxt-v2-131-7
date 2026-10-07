// 断点续传核心逻辑（无 DOM 依赖，可在 Node 中直接测试）。
//
// 会话摘要保存在 localStorage：把"待上传文件"与"清单块序号"绑定，
// 记录每块的期望 sha256、本地实算 sha256、状态、尝试次数与错误。
// 浏览器不能假定 File 句柄持久有效：重进页面后文件句柄必然丢失，
// 必须重新选择文件并通过身份核对（元数据 + 逐块摘要）才能继续。

export const SESSION_VERSION = 1
const SESSION_PREFIX = 'pq.upload.session.v1.'
const DONE_PREFIX = 'pq.upload.finalized.v1.'

// 块状态：
// unknown   尚未在本地核对摘要，也不在服务端
// verified  本地逐块 sha256 已核对通过，等待上传
// present   服务端已有该块（GET /chunks 权威结果）
// uploading 正在 PUT
// done      本次会话 PUT 成功
// error     上传或摘要核对失败
export const CHUNK_STATES = ['unknown', 'verified', 'present', 'uploading', 'done', 'error']

export class UploadError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'UploadError'
    this.code = code
    this.details = details
  }
}

export function toHex(buffer) {
  const bytes = new Uint8Array(buffer)
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

export async function sha256Hex(blob, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new UploadError('crypto_unavailable', '浏览器未提供 SHA-256 能力，无法核对块身份')
  return toHex(await subtle.digest('SHA-256', await blob.arrayBuffer()))
}

export function sortedSequences(session) {
  return Object.keys(session.chunks).map(Number).sort((a, b) => a - b)
}

export function expectedFileSize(manifest) {
  let end = 0
  for (const item of manifest.expected_chunks) end = Math.max(end, item.byte_offset + item.byte_length)
  return end
}

// 由不可变清单 + 新选择的文件建立"文件 ↔ 块序号"关联摘要，不做哈希。
export function createSession(manifest, file, now = () => new Date().toISOString()) {
  const chunks = {}
  for (const item of manifest.expected_chunks) {
    chunks[item.sequence] = {
      sequence: item.sequence,
      sha256: item.sha256,
      byte_offset: item.byte_offset,
      byte_length: item.byte_length,
      local_sha256: null,
      state: 'unknown',
      loaded: 0,
      attempts: 0,
      error: null
    }
  }
  const timestamp = now()
  return {
    version: SESSION_VERSION,
    manifest_id: manifest.id,
    manifest_digest: manifest.manifest_digest ?? null,
    file_name: file.name,
    file_size: file.size,
    file_last_modified: Number.isFinite(file.lastModified) ? file.lastModified : null,
    expected_size: expectedFileSize(manifest),
    chunk_count: manifest.expected_chunks.length,
    chunks,
    completed: false,
    created_at: timestamp,
    updated_at: timestamp
  }
}

export function sessionKey(manifestId) {
  return SESSION_PREFIX + manifestId
}

export function loadSession(manifestId, storage = globalThis.localStorage) {
  let raw = null
  try {
    raw = storage?.getItem(sessionKey(manifestId))
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const session = JSON.parse(raw)
    if (session.version !== SESSION_VERSION || session.manifest_id !== manifestId) return null
    return session
  } catch {
    return null
  }
}

export function saveSession(session, storage = globalThis.localStorage) {
  session.updated_at = new Date().toISOString()
  storage.setItem(sessionKey(session.manifest_id), JSON.stringify(session))
  return session
}

export function clearSession(manifestId, storage = globalThis.localStorage) {
  try {
    storage.removeItem(sessionKey(manifestId))
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

// 第一层身份核对：文件名与尺寸必须与摘要一致。
// 同名不同内容且尺寸相同的情况由逐块摘要核对兜底。
export function checkFileMetadata(session, file) {
  if (file.name !== session.file_name) {
    throw new UploadError(
      'file_name_mismatch',
      `文件身份不符：清单绑定的是 “${session.file_name}”，重新选择的是 “${file.name}”`,
      { expected: session.file_name, actual: file.name }
    )
  }
  if (file.size !== session.file_size || file.size !== session.expected_size) {
    throw new UploadError(
      'file_size_mismatch',
      `文件身份不符：“${file.name}” 大小为 ${file.size} 字节，清单期望 ${session.expected_size} 字节；同名文件内容不同，拒绝继续续传`,
      { expected_size: session.expected_size, session_size: session.file_size, actual_size: file.size }
    )
  }
}

// 第二层身份核对：按清单声明的 byte_offset/byte_length 逐块切片实算 SHA-256。
// 任何一块摘要不符即拒绝，绝不进入上传阶段。
export async function verifyChunkDigests({
  session,
  file,
  sequences = sortedSequences(session),
  hasher = sha256Hex,
  onProgress,
  signal
}) {
  let done = 0
  for (const sequence of sequences) {
    if (signal?.aborted) throw new UploadError('aborted', '身份核对已取消')
    const plan = session.chunks[sequence]
    if (!plan) throw new UploadError('unknown_sequence', `摘要中不存在块 ${sequence}`, { sequence })
    const blob = file.slice(plan.byte_offset, plan.byte_offset + plan.byte_length)
    if (blob.size !== plan.byte_length) {
      throw new UploadError(
        'file_size_mismatch',
        `块 ${sequence} 切片长度不足：文件可能被截断或不是同一份录波`,
        { sequence, expected: plan.byte_length, actual: blob.size }
      )
    }
    const actual = await hasher(blob)
    if (actual !== plan.sha256) {
      plan.state = 'error'
      plan.error = { code: 'chunk_digest_mismatch', expected: plan.sha256, actual }
      throw new UploadError(
        'chunk_digest_mismatch',
        `块 ${sequence} 的 SHA-256 与清单不符：同名文件内容不同，拒绝继续续传`,
        { sequence, expected: plan.sha256, actual }
      )
    }
    plan.local_sha256 = actual
    if (plan.state !== 'present' && plan.state !== 'done') plan.state = 'verified'
    plan.error = null
    done += 1
    onProgress?.({ stage: 'verify', sequence, done, total: sequences.length })
  }
  return session
}

// 以服务端 GET /chunks 为权威来源核对状态，返回仍缺失的块序号。
// 只补缺块；服务端已存在且摘要一致的块不再重传。
export function reconcileServer(session, serverChunks) {
  const bySequence = new Map()
  for (const chunk of serverChunks || []) {
    if (Object.prototype.hasOwnProperty.call(session.chunks, chunk.sequence)) {
      bySequence.set(chunk.sequence, chunk)
    }
  }
  const missing = []
  for (const sequence of sortedSequences(session)) {
    const plan = session.chunks[sequence]
    const remote = bySequence.get(sequence)
    if (remote) {
      if (remote.sha256 !== plan.sha256) {
        plan.state = 'error'
        plan.error = { code: 'server_digest_conflict', expected: plan.sha256, actual: remote.sha256 }
        missing.push(sequence)
      } else {
        plan.state = 'present'
        plan.local_sha256 = plan.local_sha256 || remote.sha256
        plan.loaded = plan.byte_length
        plan.error = null
      }
    } else if (plan.state === 'done') {
      // 本会话刚传完但服务端列表尚未刷新，保留 done，不立即重传
      // （下一轮 reconcile 若仍无记录会自然落入缺失列表）。
      continue
    } else {
      plan.state = plan.local_sha256 ? 'verified' : 'unknown'
      plan.loaded = 0
      missing.push(sequence)
    }
  }
  return missing
}

export function readyToFinalize(session) {
  const plans = Object.values(session.chunks)
  return plans.length > 0 && plans.every((plan) => plan.state === 'present' || plan.state === 'done')
}

export function presentCount(session) {
  return Object.values(session.chunks).filter((p) => p.state === 'present' || p.state === 'done').length
}

export function normalizeUploadError(error) {
  const detail = error?.responseDetail ?? error?.detail ?? null
  const normalized = {
    code: detail?.code || error?.code || 'upload_failed',
    message: error?.message || String(error),
    status: error?.status ?? null,
    detail
  }
  if (detail?.expected) normalized.expected = detail.expected
  else if (error?.details?.expected) normalized.expected = error.details.expected
  if (detail?.actual) normalized.actual = detail.actual
  else if (error?.details?.actual) normalized.actual = error.details.actual
  return normalized
}

// 顺序补传给定块（乱序清单也安全：服务端按序号独立接收）。
// 逐块更新进度与错误；单块失败不打断其余块，最后返回失败序号列表。
// putChunk(manifestId, sequence, blob, {onProgress, signal})
export async function uploadMissing({
  manifestId,
  file,
  session,
  sequences,
  putChunk,
  hasher = sha256Hex,
  onState,
  signal
}) {
  const failed = []
  const identityFailure = Object.values(session.chunks).find(
    (plan) => plan.state === 'error' && plan.error?.code === 'chunk_digest_mismatch'
  )
  if (identityFailure) {
    // 存在本地摘要与清单不符的块 = 所选文件不是声明的那份录波，
    // 文件级拒绝：任何块都不允许继续 PUT。
    throw new UploadError(
      'file_identity_mismatch',
      `块 ${identityFailure.sequence} 摘要与清单不符，已判定为同名不同内容文件，拒绝继续续传`,
      { sequence: identityFailure.sequence, expected: identityFailure.sha256, actual: identityFailure.error.actual }
    )
  }
  for (const sequence of sequences) {
    const plan = session.chunks[sequence]
    if (!plan) continue
    if (plan.state === 'present') continue
    if (signal?.aborted) {
      plan.state = plan.local_sha256 ? 'verified' : 'unknown'
      failed.push(sequence)
      break
    }
    const blob = file.slice(plan.byte_offset, plan.byte_offset + plan.byte_length)
    plan.state = 'uploading'
    plan.error = null
    plan.loaded = 0
    plan.attempts += 1
    onState?.(session)
    try {
      if (!plan.local_sha256) {
        const actual = await hasher(blob)
        if (actual !== plan.sha256) {
          throw new UploadError('chunk_digest_mismatch', `块 ${sequence} 摘要与清单不符`, {
            sequence,
            expected: plan.sha256,
            actual
          })
        }
        plan.local_sha256 = actual
      }
      await putChunk(manifestId, sequence, blob, {
        signal,
        onProgress: (event) => {
          plan.loaded = Number.isFinite(event?.loaded) ? event.loaded : plan.loaded
          onState?.(session)
        }
      })
      plan.state = 'done'
      plan.loaded = plan.byte_length
      plan.error = null
    } catch (error) {
      if (error?.code === 'chunk_digest_mismatch') {
        plan.state = 'error'
        plan.error = normalizeUploadError(error)
        failed.push(sequence)
      } else if (signal?.aborted || error?.code === 'aborted') {
        plan.state = plan.local_sha256 ? 'verified' : 'unknown'
      } else {
        plan.state = 'error'
        plan.error = normalizeUploadError(error)
        failed.push(sequence)
      }
    }
    onState?.(session)
  }
  return failed
}

// ---- 完成清单的一次性闸门 -------------------------------------------------
//
// 服务端 finalize 本身具备幂等（已完成返回 already_completed=true），
// 浏览器侧再加一道：进行中防并发连点、完成后本地落标记，重复点击根本不发请求。

export function isFinalizedLocally(manifestId, storage = globalThis.localStorage) {
  try {
    return storage?.getItem(DONE_PREFIX + manifestId) === '1'
  } catch {
    return false
  }
}

export function markFinalizedLocally(manifestId, storage = globalThis.localStorage) {
  try {
    storage.setItem(DONE_PREFIX + manifestId, '1')
  } catch {
    /* 忽略 */
  }
}

// finalizeCall(manifestId) -> { completed, already_completed }
export function createFinalizer(finalizeCall, storage = globalThis.localStorage) {
  const inflight = new Set()
  return async function finalizeOnce(manifestId) {
    if (isFinalizedLocally(manifestId, storage)) {
      return { completed: false, already_completed: true, manifest_id: manifestId, suppressed: 'local' }
    }
    if (inflight.has(manifestId)) {
      return { completed: false, already_completed: true, manifest_id: manifestId, suppressed: 'inflight' }
    }
    inflight.add(manifestId)
    try {
      const result = await finalizeCall(manifestId)
      if (result?.completed || result?.already_completed) {
        markFinalizedLocally(manifestId, storage)
      }
      return result
    } finally {
      inflight.delete(manifestId)
    }
  }
}
