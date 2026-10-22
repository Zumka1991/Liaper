import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Clock,
  Download,
  FileText,
  Image as ImageIcon,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Video,
  X,
} from 'lucide-react';
import { toArrayBuffer } from '../crypto/e2ee';
import {
  AttachmentExpiredError,
  decodeLpvnVideoNote,
  downloadAndDecryptAttachment,
  formatBytesRu,
  formatDurationMmSs,
  getCachedAttachmentBytes,
  sanitizeAttachmentFilename,
  type DecodedLpvnVideoNote,
} from '../services/attachments';
import type { AttachmentKind, ChatAttachmentMeta } from '../types/protocol';

export interface OutgoingAttachmentTransfer {
  localId: string;
  roomId: string;
  fileName: string;
  mimeType: string;
  kind: AttachmentKind;
  plaintextBytes: Uint8Array;
  captionText: string;
  durationMs?: number;
  width?: number;
  height?: number;
  progress: number;
  status: 'uploading' | 'error';
  errorMessage?: string;
}

function triggerBrowserDownload(bytes: Uint8Array, fileName: string, mimeType: string) {
  const safeName = sanitizeAttachmentFilename(fileName);
  const blob = new Blob([toArrayBuffer(bytes)], {
    type: mimeType || 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}


/** Цветная плитка типа файла: PDF — красная, Word — синяя, изображение — зелёная, медиа — фирменная. */
export function FileTypeTile({ kind, size = 44 }: { kind: AttachmentKind; size?: number }) {
  const map: Record<string, { label: string; cls: string; Icon: typeof FileText }> = {
    pdf: { label: 'PDF', cls: 'bg-rose-50 text-rose-600 ring-rose-100', Icon: FileText },
    word: { label: 'DOC', cls: 'bg-sky-50 text-sky-600 ring-sky-100', Icon: FileText },
    image: { label: 'IMG', cls: 'bg-emerald-50 text-emerald-600 ring-emerald-100', Icon: ImageIcon },
    voice: { label: '', cls: 'bg-indigo-50 text-indigo-600 ring-indigo-100', Icon: Mic },
    video_note: { label: '', cls: 'bg-violet-50 text-violet-600 ring-violet-100', Icon: Video },
  };
  const { label, cls, Icon } = map[kind] ?? map.pdf;
  return (
    <span
      className={`flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl ring-1 ${cls}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Icon className="h-[18px] w-[18px]" />
      {label && <span className="text-[9px] font-bold leading-none tracking-wide">{label}</span>}
    </span>
  );
}

/** Псевдо-волна голосового: стабильная для каждого вложения, чтобы не прыгала между рендерами. */
function waveformBars(seed: string, count = 32): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const r = ((h >>> 0) % 1000) / 1000;
    const envelope = Math.sin((Math.PI * (i + 1)) / (count + 1));
    bars.push(0.22 + 0.78 * (0.35 * envelope + 0.65 * r));
  }
  return bars;
}

export function OutgoingTransferCard({
  transfer,
  onCancel,
  onRetry,
  onDismiss,
}: {
  transfer: OutgoingAttachmentTransfer;
  onCancel: (localId: string) => void;
  onRetry: (localId: string) => void;
  onDismiss: (localId: string) => void;
}) {
  const pct = Math.round(Math.max(0, Math.min(1, transfer.progress)) * 100);
  const kindLabel =
    transfer.kind === 'voice'
      ? 'Голосовое сообщение'
      : transfer.kind === 'video_note'
        ? 'Видеокружок'
        : transfer.kind === 'pdf'
          ? 'PDF документ'
          : transfer.kind === 'word'
            ? 'Документ Word'
            : 'Изображение';

  return (
    <div className="ml-auto w-full max-w-[300px] rounded-2xl border border-slate-200 bg-white p-3 shadow-xs">
      <div className="flex items-center gap-3">
        <FileTypeTile kind={transfer.kind} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">
            {transfer.kind === 'voice' || transfer.kind === 'video_note' ? kindLabel : sanitizeAttachmentFilename(transfer.fileName)}
          </p>
          <p className="truncate text-xs text-slate-500">
            {formatBytesRu(transfer.plaintextBytes.byteLength)}
            {transfer.durationMs ? ` · ${formatDurationMmSs(transfer.durationMs)}` : ''}
            {transfer.status === 'uploading' ? ` · ${pct}%` : ''}
          </p>
        </div>
        {transfer.status === 'uploading' ? (
          <button
            type="button"
            onClick={() => onCancel(transfer.localId)}
            aria-label="Отменить загрузку"
            title="Отменить загрузку"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200 hover:text-slate-900"
          >
            <X className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onDismiss(transfer.localId)}
            aria-label="Убрать из списка"
            title="Убрать"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {transfer.status === 'uploading' ? (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all duration-150"
              style={{ width: `${Math.max(4, pct)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-400">Шифруем на устройстве и отправляем…</p>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <span className="flex min-w-0 items-start gap-1.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{transfer.errorMessage || 'Не удалось отправить'}</span>
          </span>
          <button
            type="button"
            onClick={() => onRetry(transfer.localId)}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-white px-2.5 py-1 font-semibold text-rose-700 shadow-xs hover:bg-rose-100"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Повторить
          </button>
        </div>
      )}
    </div>
  );
}

export function AttachmentCard({
  meta,
  controlBase,
  token,
  isMine,
}: {
  meta: ChatAttachmentMeta;
  controlBase: string;
  token: string;
  isMine: boolean;
}) {
  const cachedInitial = getCachedAttachmentBytes(meta.id);
  const [decryptedBytes, setDecryptedBytes] = useState<Uint8Array | null>(cachedInitial ?? null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(cachedInitial ? 1 : 0);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState<boolean>(() => {
    if (!meta.expires_at) return false;
    const expMs = Date.parse(meta.expires_at);
    return Number.isFinite(expMs) && expMs <= Date.now();
  });

  // Object URL for image or voice WAV
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  // Decoded video note
  const [videoNote, setVideoNote] = useState<DecodedLpvnVideoNote | null>(null);
  const [videoNoteFrameUrl, setVideoNoteFrameUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playElapsedMs, setPlayElapsedMs] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const frameUrlsRef = useRef<string[]>([]);
  const animTimerRef = useRef<number | null>(null);

  // Build object URL or decode LPVN when decryptedBytes becomes available
  useEffect(() => {
    if (!decryptedBytes) return;

    if (meta.kind === 'video_note') {
      try {
        const decoded = decodeLpvnVideoNote(decryptedBytes);
        setVideoNote(decoded);
        const wavBlob = new Blob([toArrayBuffer(decoded.wavBytes)], { type: 'audio/wav' });
        const wavUrl = URL.createObjectURL(wavBlob);
        setObjectUrl(wavUrl);

        // Pre-create frame blob URLs for smooth circular playback
        const urls = decoded.frames.map((f) =>
          URL.createObjectURL(new Blob([toArrayBuffer(f.jpegBytes)], { type: 'image/jpeg' }))
        );
        frameUrlsRef.current = urls;
        if (urls.length > 0) {
          setVideoNoteFrameUrl(urls[0]);
        }

        return () => {
          URL.revokeObjectURL(wavUrl);
          urls.forEach((u) => URL.revokeObjectURL(u));
          frameUrlsRef.current = [];
        };
      } catch {
        // Fallback if standard video blob
        const blob = new Blob([toArrayBuffer(decryptedBytes)], {
          type: meta.mime_type || 'video/webm',
        });
        const url = URL.createObjectURL(blob);
        setObjectUrl(url);
        return () => URL.revokeObjectURL(url);
      }
    }

    const blob = new Blob([toArrayBuffer(decryptedBytes)], {
      type: meta.mime_type || 'application/octet-stream',
    });
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [decryptedBytes, meta.kind, meta.mime_type]);

  // Auto-fetch inline previews for images, voice messages, and video notes
  useEffect(() => {
    if (
      !decryptedBytes &&
      !expired &&
      !loading &&
      !error &&
      (meta.kind === 'image' || meta.kind === 'voice' || meta.kind === 'video_note')
    ) {
      void fetchDecrypted(false);
    }
    return () => {
      abortRef.current?.abort();
      if (animTimerRef.current !== null) {
        window.clearInterval(animTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id]);

  async function fetchDecrypted(saveAfterLoad: boolean): Promise<Uint8Array | null> {
    if (decryptedBytes) {
      if (saveAfterLoad) {
        triggerBrowserDownload(decryptedBytes, meta.name, meta.mime_type);
      }
      return decryptedBytes;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setProgress(0.05);

    try {
      const bytes = await downloadAndDecryptAttachment({
        controlBase,
        token,
        meta,
        onProgress: (p) => setProgress(p),
        signal: controller.signal,
      });
      setDecryptedBytes(bytes);
      if (saveAfterLoad) {
        triggerBrowserDownload(bytes, meta.name, meta.mime_type);
      }
      return bytes;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        return null;
      }
      if (err instanceof AttachmentExpiredError || (err as { isExpired?: boolean })?.isExpired) {
        setExpired(true);
        setError('Срок хранения истёк');
      } else {
        setError(err instanceof Error ? err.message : 'Ошибка скачивания вложения');
      }
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function togglePlayMedia() {
    if (expired) return;
    if (!decryptedBytes) {
      const loaded = await fetchDecrypted(false);
      if (!loaded) return;
    }
    const audio = audioRef.current;
    if (!audio) return;

    if (playing) {
      audio.pause();
      setPlaying(false);
      if (animTimerRef.current !== null) {
        window.clearInterval(animTimerRef.current);
        animTimerRef.current = null;
      }
    } else {
      try {
        if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.05)) {
          audio.currentTime = 0;
        }
        await audio.play();
        setPlaying(true);
        if (meta.kind === 'video_note' && videoNote && frameUrlsRef.current.length > 0) {
          if (animTimerRef.current !== null) {
            window.clearInterval(animTimerRef.current);
          }
          animTimerRef.current = window.setInterval(() => {
            if (!audioRef.current) return;
            const curMs = audioRef.current.currentTime * 1000;
            setPlayElapsedMs(curMs);
            const frames = videoNote.frames;
            let idx = 0;
            for (let i = 0; i < frames.length; i++) {
              if (frames[i].timestampMs <= curMs) {
                idx = i;
              } else {
                break;
              }
            }
            const url = frameUrlsRef.current[idx];
            if (url) {
              setVideoNoteFrameUrl(url);
            }
          }, 40);
        }
      } catch {
        setError('Не удалось воспроизвести медиафайл');
      }
    }
  }

  const expiryText = meta.expires_at
    ? `до ${new Date(meta.expires_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}`
    : 'хранится месяц';
  const pct = Math.round(progress * 100);

  const retryRow = (save: boolean) =>
    error && (
      <div className="mt-2 flex items-center justify-between gap-2 rounded-xl bg-rose-50 px-3 py-1.5 text-xs text-rose-700">
        <span className="min-w-0">{error}</span>
        <button
          type="button"
          onClick={() => void fetchDecrypted(save)}
          className="inline-flex shrink-0 items-center gap-1 font-semibold hover:underline"
        >
          <RefreshCw className="h-3 w-3" /> Повторить
        </button>
      </div>
    );

  if (expired) {
    return (
      <div className="flex w-[260px] max-w-full items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-3 text-xs text-slate-500">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white text-slate-400 ring-1 ring-slate-200">
          <Clock className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-600 line-through decoration-slate-300">
            {sanitizeAttachmentFilename(meta.name)}
          </p>
          <p>Срок хранения истёк — файл удалён</p>
        </div>
      </div>
    );
  }

  // 1. Видеокружок: круг с кольцом прогресса воспроизведения
  if (meta.kind === 'video_note') {
    const totalMs = videoNote?.durationMs || meta.duration_ms || 0;
    const ratio = loading ? progress : totalMs > 0 && playing ? Math.min(1, playElapsedMs / totalMs) : 0;
    return (
      <div className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
        <div
          className="relative rounded-full p-[3px] shadow-md"
          style={{
            background: ratio > 0
              ? `conic-gradient(#6366f1 ${ratio * 360}deg, #e2e8f0 0deg)`
              : 'linear-gradient(135deg, #c7d2fe, #ddd6fe)',
          }}
        >
          <div className="relative h-48 w-48 overflow-hidden rounded-full bg-slate-900">
            {videoNoteFrameUrl ? (
              <img src={videoNoteFrameUrl} alt="Видеокружок" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900 text-white/70">
                <Video className="h-7 w-7" />
                <span className="mt-1.5 text-xs">{loading ? `Загрузка ${pct}%` : 'Видеокружок'}</span>
              </div>
            )}
            <button
              type="button"
              onClick={() => void togglePlayMedia()}
              aria-label={playing ? 'Пауза видеокружка' : 'Воспроизвести видеокружок'}
              className={`group absolute inset-0 flex items-center justify-center text-white transition ${playing ? 'bg-transparent' : 'bg-black/10 hover:bg-black/25'}`}
            >
              <span className={`flex h-12 w-12 items-center justify-center rounded-full bg-white/90 text-slate-900 shadow-lg transition group-hover:scale-105 ${playing ? 'opacity-0 group-hover:opacity-100' : ''}`}>
                {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
              </span>
            </button>
            <span className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/55 px-2.5 py-0.5 font-mono text-xs text-white backdrop-blur-sm">
              {formatDurationMmSs(playing ? playElapsedMs : totalMs)}
            </span>
          </div>
        </div>

        {objectUrl && (
          <audio
            ref={audioRef}
            src={objectUrl}
            onTimeUpdate={(e) => setPlayElapsedMs(e.currentTarget.currentTime * 1000)}
            onEnded={() => {
              setPlaying(false);
              setPlayElapsedMs(0);
              if (animTimerRef.current !== null) {
                window.clearInterval(animTimerRef.current);
                animTimerRef.current = null;
              }
            }}
            className="hidden"
          />
        )}
        {retryRow(false)}
      </div>
    );
  }

  // 2. Голосовое: кнопка воспроизведения и волна, закрашиваемая по мере проигрывания
  if (meta.kind === 'voice') {
    const totalMs = meta.duration_ms || 0;
    const ratio = totalMs > 0 && (playing || playElapsedMs > 0) ? Math.min(1, playElapsedMs / totalMs) : 0;
    const bars = waveformBars(meta.id);
    return (
      <div className={`w-[260px] max-w-full rounded-2xl p-2.5 shadow-xs ${isMine ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-900'}`}>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={() => void togglePlayMedia()}
            aria-label={playing ? 'Пауза голосового сообщения' : 'Воспроизвести голосовое сообщение'}
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition disabled:opacity-60 ${
              isMine ? 'bg-white text-indigo-600 hover:bg-indigo-50' : 'bg-indigo-600 text-white hover:bg-indigo-500'
            }`}
          >
            {loading ? <span className="text-[10px] font-bold">{pct}%</span> : playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex h-7 items-center gap-[2px]" aria-hidden="true">
              {bars.map((h, i) => {
                const played = (i + 0.5) / bars.length <= ratio;
                return (
                  <span
                    key={i}
                    className={`flex-1 rounded-full transition-colors ${
                      isMine ? (played ? 'bg-white' : 'bg-white/40') : played ? 'bg-indigo-600' : 'bg-slate-300'
                    }`}
                    style={{ height: `${Math.round(h * 100)}%` }}
                  />
                );
              })}
            </div>
            <div className={`mt-0.5 flex justify-between font-mono text-[11px] ${isMine ? 'text-indigo-100' : 'text-slate-500'}`}>
              <span>{formatDurationMmSs(playing || playElapsedMs > 0 ? playElapsedMs : totalMs)}</span>
              <span className="font-sans">{expiryText}</span>
            </div>
          </div>
        </div>

        {objectUrl && (
          <audio
            ref={audioRef}
            src={objectUrl}
            onTimeUpdate={(e) => setPlayElapsedMs(e.currentTarget.currentTime * 1000)}
            onEnded={() => {
              setPlaying(false);
              setPlayElapsedMs(0);
            }}
            className="hidden"
          />
        )}
        {retryRow(false)}
      </div>
    );
  }

  // 3. Изображение: превью с кнопкой сохранения поверх
  if (meta.kind === 'image') {
    return (
      <div className="group relative w-[280px] max-w-full overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-xs">
        {objectUrl ? (
          <a href={objectUrl} target="_blank" rel="noreferrer" className="block" title="Открыть в полном размере">
            <img
              src={objectUrl}
              alt={sanitizeAttachmentFilename(meta.name)}
              className="max-h-72 w-full object-cover"
            />
          </a>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-xs text-slate-500">
            <FileTypeTile kind="image" />
            <span>{loading ? `Расшифровка… ${pct}%` : 'Изображение'}</span>
            {loading && (
              <span className="h-1 w-24 overflow-hidden rounded-full bg-slate-200">
                <span className="block h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
              </span>
            )}
          </div>
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/55 via-black/20 to-transparent px-3 pb-2 pt-8 text-white">
          <span className="min-w-0">
            <span className="block truncate text-xs font-medium">{sanitizeAttachmentFilename(meta.name)}</span>
            <span className="block text-[11px] text-white/80">{formatBytesRu(meta.plaintext_size)} · {expiryText}</span>
          </span>
          <button
            type="button"
            disabled={loading}
            onClick={() => void fetchDecrypted(true)}
            aria-label="Сохранить изображение"
            title="Сохранить"
            className="pointer-events-auto grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/90 text-slate-900 shadow transition hover:bg-white"
          >
            <Download className="h-4 w-4" />
          </button>
        </div>
        {error && <div className="px-3 pb-2">{retryRow(false)}</div>}
      </div>
    );
  }

  // 4. Документы PDF и Word
  return (
    <div className={`w-[280px] max-w-full rounded-2xl p-2.5 shadow-xs ${isMine ? 'bg-indigo-600' : 'border border-slate-200 bg-white'}`}>
      <div className="flex items-center gap-3">
        <span className={isMine ? 'rounded-xl bg-white' : ''}><FileTypeTile kind={meta.kind} /></span>
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-semibold ${isMine ? 'text-white' : 'text-slate-900'}`} title={sanitizeAttachmentFilename(meta.name)}>
            {sanitizeAttachmentFilename(meta.name)}
          </p>
          <p className={`truncate text-xs ${isMine ? 'text-indigo-100' : 'text-slate-500'}`}>
            {loading ? `Скачивание… ${pct}%` : `${formatBytesRu(meta.plaintext_size)} · ${expiryText}`}
          </p>
        </div>
        <button
          type="button"
          disabled={loading}
          onClick={() => void fetchDecrypted(true)}
          aria-label={`Скачать ${sanitizeAttachmentFilename(meta.name)}`}
          title="Скачать"
          className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full transition disabled:cursor-wait ${
            isMine ? 'bg-white/15 text-white hover:bg-white/25' : 'bg-slate-100 text-slate-700 hover:bg-indigo-50 hover:text-indigo-600'
          }`}
          style={loading ? { background: `conic-gradient(${isMine ? '#fff' : '#6366f1'} ${pct * 3.6}deg, ${isMine ? '#ffffff33' : '#e2e8f0'} 0deg)` } : undefined}
        >
          {loading ? <span className={`h-7 w-7 rounded-full ${isMine ? 'bg-indigo-600' : 'bg-white'}`} /> : <Download className="h-4 w-4" />}
        </button>
      </div>
      {retryRow(true)}
    </div>
  );
}
