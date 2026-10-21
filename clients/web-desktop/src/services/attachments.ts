import { base64ToBytes, bytesToBase64, toArrayBuffer } from '../crypto/e2ee.ts';
import type { AttachmentKind, ChatAttachmentMeta } from '../types/protocol.ts';

export const MAX_ATTACHMENT_CIPHERTEXT_BYTES = 128 * 1024 * 1024; // 128 MiB
export const MAX_ATTACHMENT_PLAINTEXT_BYTES = MAX_ATTACHMENT_CIPHERTEXT_BYTES - 16;

export class AttachmentExpiredError extends Error {
  public readonly isExpired = true;
  constructor(message = 'Срок хранения истёк') {
    super(message);
    this.name = 'AttachmentExpiredError';
  }
}

export class AttachmentQuotaError extends Error {
  public readonly isQuota = true;
  constructor(message = 'Превышена квота хранилища (5 ГиБ на пользователя или 128 МиБ на файл)') {
    super(message);
    this.name = 'AttachmentQuotaError';
  }
}

export function sanitizeAttachmentFilename(rawName: string, fallbackExt = ''): string {
  const base = rawName
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? 'attachment';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  const safe = cleaned.length > 0 ? cleaned.slice(0, 120) : `file${fallbackExt}`;
  return safe;
}

export function classifyAttachmentFile(
  fileName: string,
  mimeType: string
): { kind: AttachmentKind; mimeType: string } | null {
  const lowerName = fileName.toLowerCase().trim();
  const lowerMime = mimeType.toLowerCase().trim();

  if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) {
    return { kind: 'pdf', mimeType: 'application/pdf' };
  }
  if (
    lowerMime === 'application/msword' ||
    lowerName.endsWith('.doc')
  ) {
    return { kind: 'word', mimeType: 'application/msword' };
  }
  if (
    lowerMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerName.endsWith('.docx')
  ) {
    return {
      kind: 'word',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }
  if (
    lowerMime.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|bmp)$/i.test(lowerName)
  ) {
    const resolvedMime = lowerMime.startsWith('image/')
      ? lowerMime
      : lowerName.endsWith('.png')
        ? 'image/png'
        : lowerName.endsWith('.webp')
          ? 'image/webp'
          : lowerName.endsWith('.gif')
            ? 'image/gif'
            : lowerName.endsWith('.bmp')
              ? 'image/bmp'
              : 'image/jpeg';
    return { kind: 'image', mimeType: resolvedMime };
  }
  if (lowerMime === 'audio/wav' || lowerMime === 'audio/x-wav' || lowerName.endsWith('.wav')) {
    return { kind: 'voice', mimeType: 'audio/wav' };
  }
  if (
    lowerMime === 'application/x-liaper-videonote' ||
    lowerName.endsWith('.lpvn')
  ) {
    return { kind: 'video_note', mimeType: 'application/x-liaper-videonote' };
  }
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface EncryptedAttachmentBlob {
  ciphertextBytes: Uint8Array;
  fileKeyB64: string;
  nonceB64: string;
  sha256Hex: string;
  plaintextSize: number;
  ciphertextSize: number;
}

export async function encryptAttachmentBytes(
  plaintextBytes: Uint8Array
): Promise<EncryptedAttachmentBlob> {
  if (plaintextBytes.byteLength === 0) {
    throw new Error('Файл пуст');
  }
  if (plaintextBytes.byteLength > MAX_ATTACHMENT_PLAINTEXT_BYTES) {
    throw new AttachmentQuotaError('Файл превышает лимит 128 МиБ на одно вложение');
  }

  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const rawKeyBuf = await crypto.subtle.exportKey('raw', key);
  const fileKeyB64 = bytesToBase64(new Uint8Array(rawKeyBuf));

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const nonceB64 = bytesToBase64(nonce);

  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    key,
    toArrayBuffer(plaintextBytes)
  );
  const ciphertextBytes = new Uint8Array(cipherBuf);
  const hashHex = await sha256Hex(ciphertextBytes);

  return {
    ciphertextBytes,
    fileKeyB64,
    nonceB64,
    sha256Hex: hashHex,
    plaintextSize: plaintextBytes.byteLength,
    ciphertextSize: ciphertextBytes.byteLength,
  };
}

