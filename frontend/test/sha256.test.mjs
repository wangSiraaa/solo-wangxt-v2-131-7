import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import test from 'node:test'

import { Sha256, bitLengthWords } from '../src/upload/sha256.js'

const hex = (data) => createHash('sha256').update(data).digest('hex')

test('标准测试向量', () => {
  assert.equal(new Sha256().digest(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(
    new Sha256().update(new TextEncoder().encode('abc')).digest(),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(
    new Sha256().update(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).digest(),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  const million = new Uint8Array(1_000_000).fill(0x61)
  assert.equal(
    new Sha256().update(million).digest(),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
})

test('随机数据随机切片与 node:crypto 对拍', () => {
  for (const size of [1, 55, 56, 63, 64, 65, 127, 128, 1000, 1 << 20]) {
    const data = randomBytes(size)
    const hasher = new Sha256()
    let offset = 0
    while (offset < data.length) {
      const take = Math.min(data.length - offset, 1 + Math.floor(Math.random() * 200))
      hasher.update(data.subarray(offset, offset + take))
      offset += take
    }
    assert.equal(hasher.digest(), hex(data), `size=${size}`)
  }
})

test('digest 不破坏状态，可继续 update', () => {
  const hasher = new Sha256()
  hasher.update(new TextEncoder().encode('hello '))
  const first = hasher.digest()
  assert.equal(first, hex(Buffer.from('hello ')))
  hasher.update(new TextEncoder().encode('world'))
  assert.equal(hasher.digest(), hex(Buffer.from('hello world')))
  assert.equal(hasher.digest(), hex(Buffer.from('hello world')))
})

test('位长度编码处理 >4GiB 进位', () => {
  assert.deepEqual(bitLengthWords(0, 0), { hi: 0, lo: 0 })
  // 0xFFFFFFFF 字节 = 0x7_FFFFFFF8 位
  assert.deepEqual(bitLengthWords(0, 0xffffffff), { hi: 7, lo: 0xfffffff8 })
  // 2^32 + 2^29 字节 = 0x9_00000000 位
  assert.deepEqual(bitLengthWords(1, 0x20000000), { hi: 9, lo: 0 })
})

test('跨 4GiB 边界的 update 长度累加', () => {
  const hasher = new Sha256()
  hasher._lengthLo = 0xfffffff0 // 模拟已接近 4 GiB
  hasher.update(new Uint8Array(0x20))
  assert.equal(hasher._lengthLo, 0x10)
  assert.equal(hasher._lengthHi, 1)
})
