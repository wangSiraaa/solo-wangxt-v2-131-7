<template>
  <section class="upload-panel">
    <h3>断点续传上传</h3>

    <div v-if="manifest.status === 'completed'" class="upload-banner ok">
      清单已在服务端完成，原始块不可变；不能再上传或重复完成。
    </div>

    <template v-else>
      <div class="upload-row">
        <label class="file-picker">
          <input ref="fileInput" type="file" @change="onFilePicked" />
          <span>{{ boundFile ? `已绑定：${boundFile.name}` : '选择本地录波文件…' }}</span>
        </label>
        <div class="upload-actions">
          <button @click="start" :disabled="!boundFile || running || manifest.status !== 'open'">
            核对并续传
          </button>
          <button class="secondary" @click="abort" :disabled="!running">中断</button>
          <button class="secondary" @click="reconcileFromServer" :disabled="running">仅刷新服务端状态</button>
          <button
            @click="finalize"
            :disabled="finalizeDisabled"
            :title="finalizeHint"
          >核对并完成清单</button>
          <button class="danger" @click="forget" :disabled="running">清除本地进度</button>
        </div>
      </div>

      <p class="meta" v-if="!boundFile && session">
        本地保存了 <strong>{{ session.file_name }}</strong>
        （{{ formatBytes(session.file_size) }}）的块序号关联摘要，但浏览器不保留文件句柄。
        重新选择<strong>同一份</strong>文件后，先做身份核对（文件名/大小 + 逐块 SHA-256）再补传。
      </p>
      <p class="meta" v-else-if="!boundFile">
        尚未建立上传会话。选择文件后将按清单逐块切片、计算摘要并保存关联到本机浏览器。
      </p>

      <div v-if="globalError" class="upload-banner error">
        <strong>[{{ globalError.code }}]</strong> {{ globalError.message }}
      </div>
      <div v-if="statusLine" class="upload-banner" :class="ready ? 'ok' : 'info'">{{ statusLine }}</div>

      <div class="overall">
        <div class="overall-bar">
          <div class="overall-fill" :style="{ width: overallPercent + '%' }"></div>
        </div>
        <span class="meta">
          服务端已到 {{ present }} / {{ total }} 块 · 整体 {{ overallPercent }}%
          <template v-if="verifying"> · 正在核对块 {{ verifySequence }} 摘要（{{ verifyDone }}/{{ verifyTotal }}）</template>
        </span>
      </div>

      <div class="chunk-scroll">
        <table class="chunk-table">
          <thead>
            <tr><th>序号</th><th>状态</th><th>本地摘要</th><th>进度</th><th>尝试</th><th>错误</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="plan in plans" :key="plan.sequence" :class="['st-' + plan.state]">
              <td>{{ plan.sequence }}</td>
              <td><span class="chunk-state" :class="plan.state">{{ stateLabel(plan.state) }}</span></td>
              <td :title="plan.local_sha256 || ''">
                {{ plan.local_sha256 ? short(plan.local_sha256) : '—' }}
              </td>
              <td>
                {{ formatBytes(plan.loaded) }} / {{ formatBytes(plan.byte_length) }}
                <span v-if="plan.state === 'uploading'">（{{ chunkPercent(plan) }}%）</span>
              </td>
              <td>{{ plan.attempts }}</td>
              <td class="cell-error">
                <template v-if="plan.error">
                  <strong>[{{ plan.error.code }}]</strong>
                  <span v-if="plan.error.actual"> 期望 {{ short(plan.error.expected) }} 实得 {{ short(plan.error.actual) }}</span>
                </template>
                <span v-else>—</span>
              </td>
              <td>
                <button
                  v-if="plan.state === 'error'"
                  class="secondary tiny"
                  @click="retryOne(plan.sequence)"
                  :disabled="running"
                >补传该块</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '../api'
import {
  checkFileMetadata,
  clearSession,
  createFinalizer,
  createSession,
  loadSession,
  presentCount,
  readyToFinalize,
  reconcileServer,
  saveSession,
  sha256Hex,
  sortedSequences,
  uploadMissing,
  verifyChunkDigests,
  isFinalizedLocally
} from './resumable'

const props = defineProps({
  manifest: { type: Object, required: true }
})
const emit = defineEmits(['finalized'])

const fileInput = ref(null)
const boundFile = ref(null)
const session = ref(null)
const serverChunks = ref([])
const running = ref(false)
const verifying = ref(false)
const verifySequence = ref(null)
const verifyDone = ref(0)
const verifyTotal = ref(0)
const globalError = ref(null)
const statusLine = ref('')
let controller = null
let saveTimer = null

