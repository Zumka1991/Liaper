import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:liaper_android/services/e2ee_attachments.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('X25519 envelope exchange and keyring chat encryption/decryption',
      () async {
    SharedPreferences.setMockInitialValues({});
    final prefsA = await SharedPreferences.getInstance();
    final alice = await AndroidE2eeService.getOrCreateIdentity(prefsA);

    SharedPreferences.setMockInitialValues({});
    final prefsB = await SharedPreferences.getInstance();
    final bob = await AndroidE2eeService.getOrCreateIdentity(prefsB);

    final roomKey = await AndroidE2eeService.generateRoomKey();
    final envelopes = await AndroidE2eeService.createKeyEnvelopesForUser(
      roomId: 'room-test-1',
      senderId: 'alice-id',
      senderUsername: 'alice',
      myIdentity: alice,
      recipientId: 'bob-id',
      recipientUsername: 'bob',
      recipientPublicKeysField: bob.publicKeyB64,
      roomKeyBundle: roomKey,
    );
    expect(envelopes.length, 1);

    final opened =
        await AndroidE2eeService.openKeyEnvelope(envelopes.first, bob);
    expect(opened.roomKeyId, roomKey.roomKeyId);
    expect(opened.rawKeyB64, roomKey.rawKeyB64);

    final keyring = RoomKeyring(
      activeKey: opened,
      keysById: {opened.roomKeyId: opened},
    );

    const meta = ChatAttachmentMeta(
      id: 'att-100',
      name: 'homework.pdf',
      mimeType: 'application/pdf',
      kind: 'pdf',
      plaintextSize: 4096,
      ciphertextSize: 4112,
      fileKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      nonceB64: 'AAAAAAAAAAAAAAAA',
      sha256Hex:
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      expiresAt: '2026-11-22T00:00:00Z',
    );

    final serialized =
        AndroidE2eeService.serializeChatPayload('Домашнее задание', meta);
    final enc =
        await AndroidE2eeService.encryptChatWithBundle(serialized, roomKey);

    final dec = await AndroidE2eeService.decryptChatMessageWithKeyring(
      roomId: 'room-test-1',
      ciphertextB64: enc['ciphertext_b64']!,
      ivB64: enc['iv_b64']!,
      roomKeyId: enc['room_key_id']!,
      keyring: keyring,
    );
    expect(dec.verifiedE2ee, isTrue);
    expect(dec.plaintext, 'Домашнее задание');
    expect(dec.attachment?.id, 'att-100');
    expect(dec.attachment?.kind, 'pdf');

    // Legacy room_id key must NEVER be accepted for attachment payloads
    final legacyKey =
        AndroidE2eeService.deriveLegacyRoomKeyFromId('room-test-1');
    final forged =
        await AndroidE2eeService.encryptChatWithBundle(serialized, legacyKey);
    expect(
      () => AndroidE2eeService.decryptChatMessageWithKeyring(
        roomId: 'room-test-1',
        ciphertextB64: forged['ciphertext_b64']!,
        ivB64: forged['iv_b64']!,
        roomKeyId: forged['room_key_id']!,
        keyring: null,
      ),
      throwsFormatException,
    );
  });

  test('Attachment AES-GCM encryption and LPVN v1 container roundtrip',
      () async {
    final wav = Uint8List.fromList([82, 73, 70, 70, 1, 2, 3, 4]);
    final frame1 = Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0, 10, 20, 0xff, 0xd9]);
    final frame2 = Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0, 30, 40, 0xff, 0xd9]);

    final encoded = AndroidAttachmentService.encodeLpvnVideoNote(
      durationMs: 1500,
      wavBytes: wav,
      frames: [
        LpvnVideoFrame(timestampMs: 0, jpegBytes: frame1),
        LpvnVideoFrame(timestampMs: 125, jpegBytes: frame2),
      ],
    );

    final encrypted =
        await AndroidAttachmentService.encryptAttachmentBytes(encoded);
    final decrypted = await AndroidAttachmentService.decryptAttachmentBytes(
      ciphertextBytes: encrypted.ciphertextBytes,
      fileKeyB64: encrypted.fileKeyB64,
      nonceB64: encrypted.nonceB64,
      expectedSha256Hex: encrypted.sha256Hex,
    );

    final decoded = AndroidAttachmentService.decodeLpvnVideoNote(decrypted);
    expect(decoded.durationMs, 1500);
    expect(decoded.wavBytes, wav);
    expect(decoded.frames.length, 2);
    expect(decoded.frames[1].timestampMs, 125);
    expect(decoded.frames[1].jpegBytes, frame2);
  });
}
