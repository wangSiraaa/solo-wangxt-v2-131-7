<template>
  <section class="upload-panel">
    <h3>断点续传</h3>

    <p v-if="!storage" class="issue warning">
      浏览器本地存储不可用，本次会话可以上传，但刷新后无法恢复续传记录。
    </p>

    <!-- 本地记录与服务端清单对账失败：宁可阻断，也不能把字节送进错误的不可变清单 -->
    <div v-if="reconcileProblems.length" class="issue error">
      <strong>本地记录与服务端清单不一致，已阻止继续：</strong>
      {{ reconcileProblems.join('；') }}
      <div style="margin-top:6px">
        <button class="danger" @click="clearRecord">清除本地记录</button>
      </div>
    </div>

    <template v-else>
      <div v-if="record" class="resume-card">
        <div>
          本地记录：<strong>{{ record.file.name }}</strong>
          （{{ formatBytes(record.file.size) }}，{{ record.chunks.length }} 块）
          <span class="meta">更新于 {{ record.updatedAt }}</span>
        </div>
        <div v-if="manifest.status === 'open'" style="margin-top:8px">
          <template v-if="identityState !== 'ok'">
            <label class="file-pick">
              重新选择原文件以继续：
              <input type="file" @change="onFilePicked" />
            </label>
            <span v-if="identityState === 'verifying'" class="meta">正在核对文件身份…</span>
          </template>
          <span v-else class="ok-text">✓ 文件身份核对通过：{{ fileHandle?.name }}</span>
          <div v-if="identityState === 'rejected'" class="issue error" style="margin-top:6px">
            <strong>已拒绝继续：</strong>所选文件与本地上传记录不符（{{ identityProblemText }}）。
            同名不同内容的文件不能顶替原文件，请重新选择。
          </div>
        </div>
      </div>

      <div v-else-if="manifest.status === 'open'" class="resume-card">
        <div class="meta">
          本浏览器没有该清单的续传记录。若文件在本机，可按清单逐块核对摘要后认领续传；
          或在左侧「新建上传」中重新建立清单。
        </div>
        <div style="margin-top:8px">
          <label class="file-pick">
            按清单认领本地文件：
            <input type="file" @change="onAdoptPicked" :disabled="adoptState === 'hashing'" />
          </label>
          <span v-if="adoptState === 'hashing'" class="meta">
            正在核对块 {{ adoptProgress.sequence + 1 }}/{{ adoptProgress.count }}
            （{{ formatBytes(adoptProgress.bytes) }}/{{ formatBytes(adoptProgress.totalBytes) }}）
            <button class="secondary" @click="adoptCancel = true">取消</button>
          </span>
        </div>
        <div v-if="adoptError" class="issue error" style="margin-top:6px">
          <strong>认领失败：</strong>{{ adoptError }}
        </div>
      </div>

      <!-- 汇总进度 -->
      <div class="upload-summary">
        <div class="progress"><div class="progress-fill" :style="{ width: `${overallPercent}%` }"></div></div>
        <span class="meta">
          服务端已确认 {{ plan.confirmed }}/{{ plan.actions.length }} 块
          · {{ formatBytes(confirmedBytes) }}/{{ formatBytes(totalBytes) }}
          <template v-if="plan.pending">· 待补 {{ plan.pending }} 块</template>
          <template v-if="plan.failed">· <span class="err-text">{{ plan.failed }} 块摘要不符</span></template>
        </span>
      </div>

      <div v-if="plan.unexpected.length" class="issue warning">
        服务端存在清单之外的块：序号 {{ plan.unexpected.join(', ') }}，完成核对时会被拒绝。
      </div>

      <!-- 逐块状态：只列需要关注的块（待补/上传中/失败/刚传完待确认） -->
      <table v-if="rows.length" class="chunk-table">
        <thead>
          <tr><th>块</th><th>字节区间</th><th>状态</th><th>进度 / 错误</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.sequence">
            <td>#{{ row.sequence }}</td>
            <td class="meta">{{ row.expected.byte_offset }} … {{ row.expected.byte_offset + row.expected.byte_length - 1 }}</td>
            <td><span class="badge" :class="row.badge">{{ row.status }}</span></td>
            <td>
              <div v-if="row.progress !== null" class="progress small">
                <div class="progress-fill" :style="{ width: `${Math.round(row.progress * 100)}%` }"></div>
              </div>
              <span v-if="row.progress !== null" class="meta">{{ Math.round(row.progress * 100) }}%</span>
              <span v-if="row.error" class="err-text">{{ row.error }}</span>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="meta">全部 {{ plan.actions.length }} 块均已被服务端确认。</p>

      <div class="upload-actions">
        <template v-if="manifest.status === 'open'">
          <button
            v-if="plan.pending > 0"
            @click="startUpload"
            :disabled="!canUpload"
            :title="identityState === 'ok' ? '' : '需先重新选择原文件并通过身份核对'"
          >补传缺失的 {{ plan.pending }} 块</button>
          <button v-if="uploading" class="secondary" @click="pauseUpload">暂停</button>
          <button @click="finalize" :disabled="!canFinalize" :title="finalizeHint">核对并完成清单</button>
        </template>
        <span v-if="manifest.status === 'completed'" class="ok-text">✓ 清单已完成</span>
        <span v-else-if="finalizeState === 'done'" class="ok-text">✓ 清单已完成</span>
        <span v-else-if="finalizeState === 'already'" class="ok-text">✓ 清单此前已完成，本次未重复发布</span>
        <span v-else-if="finalizeState === 'busy'" class="meta">正在完成核对…</span>
        <button v-if="record" class="secondary" @click="clearRecord">清除本地记录</button>
      </div>

      <div v-if="finalizeIssues.length" style="margin-top:8px">
        <div v-for="(issue, index) in finalizeIssues" :key="index" class="issue" :class="issue.severity">
          <strong>[{{ issue.severity }}] {{ issue.code }}</strong> — {{ issue.message }}
        </div>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { api } from '../api.js'