export async function decryptAttachmentBytes(
  ciphertextBytes: Uint8Array,
  fileKeyB64: string,
  nonceB64: string,
  expectedSha256Hex?: string
): Promise<Uint8Array> {
  if (expectedSha256Hex) {
    const actualSha = await sha256Hex(ciphertextBytes);
    if (actualSha.toLowerCase() !== expectedSha256Hex.toLowerCase()) {
      throw new Error('Контрольная сумма SHA-256 зашифрованного вложения не совпала');
    }
  }
  const rawKey = base64ToBytes(fileKeyB64);
  const nonce = base64ToBytes(nonceB64);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(rawKey),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(nonce) },
    cryptoKey,
    toArrayBuffer(ciphertextBytes)
  );
  return new Uint8Array(plainBuf);
}

// Memory cache of decrypted attachment bytes by attachment ID
const decryptedAttachmentCache = new Map<string, Uint8Array>();

export function getCachedAttachmentBytes(attachmentId: string): Uint8Array | undefined {
  return decryptedAttachmentCache.get(attachmentId);
}

export function setCachedAttachmentBytes(attachmentId: string, bytes: Uint8Array): void {
  decryptedAttachmentCache.set(attachmentId, bytes);
}

function putBinaryWithProgress(
  url: string,
  uploadToken: string,
  bytes: Uint8Array,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<{ receipt?: string; expires_at?: string }> {
  if (typeof XMLHttpRequest === 'undefined') {
    return fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${uploadToken}`,
        'Content-Type': 'application/octet-stream',
      },
      body: toArrayBuffer(bytes),
      signal,
    }).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Ошибка загрузки на файловую ноду (HTTP ${res.status})`);
      }
      onProgress?.(1);
      return (await res.json().catch(() => ({}))) as { receipt?: string; expires_at?: string };
    });
  }

  return new Promise<{ receipt?: string; expires_at?: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${uploadToken}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    const onAbort = () => {
      try {
        xhr.abort();
      } catch {}
      reject(new DOMException('Загрузка отменена', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress?.(Math.min(0.95, ev.loaded / ev.total));
      }
    };
    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        let parsed: { receipt?: string; expires_at?: string } = {};
        try {
          parsed = JSON.parse(xhr.responseText || '{}') as {
            receipt?: string;
            expires_at?: string;
          };
        } catch {}
        resolve(parsed);
      } else if (xhr.status === 413) {
        reject(new AttachmentQuotaError('Размер вложения превышает лимит 128 МиБ'));
      } else if (xhr.status === 507) {
        reject(new AttachmentQuotaError('На файловой ноде недостаточно места'));
      } else {
        reject(new Error(`Ошибка файловой ноды (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Сетевая ошибка при отправке зашифрованного блоба на файловую ноду'));
    };
    xhr.onabort = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Загрузка отменена', 'AbortError'));
    };
    xhr.send(toArrayBuffer(bytes));
  });
}

function getBinaryWithProgress(
  url: string,
  downloadToken: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<{ status: number; bytes: Uint8Array }> {
  if (typeof XMLHttpRequest === 'undefined') {
    return fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${downloadToken}` },
      signal,
    }).then(async (res) => {
      if (res.status === 410) {
        throw new AttachmentExpiredError('Срок хранения истёк');
      }
      if (!res.ok) {
        throw new Error(`Ошибка скачивания вложения (HTTP ${res.status})`);
      }
      const buf = await res.arrayBuffer();
      onProgress?.(1);
      return { status: res.status, bytes: new Uint8Array(buf) };
    });
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.setRequestHeader('Authorization', `Bearer ${downloadToken}`);
    xhr.responseType = 'arraybuffer';

    const onAbort = () => {
      try {
        xhr.abort();
      } catch {}
      reject(new DOMException('Скачивание отменено', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    xhr.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress?.(Math.min(0.95, ev.loaded / ev.total));
      }
    };
    xhr.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      if (xhr.status === 410) {
        reject(new AttachmentExpiredError('Срок хранения истёк'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
        onProgress?.(1);
        resolve({ status: xhr.status, bytes: new Uint8Array(xhr.response as ArrayBuffer) });
      } else {
        reject(new Error(`Не удалось скачать вложение (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Сетевая ошибка при скачивании вложения'));
    };
    xhr.onabort = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new DOMException('Скачивание отменено', 'AbortError'));
    };
    xhr.send();
  });
}

export async function uploadEncryptedAttachment(params: {
  controlBase: string;
  token: string;
  roomId: string;
  fileName: string;
  mimeType: string;
  kind: AttachmentKind;
  plaintextBytes: Uint8Array;
  durationMs?: number;
  width?: number;
  height?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<ChatAttachmentMeta> {
  const safeName = sanitizeAttachmentFilename(params.fileName);
  params.onProgress?.(0.05);

  const encrypted = await encryptAttachmentBytes(params.plaintextBytes);
  if (params.signal?.aborted) {
    throw new DOMException('Загрузка отменена', 'AbortError');
  }
  params.onProgress?.(0.15);

  const reserveRes = await fetch(`${params.controlBase}/api/attachments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      room_id: params.roomId,
      size_bytes: encrypted.ciphertextSize,
      sha256: encrypted.sha256Hex,
    }),
    signal: params.signal,
  });

  if (!reserveRes.ok) {
    const errBody = (await reserveRes.json().catch(() => ({}))) as { error?: string };
    if (reserveRes.status === 507) {
      throw new AttachmentQuotaError(
        errBody.error || 'Недостаточно места: исчерпана квота 5 ГиБ на пользователя'
      );
    }
    if (reserveRes.status === 413) {
      throw new AttachmentQuotaError(
        errBody.error || 'Размер зашифрованного вложения превышает лимит 128 МиБ'
      );
    }
    throw new Error(errBody.error || `Не удалось зарезервировать вложение (HTTP ${reserveRes.status})`);
  }

  const reservation = (await reserveRes.json()) as {
    attachment_id: string;
    upload_url: string;
    upload_token: string;
  };

  const putResult = await putBinaryWithProgress(
    reservation.upload_url,
    reservation.upload_token,
    encrypted.ciphertextBytes,
    (p) => params.onProgress?.(0.15 + p * 0.75),
    params.signal
  );

  let expiresAt = putResult.expires_at || '';
  if (putResult.receipt) {
    const completeRes = await fetch(
      `${params.controlBase}/api/attachments/${reservation.attachment_id}/complete`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ receipt: putResult.receipt }),
        signal: params.signal,
      }
    );
    if (completeRes.ok) {
      const completed = (await completeRes.json().catch(() => ({}))) as {
        expires_at?: string;
      };
      if (completed.expires_at) {
        expiresAt = completed.expires_at;
      }
    }
  }

  setCachedAttachmentBytes(reservation.attachment_id, params.plaintextBytes);
  params.onProgress?.(1);

  return {
    id: reservation.attachment_id,
    name: safeName,
    mime_type: params.mimeType,
    kind: params.kind,
    plaintext_size: encrypted.plaintextSize,
    ciphertext_size: encrypted.ciphertextSize,
    file_key_b64: encrypted.fileKeyB64,
    nonce_b64: encrypted.nonceB64,
    sha256_hex: encrypted.sha256Hex,
    expires_at: expiresAt,
    duration_ms: params.durationMs,
    width: params.width,
    height: params.height,
  };
}