const finalizer = createFinalizer((id) => api.finalize(id))
const finalizedLocal = ref(false)

const plans = computed(() => (session.value ? sortedSequences(session.value).map((s) => session.value.chunks[s]) : []))
const total = computed(() => (session.value ? session.value.chunk_count : props.manifest.expected_chunks.length))
const present = computed(() => (session.value ? presentCount(session.value) : serverPresent()))
const ready = computed(() => Boolean(session.value) && readyToFinalize(session.value))
const overallPercent = computed(() => (total.value ? Math.round((present.value / total.value) * 100) : 0))
const finalizeDisabled = computed(() =>
  props.manifest.status !== 'open' ||
  running.value ||
  finalizedLocal.value ||
  !session.value ||
  !ready.value
)
const finalizeHint = computed(() => {
  if (finalizedLocal.value) return '本浏览器已完成该清单，重复点击不会再次发布'
  if (!ready.value) return '全部块与服务端核对通过后才允许完成'
  return ''
})

function serverPresent() {
  const declared = new Set(props.manifest.expected_chunks.map((c) => c.sequence))
  return serverChunks.value.filter((c) => declared.has(c.sequence)).length
}
function short(value) { return value ? `${String(value).slice(0, 8)}…` : '—' }
function stateLabel(state) {
  return {
    unknown: '未核对',
    verified: '本地已核对',
    present: '服务端已到',
    uploading: '上传中',
    done: '已传待核对',
    error: '错误'
  }[state] || state
}
function formatBytes(value) {
  if (!Number.isFinite(value)) return '—'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = value / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}
function chunkPercent(plan) {
  return plan.byte_length ? Math.min(100, Math.round((plan.loaded / plan.byte_length) * 100)) : 0
}

function persistSoon() {
  if (!session.value) return
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (session.value) saveSession(session.value)
  }, 400)
}
function persistNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (session.value) saveSession(session.value)
}

function resetState() {
  boundFile.value = null
  session.value = null
  serverChunks.value = []
  globalError.value = null
  statusLine.value = ''
  verifying.value = false
  if (fileInput.value) fileInput.value.value = ''
  const stored = loadSession(props.manifest.id)
  // 清单按 id 不可变；若保存的 digest 与当前清单不符，说明对错了清单，丢弃摘要。
  if (stored && (!stored.manifest_digest || stored.manifest_digest === props.manifest.manifest_digest)) {
    session.value = stored
  } else if (stored) {
    clearSession(props.manifest.id)
  }
  finalizedLocal.value = props.manifest.status === 'completed' || isFinalizedLocally(props.manifest.id)
}

async function reconcileFromServer() {
  const remote = await api.chunks(props.manifest.id)
  serverChunks.value = remote || []
  if (session.value) {
    reconcileServer(session.value, serverChunks.value)
    persistNow()
    statusLine.value = readyToFinalize(session.value)
      ? `服务端核对通过：${presentCount(session.value)}/${session.value.chunk_count} 块齐备，可以完成清单。`
      : '已按服务端状态刷新：只补缺失或摘要不符的块。'
  }
}

function onFilePicked(event) {
  const file = event.target.files?.[0]
  if (!file) return
  globalError.value = null
  try {
    if (session.value) {
      // 重进页面后重新选择文件：必须通过身份核对，不能用新文件覆盖旧摘要继续。
      checkFileMetadata(session.value, file)
      boundFile.value = file
      statusLine.value = '文件元数据身份一致，点击“核对并续传”将逐块核对 SHA-256。'
    } else {
      session.value = createSession(props.manifest, file)
      boundFile.value = file
      persistNow()
      statusLine.value = '已建立文件与块序号的本地关联摘要。'
    }
  } catch (error) {
    boundFile.value = null
    fileInput.value.value = ''
    globalError.value = { code: error.code || 'file_identity_failed', message: error.message }
  }
}

async function verifyAllMissing() {
  const need = sortedSequences(session.value).filter((s) => {
    const plan = session.value.chunks[s]
    return plan.state !== 'present' && plan.state !== 'done'
  })
  const unverified = need.filter((s) => !session.value.chunks[s].local_sha256)
  if (!unverified.length) return
  verifying.value = true
  verifyTotal.value = unverified.length
  verifyDone.value = 0
  try {
    await verifyChunkDigests({
      session: session.value,
      file: boundFile.value,
      sequences: unverified,
      hasher: sha256Hex,
      signal: controller?.signal,
      onProgress: ({ sequence, done }) => {
        verifySequence.value = sequence
        verifyDone.value = done
        persistSoon()
      }
    })
    persistNow()
  } finally {
    verifying.value = false
  }
}

