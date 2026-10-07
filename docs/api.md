# 主要 HTTP 接口

所有时间使用 ISO 8601。原始块编码为 `float32le-interleaved`。

## 清单与上传

### `POST /manifests`

创建不可变分块清单，请求示例：

```json
{
  "name": "line-20261001",
  "nominal_sample_rate": 6000,
  "expected_chunks": [
    {
      "sequence": 0,
      "sha256": "...64 hex...",
      "byte_offset": 0,
      "byte_length": 3600,
      "sample_count": 300,
      "sample_rate": 6000,
      "channels": ["Va", "Vb", "Vc"],
      "start_time": "2026-10-01T00:00:00",
      "end_time": "2026-10-01T00:00:00.049833333",
      "encoding": "float32le-interleaved"
    }
  ]
}
```

创建失败返回 422，`detail.issues` 中列出重叠、空洞、序号、时间或通道集合错误。

### `PUT /manifests/{manifest_id}/chunks/{sequence}/raw`

`multipart/form-data` 字段名：`chunk_file`。可乱序、重传。重复摘要返回已有块；摘要/长度错误返回 422。

### `GET /manifests/{id}/chunks`

返回服务端已收到的块（含 sha256）。断点续传以它为权威来源：浏览器重进页面后先调它，只补缺失或摘要不符的块。

### 浏览器断点续传（`frontend/src/upload/`）

- 选择文件后把“文件 ↔ 清单块序号”关联摘要存入 `localStorage`（key：`pq.upload.session.v1.{manifestId}`），含每块期望/实算 SHA-256、状态、字节进度、尝试次数与错误。
- 浏览器不保留文件句柄：重进页面后必须重新选择文件，并先过两层身份核对：
  1. 文件名与总大小（`max(byte_offset+byte_length)`）一致；
  2. 按 `byte_offset/byte_length` 逐块切片、用 `crypto.subtle` 实算 SHA-256 与清单比对。
     任一块不符即判定为同名不同内容文件，文件级拒绝继续，不发出任何 PUT。
- 续传流程：`GET /chunks` 核对 → 逐块本地摘要核对 → 只对缺失块 `PUT raw`（顺序提交，服务端支持乱序）→ 再次 `GET /chunks` 权威复核。全部块 `present/done` 后完成按钮才可用；点击完成时还会强制再复核一次。
- 逐块状态（未核对 / 本地已核对 / 服务端已到 / 上传中 / 错误）、字节级进度、尝试次数、错误 code 与摘要差异直接展示，可对单块重试补传。
- 完成闸门：进行中的并发点击只发一个 finalize 请求；成功或服务端返回 `already_completed` 后本地落标记（`pq.upload.finalized.v1.{manifestId}`），之后再次点击不重复发布清单。

### `POST /manifests/{manifest_id}/finalize`

执行最终核对。成功：

```json
{"completed": true, "already_completed": false, "warnings": []}
```

失败返回 422，issues 不做静默合并。并发时只有一个请求能完成首次转换。

### `GET /manifests/{id}/preview?calibration_version_id=...`

返回分段、采样率、降采样波形和缺口/质量 issue，供 Vue/ECharts 展示。后端使用磁盘 memmap 和降采样，避免把数 GB 原始波形全部放入响应内存。

## 标定

### `POST /calibrations`

```json
{
  "channel_set_hash": "manifest.channel_set_hash",
  "change_note": "CT 二次接线复核后修订",
  "coefficients": {
    "Va": {"gain": 1, "offset": 0, "phase_shift_rad": 0, "saturation_low": -450, "saturation_high": 450}
  }
}
```

新 active 版本会让使用旧 active 版本发布的报告进入 `needs_review`。

## 任务与报告

### `POST /analysis-tasks`

```json
{
  "manifest_id": "...",
  "calibration_version_id": "...",
  "params": {"fundamental_hz": 50, "cycles_per_window": 6, "max_harmonic": 15},
  "idempotency_key": "lab-job-123"
}
```

创建时冻结清单、标定和参数。若使用 Celery，提交后自动发送 `run_analysis`；本地测试可调用 `/run`。

### 执行、重试、取消

- `POST /analysis-tasks/{id}/run`
- `POST /analysis-tasks/{id}/retry`
- `POST /analysis-tasks/{id}/cancel`
- `POST /maintenance/recover-stale-tasks`

### `GET /reports/{id}`

报告状态：

- `published`：正常发布；
- `needs_review`：标定后来更新，需要复核；
- `diagnostic_failed`：分析有 error 阶段，保留诊断但不是完成报告。
