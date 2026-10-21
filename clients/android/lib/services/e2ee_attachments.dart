import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

const int kMaxAttachmentCiphertextBytes = 128 * 1024 * 1024;
const int kMaxAttachmentPlaintextBytes = kMaxAttachmentCiphertextBytes - 16;

class AttachmentExpiredException implements Exception {
  final String message;
  const AttachmentExpiredException([this.message = 'Срок хранения истёк']);
  @override
  String toString() => message;
}

class AttachmentQuotaException implements Exception {
  final String message;
  const AttachmentQuotaException(
      [this.message =
          'Превышена квота хранилища (5 ГиБ на пользователя или 128 МиБ на файл)']);
  @override
  String toString() => message;
}

class ChatAttachmentMeta {
  final String id;
  final String name;
  final String mimeType;
  final String kind; // 'pdf' | 'word' | 'image' | 'voice' | 'video_note'
  final int plaintextSize;
  final int ciphertextSize;
  final String fileKeyB64;
  final String nonceB64;
  final String sha256Hex;
  final String expiresAt;
  final int? durationMs;
  final int? width;
  final int? height;

  const ChatAttachmentMeta({
    required this.id,
    required this.name,
    required this.mimeType,
    required this.kind,
    required this.plaintextSize,
    required this.ciphertextSize,
    required this.fileKeyB64,
    required this.nonceB64,
    required this.sha256Hex,
    required this.expiresAt,
    this.durationMs,
    this.width,
    this.height,
  });

  factory ChatAttachmentMeta.fromJson(Map<String, dynamic> json) {
    return ChatAttachmentMeta(
      id: (json['id'] ?? '').toString(),
      name: sanitizeAttachmentFilename((json['name'] ?? 'attachment').toString()),
      mimeType: (json['mime_type'] ?? 'application/octet-stream').toString(),
      kind: (json['kind'] ?? 'pdf').toString(),
      plaintextSize: (json['plaintext_size'] as num?)?.toInt() ?? 0,
      ciphertextSize: (json['ciphertext_size'] as num?)?.toInt() ?? 0,
      fileKeyB64: (json['file_key_b64'] ?? '').toString(),
      nonceB64: (json['nonce_b64'] ?? '').toString(),
      sha256Hex: (json['sha256_hex'] ?? '').toString(),
      expiresAt: (json['expires_at'] ?? '').toString(),
      durationMs: (json['duration_ms'] as num?)?.toInt(),
      width: (json['width'] as num?)?.toInt(),
      height: (json['height'] as num?)?.toInt(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'mime_type': mimeType,
      'kind': kind,
      'plaintext_size': plaintextSize,
      'ciphertext_size': ciphertextSize,
      'file_key_b64': fileKeyB64,
      'nonce_b64': nonceB64,
      'sha256_hex': sha256Hex,
      'expires_at': expiresAt,
      if (durationMs != null) 'duration_ms': durationMs,
      if (width != null) 'width': width,
      if (height != null) 'height': height,
    };
  }
}

class OutgoingAttachmentTransfer {
  final String localId;
  final String roomId;
  final String fileName;
  final String mimeType;
  final String kind;
  final Uint8List plaintextBytes;
  final String captionText;
  final int? durationMs;
  final int? width;
  final int? height;
  double progress;
  String status; // 'uploading' | 'error'
  String? errorMessage;
  bool cancelled;

