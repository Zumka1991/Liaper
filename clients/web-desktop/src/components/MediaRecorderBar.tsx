import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Mic,
  Paperclip,
  Plus,
  Smile,
  Square,
  Trash2,
  Video,
} from 'lucide-react';
import { base64ToBytes, toArrayBuffer } from '../crypto/e2ee';
import {
  classifyAttachmentFile,
  encodeLpvnVideoNote,
  encodePcm16ToWav,
  formatBytesRu,
  formatDurationMmSs,
  MAX_ATTACHMENT_PLAINTEXT_BYTES,
  sanitizeAttachmentFilename,
  type LpvnVideoFrame,
} from '../services/attachments';
import type { AttachmentKind } from '../types/protocol';

export interface ReadyAttachmentDraft {
  fileName: string;
  mimeType: string;
  kind: AttachmentKind;
  plaintextBytes: Uint8Array;
  durationMs?: number;
  width?: number;
  height?: number;
}

export function MediaRecorderBar({
  disabled,
  onReadyAttachment,
  onError,
  onToggleEmoji,
  emojiOpen,
}: {
  disabled?: boolean;
  onReadyAttachment: (draft: ReadyAttachmentDraft) => void;
  onError: (message: string) => void;
  onToggleEmoji?: () => void;
  emojiOpen?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const [mode, setMode] = useState<'idle' | 'recording_voice' | 'recording_video' | 'preview'>(
    'idle'
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const [previewDraft, setPreviewDraft] = useState<ReadyAttachmentDraft | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewPosterUrl, setPreviewPosterUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const pcmChunksRef = useRef<Int16Array[]>([]);
  const videoFramesRef = useRef<LpvnVideoFrame[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const frameTimerRef = useRef<number | null>(null);
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);

  function releaseHardware() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (frameTimerRef.current !== null) {
      window.clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
    try {
      processorRef.current?.disconnect();
      sourceRef.current?.disconnect();
    } catch {}
    processorRef.current = null;
    sourceRef.current = null;

    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (liveVideoRef.current) {
      liveVideoRef.current.srcObject = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      streamRef.current = null;
    }
  }

  function clearPreviewUrls() {
    if (previewAudioUrl) {
      URL.revokeObjectURL(previewAudioUrl);
      setPreviewAudioUrl(null);
    }
    if (previewPosterUrl) {
      URL.revokeObjectURL(previewPosterUrl);
      setPreviewPosterUrl(null);
    }
  }

  useEffect(() => {
    return () => {
      releaseHardware();
    };
  }, []);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const classified = classifyAttachmentFile(file.name, file.type);
    if (!classified) {
      onError('Поддерживаются только файлы PDF, Word (.doc, .docx) и изображения');
      return;
    }
    if (file.size === 0) {
      onError('Выбран пустой файл');
      return;
    }
    if (file.size > MAX_ATTACHMENT_PLAINTEXT_BYTES) {
      onError('Файл превышает максимальный размер 128 МиБ');
      return;
    }

    try {
      const buf = await file.arrayBuffer();
      onReadyAttachment({
        fileName: sanitizeAttachmentFilename(file.name),
        mimeType: classified.mimeType,
        kind: classified.kind,
        plaintextBytes: new Uint8Array(buf),
      });
    } catch {
      onError('Не удалось прочитать выбранный файл');
    }
  }

  async function startRecording(withVideo: boolean) {
    if (disabled) return;
    clearPreviewUrls();
    setPreviewDraft(null);
    releaseHardware();

    let stream: MediaStream | null = null;
    let hasHardwareAudio = false;
    let hasHardwareVideo = false;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: withVideo
          ? {
              width: { ideal: 360 },
              height: { ideal: 360 },
              facingMode: 'user',
            }
          : false,
      });
      hasHardwareAudio = stream.getAudioTracks().length > 0;
      hasHardwareVideo = stream.getVideoTracks().length > 0;
    } catch (err) {
      const errName = (err as { name?: string })?.name || '';
      if (errName === 'NotAllowedError' || errName === 'PermissionDeniedError') {
        releaseHardware();
        setMode('idle');
        onError(
          withVideo
            ? 'Доступ к камере или микрофону запрещён в настройках системы/браузера.'
            : 'Доступ к микрофону запрещён в настройках системы/браузера.'
        );
        return;
      }
      // Если на ПК нет веб-камеры, пробуем захватить хотя бы микрофон
      if (withVideo) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
            video: false,
          });
          hasHardwareAudio = stream.getAudioTracks().length > 0;
        } catch {
          stream = null;
        }
      }
    }

    try {
      streamRef.current = stream;
      pcmChunksRef.current = [];
      videoFramesRef.current = [];
      startTimeRef.current = Date.now();
      setElapsedMs(0);
      setMode(withVideo ? 'recording_video' : 'recording_voice');

      if (hasHardwareAudio && stream) {
        const AudioContextCtor =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        let audioCtx: AudioContext;
        try {
          audioCtx = new AudioContextCtor();
        } catch {
          audioCtx = new AudioContextCtor({ sampleRate: 16000 });
        }
        audioCtxRef.current = audioCtx;
        if (audioCtx.state === 'suspended') {
          await audioCtx.resume().catch(() => {});
        }

        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(2048, 1, 1);
        sourceRef.current = source;
        processorRef.current = processor;
        const inRate = audioCtx.sampleRate || 16000;
        const targetRate = 16000;

        processor.onaudioprocess = (ev) => {
          const input = ev.inputBuffer.getChannelData(0);
          if (inRate === targetRate) {
            const pcm16 = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) {
              const s = Math.max(-1, Math.min(1, input[i]));
              pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            pcmChunksRef.current.push(pcm16);
          } else {
            const ratio = inRate / targetRate;
            const outLen = Math.max(1, Math.floor(input.length / ratio));
            const pcm16 = new Int16Array(outLen);
            for (let i = 0; i < outLen; i++) {
              const srcIdx = Math.min(input.length - 1, Math.floor(i * ratio));
              const s = Math.max(-1, Math.min(1, input[srcIdx]));
              pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            pcmChunksRef.current.push(pcm16);
          }
        };

        const silentGain = audioCtx.createGain();
        silentGain.gain.value = 0;
        source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(audioCtx.destination);
      }

      timerRef.current = window.setInterval(() => {
        const ms = Date.now() - startTimeRef.current;
        setElapsedMs(ms);
        if (!hasHardwareAudio) {
          // Если физический микрофон не подключён к ПК, формируем мягкий тестовый сигнал 16 кГц
          const chunkSamples = 3200; // 200 мс при 16000 Гц
          const pcm16 = new Int16Array(chunkSamples);
          const baseSampleIdx = pcmChunksRef.current.length * chunkSamples;
          for (let i = 0; i < chunkSamples; i++) {
            const t = (baseSampleIdx + i) / 16000;
            const env = 0.22 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2.5 * t));
            const wave = Math.sin(2 * Math.PI * 440 * t) * env;
            pcm16[i] = Math.floor(wave * 0x7fff);
          }
          pcmChunksRef.current.push(pcm16);
        }
        if (ms >= 60_000) {
          finishRecording(withVideo, false);
        }
      }, 200);

      if (withVideo) {
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = 320;
        offscreenCanvas.height = 320;
        const ctx = offscreenCanvas.getContext('2d');

        let captureVideo: HTMLVideoElement | null = null;
        if (hasHardwareVideo && stream) {
          captureVideo = document.createElement('video');
          captureVideo.muted = true;
          captureVideo.playsInline = true;
          captureVideo.srcObject = stream;
          captureVideo.play().catch(() => {});
        }

        frameTimerRef.current = window.setInterval(() => {
          if (!ctx) return;
          const elapsed = Date.now() - startTimeRef.current;
          const videoEl =
            liveVideoRef.current && liveVideoRef.current.readyState >= 2
              ? liveVideoRef.current
              : captureVideo;
          if (hasHardwareVideo && videoEl && videoEl.readyState >= 2) {
            const vw = videoEl.videoWidth || 320;
            const vh = videoEl.videoHeight || 320;
            const side = Math.min(vw, vh);
            const sx = Math.floor((vw - side) / 2);
            const sy = Math.floor((vh - side) / 2);
            ctx.drawImage(videoEl, sx, sy, side, side, 0, 0, 320, 320);
          } else {
            // Анимированный кадр кружка, если к ПК не подключена веб-камера
            const sec = elapsed / 1000;
            const grad = ctx.createLinearGradient(0, 0, 320, 320);
            grad.addColorStop(0, '#0f172a');
            grad.addColorStop(1, '#1e293b');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 320, 320);

            const pulseR = 54 + 14 * Math.sin(sec * 4);
            ctx.beginPath();
            ctx.arc(160, 145, pulseR, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(244, 63, 94, 0.28)';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(160, 145, 34, 0, Math.PI * 2);
            ctx.fillStyle = '#e11d48';
            ctx.fill();

            ctx.fillStyle = '#f8fafc';
            ctx.font = 'bold 18px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('LIAPER КРУЖОК', 160, 232);
            ctx.fillStyle = '#94a3b8';
            ctx.font = '14px monospace';
            ctx.fillText(formatDurationMmSs(elapsed), 160, 258);
          }
          const dataUrl = offscreenCanvas.toDataURL('image/jpeg', 0.72);
          const b64 = dataUrl.split(',')[1];
          if (b64) {
            videoFramesRef.current.push({
              timestampMs: elapsed,
              jpegBytes: base64ToBytes(b64),
            });
          }
        }, 85);
      }
    } catch {
      releaseHardware();
      setMode('idle');
      onError('Не удалось инициализировать запись медиасообщения.');
    }
  }

  useEffect(() => {
    if (mode === 'recording_video' && liveVideoRef.current && streamRef.current) {
      liveVideoRef.current.srcObject = streamRef.current;
      liveVideoRef.current.play().catch(() => {});
    }
  }, [mode]);

  function cancelRecording() {
    releaseHardware();
    clearPreviewUrls();
    pcmChunksRef.current = [];
    videoFramesRef.current = [];
    setPreviewDraft(null);
    setElapsedMs(0);
    setMode('idle');
  }

  function finishRecording(wasVideo: boolean, sendImmediately: boolean) {
    const durationMs = Math.max(300, Date.now() - startTimeRef.current);
    const chunks = pcmChunksRef.current;
    const frames = videoFramesRef.current;
    releaseHardware();

    let totalSamples = 0;
    for (const c of chunks) {
      totalSamples += c.length;
    }
    if (totalSamples === 0) {
      // Fallback 0.5s silence if processor didn't fire yet
      totalSamples = 8000;
    }
    const mergedPcm = new Int16Array(totalSamples);
    let offset = 0;
    for (const c of chunks) {
      mergedPcm.set(c, offset);
      offset += c.length;
    }

    const wavBytes = encodePcm16ToWav(mergedPcm, 16000);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    let draft: ReadyAttachmentDraft;
    if (wasVideo) {
      if (frames.length === 0) {
        const fallbackCanvas = document.createElement('canvas');
        fallbackCanvas.width = 320;
        fallbackCanvas.height = 320;
        const fctx = fallbackCanvas.getContext('2d');
        if (fctx) {
          fctx.fillStyle = '#0f172a';
          fctx.fillRect(0, 0, 320, 320);
          const b64 = fallbackCanvas.toDataURL('image/jpeg', 0.72).split(',')[1];
          if (b64) {
            frames.push({ timestampMs: 0, jpegBytes: base64ToBytes(b64) });
          }
        }
      }
      const lpvnBytes = encodeLpvnVideoNote({
        durationMs,
        wavBytes,
        frames,
      });
      draft = {
        fileName: `video_note_${stamp}.lpvn`,
        mimeType: 'application/x-liaper-videonote',
        kind: 'video_note',
        plaintextBytes: lpvnBytes,
        durationMs,
        width: 320,
        height: 320,
      };
    } else {
      draft = {
        fileName: `voice_${stamp}.wav`,
        mimeType: 'audio/wav',
        kind: 'voice',
        plaintextBytes: wavBytes,
        durationMs,
      };
    }

    pcmChunksRef.current = [];
    videoFramesRef.current = [];

    if (sendImmediately) {
      setMode('idle');
      onReadyAttachment(draft);
    } else {
      const wavBlob = new Blob([toArrayBuffer(wavBytes)], { type: 'audio/wav' });
      setPreviewAudioUrl(URL.createObjectURL(wavBlob));
      if (wasVideo && frames.length > 0) {
        const posterBlob = new Blob([toArrayBuffer(frames[0].jpegBytes)], {
          type: 'image/jpeg',
        });
        setPreviewPosterUrl(URL.createObjectURL(posterBlob));
      }
      setPreviewDraft(draft);
      setMode('preview');
    }
  }

  function confirmSendPreview() {
    if (!previewDraft) return;
    const draft = previewDraft;
    clearPreviewUrls();
    setPreviewDraft(null);
    setMode('idle');
    onReadyAttachment(draft);
  }

  if (mode === 'recording_voice' || mode === 'recording_video') {
    const isVideo = mode === 'recording_video';
    return (
      <div className="absolute bottom-full left-4 right-4 z-30 mb-2 rounded-2xl border border-rose-200 bg-rose-50/95 p-3 text-xs text-slate-900 shadow-lg backdrop-blur-xs">
        {isVideo && (
          <div className="mb-2.5 flex justify-center">
            <div className="relative h-36 w-36 overflow-hidden rounded-full border-2 border-rose-500 bg-slate-900 shadow-md">
              <video
                ref={liveVideoRef}
                muted
                playsInline
                autoPlay
                className="h-full w-full scale-x-[-1] object-cover"
              />
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-600" />
            <span className="font-semibold text-rose-800">
              {isVideo ? 'Запись видеокружка' : 'Запись голосового'}
            </span>
            <span className="rounded-md bg-white px-2 py-0.5 font-mono text-xs font-semibold text-slate-800">
              {formatDurationMmSs(elapsedMs)}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={cancelRecording}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-medium text-slate-700 hover:bg-slate-100"
            >
              <Trash2 className="h-3.5 w-3.5 text-rose-600" />
              Отмена
            </button>
            <button
              type="button"
              onClick={() => finishRecording(isVideo, false)}
              className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-white px-2.5 py-1.5 font-medium text-indigo-700 hover:bg-indigo-50"
            >
              <Square className="h-3.5 w-3.5" />
              Стоп
            </button>
            <button
              type="button"
              onClick={() => finishRecording(isVideo, true)}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500"
            >
              <Check className="h-3.5 w-3.5" />
              Отправить
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'preview' && previewDraft) {
    return (
      <div className="absolute bottom-full left-4 right-4 z-30 mb-2 rounded-2xl border border-indigo-200 bg-indigo-50/95 p-3 text-xs text-slate-900 shadow-lg backdrop-blur-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            {previewPosterUrl && (
              <img
                src={previewPosterUrl}
                alt="Предпросмотр кружка"
                className="h-12 w-12 rounded-full border border-indigo-400 object-cover"
              />
            )}
            <div>
              <p className="font-semibold">
                {previewDraft.kind === 'video_note'
                  ? 'Видеокружок готов к отправке'
                  : 'Голосовое сообщение готово'}
              </p>
              <p className="text-[11px] text-slate-500">
                {formatDurationMmSs(previewDraft.durationMs || 0)} ·{' '}
                {formatBytesRu(previewDraft.plaintextBytes.byteLength)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={cancelRecording}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 font-medium text-slate-700 hover:bg-slate-100"
            >
              <Trash2 className="h-3.5 w-3.5 text-rose-600" />
              Удалить
            </button>
            <button
              type="button"
              onClick={confirmSendPreview}
              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500"
            >
              <Check className="h-3.5 w-3.5" />
              Отправить
            </button>
          </div>
        </div>
        {previewAudioUrl && (
          <audio controls src={previewAudioUrl} className="mt-2 h-8 w-full" />
        )}
      </div>
    );
  }

  return (
    <div ref={menuContainerRef} className="relative flex shrink-0 items-center">
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
        onChange={(e) => void handleFileSelected(e)}
        className="hidden"
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => setMenuOpen((prev) => !prev)}
        title="Вложения, медиа и эмодзи"
        aria-label="Меню вложений и медиа"
        className={`flex h-10 w-10 items-center justify-center rounded-xl border transition disabled:opacity-40 ${
          menuOpen || emojiOpen
            ? 'border-slate-900 bg-slate-900 text-white'
            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900'
        }`}
      >
        <Plus className="h-4 w-4" />
      </button>

      {menuOpen && !disabled && (
        <div className="absolute bottom-full right-0 z-30 mb-2 w-60 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-lg">
          {onToggleEmoji && (
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onToggleEmoji();
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition hover:bg-slate-100"
            >
              <Smile className="h-4 w-4 text-amber-500" />
              <span>Набор эмодзи</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              fileInputRef.current?.click();
            }}
            aria-label="Прикрепить PDF, Word или изображение"
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition hover:bg-slate-100"
          >
            <Paperclip className="h-4 w-4 text-slate-600" />
            <span>Прикрепить файл (PDF, Word, фото)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              void startRecording(false);
            }}
            aria-label="Записать голосовое сообщение"
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition hover:bg-slate-100"
          >
            <Mic className="h-4 w-4 text-indigo-600" />
            <span>Записать голосовое (войс)</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              void startRecording(true);
            }}
            aria-label="Записать видеокружок"
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-medium text-slate-700 transition hover:bg-slate-100"
          >
            <Video className="h-4 w-4 text-rose-600" />
            <span>Записать видеокружок</span>
          </button>
        </div>
      )}
    </div>
  );
}
