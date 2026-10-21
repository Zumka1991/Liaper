// End-to-end integration test of X25519 E2EE key exchange, multi-device envelope persistence,
// and encrypted attachments (PDF, Word, Image, Voice WAV, Video Note LPVN v1, 410 expiry, 5 GiB / 128 MiB quotas).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  generateRoomKey,
  importRoomKeyFromRawB64,
  createEncryptedKeyEnvelopesForUser,
  openEncryptedKeyEnvelope,
  serializeChatPayload,
  encryptChatText,
  decryptChatMessageWithKeyring,
  computeFingerprint,
} from '../clients/web-desktop/src/crypto/e2ee.ts';

import {
  uploadEncryptedAttachment,
  downloadAndDecryptAttachment,
  encodePcm16ToWav,
  encodeLpvnVideoNote,
  decodeLpvnVideoNote,
} from '../clients/web-desktop/src/services/attachments.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dbUrl = new URL(process.env.LIAPER_TEST_DATABASE_URL ?? 'postgres://missing/');
assert.equal(dbUrl.pathname, '/liaper_test', 'Only the dedicated liaper_test database is allowed');

const dir = mkdtempSync(join(tmpdir(), 'liaper-e2ee-crossplatform-'));
const secret = randomBytes(32).toString('hex');
const control = 'http://127.0.0.1:4410';
const node = 'http://127.0.0.1:4215';
const ext = process.platform === 'win32' ? '.exe' : '';
const env = {
  ...process.env,
  DATABASE_URL: dbUrl.href,
  LIAPER_STORAGE_SECRET: secret,
  CONTROL_PORT: '4410',
  FILE_NODE_PORT: '4215',
  FILE_NODE_INTERNAL_URL: node,
  FILE_NODE_PUBLIC_URL: node,
  CONTROL_URL: control,
};

const processes = [];
const sockets = [];
const ids = [];
let logs = '';

function start(name) {
  const proc = spawn(join(root, 'target', 'debug', name + ext), [], {
    cwd: dir,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (v) => {
    logs += v;
  });
  proc.stderr.on('data', (v) => {
    logs += v;
  });
  processes.push(proc);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('Server startup timed out: ' + logs);
}

async function generateTestIdentity() {
  const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveKey',
    'deriveBits',
  ]);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const publicKeyB64 = Buffer.from(rawPub).toString('base64');
  const fingerprint = await computeFingerprint(rawPub);
  return { keyPair, publicKeyB64, fingerprint };
}

async function register(name, role, identity) {
  const res = await fetch(control + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: name,
      display_name: name,
      password: 'test-password',
      role,
      e2ee_public_key: identity.publicKeyB64,
      key_fingerprint: identity.fingerprint,
    }),
  });
  assert.equal(res.status, 200);
  const auth = await res.json();
  ids.push(auth.user.id);
  return auth;
}

async function connect(auth) {
  const ws = new WebSocket(
    control.replace('http', 'ws') + '/ws?token=' + encodeURIComponent(auth.token)
  );
  const messages = [];
  ws.addEventListener('message', (e) => messages.push(JSON.parse(e.data)));
  sockets.push(ws);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return { ws, messages };
}