  OutgoingAttachmentTransfer({
    required this.localId,
    required this.roomId,
    required this.fileName,
    required this.mimeType,
    required this.kind,
    required this.plaintextBytes,
    required this.captionText,
    this.durationMs,
    this.width,
    this.height,
    this.progress = 0.05,
    this.status = 'uploading',
    this.errorMessage,
    this.cancelled = false,
  });
}

String sanitizeAttachmentFilename(String rawName, [String fallbackExt = '']) {
  final normalized = rawName.replaceAll('\\', '/').split('/').last;
  final cleaned = normalized
      .replaceAll(RegExp(r'[\u0000-\u001f\u007f<>:"/\\|?*]+'), '_')
      .replaceFirst(RegExp(r'^\.+'), '')
      .trim();
  if (cleaned.isEmpty) {
    return 'file$fallbackExt';
  }
  return cleaned.length > 120 ? cleaned.substring(0, 120) : cleaned;
}

Map<String, String>? classifyAttachmentFile(String fileName, String mimeType) {
  final lowerName = fileName.toLowerCase().trim();
  final lowerMime = mimeType.toLowerCase().trim();

  if (lowerMime == 'application/pdf' || lowerName.endsWith('.pdf')) {
    return {'kind': 'pdf', 'mimeType': 'application/pdf'};
  }
  if (lowerMime == 'application/msword' || lowerName.endsWith('.doc')) {
    return {'kind': 'word', 'mimeType': 'application/msword'};
  }
  if (lowerMime ==
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      lowerName.endsWith('.docx')) {
    return {
      'kind': 'word',
      'mimeType':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }
  if (lowerMime.startsWith('image/') ||
      RegExp(r'\.(png|jpe?g|webp|gif|bmp)$', caseSensitive: false)
          .hasMatch(lowerName)) {
    final resolvedMime = lowerMime.startsWith('image/')
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
    return {'kind': 'image', 'mimeType': resolvedMime};
  }
  if (lowerMime == 'audio/wav' ||
      lowerMime == 'audio/x-wav' ||
      lowerName.endsWith('.wav')) {
    return {'kind': 'voice', 'mimeType': 'audio/wav'};
  }
  if (lowerMime == 'application/x-liaper-videonote' ||
      lowerName.endsWith('.lpvn')) {
    return {
      'kind': 'video_note',
      'mimeType': 'application/x-liaper-videonote'
    };
  }
  return null;
}

String computeFingerprintFromBytes(List<int> bytes) {
  final digest = sha256.convert(bytes).bytes;
  final hex = digest
      .take(8)
      .map((b) => b.toRadixString(16).padLeft(2, '0').toUpperCase())
      .toList();
  return '${hex[0]}${hex[1]}:${hex[2]}${hex[3]}:${hex[4]}${hex[5]}:${hex[6]}${hex[7]}';
}

String computeRoomKeyIdFromBytes(List<int> bytes) {
  return computeFingerprintFromBytes(bytes).substring(0, 9);
}

List<String> extractX25519PublicKeys(String? rawField) {
  if (rawField == null || rawField.isEmpty) return [];
  final result = <String>[];
  for (final part in rawField.split(',')) {
    final trimmed = part.trim();
    if (trimmed.isEmpty) continue;
    try {
      final bytes = base64Decode(trimmed);
      if (bytes.length == 32 && !result.contains(trimmed)) {
        result.add(trimmed);
      }
    } catch (_) {}
  }
  return result;
}

class RoomSecretKeyBundle {
  final SecretKey secretKey;
  final String rawKeyB64;
  final String roomKeyId;

  const RoomSecretKeyBundle({
    required this.secretKey,
    required this.rawKeyB64,
    required this.roomKeyId,
  });

  static RoomSecretKeyBundle fromRawB64(String rawKeyB64) {
    final bytes = base64Decode(rawKeyB64.trim());
    if (bytes.length != 32) {
      throw const FormatException('Room key must be 32 bytes');
    }
    return RoomSecretKeyBundle(
      secretKey: SecretKey(bytes),
      rawKeyB64: base64Encode(bytes),
      roomKeyId: computeRoomKeyIdFromBytes(bytes),
    );
  }
}

class RoomKeyring {
  RoomSecretKeyBundle activeKey;
  final Map<String, RoomSecretKeyBundle> keysById;

  RoomKeyring({
    required this.activeKey,
    required this.keysById,
  });
}

class IdentityCryptoBundle {
  final SimpleKeyPair keyPair;
  final String publicKeyB64;
  final String fingerprint;

  const IdentityCryptoBundle({
    required this.keyPair,
    required this.publicKeyB64,
    required this.fingerprint,
  });
}

class AndroidE2eeService {
  static const String _kPrivKeyPref = 'liaper_priv_key_v2';
  static const String _kPubKeyPref = 'liaper_pub_key_v2';
  static const String _kFpPref = 'liaper_fp_v2';
  static const String _kRoomKeysPref = 'liaper_room_keys_v2';
  static final List<int> _wrapDomainLabel =
      utf8.encode('liaper-x25519-wrap-v1');

  static Future<IdentityCryptoBundle> getOrCreateIdentity(
      SharedPreferences prefs) async {
    final savedPriv = prefs.getString(_kPrivKeyPref);
    final savedPub = prefs.getString(_kPubKeyPref);
    final savedFp = prefs.getString(_kFpPref);

    if (savedPriv != null && savedPub != null && savedFp != null) {
      try {
        final privBytes = base64Decode(savedPriv);
        final pubBytes = base64Decode(savedPub);
        if (privBytes.length == 32 && pubBytes.length == 32) {
          final keyPair = SimpleKeyPairData(
            privBytes,
            publicKey: SimplePublicKey(pubBytes, type: KeyPairType.x25519),
            type: KeyPairType.x25519,
          );
          return IdentityCryptoBundle(
            keyPair: keyPair,
            publicKeyB64: savedPub,
            fingerprint: savedFp,
          );
        }
      } catch (_) {}
    }

    final algorithm = X25519();
    final keyPair = await algorithm.newKeyPair();
    final privBytes = await keyPair.extractPrivateKeyBytes();
    final pub = await keyPair.extractPublicKey();
    final pubB64 = base64Encode(pub.bytes);
    final privB64 = base64Encode(privBytes);
    final fp = computeFingerprintFromBytes(pub.bytes);

    await prefs.setString(_kPrivKeyPref, privB64);
    await prefs.setString(_kPubKeyPref, pubB64);
    await prefs.setString(_kFpPref, fp);
    // Совместимость со старыми ключами настроек
    await prefs.setString('liaper_pub_key', pubB64);
    await prefs.setString('liaper_fp', fp);

    return IdentityCryptoBundle(
      keyPair: keyPair,
      publicKeyB64: pubB64,
      fingerprint: fp,
    );
  }

  static Future<RoomSecretKeyBundle> generateRoomKey() async {
    final algorithm = AesGcm.with256bits();
    final secretKey = await algorithm.newSecretKey();
    final bytes = await secretKey.extractBytes();
    final rawB64 = base64Encode(bytes);
    return RoomSecretKeyBundle(
      secretKey: SecretKey(bytes),
      rawKeyB64: rawB64,
      roomKeyId: computeRoomKeyIdFromBytes(bytes),
    );
  }

  static RoomSecretKeyBundle deriveLegacyRoomKeyFromId(String roomId) {
    final digest = sha256.convert(utf8.encode('liaper-room-e2ee-v1:$roomId'));
    return RoomSecretKeyBundle(
      secretKey: SecretKey(digest.bytes),
      rawKeyB64: base64Encode(digest.bytes),
      roomKeyId: computeRoomKeyIdFromBytes(digest.bytes),
    );
  }

  static Future<SecretKey> _deriveSharedWrappingKey(
    SimpleKeyPair myKeyPair,
    String peerPublicKeyB64,
  ) async {
    final peerBytes = base64Decode(peerPublicKeyB64.trim());
    if (peerBytes.length != 32) {
      throw const FormatException('Invalid X25519 public key length');
    }
    final remotePub = SimplePublicKey(peerBytes, type: KeyPairType.x25519);
    final shared = await X25519().sharedSecretKey(
      keyPair: myKeyPair,
      remotePublicKey: remotePub,
    );
    final sharedBytes = await shared.extractBytes();
    final combined = Uint8List(sharedBytes.length + _wrapDomainLabel.length);
    combined.setRange(0, sharedBytes.length, sharedBytes);
    combined.setRange(sharedBytes.length, combined.length, _wrapDomainLabel);
    final digest = sha256.convert(combined).bytes;
    return SecretKey(digest);
  }

  static Future<List<Map<String, dynamic>>> createKeyEnvelopesForUser({
    required String roomId,
    required String senderId,
    required String senderUsername,
    required IdentityCryptoBundle myIdentity,
    required String recipientId,
    required String recipientUsername,
    required String? recipientPublicKeysField,
    required RoomSecretKeyBundle roomKeyBundle,
  }) async {
    final pubKeys = extractX25519PublicKeys(recipientPublicKeysField);
    final envelopes = <Map<String, dynamic>>[];
    final aes = AesGcm.with256bits();
    final rawRoomKeyBytes = base64Decode(roomKeyBundle.rawKeyB64);

    for (final pubKeyB64 in pubKeys) {
      try {
        final wrapKey =
            await _deriveSharedWrappingKey(myIdentity.keyPair, pubKeyB64);
        final nonce = aes.newNonce();
        final secretBox = await aes.encrypt(
          rawRoomKeyBytes,
          secretKey: wrapKey,
          nonce: nonce,
        );
        final combined =
            Uint8List(secretBox.cipherText.length + secretBox.mac.bytes.length);
        combined.setRange(0, secretBox.cipherText.length, secretBox.cipherText);
        combined.setRange(
            secretBox.cipherText.length, combined.length, secretBox.mac.bytes);

        envelopes.add({
          'room_id': roomId,
          'sender_id': senderId,
          'sender_username': senderUsername,
          'sender_public_key': myIdentity.publicKeyB64,
          'recipient_id': recipientId,
          'recipient_username': recipientUsername,
          'encrypted_room_key_b64': base64Encode(combined),
          'iv_b64': base64Encode(nonce),
          'room_key_id': roomKeyBundle.roomKeyId,
        });
      } catch (_) {}
    }
    return envelopes;
  }

  static Future<RoomSecretKeyBundle> openKeyEnvelope(
    Map<String, dynamic> envelope,
    IdentityCryptoBundle myIdentity,
  ) async {
    final senderField = (envelope['sender_public_key'] ?? '').toString();
    final senderKeys = extractX25519PublicKeys(senderField);
    final senderPubB64 =
        senderKeys.isNotEmpty ? senderKeys.first : senderField.trim();
    final wrapKey =
        await _deriveSharedWrappingKey(myIdentity.keyPair, senderPubB64);
    final nonce = base64Decode((envelope['iv_b64'] ?? '').toString());
    final combined =
        base64Decode((envelope['encrypted_room_key_b64'] ?? '').toString());
    if (combined.length < 16) {
      throw const FormatException('Encrypted room key too short');
    }
    final cipherText = combined.sublist(0, combined.length - 16);
    final macBytes = combined.sublist(combined.length - 16);
    final clearBytes = await AesGcm.with256bits().decrypt(
      SecretBox(cipherText, nonce: nonce, mac: Mac(macBytes)),
      secretKey: wrapKey,
    );
    return RoomSecretKeyBundle.fromRawB64(base64Encode(clearBytes));
  }

  static Map<String, RoomKeyring> loadSavedRoomKeyrings(
      SharedPreferences prefs) {
    final result = <String, RoomKeyring>{};
    try {
      final raw = prefs.getString(_kRoomKeysPref);
      if (raw == null || raw.isEmpty) return result;
      final decoded = jsonDecode(raw) as Map<String, dynamic>;
      decoded.forEach((roomId, value) {
        if (value is Map<String, dynamic>) {
          final activeKeyId = (value['activeKeyId'] ?? '').toString();
          final keysMap = value['keys'] as Map<String, dynamic>? ?? {};
          final keysById = <String, RoomSecretKeyBundle>{};
          RoomSecretKeyBundle? activeKey;
          keysMap.forEach((kId, rawB64) {
            try {
              final bundle =
                  RoomSecretKeyBundle.fromRawB64(rawB64.toString());
              keysById[bundle.roomKeyId] = bundle;
              if (bundle.roomKeyId == activeKeyId || kId == activeKeyId) {
                activeKey = bundle;
              }
            } catch (_) {}
          });
          if (activeKey == null && keysById.isNotEmpty) {
            activeKey = keysById.values.last;
          }
          if (activeKey != null) {
            result[roomId] =
                RoomKeyring(activeKey: activeKey!, keysById: keysById);
          }
        }
      });
    } catch (_) {}
    return result;
  }

  static Future<void> saveRoomKeyrings(
    SharedPreferences prefs,
    Map<String, RoomKeyring> keyrings,
  ) async {
    final serialized = <String, dynamic>{};
    keyrings.forEach((roomId, ring) {
      final keys = <String, String>{};
      ring.keysById.forEach((kId, bundle) {
        keys[kId] = bundle.rawKeyB64;
      });
      serialized[roomId] = {
        'activeKeyId': ring.activeKey.roomKeyId,
        'keys': keys,
      };
    });
    await prefs.setString(_kRoomKeysPref, jsonEncode(serialized));
  }

  static String serializeChatPayload(
      String text, ChatAttachmentMeta? attachment) {
    if (attachment == null) return text;
    return jsonEncode({
      '_liaper_msg': 1,
      'text': text,
      'attachment': attachment.toJson(),
    });
  }

  static ({String text, ChatAttachmentMeta? attachment}) parseChatPayload(
    String rawPlaintext, {
    required bool allowAttachment,
  }) {
    final trimmed = rawPlaintext.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        final parsed = jsonDecode(trimmed);
        if (parsed is Map<String, dynamic> && parsed['_liaper_msg'] == 1) {
          final text = (parsed['text'] ?? '').toString();
          ChatAttachmentMeta? att;
          if (allowAttachment && parsed['attachment'] is Map<String, dynamic>) {
            att = ChatAttachmentMeta.fromJson(
                parsed['attachment'] as Map<String, dynamic>);
          }
          return (text: text, attachment: att);
        }
      } catch (_) {}
    }
    return (text: rawPlaintext, attachment: null);
  }

