import type { MouseEvent } from 'react';
import { splitLinks } from '../services/links';

const isTauri = () => '__TAURI_INTERNALS__' in window;

// В десктопе ссылка из webview сама не откроется — отдаём её системному браузеру
function openInDesktopBrowser(e: MouseEvent<HTMLAnchorElement>, href: string) {
  if (!isTauri()) return;
  e.preventDefault();
  import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(href))
    .catch(() => {});
}

/** Текст сообщения с кликабельными ссылками; цвет ссылки берётся из пузыря сообщения. */
export function LinkifiedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((part, i) =>
        part.href ? (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => openInDesktopBrowser(e, part.href!)}
            className="break-all underline decoration-current/50 underline-offset-2 hover:decoration-current"
          >
            {part.text}
          </a>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
