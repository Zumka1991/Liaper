import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:http/http.dart' as http;

class ArchiveCrypto {
  static Future<SecretKey> deriveKey(String password, String userId) => Pbkdf2(
        macAlgorithm: Hmac.sha256(),
        iterations: 210000,
        bits: 256,
      ).deriveKey(
          secretKey: SecretKey(utf8.encode(password)),
          nonce: utf8.encode('liaper-archive-key-v1:$userId'));

  static List<int> _aad(String userId, String archiveId) =>
      utf8.encode('liaper-lesson-archive-v1:$userId:$archiveId');

  static Future<Map<String, dynamic>> encrypt(
      Map<String, dynamic> archive, SecretKey key, String userId) async {
    final aes = AesGcm.with256bits();
    final nonce = aes.newNonce();
    final box = await aes.encrypt(utf8.encode(jsonEncode(archive)),
        secretKey: key,
        nonce: nonce,
        aad: _aad(userId, archive['id'].toString()));
    return {
      'version': 1,
      'iv_b64': base64Encode(nonce),
      'ciphertext_b64': base64Encode([...box.cipherText, ...box.mac.bytes])
    };
  }

  static Future<Map<String, dynamic>> decrypt(
      Map<String, dynamic> blob, SecretKey key, String userId) async {
    if (blob['version'] != 1) {
      throw const FormatException('Эта версия архива пока не поддерживается');
    }
    final combined = base64Decode(blob['ciphertext_b64'] as String);
    if (combined.length < 16) throw const FormatException('Архив повреждён');
    final clear = await AesGcm.with256bits().decrypt(
        SecretBox(
          Uint8List.sublistView(combined, 0, combined.length - 16),
          nonce: base64Decode(blob['iv_b64'] as String),
          mac: Mac(combined.sublist(combined.length - 16)),
        ),
        secretKey: key,
        aad: _aad(userId, blob['archive_id'].toString()));
    final archive = jsonDecode(utf8.decode(clear)) as Map<String, dynamic>;
    if (archive['id'] != blob['archive_id'] || archive['messages'] is! List) {
      throw const FormatException('Архив повреждён');
    }
    return archive;
  }
}

Map<String, dynamic> mergeArchive(
    Map<String, dynamic> left, Map<String, dynamic> right) {
  final newer =
      left['savedAt'].toString().compareTo(right['savedAt'].toString()) > 0
          ? left
          : right;
  final messages = <String, dynamic>{};
  for (final dynamic raw in [
    ...left['messages'] as List,
    ...right['messages'] as List
  ]) {
    final message = Map<String, dynamic>.from(raw as Map);
    final identity = message['id']?.toString() ??
        jsonEncode([
          message['sender'],
          message['username'],
          message['sentAt'] ?? message['time'],
          message['text']
        ]);
    messages[identity] = message;
  }
  final ends = [left['endedAt'], right['endedAt']].whereType<String>().toList()
    ..sort();
  final sortedMessages = messages.values.toList()
    ..sort((a, b) => (a['sentAt'] ?? a['time'] ?? '')
        .toString()
        .compareTo((b['sentAt'] ?? b['time'] ?? '').toString()));
  return {
    ...newer,
    if (left['startedAt'] != null || right['startedAt'] != null)
      'startedAt': left['startedAt'] ?? right['startedAt'],
    if (ends.isNotEmpty) 'endedAt': ends.last,
    'messages': sortedMessages
  };
}

List<Map<String, dynamic>> mergeArchiveLists(
    List<Map<String, dynamic>> left, List<Map<String, dynamic>> right) {
  final entries = <String, Map<String, dynamic>>{};
  for (final archive in [...left, ...right]) {
    final id = archive['id'].toString();
    entries[id] =
        entries.containsKey(id) ? mergeArchive(entries[id]!, archive) : archive;
  }
  return entries.values.toList()
    ..sort(
        (a, b) => b['savedAt'].toString().compareTo(a['savedAt'].toString()));
}

String _canonical(Map<String, dynamic> archive) => jsonEncode([
      archive['title'],
      archive['startedAt'] ?? '',
      archive['endedAt'] ?? '',
      archive['savedAt'],
      (archive['messages'] as List)
          .map((m) => [
                m['id'] ?? '',
                m['sender'],
                m['username'],
                m['text'],
                m['time'] ?? '',
                m['sentAt'] ?? ''
              ])
          .toList()
    ]);

class ArchiveSyncException implements Exception {
  const ArchiveSyncException(this.message);
  final String message;
  @override
  String toString() => message;
}

Future<void> _checked(http.Response response) async {
  if (response.statusCode >= 200 && response.statusCode < 300) return;
  String? message;
  try {
    message = (jsonDecode(response.body) as Map)['error']?.toString();
  } catch (_) {}
  throw ArchiveSyncException(message ?? 'Не удалось синхронизировать архив');
}

Future<List<Map<String, dynamic>>> syncLessonArchives(
    {required String baseUrl,
    required String token,
    required SecretKey key,
    required String userId,
    required List<Map<String, dynamic>> local,
    http.Client? client}) async {
  final transport = client ?? http.Client();
  final headers = {
    'Authorization': 'Bearer $token',
    'Content-Type': 'application/json'
  };
  var pending = local;
  try {
    for (var attempt = 0; attempt < 3; attempt++) {
      final response = await transport
          .get(Uri.parse('$baseUrl/api/lesson-archives'), headers: headers)
          .timeout(const Duration(seconds: 15));
      await _checked(response);
      final blobs = (jsonDecode(response.body) as List)
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      final remote = <Map<String, dynamic>>[];
      for (final blob in blobs) {
        remote.add(await ArchiveCrypto.decrypt(blob, key, userId));
      }
      final combined = mergeArchiveLists(remote, pending);
      var conflict = false;
      for (final entry in combined) {
        final old = remote.where((r) => r['id'] == entry['id']).firstOrNull;
        if (old != null && _canonical(old) == _canonical(entry)) continue;
        final revision = blobs
                .where((b) => b['archive_id'] == entry['id'])
                .firstOrNull?['revision'] ??
            0;
        final encrypted = await ArchiveCrypto.encrypt(entry, key, userId);
        final write = await transport
            .put(Uri.parse('$baseUrl/api/lesson-archives/${entry['id']}'),
                headers: headers,
                body: jsonEncode({...encrypted, 'expected_revision': revision}))
            .timeout(const Duration(seconds: 15));
        if (write.statusCode == 409) {
          conflict = true;
          break;
        }
        await _checked(write);
      }
      if (!conflict) return combined;
      pending = combined;
    }
    throw const ArchiveSyncException(
        'Архив изменяется на другом устройстве. Повторите синхронизацию.');
  } finally {
    if (client == null) transport.close();
  }
}