  static Future<Map<String, String>> encryptChatWithBundle(
    String plaintext,
    RoomSecretKeyBundle roomKey,
  ) async {
    final aes = AesGcm.with256bits();
    final nonce = aes.newNonce();
    final secretBox = await aes.encrypt(
      utf8.encode(plaintext),
      secretKey: roomKey.secretKey,
      nonce: nonce,
    );
    final combined =
        Uint8List(secretBox.cipherText.length + secretBox.mac.bytes.length);
    combined.setRange(0, secretBox.cipherText.length, secretBox.cipherText);
    combined.setRange(
        secretBox.cipherText.length, combined.length, secretBox.mac.bytes);

    return {
      'ciphertext_b64': base64Encode(combined),
      'iv_b64': base64Encode(nonce),
      'room_key_id': roomKey.roomKeyId,
    };
  }

  static Future<String> _decryptRawWithBundle(
    String ciphertextB64,
    String ivB64,
    RoomSecretKeyBundle bundle,
  ) async {
    final combined = base64Decode(ciphertextB64);
    final nonce = base64Decode(ivB64);
    if (combined.length < 16) {
      throw const FormatException('Ciphertext too short');
    }
    final cipherText = combined.sublist(0, combined.length - 16);
    final macBytes = combined.sublist(combined.length - 16);
    final clearBytes = await AesGcm.with256bits().decrypt(
      SecretBox(cipherText, nonce: nonce, mac: Mac(macBytes)),
      secretKey: bundle.secretKey,
    );
    return utf8.decode(clearBytes);
  }