import { computeFileFingerprint, hashChunk } from '../upload/fileHash.js'
import {
  createRecord,
  loadRecord,
  planChunkActions,
  reconcileRecord,
  removeRecord,
  saveRecord,
  verifyFileIdentity,
} from '../upload/resume.js'
import { safeStorage } from '../upload/storage.js'

const props = defineProps({
  manifest: { type: Object, required: true },
  chunks: { type: Array, default: () => [] },
  // 同一会话内「新建上传」移交过来的文件句柄；刷新后失效，需重新选择。
  initialFile: { type: File, default: null },
})
const emit = defineEmits(['changed'])

const storage = safeStorage()

const record = ref(null)
const fileHandle = ref(null)
const identityState = ref('idle') // idle | verifying | ok | rejected
const identityProblems = ref([])
const chunkUi = reactive({}) // sequence -> { status, progress, error }，仅本次会话的瞬时状态
const uploading = ref(false)
const finalizeState = ref(null) // null | busy | done | already | failed
const finalizeIssues = ref([])
const adoptState = ref('idle') // idle | hashing | rejected
const adoptProgress = ref({ sequence: 0, count: 0, bytes: 0, totalBytes: 0 })
const adoptError = ref('')
const adoptCancel = ref(false)
let abortController = null
let verifySeq = 0

const MISMATCH_LABELS = {
  name: '文件名',
  size: '文件大小',
  lastModified: '修改时间',
  fingerprint: '内容指纹',
  no_saved_identity: '无本地身份记录',
}

const plan = computed(() => planChunkActions(props.manifest.expected_chunks, props.chunks))
const totalBytes = computed(() =>
  (props.manifest.expected_chunks || []).reduce((sum, chunk) => sum + chunk.byte_length, 0))
const confirmedBytes = computed(() =>
  plan.value.actions
    .filter((item) => item.action === 'done')
    .reduce((sum, item) => sum + item.expected.byte_length, 0))
const overallPercent = computed(() =>
  totalBytes.value ? Math.round((confirmedBytes.value / totalBytes.value) * 100) : 0)
const reconcileProblems = computed(() =>
  record.value ? reconcileRecord(record.value, props.manifest).problems : [])
const identityProblemText = computed(() =>
  identityProblems.value.map((key) => MISMATCH_LABELS[key] || key).join('、'))

const canUpload = computed(() =>
  Boolean(record.value)
  && identityState.value === 'ok'
  && plan.value.pending > 0
  && props.manifest.status === 'open'
  && !uploading.value)
