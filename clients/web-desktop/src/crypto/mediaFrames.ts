// Сквозное шифрование звука и видео в звонках ключом комнаты (тот же AES-256-GCM, что у чата).
// Нода пересылает кадры, не видя содержимого. Формат v1 общий с Android (MediaFrameCipher.kt):
//   iv_b64          — случайные 12 байт на каждый кадр
//   ciphertext_b64  — шифротекст с 16-байтным тегом в конце (как отдаёт WebCrypto)
//   room_key_id     — id ключа комнаты
//   AAD             — "liaper-media-v1|<room_id>|<sender_user_id>|<kind>": кадр нельзя переложить
//                     в другую комнату, выдать за другого участника или за другой тип потока.

import { base64ToBytes, bytesToBase64, toArrayBuffer } from './e2ee.ts';

export const MEDIA_IV_BYTES = 12;

export interface EncryptedMediaFrame {
  ciphertext_b64: string;
  iv_b64: string;
  room_key_id: string;
}

const utf8 = new TextEncoder();

export function mediaFrameAad(roomId: string, senderId: string, kind: string): Uint8Array {
  return utf8.encode(`liaper-media-v1|${roomId}|${senderId}|${kind}`);
}

export async function encryptMediaFrame(params: {
  key: CryptoKey;
  roomKeyId: string;
  roomId: string;
  senderId: string;
  kind: string;
  plaintext: Uint8Array;
  iv?: Uint8Array;
}): Promise<EncryptedMediaFrame> {
  const iv = params.iv ?? crypto.getRandomValues(new Uint8Array(MEDIA_IV_BYTES));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(mediaFrameAad(params.roomId, params.senderId, params.kind)) },
    params.key,
    toArrayBuffer(params.plaintext),
  );
  return {
    ciphertext_b64: bytesToBase64(new Uint8Array(encrypted)),
    iv_b64: bytesToBase64(iv),
    room_key_id: params.roomKeyId,
  };
}

/** Расшифровывает кадр; бросает исключение, если кадр не зашифрован, подделан или ключ не тот. */
export async function decryptMediaFrame(params: {
  key: CryptoKey;
  roomId: string;
  senderId: string;
  kind: string;
  ciphertextB64: string;
  ivB64: string;
}): Promise<Uint8Array> {
  const iv = base64ToBytes(params.ivB64);
  // Старые клиенты клали сюда метку вроде "pcm16-16000-mono": такой кадр не зашифрован
  if (iv.byteLength !== MEDIA_IV_BYTES) throw new Error('Кадр без шифрования');
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(mediaFrameAad(params.roomId, params.senderId, params.kind)) },
    params.key,
    toArrayBuffer(base64ToBytes(params.ciphertextB64)),
  );
  return new Uint8Array(decrypted);
}