  static Future<({
    String plaintext,
    ChatAttachmentMeta? attachment,
    bool verifiedE2ee,
  })> decryptChatMessageWithKeyring({
    required String roomId,
    required String ciphertextB64,
    required String ivB64,
    required String roomKeyId,
    required RoomKeyring? keyring,
  }) async {
    final candidates = <RoomSecretKeyBundle>[];
    if (keyring != null) {
      final exact = keyring.keysById[roomKeyId];
      if (exact != null) candidates.add(exact);
      for (final b in keyring.keysById.values) {
        if (!candidates.any((c) => c.roomKeyId == b.roomKeyId)) {
          candidates.add(b);
        }
      }
    }

    for (final candidate in candidates) {
      try {
        final raw = await _decryptRawWithBundle(ciphertextB64, ivB64, candidate);
        final parsed = parseChatPayload(raw, allowAttachment: true);
        return (
          plaintext: parsed.text,
          attachment: parsed.attachment,
          verifiedE2ee: true,
        );
      } catch (_) {}
    }

    final legacy = deriveLegacyRoomKeyFromId(roomId);
    if (roomKeyId == legacy.roomKeyId || roomKeyId.startsWith('rk-')) {
      final raw = await _decryptRawWithBundle(ciphertextB64, ivB64, legacy);
      if (raw.contains('"_liaper_msg":1') && raw.contains('"attachment"')) {
        throw const FormatException(
            'Legacy room_id key is not allowed for attachments');
      }
      final parsed = parseChatPayload(raw, allowAttachment: false);
      return (
        plaintext: parsed.text,
        attachment: null,
        verifiedE2ee: false,
      );
    }

    throw const FormatException('Room key not available');
  }
}

