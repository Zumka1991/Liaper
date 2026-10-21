import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:liaper_android/services/lesson_archive.dart';

void main() {
  final fixture = jsonDecode(File('../../tests/fixtures/lesson-archive-v1.json')
      .readAsStringSync()) as Map<String, dynamic>;
  test('decrypts Web Crypto archive and authenticates owner, lesson and key',
      () async {
    final owner = fixture['userId'] as String;
    final archive = Map<String, dynamic>.from(fixture['archive'] as Map);
    final blob = Map<String, dynamic>.from(fixture['blob'] as Map);
    final key =
        await ArchiveCrypto.deriveKey(fixture['password'] as String, owner);
    expect(await ArchiveCrypto.decrypt(blob, key, owner), archive);
    final encrypted = await ArchiveCrypto.encrypt(archive, key, owner);
    expect(
        await ArchiveCrypto.decrypt(
            {...encrypted, 'archive_id': archive['id']}, key, owner),
        archive);
    await expectLater(
        ArchiveCrypto.decrypt(
            blob, await ArchiveCrypto.deriveKey('wrong', owner), owner),
        throwsA(anything));
    await expectLater(
        ArchiveCrypto.decrypt(blob, key, 'another-owner'), throwsA(anything));
    await expectLater(
        ArchiveCrypto.decrypt(
            {...blob, 'archive_id': 'another-lesson'}, key, owner),
        throwsA(anything));
  });
  test('merges concurrent archive messages without duplicates', () {
    final a = Map<String, dynamic>.from(fixture['archive'] as Map);
    final b = {
      ...a,
      'savedAt': '2026-10-22T12:01:00Z',
      'messages': [
        ...a['messages'] as List,
        {'id': 'message-2', 'text': 'Ответ'}
      ]
    };
    expect(mergeArchiveLists([a], [b]).single['messages'], hasLength(2));
  });
}