async function start() {
  if (!boundFile.value || !session.value || running.value) return
  globalError.value = null
  controller = new AbortController()
  running.value = true
  let aborted = false
  try {
    await reconcileFromServer()
    if (!readyToFinalize(session.value)) {
      await verifyAllMissing()
      if (controller.signal.aborted) { aborted = true; return }
      const todo = sortedSequences(session.value).filter((s) => {
        const plan = session.value.chunks[s]
        return plan.state !== 'present' && plan.state !== 'done'
      })
      if (todo.length) {
        statusLine.value = `身份核对通过，开始补传 ${todo.length} 块（顺序提交，服务端支持乱序）。`
        const failed = await uploadMissing({
          manifestId: props.manifest.id,
          file: boundFile.value,
          session: session.value,
          sequences: todo,
          putChunk: api.putChunk,
          hasher: sha256Hex,
          signal: controller.signal,
          onState: persistSoon
        })
        aborted = controller.signal.aborted
        persistNow()
        if (failed.length) {
          globalError.value = {
            code: 'partial_upload_failed',
            message: `${failed.length} 块上传失败，已保留进度；修正网络后再次“核对并续传”，只补这些块。`
          }
        }
      }
      // 再以服务端 GET /chunks 为权威做最终核对。
      if (!aborted) await reconcileFromServer()
    }
    statusLine.value = readyToFinalize(session.value)
      ? `全部 ${presentCount(session.value)} 块核对通过，允许完成清单。`
      : '仍有缺块或摘要不符的块，不能完成清单。'
  } catch (error) {
    persistNow()
    if (aborted || controller?.signal.aborted) {
      statusLine.value = '已中断，本地进度已保存；重新选择同一文件后续传只补缺块。'
    } else {
      globalError.value = { code: error.code || 'upload_failed', message: error.message }
    }
  } finally {
    running.value = false
    persistNow()
  }
}

function abort() {
  controller?.abort()
}

async function retryOne(sequence) {
  if (!boundFile.value || running.value || !session.value) return
  const plan = session.value.chunks[sequence]
  if (!plan || plan.state === 'present') return
  if (plan.error?.code === 'chunk_digest_mismatch') {
    globalError.value = {
      code: 'file_identity_mismatch',
      message: `块 ${sequence} 摘要与清单不符，文件身份不成立。请重新选择同一份录波；同名不同内容的文件不能继续。`
    }
    return
  }
  globalError.value = null
  controller = new AbortController()
  running.value = true
  try {
    const failed = await uploadMissing({
      manifestId: props.manifest.id,
      file: boundFile.value,
      session: session.value,
      sequences: [sequence],
      putChunk: api.putChunk,
      hasher: sha256Hex,
      signal: controller.signal,
      onState: persistNow
    })
    persistNow()
    if (!failed.length) await reconcileFromServer()
  } catch (error) {
    globalError.value = { code: error.code || 'upload_failed', message: error.message }
  } finally {
    running.value = false
    persistNow()
  }
}

async function finalize() {
  if (finalizeDisabled.value) return
  try {
    // 完成前强制与服务端核对一次，防止本地状态过期。
    await reconcileFromServer()
    if (!readyToFinalize(session.value)) {
      globalError.value = { code: 'not_ready', message: '服务端核对仍有缺块，拒绝完成清单。' }
      return
    }
    const result = await finalizer(props.manifest.id)
    if (result.completed || result.already_completed) {
      finalizedLocal.value = true
      statusLine.value = result.already_completed
        ? '清单此前已完成，本次调用未重复发布。'
        : '清单已完成，原始块冻结。'
      persistNow()
      emit('finalized', result)
    }
  } catch (error) {
    const detail = error.responseDetail
    globalError.value = {
      code: detail?.code || error.code || 'finalize_failed',
      message: detail && typeof detail === 'object' && !Array.isArray(detail)
        ? (detail.message || JSON.stringify(detail))
        : error.message
    }
  }
}

function forget() {
  if (!window.confirm('清除本清单在本浏览器保存的上传进度摘要？服务端已收到的块不受影响。')) return
  clearSession(props.manifest.id)
  resetState()
}

watch(() => props.manifest.id, async () => {
  resetState()
  try {
    await reconcileFromServer()
  } catch (error) {
    globalError.value = { code: 'server_unreachable', message: error.message }
  }
})
onMounted(async () => {
  resetState()
  try {
    await reconcileFromServer()
  } catch (error) {
    globalError.value = { code: 'server_unreachable', message: error.message }
  }
})
</script>
