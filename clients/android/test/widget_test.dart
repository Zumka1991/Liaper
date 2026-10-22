import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:liaper_android/main.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUp(() {
    SharedPreferences.setMockInitialValues({
      'liaper_pub_key': 'test-device-key',
      'liaper_fp': 'test-fingerprint',
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
            const MethodChannel('FlutterWebRTC.Method'),
            (call) async =>
                call.method == 'createVideoRenderer' ? {'textureId': 1} : null);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
            const MethodChannel('com.liaper.audio'), (call) async => null);
  });

  Future<void> openApp(WidgetTester tester, Size size,
      {double textScale = 1}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await tester.pumpWidget(const LiaperMobileApp());
    await tester.pumpAndSettle();
  }

  testWidgets('Login validates locally and exposes password visibility',
      (tester) async {
    await openApp(tester, const Size(390, 844));
    expect(find.text('Liaper'), findsOneWidget);
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Войти'));
    await tester.tap(find.widgetWithText(FilledButton, 'Войти'));
    await tester.pumpAndSettle();
    expect(find.text('Введите никнейм и пароль.'), findsOneWidget);
    final password = find.byWidgetPredicate(
        (w) => w is TextField && w.decoration?.labelText == 'Пароль');
    expect(tester.widget<TextField>(password).obscureText, isTrue);
    await tester.ensureVisible(find.byTooltip('Показать пароль'));
    await tester.tap(find.byTooltip('Показать пароль'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(password).obscureText, isFalse);
    expect(tester.takeException(), isNull);
  });

  for (final size in [const Size(320, 640), const Size(640, 320)]) {
    testWidgets(
        'Registration remains scrollable at $size with larger text and keyboard',
        (tester) async {
      await openApp(tester, size, textScale: 1.3);
      await tester.ensureVisible(find.text('Регистрация'));
      await tester.tap(find.text('Регистрация'));
      await tester.pumpAndSettle();
      await tester
          .ensureVisible(find.widgetWithText(FilledButton, 'Создать аккаунт'));
      expect(tester.takeException(), isNull);
      tester.view.viewInsets = const FakeViewPadding(bottom: 180);
      addTearDown(tester.view.resetViewInsets);
      await tester.pumpAndSettle();
      await tester
          .ensureVisible(find.widgetWithText(FilledButton, 'Создать аккаунт'));
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('Server settings explain the address on a physical phone',
      (tester) async {
    await openApp(tester, const Size(360, 740));
    await tester.ensureVisible(find.text('Настроить адрес сервера'));
    await tester.tap(find.text('Настроить адрес сервера'));
    await tester.pumpAndSettle();
    expect(find.textContaining('127.0.0.1 указывает на сам телефон.'),
        findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'Offline workspace fits a small phone and keeps lesson chat separate',
      (tester) async {
    SharedPreferences.setMockInitialValues({
      'liaper_pub_key': 'test-device-key',
      'liaper_fp': 'test-fingerprint',
      'liaper_token': 'test-session',
      'liaper_user': jsonEncode({
        'id': 'test-user',
        'username': 'student',
        'display_name': '',
        'role': 'student'
      }),
      'liaper_chat_archives': jsonEncode([
        {'id': 'legacy-other-user', 'title': 'Чужой архив', 'messages': []}
      ]),
    });
    await openApp(tester, const Size(320, 640), textScale: 1.3);
    // Короткий обрыв не показываем — баннер появляется, если связи нет дольше 3 с
    expect(find.text('Нет связи. Переподключаемся…'), findsNothing);
    await tester.pump(const Duration(seconds: 4));
    expect(find.text('Нет связи. Переподключаемся…'), findsOneWidget);
    expect(find.text('Добавить'),findsNothing);
    expect(find.text('Пока нет преподавателей'),findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('Сообщения'));
    await tester.pumpAndSettle();
    expect(find.text('Архив (0)'), findsOneWidget);
    expect(find.text('Чужой архив'), findsNothing);
    final composer = find.byWidgetPredicate(
        (w) => w is TextField && w.keyboardType == TextInputType.multiline);
    expect(tester.widget<TextField>(composer).enabled, isFalse);
    await tester.tap(find.text('Профиль'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    // Дать истечь таймаутам подключения к серверу и баннера «Нет связи»
    await tester.pump(const Duration(seconds: 11));
  });
}