// 全部块都被服务端确认后才允许完成清单；后端 finalize 仍会独立复核一次。
const canFinalize = computed(() =>
  plan.value.complete
  && props.manifest.status === 'open'
  && !['busy', 'done', 'already'].includes(finalizeState.value || ''))
const finalizeHint = computed(() => {
  if (props.manifest.status !== 'open') return ''
  if (!plan.value.complete) return `还有 ${plan.value.pending + plan.value.failed} 块未被服务端确认`
  return ''
})

const rows = computed(() =>
  plan.value.actions
    .filter((item) => item.action !== 'done' || chunkUi[item.sequence])
    .map((item) => {
      const ui = chunkUi[item.sequence]
      const row = { sequence: item.sequence, expected: item.expected, status: '待补传', badge: 'open', progress: null, error: null }
      if (item.action === 'done') {
        row.status = '已确认'
        row.badge = 'completed'
      } else if (item.action === 'error') {
        row.status = '服务端摘要不符'
        row.badge = 'error'
        row.error = `服务端 ${item.server?.sha256?.slice(0, 12)}… ≠ 清单 ${item.expected.sha256.slice(0, 12)}…`
      } else if (ui?.status === 'uploading') {
        row.status = '上传中'
        row.badge = 'running'
        row.progress = ui.progress
      } else if (ui?.status === 'error') {
        row.status = '失败'
        row.badge = 'error'
        row.error = ui.error
      } else if (ui?.status === 'done') {
        row.status = '已上传，待确认'
        row.badge = 'queued'
      }
      return row
    }))

function persist(next) {
  record.value = next
  if (storage) {
    try { saveRecord(storage, next) } catch { /* 存储不可用时仅本次会话有效 */ }
  }
}

function resetSession() {
  if (abortController) abortController.abort()
  abortController = null
  verifySeq += 1 // 使进行中的身份核对失效
  uploading.value = false
  fileHandle.value = null
  identityState.value = 'idle'
  identityProblems.value = []
  finalizeState.value = null
  finalizeIssues.value = []
  adoptState.value = 'idle'
  adoptError.value = ''
  adoptCancel.value = false
  for (const key of Object.keys(chunkUi)) delete chunkUi[key]
}

function refreshRecord() {
  record.value = storage ? loadRecord(storage, props.manifest.id) : null
}

watch(() => props.manifest.id, () => {
  resetSession()
  refreshRecord()
  // 新建上传后清单 id 才切换到这里；initialFile 可能已就位，直接核对身份
  if (props.initialFile && record.value && record.value.manifestId === props.manifest.id) {
    verifyFile(props.initialFile)
  }
}, { immediate: true })

// 新建上传完成后，同一会话的文件句柄直接移交过来，免去立刻重选一次。
watch(() => props.initialFile, async (file) => {
  if (!file || !record.value || record.value.manifestId !== props.manifest.id) return
  if (identityState.value === 'ok') return
  await verifyFile(file)
})

async function verifyFile(file) {
  const seq = ++verifySeq // 连续选择文件时，只有最后一次核对生效
  identityState.value = 'verifying'
  identityProblems.value = []
  try {
    const fingerprint = await computeFileFingerprint(file)
    if (seq !== verifySeq) return
    const meta = { name: file.name, size: file.size, lastModified: file.lastModified, fingerprint }
    const result = verifyFileIdentity(meta, record.value.file)
    if (!result.ok) {
      identityState.value = 'rejected'
      identityProblems.value = result.mismatches
      fileHandle.value = null
      return
    }
    fileHandle.value = file
    identityState.value = 'ok'
  } catch {
    if (seq !== verifySeq) return
    identityState.value = 'rejected'
    identityProblems.value = ['fingerprint_failed']
  }
}

async function onFilePicked(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) await verifyFile(file)
}

