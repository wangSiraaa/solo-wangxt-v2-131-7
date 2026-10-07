// localStorage 在隐私模式/禁用 Cookie 时可能抛异常，探测一次后安全降级。
export function safeStorage() {
  try {
    const probe = '__pq_probe__'
    window.localStorage.setItem(probe, '1')
    window.localStorage.removeItem(probe)
    return window.localStorage
  } catch {
    return null
  }
}
