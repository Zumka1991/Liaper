import 'package:flutter_test/flutter_test.dart';
import 'package:liaper_android/services/e2ee_attachments.dart';

void main() {
  test('пересланное сообщение: новый и старый формат', () {
    final raw = AndroidE2eeService.serializeChatPayload('Решите № 12', null,
        const ForwardedFrom(source: 'Урок', sender: 'Мария', time: '17:05'));
    final p = AndroidE2eeService.parseChatPayload(raw, allowAttachment: true);
    expect(p.text, 'Решите № 12');
    expect(p.forwarded?.sender, 'Мария');

    final legacy = AndroidE2eeService.parseChatPayload(
        'Переслано из архива «Теорема Виета» (Иван Петров @ivan, 16:30):\nx1 + x2 = -b',
        allowAttachment: true);
    expect(legacy.text, 'x1 + x2 = -b');
    expect(legacy.forwarded?.sender, 'Иван Петров');
    expect(legacy.forwarded?.username, 'ivan');
    expect(legacy.forwarded?.time, '16:30');
  });
}
