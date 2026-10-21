import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEncryptedKeyEnvelopesForUser,
  decryptChatMessageWithKeyring,
  encryptChatText,
  generateRoomKey,
  getOrCreateIdentityKeys,
  openEncryptedKeyEnvelope,
  serializeChatPayload,
} from '../src/crypto/e2ee.ts';
import {
  classifyAttachmentFile,
  decodeLpvnVideoNote,
  decryptAttachmentBytes,
  encodeLpvnVideoNote,
  encodePcm16ToWav,
  encryptAttachmentBytes,
  sanitizeAttachmentFilename,
} from '../src/services/attachments.ts';

test('X25519 key envelope wraps random room key and rejects legacy room_id key for attachments', async () => {
  const alice = await getOrCreateIdentityKeys();
  const bob = await getOrCreateIdentityKeys();
  const roomKey = await generateRoomKey();
  const roomId = '1f734d16-93a8-426e-b45f-0263fdb8aea6';

  const envelopes = await createEncryptedKeyEnvelopesForUser({
    roomId,
    senderId: 'alice-id',
    senderUsername: 'alice',
    senderPublicKeyB64: alice.publicKeySpkiB64,
    myPrivateKey: alice.privateKey,
    recipientId: 'bob-id',
    recipientUsername: 'bob',
    recipientPublicKeysField: `invalid_legacy_key,${bob.publicKeySpkiB64}`,
    roomKeyBundle: roomKey,
  });

  assert.equal(envelopes.length, 1);
  const unwrapped = await openEncryptedKeyEnvelope(envelopes[0], bob.privateKey);
  assert.equal(unwrapped.rawKeyB64, roomKey.rawKeyB64);
  assert.equal(unwrapped.roomKeyId, roomKey.roomKeyId);

  const meta = {
    id: 'att-1',
    name: 'homework.pdf',
    mime_type: 'application/pdf',
    kind: 'pdf',
    plaintext_size: 1024,
    ciphertext_size: 1040,
    file_key_b64: roomKey.rawKeyB64,
    nonce_b64: 'AAAAAAAAAAAAAAAA',
    sha256_hex: '00'.repeat(32),
    expires_at: '2026-11-22T00:00:00Z',
  };
  const payload = serializeChatPayload('Конспект урока', meta);
  const encrypted = await encryptChatText(payload, unwrapped);

  const decrypted = await decryptChatMessageWithKeyring({
    roomId,
    ciphertextB64: encrypted.ciphertextB64,
    ivB64: encrypted.ivB64,
    roomKeyId: encrypted.roomKeyId,
    keyring: {
      activeKey: unwrapped,
      keysById: { [unwrapped.roomKeyId]: unwrapped },
    },
  });

  assert.equal(decrypted.verifiedE2ee, true);
  assert.equal(decrypted.plaintext, 'Конспект урока');
  assert.equal(decrypted.attachment?.id, 'att-1');

  // Outsider without keyring cannot decrypt
  await assert.rejects(
    decryptChatMessageWithKeyring({
      roomId,
      ciphertextB64: encrypted.ciphertextB64,
      ivB64: encrypted.ivB64,
      roomKeyId: encrypted.roomKeyId,
      keyring: null,
    })
  );
});

test('attachment AES-256-GCM encryption, LPVN container, and filename sanitization', async () => {
  assert.equal(sanitizeAttachmentFilename('../../etc/passwd'), 'passwd');
  assert.equal(classifyAttachmentFile('report.docx', '')?.kind, 'word');
  assert.equal(classifyAttachmentFile('task.pdf', 'application/pdf')?.kind, 'pdf');
  assert.equal(classifyAttachmentFile('photo.png', 'image/png')?.kind, 'image');
  assert.equal(classifyAttachmentFile('script.exe', 'application/octet-stream'), null);

  const rawData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const enc = await encryptAttachmentBytes(rawData);
  assert.equal(enc.ciphertextSize, rawData.byteLength + 16);

  const dec = await decryptAttachmentBytes(
    enc.ciphertextBytes,
    enc.fileKeyB64,
    enc.nonceB64,
    enc.sha256Hex
  );
  assert.deepEqual(dec, rawData);

  const wav = encodePcm16ToWav(new Int16Array([0, 1000, -1000, 500]), 16000);
  const lpvn = encodeLpvnVideoNote({
    durationMs: 1250,
    wavBytes: wav,
    frames: [
      { timestampMs: 0, jpegBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) },
      { timestampMs: 500, jpegBytes: new Uint8Array([0xff, 0xd8, 0x00, 0xff, 0xd9]) },
    ],
  });
  const parsed = decodeLpvnVideoNote(lpvn);
  assert.equal(parsed.durationMs, 1250);
  assert.deepEqual(parsed.wavBytes, wav);
  assert.equal(parsed.frames.length, 2);
  assert.equal(parsed.frames[1].timestampMs, 500);
});
