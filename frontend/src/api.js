const BASE = ''

async function request(path, options = {}) {
  const response = await fetch(BASE + path, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw Object.assign(new Error(JSON.stringify(data ?? response.statusText)), {
    status: response.status,
    responseDetail: data?.detail ?? null
  })
  return data
}

// 分块 PUT 走 XHR 以获得 upload progress；响应体错误统一转成带 detail/code 的 Error。
function uploadChunkRequest(manifestId, sequence, blob, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('chunk_file', blob, `${sequence}.bin`)
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `${BASE}/manifests/${manifestId}/chunks/${sequence}/raw`)
    xhr.upload.onprogress = (event) => onProgress?.({ loaded: event.loaded, total: event.total })
    xhr.onload = () => {
      let data = null
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { data = null }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data)
      } else {
        reject(Object.assign(new Error(xhr.responseText || xhr.statusText), {
          status: xhr.status,
          responseDetail: data?.detail ?? null
        }))
      }
    }
    xhr.onerror = () => reject(Object.assign(new Error('network error'), { status: 0 }))
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { code: 'aborted' }))
    if (signal) {
      if (signal.aborted) { xhr.abort(); return }
      signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }
    xhr.send(form)
  })
}

export const api = {
  health: () => request('/health'),
  manifests: () => request('/manifests'),
  manifest: (id) => request(`/manifests/${id}`),
  chunks: (id) => request(`/manifests/${id}/chunks`),
  putChunk: (manifestId, sequence, blob, options) =>
    uploadChunkRequest(manifestId, sequence, blob, options),
  issues: (id) => request(`/manifests/${id}/issues`),
  finalize: (id) => request(`/manifests/${id}/finalize`, { method: 'POST' }),
  preview: (id, calibrationVersionId) => {
    const suffix = calibrationVersionId ? `?calibration_version_id=${encodeURIComponent(calibrationVersionId)}` : ''
    return request(`/manifests/${id}/preview${suffix}`)
  },
  calibrations: (channelSetHash) =>
    request(`/calibrations${channelSetHash ? `?channel_set_hash=${encodeURIComponent(channelSetHash)}` : ''}`),
  tasks: (manifestId) => request(`/analysis-tasks?manifest_id=${encodeURIComponent(manifestId)}`),
  createTask: (manifestId, calibrationVersionId) =>
    request('/analysis-tasks', {
      method: 'POST',
      body: JSON.stringify({ manifest_id: manifestId, calibration_version_id: calibrationVersionId })
    }),
  runTask: (id) => request(`/analysis-tasks/${id}/run`, { method: 'POST' }),
  cancelTask: (id) => request(`/analysis-tasks/${id}/cancel`, { method: 'POST' }),
  retryTask: (id) => request(`/analysis-tasks/${id}/retry`, { method: 'POST' }),
  reports: (manifestId) => request(`/reports?manifest_id=${encodeURIComponent(manifestId)}`),
  report: (id) => request(`/reports/${id}`)
}
