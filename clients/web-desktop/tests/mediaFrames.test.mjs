import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encryptMediaFrame, decryptMediaFrame } from '../src/crypto/mediaFrames.ts';

const fx = JSON.parse(readFileSync(new URL('../../../tests/fixtures/media-frame-v1.json', import.meta.url)));
const raw = Buffer.from(fx.raw_key_b64, 'base64');
const plaintext = new Uint8Array(Buffer.from(fx.plaintext_b64, 'base64'));
const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
const frameParams = (over = {}) => ({
  key, roomId: fx.room_id, senderId: fx.sender_id, kind: fx.kind,
  ciphertextB64: fx.frame.ciphertext_b64, ivB64: fx.frame.iv_b64, ...over,
});

test('кадр совпадает с общим тестовым вектором (его же проверяет Android)', async () => {
  const frame = await encryptMediaFrame({
    key, roomKeyId: fx.frame.room_key_id, roomId: fx.room_id, senderId: fx.sender_id, kind: fx.kind,
    plaintext, iv: new Uint8Array(Buffer.from(fx.frame.iv_b64, 'base64')),
  });
  assert.deepEqual(frame, fx.frame);
  assert.deepEqual(await decryptMediaFrame(frameParams()), plaintext);
});

test('каждый кадр получает свой IV', async () => {
  const p = { key, roomKeyId: 'k', roomId: fx.room_id, senderId: fx.sender_id, kind: fx.kind, plaintext };
  const [a, b] = await Promise.all([encryptMediaFrame(p), encryptMediaFrame(p)]);
  assert.notEqual(a.iv_b64, b.iv_b64);
  assert.notEqual(a.ciphertext_b64, b.ciphertext_b64);
});

test('кадр нельзя переложить в другую комнату, приписать другому участнику или другому потоку', async () => {
  await assert.rejects(decryptMediaFrame(frameParams({ roomId: 'другая-комната' })));
  await assert.rejects(decryptMediaFrame(frameParams({ senderId: 'чужой-участник' })));
  await assert.rejects(decryptMediaFrame(frameParams({ kind: 'video_jpeg' })));
});

test('незашифрованный кадр старого клиента отвергается', async () => {
  await assert.rejects(decryptMediaFrame(frameParams({ ivB64: Buffer.from('pcm16-16000-mono').toString('base64'), ciphertextB64: fx.plaintext_b64 })));
});
