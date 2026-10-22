// Ссылки в тексте сообщений: только http(s) и www.; превью не грузим — переписка шифруется,
// а загрузка страницы выдала бы сайту, что ссылку кто-то открыл.

export type TextPart = { text: string; href?: string };

const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'«»]+/gi;
// Знаки препинания в конце обычно относятся к предложению, а не к адресу
const TRAILING_RE = /[.,!?;:…]+$/;

function trimTrailing(url: string): string {
  let out = url.replace(TRAILING_RE, '');
  // Закрывающая скобка без открывающей — это скобка вокруг ссылки: «(см. https://a.ru)»
  while (out.endsWith(')') && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, -1).replace(TRAILING_RE, '');
  }
  return out;
}

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_RE)) {
    const raw = trimTrailing(match[0]);
    if (!raw || /^(?:https?:\/\/|www\.)$/i.test(raw)) continue;
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    const href = /^www\./i.test(raw) ? `https://${raw}` : raw;
    parts.push({ text: raw, href });
    last = start + raw.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
