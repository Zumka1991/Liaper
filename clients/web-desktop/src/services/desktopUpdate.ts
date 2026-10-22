// Обновление десктопа изнутри приложения: Tauri updater скачивает сборку, проверяет подпись
// (ключ в tauri.conf.json), ставит её и перезапускает приложение.
// На Windows установщик NSIS в тихом режиме сам закрывает и снова открывает Liaper.

import type { Update } from '@tauri-apps/plugin-updater';

export const isDesktopApp = () => '__TAURI_INTERNALS__' in window;

export type DesktopUpdate = Update;

/** null — обновлений нет или это не десктоп. */
export async function checkDesktopUpdate(): Promise<DesktopUpdate | null> {
  if (!isDesktopApp()) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  return check();
}

/** Скачивает, устанавливает и перезапускает. onProgress — доля от 0 до 1 (если размер известен). */
export async function installDesktopUpdate(update: DesktopUpdate, onProgress: (ratio: number | null) => void): Promise<void> {
  let total = 0;
  let received = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
      onProgress(total > 0 ? 0 : null);
    } else if (event.event === 'Progress') {
      received += event.data.chunkLength;
      onProgress(total > 0 ? Math.min(1, received / total) : null);
    } else if (event.event === 'Finished') {
      onProgress(1);
    }
  });
  // Windows-установщик закрывает приложение сам; на Linux перезапускаемся явно
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
