import 'package:flutter_test/flutter_test.dart';
import 'package:liaper_android/widgets/linkified_text.dart';

List<String?> links(String text) =>
    splitLinks(text).where((p) => p.href != null).map((p) => p.href).toList();

void main() {
  test('находит http(s) и www-ссылки, текст вокруг сохраняется', () {
    const text = 'Смотри https://liaper.ru/docs и www.example.com, ок?';
    expect(splitLinks(text).map((p) => p.text).join(), text);
    expect(links(text), ['https://liaper.ru/docs', 'https://www.example.com']);
  });

  test('знаки препинания и скобка вокруг ссылки в адрес не входят', () {
    expect(links('(см. https://a.ru/x).'), ['https://a.ru/x']);
    expect(links('https://ru.wikipedia.org/wiki/Мост_(значения)'),
        ['https://ru.wikipedia.org/wiki/Мост_(значения)']);
    expect(links('Ссылка: http://a.ru!'), ['http://a.ru']);
  });

  test('опасные схемы не становятся ссылками', () {
    expect(links('javascript:alert(1) file:///etc/passwd ftp://a.ru'), isEmpty);
  });
}