class LpvnVideoFrame {
  final int timestampMs;
  final Uint8List jpegBytes;
  const LpvnVideoFrame({required this.timestampMs, required this.jpegBytes});
}

class DecodedLpvnVideoNote {
  final int durationMs;
  final Uint8List wavBytes;
  final List<LpvnVideoFrame> frames;
  const DecodedLpvnVideoNote({
    required this.durationMs,
    required this.wavBytes,
    required this.frames,
  });
}

class AndroidAttachmentService {
  static final Map<String, Uint8List> _decryptedCache = {};

  static Uint8List? getCachedBytes(String attachmentId) =>
      _decryptedCache[attachmentId];

  static void setCachedBytes(String attachmentId, Uint8List bytes) {
    _decryptedCache[attachmentId] = bytes;
  }

  static String resolveNodeHttpUrl(String controlBaseUrl, String nodeUrl) {
    try {
      final serverUri = Uri.parse(controlBaseUrl);
      final targetUri = Uri.parse(nodeUrl);
      if ((targetUri.host == '127.0.0.1' || targetUri.host == 'localhost') &&
          serverUri.host.isNotEmpty &&
          serverUri.host != '127.0.0.1' &&
          serverUri.host != 'localhost') {
        return targetUri.replace(host: serverUri.host).toString();
      }
    } catch (_) {}
    return nodeUrl;
  }

