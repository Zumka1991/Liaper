import type { ChatAttachmentMeta, E2eeKeyEnvelope, RichChatPayload } from '../types/protocol';

const STORAGE_PRIV_KEY = 'liaper_e2ee_x25519_priv_jwk_v2';
const STORAGE_PUB_KEY = 'liaper_e2ee_x25519_pub_raw_v2';
const STORAGE_FP_KEY = 'liaper_e2ee_x25519_fp_v2';
const STORAGE_ROOM_KEYS = 'liaper_e2ee_room_keys_v2';
const WRAP_DOMAIN_LABEL = new TextEncoder().encode('liaper-x25519-wrap-v1');

export interface IdentityCryptoBundle {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeySpkiB64: string;
  fingerprint: string;
}

export interface RoomSecretKeyBundle {
  cryptoKey: CryptoKey;
  rawKeyB64: string;
  roomKeyId: string;
}

export interface RoomKeyring {
  activeKey: RoomSecretKeyBundle;
  keysById: Record<string, RoomSecretKeyBundle>;
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function computeFingerprint(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? toArrayBuffer(data) : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
  const hashArray = Array.from(new Uint8Array(hashBuffer)).slice(0, 8);
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0').toUpperCase());
  return `${hex[0]}${hex[1]}:${hex[2]}${hex[3]}:${hex[4]}${hex[5]}:${hex[6]}${hex[7]}`;
}

export function extractX25519PublicKeys(rawField: string | undefined | null): string[] {
  if (!rawField) return [];
  const result: string[] = [];
  for (const part of rawField.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const bytes = base64ToBytes(trimmed);
      if (bytes.byteLength === 32 && !result.includes(trimmed)) {
        result.push(trimmed);
      }
    } catch {
      // Ignore invalid base64
    }
  }
  return result;
}

/**
 * Генерирует или загружает постоянную пару ключей X25519 текущего устройства.
 */
export async function getOrCreateIdentityKeys(): Promise<IdentityCryptoBundle> {
  const storage = getStorage();
  const savedPrivJwk = storage?.getItem(STORAGE_PRIV_KEY);
  const savedPubRaw = storage?.getItem(STORAGE_PUB_KEY);
  const savedFp = storage?.getItem(STORAGE_FP_KEY);

  if (savedPrivJwk && savedPubRaw && savedFp) {
    try {
      const privJwk = JSON.parse(savedPrivJwk) as JsonWebKey;
      const pubBytes = base64ToBytes(savedPubRaw);
      if (pubBytes.byteLength === 32) {
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          privJwk,
          { name: 'X25519' },
          true,
          ['deriveBits']
        );
        const publicKey = await crypto.subtle.importKey(
          'raw',
          toArrayBuffer(pubBytes),
          { name: 'X25519' },
          true,
          []
        );
        return {
          privateKey,
          publicKey,
          publicKeySpkiB64: savedPubRaw,
          fingerprint: savedFp,
        };
      }
    } catch {
      // Перегенерация в случае повреждения локального кэша
    }
  }

  const keyPair = (await crypto.subtle.generateKey(
    { name: 'X25519' },
    true,
    ['deriveBits']
  )) as CryptoKeyPair;

  const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const pubRawBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicKeySpkiB64 = bytesToBase64(new Uint8Array(pubRawBuffer));
  const fingerprint = await computeFingerprint(pubRawBuffer);

  storage?.setItem(STORAGE_PRIV_KEY, JSON.stringify(privJwk));
  storage?.setItem(STORAGE_PUB_KEY, publicKeySpkiB64);
  storage?.setItem(STORAGE_FP_KEY, fingerprint);

  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    publicKeySpkiB64,
    fingerprint,
  };
}

/**
 * Устаревший детерминированный ключ из room_id — используется ТОЛЬКО для чтения
 * старых текстовых сообщений из истории. Запрещён для новых сообщений и ключей вложений.
 */
