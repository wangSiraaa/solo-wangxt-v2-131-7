<template>
  <details class="new-upload">
    <summary>＋ 新建上传（选文件 → 算摘要 → 建清单）</summary>
    <div class="new-upload-body">
      <label>
        录波文件（float32le 交织）
        <input type="file" @change="onFilePicked" :disabled="busy" />
      </label>
      <template v-if="file">
        <div class="meta">{{ file.name }} · {{ formatBytes(file.size) }}</div>
        <label>
          清单名称
          <input v-model.trim="form.name" :disabled="busy" />
        </label>
        <label>
          采样率 (Hz)
          <input v-model.number="form.sampleRate" type="number" min="1" step="any" :disabled="busy" />
        </label>
        <label>
          通道（逗号分隔，顺序须与文件交织顺序一致）
          <input v-model.trim="form.channelsText" :disabled="busy" />
        </label>
        <label>
          每块采样数
          <input v-model.number="form.chunkSamples" type="number" min="1" step="1" :disabled="busy" />
        </label>
        <label>
          起始时间（墙钟，naive）
          <input v-model="form.startTime" type="datetime-local" step="1" :disabled="busy" />
        </label>
        <div v-if="phase === 'hashing'" class="meta">
          正在计算块摘要 {{ progress.sequence + 1 }}/{{ progress.count }}
          （{{ formatBytes(progress.bytes) }}/{{ formatBytes(progress.totalBytes) }}）
          <button class="secondary" @click="cancelRequested = true">取消</button>
        </div>
        <div v-if="phase === 'creating'" class="meta">正在创建清单…</div>
        <div class="new-upload-actions">
          <button @click="submit" :disabled="busy || !file">计算摘要并创建清单</button>
        </div>
      </template>
      <div v-if="error" class="issue error">{{ error }}</div>
    </div>
  </details>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { api } from '../api.js'
import { computeFileFingerprint, hashChunk } from '../upload/fileHash.js'
import { buildChunkPlan, buildManifestPayload, createRecord, saveRecord } from '../upload/resume.js'
import { safeStorage } from '../upload/storage.js'

const emit = defineEmits(['created'])

const storage = safeStorage()
const file = ref(null)
const phase = ref('idle') // idle | hashing | creating
const progress = ref({ sequence: 0, count: 0, bytes: 0, totalBytes: 0 })
const error = ref('')
const cancelRequested = ref(false)

const nowLocalInput = () => {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

const form = reactive({
  name: '',
  sampleRate: 6000,
  channelsText: 'Va,Vb,Vc',
  chunkSamples: 1000000,
  startTime: nowLocalInput(),
})

const busy = computed(() => phase.value !== 'idle')

function onFilePicked(event) {
  const picked = event.target.files?.[0]
  if (!picked) return
  file.value = picked
  error.value = ''
  if (!form.name) form.name = picked.name.replace(/\.[^.]+$/, '') || picked.name
}

async function submit() {
  error.value = ''
  cancelRequested.value = false
  const channels = form.channelsText.split(',').map((item) => item.trim()).filter(Boolean)
  try {
    const chunkPlan = buildChunkPlan({
      fileSize: file.value.size,
      sampleRate: form.sampleRate,
      channels,
      startTimeIso: form.startTime,
      chunkSamples: form.chunkSamples,
    })
    phase.value = 'hashing'
    const digests = []
    let doneBytes = 0
    for (const chunk of chunkPlan) {
      if (cancelRequested.value) throw new Error('已取消')
      progress.value = { sequence: chunk.sequence, count: chunkPlan.length, bytes: doneBytes, totalBytes: file.value.size }
      const digest = await hashChunk(file.value, chunk.byteOffset, chunk.byteLength, (done) => {
        progress.value = { sequence: chunk.sequence, count: chunkPlan.length, bytes: doneBytes + done, totalBytes: file.value.size }
      })
      digests.push(digest)
      doneBytes += chunk.byteLength
    }
    phase.value = 'creating'
    const payload = buildManifestPayload({
      name: form.name,
      nominalSampleRate: form.sampleRate,
      chunkPlan,
      digests,
    })
    const manifest = await api.createManifest(payload)
    // 清单落库后立即写本地续传记录：文件身份 ↔ 清单 ↔ 块序号摘要
    const fingerprint = await computeFileFingerprint(file.value)
    const record = createRecord({
      manifestId: manifest.id,
      manifestDigest: manifest.manifest_digest,
      name: manifest.name,
      file: {
        name: file.value.name,
        size: file.value.size,
        lastModified: file.value.lastModified,
        fingerprint,
      },
      chunks: payload.expected_chunks,
    })
    if (storage) {
      try { saveRecord(storage, record) } catch { /* 仅本次会话有效 */ }
    }
    phase.value = 'idle'
    emit('created', { manifestId: manifest.id, file: file.value })
  } catch (cause) {
    phase.value = 'idle'
    error.value = friendlyError(cause)
  }
}

function friendlyError(cause) {
  try {
    const body = JSON.parse(cause.message)
    const issues = body?.detail?.issues
    if (Array.isArray(issues) && issues.length) {
      return issues.map((issue) => `${issue.code}: ${issue.message || JSON.stringify(issue)}`).join('；')
    }
    if (typeof body?.detail === 'string') return body.detail
  } catch { /* 非 JSON 错误 */ }
  return cause?.message || String(cause)
}

function formatBytes(value) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size.toFixed(size >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}
</script>
