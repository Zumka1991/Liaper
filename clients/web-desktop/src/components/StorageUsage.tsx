import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

type Usage = { used_bytes: number; reserved_bytes: number; quota_bytes: number };
function size(bytes: number): string {
  if (bytes === 0) return '0 Б';
  const unit = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return `${(bytes / 1024 ** unit).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${['Б', 'КиБ', 'МиБ', 'ГиБ'][unit]}`;
}
export function StorageUsage({
  baseUrl,
  token,
  refreshTrigger = 0,
}: {
  baseUrl: string;
  token: string;
  refreshTrigger?: number;
}) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { controller.abort(); setLoading(false); setError('Сервер не ответил. Повторите попытку.'); }, 15000);
    setLoading(true); setError(''); setUsage(null);
    void fetch(`${baseUrl}/api/storage/usage`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Не удалось получить данные хранилища');
        const result = await response.json() as Usage;
        if (!controller.signal.aborted) setUsage(result);
      }).catch(() => { if (!controller.signal.aborted) setError('Не удалось обновить занятое место. Проверьте соединение.'); })
      .finally(() => { window.clearTimeout(timeout); if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [baseUrl, token, attempt, refreshTrigger]);
  return <section aria-label="Хранилище" className="rounded-xl border border-slate-200 bg-white p-4">
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold text-slate-900">Хранилище</h3>
      <button type="button" disabled={loading} onClick={() => setAttempt((n) => n + 1)} aria-label="Обновить занятое место" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-40"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></button>
    </div>
    <div role="status" aria-live="polite" className="mt-2 text-sm text-slate-700">
      {usage ? <><p><strong>{size(usage.used_bytes)}</strong> из {size(usage.quota_bytes)}</p>
        <progress aria-label="Занятое место с учётом загрузок" value={usage.used_bytes + usage.reserved_bytes} max={usage.quota_bytes} className="storage-meter my-3 h-2 w-full" />
        {usage.reserved_bytes > 0 && <p className="mb-2 text-xs">Загружается: {size(usage.reserved_bytes)}</p>}</> : <p>{loading ? 'Получаем данные…' : error}</p>}
    </div>
    <p className="text-xs leading-relaxed text-slate-500">Файлы, голосовые сообщения и кружки хранятся один месяц с момента загрузки, затем удаляются автоматически. Лимит — 5 ГиБ на аккаунт.</p>
  </section>;
}
