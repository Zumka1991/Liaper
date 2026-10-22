import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatPayload, serializeChatPayload } from '../src/crypto/e2ee.ts';

test('пересланное сообщение хранит источник отдельно от текста', () => {
  const raw = serializeChatPayload('Решите № 12', undefined, { source: 'Квадратные уравнения', sender: 'Мария', username: 'maria', time: '17:05' });
  const parsed = parseChatPayload(raw, true);
  assert.equal(parsed.text, 'Решите № 12');
  assert.deepEqual(parsed.forwarded, { source: 'Квадратные уравнения', sender: 'Мария', username: 'maria', time: '17:05' });
  assert.equal(serializeChatPayload('обычное'), 'обычное');
});

test('сообщения, пересланные старой версией, разбираются в компактный вид', () => {
  const parsed = parseChatPayload('Переслано из архива «Теорема Виета» (Иван Петров @ivan, 16:30):\nx1 + x2 = -b', true);
  assert.equal(parsed.text, 'x1 + x2 = -b');
  assert.deepEqual(parsed.forwarded, { source: 'Теорема Виета', sender: 'Иван Петров', username: 'ivan', time: '16:30' });
  assert.equal(parseChatPayload('Просто текст', true).forwarded, undefined);
});
