import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLinks } from '../src/services/links.ts';

const links = (text) => splitLinks(text).filter((p) => p.href).map((p) => p.href);

test('находит http(s) и www-ссылки, текст вокруг сохраняется', () => {
  const parts = splitLinks('Смотри https://liaper.ru/docs и www.example.com, ок?');
  assert.equal(parts.map((p) => p.text).join(''), 'Смотри https://liaper.ru/docs и www.example.com, ок?');
  assert.deepEqual(links('Смотри https://liaper.ru/docs и www.example.com, ок?'), ['https://liaper.ru/docs', 'https://www.example.com']);
});

test('знаки препинания и скобка вокруг ссылки в адрес не входят', () => {
  assert.deepEqual(links('(см. https://a.ru/x).'), ['https://a.ru/x']);
  assert.deepEqual(links('https://ru.wikipedia.org/wiki/Мост_(значения)'), ['https://ru.wikipedia.org/wiki/Мост_(значения)']);
  assert.deepEqual(links('Ссылка: http://a.ru!'), ['http://a.ru']);
});

test('опасные схемы не становятся ссылками', () => {
  assert.deepEqual(links('javascript:alert(1) file:///etc/passwd ftp://a.ru'), []);
  assert.deepEqual(links('просто текст без ссылок'), []);
});
