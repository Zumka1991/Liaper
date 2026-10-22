import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Head, solvePowSync } from '../src/services/pow.ts';

const leadingZeroBits = (buf) => {
  let bits = 0;
  for (const b of buf) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
  return bits;
};

test('sha256Head совпадает с node:crypto на строках разной длины', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), `v1.${'a'.repeat(32)}.18.1700000000.${'f'.repeat(64)}:123456`]) {
    const ref = createHash('sha256').update(s).digest();
    const head = sha256Head(s);
    assert.equal(head[0], ref.readUInt32BE(0), s.length);
    assert.equal(head[1], ref.readUInt32BE(4), s.length);
  }
});

test('решение proof-of-work проходит серверную проверку и быстро находится', () => {
  const challenge = `v1.${'0123456789abcdef'.repeat(2)}.18.1700000000.${'ab'.repeat(32)}`;
  const t0 = performance.now();
  const solution = solvePowSync(challenge, 18);
  const ms = performance.now() - t0;
  const digest = createHash('sha256').update(`${challenge}:${solution}`).digest();
  assert.ok(leadingZeroBits(digest) >= 18);
  console.log(`18 бит: ${solution} за ${ms.toFixed(0)} мс`);
});
