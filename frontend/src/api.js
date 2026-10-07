const BASE = ''

async function request(path, options = {}) {
  const response = await fetch(BASE + path, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) throw new Error(JSON.stringify(data ?? response.statusText))
  return data
}

export const api = {
  health: () => request('/health'),
  manifests: () => request('/manifests'),
  manifest: (id) => request(`/manifests/${id}`),
  createManifest: (payload) => request('/manifests', { method: 'POST', body: JSON.stringify(payload) }),
  chunks: (id) => request(`/manifests/${id}/chunks`),
  issues: (id) => request(`/manifests/${id}/issues`),
  finalize: (id) => request(`/manifests/${id}/finalize`, { method: 'POST' }),
  // 分块 PUT 走 XMLHttpRequest：fetch 拿不到上传进度，也无法在未读流时中止。
  // blob 用 file.slice 惰性读取，数 GB 文件不会进内存。
  uploadChunk: (manifestId, sequence, blob, { onProgress, signal } = {}) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `${BASE}/manifests/${manifestId}/chunks/${sequence}/raw`)
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total)
      }
      xhr.onload = () => {
        let data = null
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null } catch { data = null }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data)
        else reject(new Error(JSON.stringify(data ?? xhr.statusText)))
      }
      xhr.onerror = () => reject(new Error('network error'))
      xhr.onabort = () => reject(new DOMException('upload aborted', 'AbortError'))
      if (signal) {
        if (signal.aborted) { xhr.abort(); return }
        signal.addEventListener('abort', () => xhr.abort(), { once: true })
      }
      const form = new FormData()
      form.append('chunk_file', blob, `chunk-${sequence}.bin`)
      xhr.send(form)
    }),
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