  static Future<({
    Uint8List ciphertextBytes,
    String fileKeyB64,
    String nonceB64,
    String sha256Hex,
  })> encryptAttachmentBytes(Uint8List plaintextBytes) async {
    if (plaintextBytes.isEmpty) {
      throw const FormatException('Файл пуст');
    }
    if (plaintextBytes.length > kMaxAttachmentPlaintextBytes) {
      throw const AttachmentQuotaException(
          'Файл превышает лимит 128 МиБ на одно вложение');
    }
    final aes = AesGcm.with256bits();
    final key = await aes.newSecretKey();
    final rawKeyBytes = await key.extractBytes();
    final nonce = aes.newNonce();

    final secretBox = await aes.encrypt(
      plaintextBytes,
      secretKey: key,
      nonce: nonce,
    );
    final combined =
        Uint8List(secretBox.cipherText.length + secretBox.mac.bytes.length);
    combined.setRange(0, secretBox.cipherText.length, secretBox.cipherText);
    combined.setRange(
        secretBox.cipherText.length, combined.length, secretBox.mac.bytes);

    final shaHex = sha256.convert(combined).toString();
    return (
      ciphertextBytes: combined,
      fileKeyB64: base64Encode(rawKeyBytes),
      nonceB64: base64Encode(nonce),
      sha256Hex: shaHex,
    );
  }

  static Future<Uint8List> decryptAttachmentBytes({
    required Uint8List ciphertextBytes,
    required String fileKeyB64,
    required String nonceB64,
    String? expectedSha256Hex,
  }) async {
    if (expectedSha256Hex != null && expectedSha256Hex.isNotEmpty) {
      final actualSha = sha256.convert(ciphertextBytes).toString();
      if (actualSha.toLowerCase() != expectedSha256Hex.toLowerCase()) {
        throw const FormatException(
            'Контрольная сумма SHA-256 зашифрованного вложения не совпала');
      }
    }
    if (ciphertextBytes.length < 16) {
      throw const FormatException('Повреждённое зашифрованное вложение');
    }
    final keyBytes = base64Decode(fileKeyB64);
    final nonce = base64Decode(nonceB64);
    final cipherText = ciphertextBytes.sublist(0, ciphertextBytes.length - 16);
    final macBytes = ciphertextBytes.sublist(ciphertextBytes.length - 16);

    final clear = await AesGcm.with256bits().decrypt(
      SecretBox(cipherText, nonce: nonce, mac: Mac(macBytes)),
      secretKey: SecretKey(keyBytes),
    );
    return Uint8List.fromList(clear);
  }