export async function downloadAndDecryptAttachment(params: {
  controlBase: string;
  token: string;
  meta: ChatAttachmentMeta;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<Uint8Array> {
  const cached = getCachedAttachmentBytes(params.meta.id);
  if (cached) {
    params.onProgress?.(1);
    return cached;
  }

  params.onProgress?.(0.05);
  const grantRes = await fetch(
    `${params.controlBase}/api/attachments/${params.meta.id}/download`,
    {
      headers: {
        Authorization: `Bearer ${params.token}`,
      },
      signal: params.signal,
    }
  );

  if (grantRes.status === 410) {
    throw new AttachmentExpiredError('Срок хранения истёк');
  }
  if (!grantRes.ok) {
    const errBody = (await grantRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      errBody.error || `Не удалось получить ссылку на вложение (HTTP ${grantRes.status})`
    );
  }

  const grant = (await grantRes.json()) as {
    download_url: string;
    download_token: string;
    sha256?: string;
    expires_at?: string;
  };

  const { bytes: ciphertextBytes } = await getBinaryWithProgress(
    grant.download_url,
    grant.download_token,
    (p) => params.onProgress?.(0.1 + p * 0.75),
    params.signal
  );

  const plaintextBytes = await decryptAttachmentBytes(
    ciphertextBytes,
    params.meta.file_key_b64,
    params.meta.nonce_b64,
    params.meta.sha256_hex || grant.sha256
  );

  setCachedAttachmentBytes(params.meta.id, plaintextBytes);
  params.onProgress?.(1);
  return plaintextBytes;
}

// ============================================================================
// WAV (16kHz 16-bit Mono) & LPVN v1 Video Note Container
// ============================================================================

export function encodePcm16ToWav(samples: Int16Array, sampleRate = 16000): Uint8Array {
  const dataLen = samples.byteLength;
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, 1, true); // Mono = 1 channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataLen, true);

  const outBytes = new Uint8Array(buffer);
  outBytes.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength), 44);
  return outBytes;
}