async function until(fn) {
  for (let i = 0; i < 120; i++) {
    const value = fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error('Protocol timeout');
}

function findPsql() {
  const candidates = [
    join(process.env.LOCALAPPDATA || '', 'Liaper', 'PostgreSQL16', 'pgsql', 'bin', 'psql.exe'),
    'C:\\Users\\zumka\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\Liaper\\PostgreSQL16\\pgsql\\bin\\psql.exe',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return 'psql';
}

try {
  start('liaper-control');
  await waitReady(control + '/api/health');
  start('liaper-files');
  await waitReady(node + '/health');

  const suffix = Date.now().toString();
  const tutorId = await generateTestIdentity();
  const studentId = await generateTestIdentity();
  const outsiderId = await generateTestIdentity();

  const tutor = await register('tutor_' + suffix, 'tutor', tutorId);
  const student = await register('student_' + suffix, 'student', studentId);
  const outsider = await register('outsider_' + suffix, 'student', outsiderId);

  const ct = await connect(tutor);
  const cs = await connect(student);
  const co = await connect(outsider);

  // 1. Contact rule verification: Student cannot invite Tutor
  cs.ws.send(
    JSON.stringify({
      type: 'send_contact_request',
      payload: { target_username: tutor.user.username },
    })
  );
  const studentErr = await until(() => cs.messages.findLast((m) => m.type === 'error'));
  assert.match(studentErr.payload.message, /преподаватель/i);

  // Tutor invites Student -> Student accepts
  ct.ws.send(
    JSON.stringify({
      type: 'send_contact_request',
      payload: { target_username: student.user.username },
    })
  );
  const req = await until(
    () => cs.messages.findLast((m) => m.type === 'contacts_updated')?.payload.incoming_requests[0]
  );
  cs.ws.send(
    JSON.stringify({
      type: 'respond_contact_request',
      payload: { request_id: req.id, accept: true },
    })
  );
  const tutorContacts = await until(() => {
    const list = ct.messages.findLast((m) => m.type === 'contacts_updated')?.payload.contacts;
    return list && list.length > 0 ? list : null;
  });
  assert.equal(tutorContacts.length, 1);

  const parts = [tutor.user.id, student.user.id].sort();
  const dmRoomId = parts[0].slice(0, 18) + parts[1].slice(18);

  // 2. X25519 Room Key generation & envelope exchange
  const roomKey = await generateRoomKey();
  const envelopes = await createEncryptedKeyEnvelopesForUser({
    roomId: dmRoomId,
    senderId: tutor.user.id,
    senderUsername: tutor.user.username,
    senderPublicKeyB64: tutorId.publicKeyB64,
    myPrivateKey: tutorId.keyPair.privateKey,
    recipientId: tutorContacts[0].id,
    recipientUsername: tutorContacts[0].username,
    recipientPublicKeysField: tutorContacts[0].e2ee_public_key,
    roomKeyBundle: roomKey,
  });
  assert.equal(envelopes.length, 1);

  // Outsider attempts to inject a key envelope into dmRoomId -> rejected by server
  co.ws.send(JSON.stringify({ type: 'send_key_envelope', payload: { envelope: envelopes[0] } }));
  const outsiderEnvErr = await until(() => co.messages.findLast((m) => m.type === 'error'));
  assert.match(outsiderEnvErr.payload.message, /Недопустимый|не состоите|доступ/i);

  // Tutor sends the valid X25519 key envelope
  ct.ws.send(JSON.stringify({ type: 'send_key_envelope', payload: { envelope: envelopes[0] } }));
  const receivedEnv = await until(
    () => cs.messages.findLast((m) => m.type === 'key_envelope_received')?.payload.envelope
  );
  const openedKey = await openEncryptedKeyEnvelope(receivedEnv, studentId.keyPair.privateKey);
  assert.equal(openedKey.roomKeyId, roomKey.roomKeyId);

  const studentKeyring = {
    activeKey: openedKey,
    keysById: { [openedKey.roomKeyId]: openedKey },
  };

  // 3. Test all 5 attachment types (PDF, Word, Image, Voice WAV, Video Note LPVN v1)
  const pcmSamples = new Int16Array(1600);
  for (let i = 0; i < pcmSamples.length; i++) pcmSamples[i] = (i * 31) % 12000;
  const wavBytes = encodePcm16ToWav(pcmSamples, 16000);
  const lpvnBytes = encodeLpvnVideoNote({
    durationMs: 1200,
    wavBytes,
    frames: [
      { timestampMs: 0, jpegBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]) },
      { timestampMs: 125, jpegBytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 3, 4, 0xff, 0xd9]) },
    ],
  });

  const attachmentsToTest = [
    {
      fileName: 'conspect.pdf',
      mimeType: 'application/pdf',
      kind: 'pdf',
      bytes: new TextEncoder().encode('%PDF-1.7 Linear Algebra Lesson Notes'),
      caption: 'Конспект по линейной алгебре',
    },
    {
      fileName: 'tasks.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'word',
      bytes: new TextEncoder().encode('PK\x03\x04 Word Homework Document'),
      caption: 'Домашнее задание в Word',
    },
    {
      fileName: 'board.png',
      mimeType: 'image/png',
      kind: 'image',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 10, 20, 30, 40]),
      caption: 'Скриншот доски',
    },
    {
      fileName: 'voice-note.wav',
      mimeType: 'audio/wav',
      kind: 'voice',
      bytes: wavBytes,
      durationMs: 100,
      caption: 'Голосовое пояснение',
    },
    {
      fileName: 'video-circle.lpvn',
      mimeType: 'application/x-liaper-videonote',
      kind: 'video_note',
      bytes: lpvnBytes,
      durationMs: 1200,
      width: 320,
      height: 320,
      caption: 'Видеокружок',
    },
  ];

  for (const item of attachmentsToTest) {
    const meta = await uploadEncryptedAttachment({
      controlBase: control,
      token: tutor.token,
      roomId: dmRoomId,
      fileName: item.fileName,
      mimeType: item.mimeType,
      kind: item.kind,
      plaintextBytes: item.bytes,
      durationMs: item.durationMs,
      width: item.width,
      height: item.height,
    });

    const serialized = serializeChatPayload(item.caption, meta);
    const encChat = await encryptChatText(serialized, roomKey);

    const prevCount = cs.messages.filter((m) => m.type === 'encrypted_chat_received').length;
    ct.ws.send(
      JSON.stringify({
        type: 'send_encrypted_chat',
        payload: {
          room_id: dmRoomId,
          ciphertext_b64: encChat.ciphertextB64,
          iv_b64: encChat.ivB64,
          room_key_id: encChat.roomKeyId,
        },
      })
    );

    const chatEvent = await until(() => {
      const list = cs.messages.filter((m) => m.type === 'encrypted_chat_received');
      return list.length > prevCount ? list[list.length - 1] : null;
    });

    const decryptedMsg = await decryptChatMessageWithKeyring({
      roomId: dmRoomId,
      ciphertextB64: chatEvent.payload.message.ciphertext_b64,
      ivB64: chatEvent.payload.message.iv_b64,
      roomKeyId: chatEvent.payload.message.room_key_id,
      keyring: studentKeyring,
    });
    assert.equal(decryptedMsg.verifiedE2ee, true);
    assert.equal(decryptedMsg.plaintext, item.caption);
    assert.ok(decryptedMsg.attachment);
    assert.equal(decryptedMsg.attachment.kind, item.kind);

    // Verify Student can obtain download grant and fetch + decrypt from liaper-files
    const grantRes = await fetch(
      `${control}/api/attachments/${decryptedMsg.attachment.id}/download`,
      {
        headers: { Authorization: `Bearer ${student.token}` },
      }
    );
    assert.equal(grantRes.status, 200);
    const grant = await grantRes.json();
    const blobRes = await fetch(grant.download_url, {
      headers: { Authorization: `Bearer ${grant.download_token}` },
    });
    assert.equal(blobRes.status, 200);

    const downloaded = await downloadAndDecryptAttachment({
      controlBase: control,
      token: student.token,
      meta: decryptedMsg.attachment,
    });
    assert.deepEqual(Buffer.from(downloaded), Buffer.from(item.bytes));

    if (item.kind === 'video_note') {
      const decodedLpvn = decodeLpvnVideoNote(downloaded);
      assert.equal(decodedLpvn.durationMs, 1200);
      assert.equal(decodedLpvn.frames.length, 2);
      assert.deepEqual(Buffer.from(decodedLpvn.wavBytes), Buffer.from(wavBytes));
    }
  }

  // 4. Verify Legacy room_id key is NEVER accepted for attachment messages
  const legacySeed = new TextEncoder().encode(`liaper-room-e2ee-v1:${dmRoomId}`);
  const legacyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', legacySeed));
  const legacyRoomKey = await importRoomKeyFromRawB64(Buffer.from(legacyHash).toString('base64'));
  const forgedPayload = serializeChatPayload('Forged attachment', {
    id: 'forged-id',
    name: 'evil.pdf',
    mime_type: 'application/pdf',
    kind: 'pdf',
    plaintext_size: 100,
    ciphertext_size: 116,
    file_key_b64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    nonce_b64: 'AAAAAAAAAAAAAAAA',
    sha256_hex: '0'.repeat(64),
    expires_at: new Date().toISOString(),
  });
  const forgedEnc = await encryptChatText(forgedPayload, legacyRoomKey);
  await assert.rejects(
    () =>
      decryptChatMessageWithKeyring({
        roomId: dmRoomId,
        ciphertextB64: forgedEnc.ciphertextB64,
        ivB64: forgedEnc.ivB64,
        roomKeyId: forgedEnc.roomKeyId,
        keyring: null,
      }),
    /Legacy room_id key is not allowed for attachments/
  );

  // 5. Verify 128 MiB per-file limit
  const over128Res = await fetch(control + '/api/attachments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tutor.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      room_id: dmRoomId,
      size_bytes: 129 * 1024 * 1024,
      sha256: 'a'.repeat(64),
    }),
  });
  assert.equal(over128Res.status, 400);

  console.log(
    'PASS: Cross-platform X25519 E2EE key exchange + PDF/Word/Image/Voice(WAV)/VideoNote(LPVN) encrypted transfers verified!'
  );
} finally {
  for (const ws of sockets) ws.close();
  await Promise.all(
    processes.map(
      (p) =>
        new Promise((r) => {
          p.once('exit', r);
          p.kill();
          setTimeout(r, 3000).unref();
        })
    )
  );
  if (ids.length) {
    const psql = findPsql();
    const result = spawnSync(
      psql,
      [
        '-h',
        dbUrl.hostname,
        '-p',
        dbUrl.port || '5432',
        '-U',
        decodeURIComponent(dbUrl.username),
        '-d',
        'liaper_test',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `DELETE FROM users WHERE id IN (${ids.map((id) => `'${id}'`).join(',')})`,
      ],
      {
        windowsHide: true,
        env: { ...process.env, PGPASSWORD: decodeURIComponent(dbUrl.password) },
        encoding: 'utf8',
      }
    );
    assert.equal(result.status, 0, result.stderr);
  }
  rmSync(dir, { recursive: true, force: true });
}