  static Future<ChatAttachmentMeta> uploadEncryptedAttachment({
    required String controlBaseUrl,
    required String token,
    required String roomId,
    required String fileName,
    required String mimeType,
    required String kind,
    required Uint8List plaintextBytes,
    int? durationMs,
    int? width,
    int? height,
    void Function(double progress)? onProgress,
    bool Function()? isCancelled,
  }) async {
    final safeName = sanitizeAttachmentFilename(fileName);
    onProgress?.call(0.08);

    final encrypted = await encryptAttachmentBytes(plaintextBytes);
    if (isCancelled?.call() == true) {
      throw Exception('Загрузка отменена');
    }
    onProgress?.call(0.2);

    final reserveRes = await http
        .post(
          Uri.parse('$controlBaseUrl/api/attachments'),
          headers: {
            'Authorization': 'Bearer $token',
            'Content-Type': 'application/json',
          },
          body: jsonEncode({
            'room_id': roomId,
            'size_bytes': encrypted.ciphertextBytes.length,
            'sha256': encrypted.sha256Hex,
          }),
        )
        .timeout(const Duration(seconds: 20));

    if (reserveRes.statusCode >= 400) {
      String errMsg =
          'Не удалось зарезервировать вложение (HTTP ${reserveRes.statusCode})';
      try {
        final body = jsonDecode(reserveRes.body) as Map<String, dynamic>;
        if (body['error'] != null) errMsg = body['error'].toString();
      } catch (_) {}
      if (reserveRes.statusCode == 507 || reserveRes.statusCode == 413) {
        throw AttachmentQuotaException(errMsg);
      }
      throw Exception(errMsg);
    }

    final reservation = jsonDecode(reserveRes.body) as Map<String, dynamic>;
    final attachmentId = reservation['attachment_id'].toString();
    final rawUploadUrl = reservation['upload_url'].toString();
    final uploadToken = (reservation['upload_token'] ?? '').toString();
    final uploadUrl = resolveNodeHttpUrl(controlBaseUrl, rawUploadUrl);

    if (isCancelled?.call() == true) {
      throw Exception('Загрузка отменена');
    }
    onProgress?.call(0.45);

    final putRes = await http
        .put(
          Uri.parse(uploadUrl),
          headers: {
            'Authorization': 'Bearer $uploadToken',
            'Content-Type': 'application/octet-stream',
          },
          body: encrypted.ciphertextBytes,
        )
        .timeout(const Duration(seconds: 60));

    if (putRes.statusCode >= 400) {
      if (putRes.statusCode == 413) {
        throw const AttachmentQuotaException(
            'Размер вложения превышает лимит 128 МиБ');
      }
      if (putRes.statusCode == 507) {
        throw const AttachmentQuotaException(
            'На файловой ноде недостаточно места');
      }
      throw Exception('Ошибка файловой ноды (HTTP ${putRes.statusCode})');
    }

    onProgress?.call(0.85);
    if (isCancelled?.call() == true) {
      throw Exception('Загрузка отменена');
    }

    String expiresAt = '';
    String receipt = '';
    try {
      final putJson = jsonDecode(putRes.body) as Map<String, dynamic>;
      expiresAt = (putJson['expires_at'] ?? '').toString();
      receipt = (putJson['receipt'] ?? '').toString();
    } catch (_) {}

    if (receipt.isNotEmpty) {
      final completeRes = await http
          .post(
            Uri.parse('$controlBaseUrl/api/attachments/$attachmentId/complete'),
            headers: {
              'Authorization': 'Bearer $token',
              'Content-Type': 'application/json',
            },
            body: jsonEncode({'receipt': receipt}),
          )
          .timeout(const Duration(seconds: 20));

      if (completeRes.statusCode >= 200 && completeRes.statusCode < 300) {
        try {
          final completed =
              jsonDecode(completeRes.body) as Map<String, dynamic>;
          final exp = (completed['expires_at'] ?? '').toString();
          if (exp.isNotEmpty) expiresAt = exp;
        } catch (_) {}
      }
    }

    setCachedBytes(attachmentId, plaintextBytes);
    onProgress?.call(1.0);

    return ChatAttachmentMeta(
      id: attachmentId,
      name: safeName,
      mimeType: mimeType,
      kind: kind,
      plaintextSize: plaintextBytes.length,
      ciphertextSize: encrypted.ciphertextBytes.length,
      fileKeyB64: encrypted.fileKeyB64,
      nonceB64: encrypted.nonceB64,
      sha256Hex: encrypted.sha256Hex,
      expiresAt: expiresAt,
      durationMs: durationMs,
      width: width,
      height: height,
    );
  }

  static Future<Uint8List> downloadAndDecryptAttachment({
    required String controlBaseUrl,
    required String token,
    required ChatAttachmentMeta meta,
    void Function(double progress)? onProgress,
  }) async {
    final cached = getCachedBytes(meta.id);
    if (cached != null) {
      onProgress?.call(1.0);
      return cached;
    }

    onProgress?.call(0.1);
    final grantRes = await http
        .get(
          Uri.parse('$controlBaseUrl/api/attachments/${meta.id}/download'),
          headers: {'Authorization': 'Bearer $token'},
        )
        .timeout(const Duration(seconds: 20));

    if (grantRes.statusCode == 410) {
      throw const AttachmentExpiredException('Срок хранения истёк');
    }
    if (grantRes.statusCode >= 400) {
      String errMsg =
          'Не удалось получить доступ к вложению (HTTP ${grantRes.statusCode})';
      try {
        final body = jsonDecode(grantRes.body) as Map<String, dynamic>;
        if (body['error'] != null) errMsg = body['error'].toString();
      } catch (_) {}
      throw Exception(errMsg);
    }

    final grant = jsonDecode(grantRes.body) as Map<String, dynamic>;
    final rawDownloadUrl = grant['download_url'].toString();
    final downloadToken = (grant['download_token'] ?? '').toString();
    final downloadUrl = resolveNodeHttpUrl(controlBaseUrl, rawDownloadUrl);
    onProgress?.call(0.35);

    final blobRes = await http
        .get(
          Uri.parse(downloadUrl),
          headers: {'Authorization': 'Bearer $downloadToken'},
        )
        .timeout(const Duration(seconds: 60));
    if (blobRes.statusCode == 410) {
      throw const AttachmentExpiredException('Срок хранения истёк');
    }
    if (blobRes.statusCode >= 400) {
      throw Exception(
          'Ошибка скачивания с файловой ноды (HTTP ${blobRes.statusCode})');
    }

    onProgress?.call(0.8);
    final plaintext = await decryptAttachmentBytes(
      ciphertextBytes: blobRes.bodyBytes,
      fileKeyB64: meta.fileKeyB64,
      nonceB64: meta.nonceB64,
      expectedSha256Hex: meta.sha256Hex.isNotEmpty
          ? meta.sha256Hex
          : grant['sha256']?.toString(),
    );
    setCachedBytes(meta.id, plaintext);
    onProgress?.call(1.0);
    return plaintext;
  }