async function deriveLegacyRoomKeyFromId(roomId: string): Promise<RoomSecretKeyBundle> {
  const seed = new TextEncoder().encode(`liaper-room-e2ee-v1:${roomId}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', toArrayBuffer(seed));
  const rawBytes = new Uint8Array(hashBuffer);
  const rawKeyB64 = bytesToBase64(rawBytes);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    hashBuffer,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const fullFp = await computeFingerprint(hashBuffer);
  return {
    cryptoKey,
    rawKeyB64,
    roomKeyId: fullFp.slice(0, 9),
  };
}

/**
 * Создаёт новый криптографически случайный 256-битный ключ AES-GCM для комнаты или диалога.
 */
export async function generateRoomKey(): Promise<RoomSecretKeyBundle> {
  const cryptoKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const rawBuffer = await crypto.subtle.exportKey('raw', cryptoKey);
  const rawBytes = new Uint8Array(rawBuffer);
  const rawKeyB64 = bytesToBase64(rawBytes);
  const fullFp = await computeFingerprint(rawBuffer);
  const roomKeyId = fullFp.slice(0, 9);

  return {
    cryptoKey,
    rawKeyB64,
    roomKeyId,
  };
}

export async function importRoomKeyFromRawB64(rawKeyB64: string): Promise<RoomSecretKeyBundle> {
  const rawBytes = base64ToBytes(rawKeyB64);
  if (rawBytes.byteLength !== 32) {
    throw new Error('Room key must be 32 bytes');
  }
  const rawBuf = toArrayBuffer(rawBytes);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawBuf,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const fullFp = await computeFingerprint(rawBuf);
  return {
    cryptoKey,
    rawKeyB64,
    roomKeyId: fullFp.slice(0, 9),
  };
}

interface StoredRoomKeysMap {
  [roomId: string]: {
    activeKeyId: string;
    keys: Record<string, string>; // roomKeyId -> rawKeyB64
  };
}

function readStoredRoomKeysMap(): StoredRoomKeysMap {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_ROOM_KEYS);
    if (!raw) return {};
    return JSON.parse(raw) as StoredRoomKeysMap;
  } catch {
    return {};
  }
}

export function saveRoomKeyToLocalStore(
  roomId: string,
  bundle: RoomSecretKeyBundle,
  makeActive = true
): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const map = readStoredRoomKeysMap();
    const existing = map[roomId] ?? { activeKeyId: bundle.roomKeyId, keys: {} };
    existing.keys[bundle.roomKeyId] = bundle.rawKeyB64;
    if (makeActive || !existing.activeKeyId) {
      existing.activeKeyId = bundle.roomKeyId;
    }
    map[roomId] = existing;
    storage.setItem(STORAGE_ROOM_KEYS, JSON.stringify(map));
  } catch {
    // Ignore storage quota issues
  }
}

export async function loadSavedRoomKeyrings(): Promise<Record<string, RoomKeyring>> {
  const map = readStoredRoomKeysMap();
  const result: Record<string, RoomKeyring> = {};
  for (const [roomId, entry] of Object.entries(map)) {
    const keysById: Record<string, RoomSecretKeyBundle> = {};
    let activeKey: RoomSecretKeyBundle | null = null;
    for (const [keyId, rawB64] of Object.entries(entry.keys ?? {})) {
      try {
        const bundle = await importRoomKeyFromRawB64(rawB64);
        keysById[bundle.roomKeyId] = bundle;
        if (bundle.roomKeyId === entry.activeKeyId || keyId === entry.activeKeyId) {
          activeKey = bundle;
        }
      } catch {
        // Ignore corrupted key entry
      }
    }
    const allBundles = Object.values(keysById);
    if (!activeKey && allBundles.length > 0) {
      activeKey = allBundles[allBundles.length - 1];
    }
    if (activeKey) {
      result[roomId] = { activeKey, keysById };
    }
  }
  return result;
}

/**
 * Вычисляет общий секрет X25519 между локальным приватным ключом и 32-байтным публичным ключом собеседника,
 * затем формирует 256-битный ключ обёртки AES-GCM через SHA-256(sharedSecret || "liaper-x25519-wrap-v1").
 */
async function deriveSharedWrappingKey(
  myPrivateKey: CryptoKey,
  peerPublicKeyB64: string
): Promise<CryptoKey> {
  const peerPubBytes = base64ToBytes(peerPublicKeyB64);
  if (peerPubBytes.byteLength !== 32) {
    throw new Error('Invalid X25519 public key length');
  }
  const peerPublicKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(peerPubBytes),
    { name: 'X25519' },
    false,
    []
  );

  const sharedSecretBuf = await crypto.subtle.deriveBits(
    { name: 'X25519', public: peerPublicKey },
    myPrivateKey,
    256
  );
  const sharedBytes = new Uint8Array(sharedSecretBuf);
  const combined = new Uint8Array(sharedBytes.byteLength + WRAP_DOMAIN_LABEL.byteLength);
  combined.set(sharedBytes, 0);
  combined.set(WRAP_DOMAIN_LABEL, sharedBytes.byteLength);

  const digestBuf = await crypto.subtle.digest('SHA-256', toArrayBuffer(combined));
  return crypto.subtle.importKey(
    'raw',
    digestBuf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Запечатывает симметричный ключ комнаты (AES-256-GCM) персонально для публичного ключа X25519.
 */
export async function createEncryptedKeyEnvelope(params: {
  roomId: string;
  senderId: string;
  senderUsername: string;
  senderPublicKeyB64: string;
  myPrivateKey: CryptoKey;
  recipientId: string;
  recipientUsername: string;
  recipientPublicKeyB64: string;
  roomKeyBundle: RoomSecretKeyBundle;
}): Promise<E2eeKeyEnvelope> {
  const sharedKey = await deriveSharedWrappingKey(
    params.myPrivateKey,
    params.recipientPublicKeyB64
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const rawRoomKeyBytes = base64ToBytes(params.roomKeyBundle.rawKeyB64);

  const encryptedBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    sharedKey,
    toArrayBuffer(rawRoomKeyBytes)
  );

  return {
    room_id: params.roomId,
    sender_id: params.senderId,
    sender_username: params.senderUsername,
    sender_public_key: params.senderPublicKeyB64,
    recipient_id: params.recipientId,
    recipient_username: params.recipientUsername,
    encrypted_room_key_b64: bytesToBase64(new Uint8Array(encryptedBuf)),
    iv_b64: bytesToBase64(iv),
    room_key_id: params.roomKeyBundle.roomKeyId,
  };
}

/**
 * Создаёт конверты ключа комнаты для всех активных X25519-ключей пользователя.
 */
export async function createEncryptedKeyEnvelopesForUser(params: {
  roomId: string;
  senderId: string;
  senderUsername: string;
  senderPublicKeyB64: string;
  myPrivateKey: CryptoKey;
  recipientId: string;
  recipientUsername: string;
  recipientPublicKeysField: string;
  roomKeyBundle: RoomSecretKeyBundle;
}): Promise<E2eeKeyEnvelope[]> {
  const pubKeys = extractX25519PublicKeys(params.recipientPublicKeysField);
  const envelopes: E2eeKeyEnvelope[] = [];
  for (const pubKeyB64 of pubKeys) {
    try {
      const env = await createEncryptedKeyEnvelope({
        roomId: params.roomId,
        senderId: params.senderId,
        senderUsername: params.senderUsername,
        senderPublicKeyB64: params.senderPublicKeyB64,
        myPrivateKey: params.myPrivateKey,
        recipientId: params.recipientId,
        recipientUsername: params.recipientUsername,
        recipientPublicKeyB64: pubKeyB64,
        roomKeyBundle: params.roomKeyBundle,
      });
      envelopes.push(env);
    } catch {
      // Skip invalid key
    }
  }
  return envelopes;
}

/**
 * Распечатывает полученный конверт с ключом комнаты через X25519.
 */
export async function openEncryptedKeyEnvelope(
  envelope: E2eeKeyEnvelope,
  myPrivateKey: CryptoKey
): Promise<RoomSecretKeyBundle> {
  const senderKeys = extractX25519PublicKeys(envelope.sender_public_key);
  const senderPubB64 = senderKeys[0] ?? envelope.sender_public_key.trim();
  const sharedKey = await deriveSharedWrappingKey(myPrivateKey, senderPubB64);
  const iv = base64ToBytes(envelope.iv_b64);
  const cipherBytes = base64ToBytes(envelope.encrypted_room_key_b64);

  const decryptedRawBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    sharedKey,
    toArrayBuffer(cipherBytes)
  );

  const rawKeyB64 = bytesToBase64(new Uint8Array(decryptedRawBuf));
  return importRoomKeyFromRawB64(rawKeyB64);
}

export function serializeChatPayload(text: string, attachment?: ChatAttachmentMeta): string {
  if (!attachment) {
    return text;
  }
  const payload: RichChatPayload = {
    _liaper_msg: 1,
    text,
    attachment,
  };
  return JSON.stringify(payload);
}

export function parseChatPayload(
  rawPlaintext: string,
  allowAttachment: boolean
): { text: string; attachment?: ChatAttachmentMeta } {
  const trimmed = rawPlaintext.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<RichChatPayload>;
      if (parsed && parsed._liaper_msg === 1) {
        return {
          text: typeof parsed.text === 'string' ? parsed.text : '',
          attachment: allowAttachment && parsed.attachment ? parsed.attachment : undefined,
        };
      }
    } catch {
      // Plain text that happened to start with '{'
    }
  }
  return { text: rawPlaintext };
}

/**
 * Шифрует текстовое сообщение чата (или JSON-пакет с метаданными вложения) ключом комнаты (AES-256-GCM).
 */
export async function encryptChatText(
  plaintext: string,
  roomKey: RoomSecretKeyBundle
): Promise<{ ciphertextB64: string; ivB64: string; roomKeyId: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    roomKey.cryptoKey,
    toArrayBuffer(encoded)
  );
  return {
    ciphertextB64: bytesToBase64(new Uint8Array(cipherBuf)),
    ivB64: bytesToBase64(iv),
    roomKeyId: roomKey.roomKeyId,
  };
}

/**
 * Расшифровывает текстовое сообщение чата ключом комнаты (AES-256-GCM).
 */
export async function decryptChatText(
  ciphertextB64: string,
  ivB64: string,
  roomKey: RoomSecretKeyBundle
): Promise<string> {
  const iv = base64ToBytes(ivB64);
  const cipherBytes = base64ToBytes(ciphertextB64);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    roomKey.cryptoKey,
    toArrayBuffer(cipherBytes)
  );
  return new TextDecoder().decode(plainBuf);
}

/**
 * Расшифровывает сообщение чата с использованием связки ключей комнаты (включая ротированные ключи)
 * и безопасным fallback только для старых текстовых сообщений.
 */
export async function decryptChatMessageWithKeyring(params: {
  roomId: string;
  ciphertextB64: string;
  ivB64: string;
  roomKeyId: string;
  keyring?: RoomKeyring | null;
}): Promise<{
  plaintext: string;
  attachment?: ChatAttachmentMeta;
  verifiedE2ee: boolean;
}> {
  const candidateKeys: RoomSecretKeyBundle[] = [];
  if (params.keyring) {
    const exact = params.keyring.keysById[params.roomKeyId];
    if (exact) {
      candidateKeys.push(exact);
    }
    for (const k of Object.values(params.keyring.keysById)) {
      if (!candidateKeys.some((c) => c.roomKeyId === k.roomKeyId)) {
        candidateKeys.push(k);
      }
    }
  }

  for (const keyBundle of candidateKeys) {
    try {
      const raw = await decryptChatText(params.ciphertextB64, params.ivB64, keyBundle);
      const parsed = parseChatPayload(raw, true);
      return {
        plaintext: parsed.text,
        attachment: parsed.attachment,
        verifiedE2ee: true,
      };
    } catch {
      // Try next key in keyring
    }
  }

  // Fallback исключительно для исторических текстовых сообщений, зашифрованных старым ключом из room_id
  const legacyKey = await deriveLegacyRoomKeyFromId(params.roomId);
  if (params.roomKeyId === legacyKey.roomKeyId || params.roomKeyId.startsWith('rk-')) {
    const raw = await decryptChatText(params.ciphertextB64, params.ivB64, legacyKey);
    const parsed = parseChatPayload(raw, false);
    if (raw.includes('"_liaper_msg":1') && raw.includes('"attachment"')) {
      throw new Error('Legacy room_id key is not allowed for attachments');
    }
    return {
      plaintext: parsed.text,
      attachment: undefined,
      verifiedE2ee: false,
    };
  }

  throw new Error('Room key not available for message');
}
