// 增量 SHA-256。数 GB 录波文件不能整块读进内存，而 WebCrypto 的
// crypto.subtle.digest 不支持流式更新，因此这里实现一个可分片 update 的
// 纯位运算版本，无外部依赖，供浏览器按 8 MiB 子片喂数据。

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

const BLOCK_SIZE = 64
const W = new Uint32Array(64)

function rotateRight(value, bits) {
  return (value >>> bits) | (value << (32 - bits))
}

function compress(state, block, offset) {
  for (let i = 0; i < 16; i += 1) {
    const j = offset + i * 4
    W[i] = ((block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3]) >>> 0
  }
  for (let i = 16; i < 64; i += 1) {
    const w15 = W[i - 15]
    const w2 = W[i - 2]
    const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3)
    const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10)
    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
  }
  let a = state[0]
  let b = state[1]
  let c = state[2]
  let d = state[3]
  let e = state[4]
  let f = state[5]
  let g = state[6]
  let h = state[7]
  for (let i = 0; i < 64; i += 1) {
    const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)
    const ch = (e & f) ^ (~e & g)
    const t1 = (h + s1 + ch + K[i] + W[i]) | 0
    const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)
    const maj = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (s0 + maj) | 0
    h = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }
  state[0] = (state[0] + a) >>> 0
  state[1] = (state[1] + b) >>> 0
  state[2] = (state[2] + c) >>> 0
  state[3] = (state[3] + d) >>> 0
  state[4] = (state[4] + e) >>> 0
  state[5] = (state[5] + f) >>> 0
  state[6] = (state[6] + g) >>> 0
  state[7] = (state[7] + h) >>> 0
}

// 位长度编码：字节长度用 (hi, lo) 两个 32 位字跟踪，左移 3 位并把进位
// 并入高字。单独导出以便对 >4 GiB 的进位路径做单元测试。
export function bitLengthWords(lengthHi, lengthLo) {
  return {
    hi: ((lengthHi << 3) | (lengthLo >>> 29)) >>> 0,
    lo: (lengthLo << 3) >>> 0,
  }
}

export class Sha256 {
  constructor() {
    this._state = new Uint32Array(INITIAL_STATE)
    this._buffer = new Uint8Array(BLOCK_SIZE)
    this._bufferLength = 0
    this._lengthHi = 0
    this._lengthLo = 0
  }

  update(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const lo = (this._lengthLo + bytes.length) >>> 0
    if (lo < this._lengthLo) this._lengthHi = (this._lengthHi + 1) >>> 0
    this._lengthLo = lo

    let offset = 0
    if (this._bufferLength > 0) {
      const take = Math.min(BLOCK_SIZE - this._bufferLength, bytes.length)
      this._buffer.set(bytes.subarray(0, take), this._bufferLength)
      this._bufferLength += take
      offset += take
      if (this._bufferLength === BLOCK_SIZE) {
        compress(this._state, this._buffer, 0)
        this._bufferLength = 0
      }
    }
    while (offset + BLOCK_SIZE <= bytes.length) {
      compress(this._state, bytes, offset)
      offset += BLOCK_SIZE
    }
    if (offset < bytes.length) {
      this._buffer.set(bytes.subarray(offset), 0)
      this._bufferLength = bytes.length - offset
    }
    return this
  }

  // 在状态副本上完成 padding，digest 之后仍可继续 update 或重复 digest。
  digest() {
    const state = new Uint32Array(this._state)
    const { hi, lo } = bitLengthWords(this._lengthHi, this._lengthLo)
    const tailLength = this._bufferLength
    const padLength = tailLength < 56 ? 56 - tailLength : 120 - tailLength
    const final = new Uint8Array(tailLength + padLength + 8)
    final.set(this._buffer.subarray(0, tailLength), 0)
    final[tailLength] = 0x80
    const n = final.length
    final[n - 8] = (hi >>> 24) & 0xff
    final[n - 7] = (hi >>> 16) & 0xff
    final[n - 6] = (hi >>> 8) & 0xff
    final[n - 5] = hi & 0xff
    final[n - 4] = (lo >>> 24) & 0xff
    final[n - 3] = (lo >>> 16) & 0xff
    final[n - 2] = (lo >>> 8) & 0xff
    final[n - 1] = lo & 0xff
    for (let offset = 0; offset < final.length; offset += BLOCK_SIZE) {
      compress(state, final, offset)
    }
    let hex = ''
    for (const word of state) {
      hex += (word >>> 0).toString(16).padStart(8, '0')
    }
    return hex
  }
}