  static Uint8List encodeLpvnVideoNote({
    required int durationMs,
    required Uint8List wavBytes,
    required List<LpvnVideoFrame> frames,
  }) {
    int totalLen = 20 + wavBytes.length;
    for (final f in frames) {
      totalLen += 8 + f.jpegBytes.length;
    }
    final out = Uint8List(totalLen);
    final bd = ByteData.sublistView(out);
    // "LPVN"
    bd.setUint8(0, 0x4c);
    bd.setUint8(1, 0x50);
    bd.setUint8(2, 0x56);
    bd.setUint8(3, 0x4e);
    bd.setUint32(4, 1, Endian.little);
    bd.setUint32(8, durationMs.clamp(0, 0x7fffffff), Endian.little);
    bd.setUint32(12, wavBytes.length, Endian.little);
    bd.setUint32(16, frames.length, Endian.little);

    int offset = 20;
    out.setRange(offset, offset + wavBytes.length, wavBytes);
    offset += wavBytes.length;

    for (final f in frames) {
      bd.setUint32(offset, f.timestampMs.clamp(0, 0x7fffffff), Endian.little);
      bd.setUint32(offset + 4, f.jpegBytes.length, Endian.little);
      offset += 8;
      out.setRange(offset, offset + f.jpegBytes.length, f.jpegBytes);
      offset += f.jpegBytes.length;
    }
    return out;
  }

  static DecodedLpvnVideoNote decodeLpvnVideoNote(Uint8List bytes) {
    if (bytes.length < 20) {
      throw const FormatException('Повреждённый контейнер видеокружка');
    }
    final bd = ByteData.sublistView(bytes);
    if (bd.getUint8(0) != 0x4c ||
        bd.getUint8(1) != 0x50 ||
        bd.getUint8(2) != 0x56 ||
        bd.getUint8(3) != 0x4e) {
      throw const FormatException('Неизвестный формат видеокружка');
    }
    final version = bd.getUint32(4, Endian.little);
    if (version != 1) {
      throw FormatException('Неподдерживаемая версия видеокружка: $version');
    }
    final durationMs = bd.getUint32(8, Endian.little);
    final wavLen = bd.getUint32(12, Endian.little);
    final frameCount = bd.getUint32(16, Endian.little);
    if (20 + wavLen > bytes.length) {
      throw const FormatException('Повреждённая аудиодорожка видеокружка');
    }
    final wavBytes = Uint8List.fromList(bytes.sublist(20, 20 + wavLen));
    int offset = 20 + wavLen;
    final frames = <LpvnVideoFrame>[];
    for (int i = 0; i < frameCount; i++) {
      if (offset + 8 > bytes.length) break;
      final ts = bd.getUint32(offset, Endian.little);
      final jpegLen = bd.getUint32(offset + 4, Endian.little);
      offset += 8;
      if (offset + jpegLen > bytes.length) break;
      final jpeg = Uint8List.fromList(bytes.sublist(offset, offset + jpegLen));
      offset += jpegLen;
      frames.add(LpvnVideoFrame(timestampMs: ts, jpegBytes: jpeg));
    }
    return DecodedLpvnVideoNote(
      durationMs: durationMs,
      wavBytes: wavBytes,
      frames: frames,
    );
  }

  static String formatBytesRu(int bytes) {
    if (bytes >= 1024 * 1024 * 1024) {
      return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(2)} ГиБ';
    }
    if (bytes >= 1024 * 1024) {
      return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} МиБ';
    }
    if (bytes >= 1024) {
      return '${(bytes / 1024).toStringAsFixed(1)} КиБ';
    }
    return '$bytes Б';
  }

  static String formatDurationMmSs(int ms) {
    final totalSec = (ms / 1000).round().clamp(0, 86400);
    final m = totalSec ~/ 60;
    final s = totalSec % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }
}