export interface LpvnVideoFrame {
  timestampMs: number;
  jpegBytes: Uint8Array;
}

export interface DecodedLpvnVideoNote {
  durationMs: number;
  wavBytes: Uint8Array;
  frames: LpvnVideoFrame[];
}

export function encodeLpvnVideoNote(params: {
  durationMs: number;
  wavBytes: Uint8Array;
  frames: LpvnVideoFrame[];
}): Uint8Array {
  let totalBytes = 20 + params.wavBytes.byteLength;
  for (const frame of params.frames) {
    totalBytes += 8 + frame.jpegBytes.byteLength;
  }

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  // Magic "LPVN"
  view.setUint8(0, 0x4c);
  view.setUint8(1, 0x50);
  view.setUint8(2, 0x56);
  view.setUint8(3, 0x4e);
  view.setUint32(4, 1, true); // version 1
  view.setUint32(8, Math.max(0, Math.round(params.durationMs)), true);
  view.setUint32(12, params.wavBytes.byteLength, true);
  view.setUint32(16, params.frames.length, true);

  let offset = 20;
  out.set(params.wavBytes, offset);
  offset += params.wavBytes.byteLength;

  for (const frame of params.frames) {
    view.setUint32(offset, Math.max(0, Math.round(frame.timestampMs)), true);
    view.setUint32(offset + 4, frame.jpegBytes.byteLength, true);
    offset += 8;
    out.set(frame.jpegBytes, offset);
    offset += frame.jpegBytes.byteLength;
  }

  return out;
}

export function decodeLpvnVideoNote(bytes: Uint8Array): DecodedLpvnVideoNote {
  if (bytes.byteLength < 20) {
    throw new Error('Повреждённый контейнер видеокружка (слишком мал)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  if (magic !== 'LPVN') {
    throw new Error('Неизвестный формат видеокружка');
  }
  const version = view.getUint32(4, true);
  if (version !== 1) {
    throw new Error(`Неподдерживаемая версия видеокружка: ${version}`);
  }
  const durationMs = view.getUint32(8, true);
  const wavByteLen = view.getUint32(12, true);
  const frameCount = view.getUint32(16, true);

  if (20 + wavByteLen > bytes.byteLength) {
    throw new Error('Повреждённая аудиодорожка видеокружка');
  }
  const wavBytes = bytes.slice(20, 20 + wavByteLen);
  let offset = 20 + wavByteLen;
  const frames: LpvnVideoFrame[] = [];

  for (let i = 0; i < frameCount; i++) {
    if (offset + 8 > bytes.byteLength) break;
    const timestampMs = view.getUint32(offset, true);
    const jpegLen = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + jpegLen > bytes.byteLength) break;
    const jpegBytes = bytes.slice(offset, offset + jpegLen);
    offset += jpegLen;
    frames.push({ timestampMs, jpegBytes });
  }

  return { durationMs, wavBytes, frames };
}

export function formatBytesRu(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГиБ`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} КиБ`;
  }
  return `${bytes} Б`;
}

export function formatDurationMmSs(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
