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
    <div className="rounded-xl border border-indigo-200 bg-indigo-50/70 p-3 text-xs text-slate-800 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">
            {sanitizeAttachmentFilename(transfer.fileName)}
          </p>
          <p className="text-[11px] text-slate-500">
            {kindLabel} · {formatBytesRu(transfer.plaintextBytes.byteLength)}
            {transfer.durationMs ? ` · ${formatDurationMmSs(transfer.durationMs)}` : ''}
          </p>
        </div>
        {transfer.status === 'uploading' ? (
          <button
            type="button"
            onClick={() => onCancel(transfer.localId)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
            title="Отменить загрузку"
          >
            <X className="h-3.5 w-3.5" />
            Отмена
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onRetry(transfer.localId)}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Повторить
            </button>
            <button
              type="button"
              onClick={() => onDismiss(transfer.localId)}
              className="rounded-lg border border-slate-300 bg-white p-1 text-slate-500 hover:bg-slate-100"
              title="Убрать"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {transfer.status === 'uploading' ? (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[11px] text-indigo-700">
            <span>Шифрование AES-256-GCM и отправка…</span>
            <span>{pct}%</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-indigo-100">
            <div
              className="h-full rounded-full bg-indigo-600 transition-all duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{transfer.errorMessage || 'Не удалось загрузить вложение'}</span>
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
    ? `Хранится до ${new Date(meta.expires_at).toLocaleDateString('ru-RU')}`
    : 'Хранится 1 месяц';

  if (expired) {
    return (
      <div className="flex items-center gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 shadow-xs">
        <Clock className="h-4 w-4 shrink-0 opacity-80" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{sanitizeAttachmentFilename(meta.name)}</p>
          <p className="text-[11px] opacity-85">
            Срок хранения истёк (1 месяц) — вложение удалено с сервера
          </p>
        </div>
      </div>
    );
  }

  // 1. Круглое видеосообщение (Видеокружок) — без прямоугольной рамки вокруг
  if (meta.kind === 'video_note') {
    const totalMs = videoNote?.durationMs || meta.duration_ms || 0;
    return (
      <div className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}>
        <div
          className={`relative h-48 w-48 overflow-hidden rounded-full bg-slate-900 shadow-md ring-2 ${
            playing ? 'ring-emerald-500' : 'ring-slate-200'
          }`}
        >
          {videoNoteFrameUrl ? (
            <img
              src={videoNoteFrameUrl}
              alt="Видеокружок"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center text-white/80">
              <Video className="h-7 w-7" />
              <span className="mt-1 text-[11px]">
                {loading ? `${Math.round(progress * 100)}%` : 'Видеокружок'}
              </span>
            </div>
          )}

          <button
            type="button"
            onClick={() => void togglePlayMedia()}
            aria-label={playing ? 'Пауза видеокружка' : 'Воспроизвести видеокружок'}
            className="absolute inset-0 flex items-center justify-center bg-black/15 text-white transition hover:bg-black/30"
          >
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/50 backdrop-blur-xs">
              {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
            </span>
          </button>

          <span className="pointer-events-none absolute bottom-2.5 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-0.5 font-mono text-[11px] text-white">
            {formatDurationMmSs(playing ? playElapsedMs : totalMs)}
          </span>
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

        {error && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-rose-500">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void fetchDecrypted(false)}
              className="underline hover:no-underline"
            >
              Повторить
            </button>
          </div>
        )}
      </div>
    );
  }

  // 2. Голосовое сообщение (Войс) — светлая аккуратная карточка без чёрной рамки
  if (meta.kind === 'voice') {
    const totalMs = meta.duration_ms || 0;
    return (
      <div className="min-w-[230px] rounded-2xl border border-slate-200 bg-white p-3 text-slate-900 shadow-xs">
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={() => void togglePlayMedia()}
            aria-label={playing ? 'Пауза голосового сообщения' : 'Воспроизвести голосовое сообщение'}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2 text-xs font-semibold text-slate-900">
              <span className="inline-flex items-center gap-1 truncate">
                <Mic className="h-3.5 w-3.5 shrink-0 text-indigo-600" />
                Голосовое сообщение
              </span>
              <span className="font-mono text-[11px] text-slate-500">
                {formatDurationMmSs(playing ? playElapsedMs : totalMs)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-indigo-600 transition-all"
                style={{
                  width: loading
                    ? `${Math.round(progress * 100)}%`
                    : totalMs > 0 && playing
                      ? `${Math.min(100, Math.round((playElapsedMs / totalMs) * 100))}%`
                      : decryptedBytes
                        ? '100%'
                        : '0%',
                }}
              />
            </div>
            <p className="mt-1 text-[10px] text-slate-400">
              {formatBytesRu(meta.plaintext_size)} · {expiryText}
            </p>
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

        {error && (
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-rose-600">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void fetchDecrypted(false)}
              className="inline-flex items-center gap-1 underline"
            >
              <RefreshCw className="h-3 w-3" /> Повторить
            </button>
          </div>
        )}
      </div>
    );
  }

  // 3. Изображение — без чёрной подложки вокруг
  if (meta.kind === 'image') {
    return (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-xs">
        {objectUrl ? (
          <a href={objectUrl} target="_blank" rel="noreferrer" className="block">
            <img
              src={objectUrl}
              alt={sanitizeAttachmentFilename(meta.name)}
              className="max-h-64 w-full object-contain bg-slate-50"
            />
          </a>
        ) : (
          <div className="flex h-32 flex-col items-center justify-center gap-1 p-4 text-xs text-slate-500">
            <ImageIcon className="h-6 w-6" />
            <span>
              {loading
                ? `Расшифровка изображения… ${Math.round(progress * 100)}%`
                : 'Изображение E2EE'}
            </span>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-3 py-2 text-[11px]">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-slate-900">
              {sanitizeAttachmentFilename(meta.name)}
            </p>
            <p className="text-[10px] text-slate-400">
              {formatBytesRu(meta.plaintext_size)} · {expiryText}
            </p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void fetchDecrypted(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-slate-100 px-2.5 py-1 font-medium text-slate-700 transition hover:bg-slate-200"
          >
            <Download className="h-3.5 w-3.5" />
            Сохранить
          </button>
        </div>

        {error && (
          <div className="flex items-center justify-between border-t border-rose-200 px-3 py-1.5 text-[11px] text-rose-600">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void fetchDecrypted(false)}
              className="inline-flex items-center gap-1 font-medium underline"
            >
              <RefreshCw className="h-3 w-3" /> Повторить
            </button>
          </div>
        )}
      </div>
    );
  }

  // 4. Документы PDF и Word (.doc / .docx) — светлая аккуратная карточка без чёрной рамки
  const badge = meta.kind === 'pdf' ? 'PDF' : 'WORD';
  return (
    <div className="min-w-[230px] rounded-2xl border border-slate-200 bg-white p-3 text-slate-900 shadow-xs">
      <div className="flex items-center gap-2.5">
        <div className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl bg-indigo-50 text-[10px] font-bold text-indigo-700">
          <FileText className="h-4 w-4" />
          <span>{badge}</span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-slate-900">
            {sanitizeAttachmentFilename(meta.name)}
          </p>
          <p className="text-[11px] text-slate-400">
            {formatBytesRu(meta.plaintext_size)} · {expiryText}
          </p>
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={() => void fetchDecrypted(true)}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {loading ? `${Math.round(progress * 100)}%` : 'Скачать'}
        </button>
      </div>

      {loading && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-indigo-600 transition-all"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}

      {error && (
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-rose-600">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void fetchDecrypted(true)}
            className="inline-flex items-center gap-1 font-medium underline"
          >
            <RefreshCw className="h-3 w-3" /> Повторить
          </button>
        </div>
      )}
    </div>
  );
}
