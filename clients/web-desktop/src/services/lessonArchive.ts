import { base64ToBytes, bytesToBase64 } from '../crypto/e2ee.ts';
import type { ChatAttachmentMeta } from '../types/protocol.ts';

export interface LessonArchive {
  id: string;
  title: string;
  savedAt: string;
  startedAt?: string;
  endedAt?: string;
  messages: {
    id?: string;
    sender_id?: string;
    sender: string;
    username: string;
    text: string;
    time: string;
    sentAt?: string;
    attachment?: ChatAttachmentMeta;
  }[];
}

export interface ArchiveBlob {
  archive_id: string;
  version: number;
  ciphertext_b64: string;
  iv_b64: string;
  revision: number;
}

const utf8 = new TextEncoder();
const buffer = (value: Uint8Array) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
const aad = (userId: string, archiveId: string) => utf8.encode(`liaper-lesson-archive-v1:${userId}:${archiveId}`);

export async function deriveArchiveKey(password: string, userId: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', utf8.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 210000,
    salt: utf8.encode(`liaper-archive-key-v1:${userId}`) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptArchive(archive: LessonArchive, key: CryptoKey, userId: string): Promise<Pick<ArchiveBlob, 'version' | 'ciphertext_b64' | 'iv_b64'>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(userId, archive.id) }, key, utf8.encode(JSON.stringify(archive)));
  return { version: 1, ciphertext_b64: bytesToBase64(new Uint8Array(encrypted)), iv_b64: bytesToBase64(iv) };
}

export async function decryptArchive(blob: ArchiveBlob, key: CryptoKey, userId: string): Promise<LessonArchive> {
  if (blob.version !== 1) throw new Error('Эта версия архива пока не поддерживается');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(base64ToBytes(blob.iv_b64)), additionalData: aad(userId, blob.archive_id) }, key, buffer(base64ToBytes(blob.ciphertext_b64)));
  const archive = JSON.parse(new TextDecoder().decode(plain)) as LessonArchive;
  if (archive.id !== blob.archive_id || !Array.isArray(archive.messages)) throw new Error('Архив повреждён');
  return archive;
}

export function mergeArchive(left: LessonArchive, right: LessonArchive): LessonArchive {
  const newer = left.savedAt > right.savedAt ? left : right;
  const messages = new Map<string, LessonArchive['messages'][number]>();
  for (const message of [...left.messages, ...right.messages]) {
    const identity = message.id || JSON.stringify([message.sender, message.username, message.sentAt || message.time, message.text]);
    const prev = messages.get(identity);
    messages.set(identity, {
      ...(prev || {}),
      ...message,
      attachment: message.attachment ?? prev?.attachment,
      sender_id: message.sender_id ?? prev?.sender_id,
    });
  }
  return { ...newer, startedAt: left.startedAt || right.startedAt,
    endedAt: [left.endedAt, right.endedAt].filter(Boolean).sort().at(-1),
    messages: [...messages.values()].sort((a, b) => (a.sentAt || a.time || '').localeCompare(b.sentAt || b.time || '')) };
}

export function mergeArchiveLists(...lists: LessonArchive[][]): LessonArchive[] {
  const entries = new Map<string, LessonArchive>();
  for (const archive of lists.flat()) entries.set(archive.id, entries.has(archive.id) ? mergeArchive(entries.get(archive.id)!, archive) : archive);
  return [...entries.values()].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

function canonical(archive: LessonArchive): string {
  return JSON.stringify([archive.title, archive.startedAt || '', archive.endedAt || '', archive.savedAt,
    archive.messages.map((m) => [m.id || '', m.sender, m.username, m.text, m.time || '', m.sentAt || '', m.attachment?.id || ''])]);
}

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = await response.json().catch(() => ({})) as { error?: string };
  throw new Error(body.error || 'Не удалось синхронизировать архив');
}

export async function syncLessonArchives(baseUrl: string, token: string, key: CryptoKey, userId: string,
  local: LessonArchive[], fetcher: typeof fetch = fetch): Promise<LessonArchive[]> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let pending = local;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await checked(await fetcher(`${baseUrl}/api/lesson-archives`, { headers, signal: AbortSignal.timeout(15000) }));
    const blobs = await response.json() as ArchiveBlob[];
    // A wrong key stops the whole sync before any upload; never overwrite an unreadable archive.
    const remote = await Promise.all(blobs.map((blob) => decryptArchive(blob, key, userId)));
    const combined = mergeArchiveLists(remote, pending);
    const remoteById = new Map(remote.map((entry) => [entry.id, entry]));
    const versions = new Map(blobs.map((blob) => [blob.archive_id, blob.revision]));
    let conflict = false;
    for (const entry of combined) {
      const old = remoteById.get(entry.id);
      if (old && canonical(old) === canonical(entry)) continue;
      const encrypted = await encryptArchive(entry, key, userId);
      const write = await fetcher(`${baseUrl}/api/lesson-archives/${encodeURIComponent(entry.id)}`, { method: 'PUT', headers,
        body: JSON.stringify({ ...encrypted, expected_revision: versions.get(entry.id) ?? 0 }), signal: AbortSignal.timeout(15000) });
      if (write.status === 409) { conflict = true; break; }
      await checked(write);
    }
    if (!conflict) return combined;
    pending = combined;
  }
  throw new Error('Архив одновременно изменяется на другом устройстве. Повторите синхронизацию.');
}
