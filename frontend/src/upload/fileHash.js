// 浏览器侧文件哈希原语：按 8 MiB 子片读取 Blob，内存占用与文件总大小无关。

import { Sha256 } from './sha256.js'
import { fingerprintRegions } from './resume.js'

const SLICE_SIZE = 8 * 1024 * 1024

// 顺序读取若干字节区间并更新给定的摘要，onProgress(已完成字节, 总字节)。
export async function hashBlobRegions(blob, regions, onProgress, hasher = new Sha256()) {
  const total = regions.reduce((sum, region) => sum + region.length, 0)
  let done = 0
  for (const region of regions) {
    let offset = region.offset
    const end = region.offset + region.length
    while (offset < end) {
      const size = Math.min(SLICE_SIZE, end - offset)
      const buffer = await blob.slice(offset, offset + size).arrayBuffer()
      hasher.update(new Uint8Array(buffer))
      offset += size
      done += size
      onProgress?.(done, total)
    }
  }
  return hasher
}

// 单个清单块的字节摘要（byteOffset/byteLength 来自清单声明）。
export async function hashChunk(file, byteOffset, byteLength, onProgress) {
  const hasher = await hashBlobRegions(file, [{ offset: byteOffset, length: byteLength }], onProgress)
  return hasher.digest()
}

// 文件身份指纹：名称/大小/修改时间 + 头/中/尾采样内容。
export async function computeFileFingerprint(file, onProgress) {
  const hasher = new Sha256()
  hasher.update(new TextEncoder().encode(`pq-file-v1\n${file.name}\n${file.size}\n${file.lastModified}\n`))
  await hashBlobRegions(file, fingerprintRegions(file.size), onProgress, hasher)
  return hasher.digest()
}