// 无本地记录时的认领：文件大小与逐块摘要全部匹配清单，才建立续传记录。
async function onAdoptPicked(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  adoptState.value = 'hashing'
  adoptError.value = ''
  adoptCancel.value = false
  try {
    const expected = props.manifest.expected_chunks
    const total = expected.reduce((sum, chunk) => sum + chunk.byte_length, 0)
    if (file.size !== total) {
      throw new Error(`文件大小 ${file.size} 与清单总字节 ${total} 不符`)
    }
    let doneBytes = 0
    for (const chunk of expected) {
      if (adoptCancel.value) throw new Error('已取消')
      adoptProgress.value = { sequence: chunk.sequence, count: expected.length, bytes: doneBytes, totalBytes: total }
      const digest = await hashChunk(file, chunk.byte_offset, chunk.byte_length, (done) => {
        adoptProgress.value = { sequence: chunk.sequence, count: expected.length, bytes: doneBytes + done, totalBytes: total }
      })
      if (digest !== chunk.sha256) {
        throw new Error(`块 ${chunk.sequence} 摘要不符：该文件不是此清单的原始录波`)
      }
      doneBytes += chunk.byte_length
    }
    const fingerprint = await computeFileFingerprint(file)
    const next = createRecord({
      manifestId: props.manifest.id,
      manifestDigest: props.manifest.manifest_digest,
      name: props.manifest.name,
      file: { name: file.name, size: file.size, lastModified: file.lastModified, fingerprint },
      chunks: expected,
    })
    for (const server of props.chunks) next.uploaded[server.sequence] = server.sha256
    persist(next)
    fileHandle.value = file
    identityState.value = 'ok'
    adoptState.value = 'idle'
  } catch (error) {
    adoptState.value = 'rejected'
    adoptError.value = error?.message || String(error)
  }
}

async function startUpload() {
  if (!canUpload.value || !fileHandle.value) return
  // 重试前清掉上一轮的失败标记
  for (const key of Object.keys(chunkUi)) {
    if (chunkUi[key].status === 'error') delete chunkUi[key]
  }
  uploading.value = true
  abortController = new AbortController()
  try {
    for (;;) {
      // 每轮重新评估：父组件轮询可能已确认更多块，只补仍然缺失的
      const next = plan.value.actions.find((item) =>
        item.action === 'upload' && chunkUi[item.sequence]?.status !== 'done')
      if (!next) break
      const sequence = next.sequence
      chunkUi[sequence] = { status: 'uploading', progress: 0, error: null }
      const blob = fileHandle.value.slice(
        next.expected.byte_offset,
        next.expected.byte_offset + next.expected.byte_length)
      try {
        await api.uploadChunk(props.manifest.id, sequence, blob, {
          signal: abortController.signal,
          onProgress: (loaded, total) => {
            chunkUi[sequence] = { status: 'uploading', progress: total ? loaded / total : 0, error: null }
          },
        })
        chunkUi[sequence] = { status: 'done', progress: 1, error: null }
        if (record.value) {
          record.value.uploaded[sequence] = next.expected.sha256
          persist(record.value)
        }
        emit('changed')
      } catch (error) {
        if (error?.name === 'AbortError') {
          delete chunkUi[sequence]
          break
        }
        chunkUi[sequence] = { status: 'error', progress: 0, error: friendlyError(error) }
        break
      }
    }
  } finally {
    uploading.value = false
    abortController = null
  }
}

function pauseUpload() {
  abortController?.abort()
}

async function finalize() {
  if (!canFinalize.value) return
  finalizeState.value = 'busy'
  finalizeIssues.value = []
  try {
    const result = await api.finalize(props.manifest.id)
    if (result.already_completed) {
      // 重复点击/并发完成：服务端保证最多发布一次，界面如实展示
      finalizeState.value = 'already'
    } else if (result.completed) {
      finalizeState.value = 'done'
      if (record.value) {
        record.value.state = 'completed'
        persist(record.value)
      }
    }
    emit('changed')
  } catch (error) {
    finalizeState.value = 'failed'
    finalizeIssues.value = parseIssues(error)
  }
}

function clearRecord() {
  if (storage) removeRecord(storage, props.manifest.id)
  resetSession()
  record.value = null
}

function parseIssues(error) {
  try {
    const body = JSON.parse(error.message)
    const issues = body?.detail?.issues
    return Array.isArray(issues) ? issues : []
  } catch {
    return []
  }
}

function friendlyError(error) {
  try {
    const body = JSON.parse(error.message)
    if (body?.detail?.message) return body.detail.message
    if (body?.detail?.code) return body.detail.code
    if (typeof body?.detail === 'string') return body.detail
  } catch { /* 非 JSON 错误 */ }
  return error?.message || String(error)
}

function formatBytes(value) {
  if (value == null) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size.toFixed(size >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`
}
</script>
