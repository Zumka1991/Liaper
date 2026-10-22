import {
  base64ToBytes,
  bytesToBase64,
  type RoomSecretKeyBundle,
} from '../crypto/e2ee';
import type {
  ClientToNodeMsg,
  NodeToClientMsg,
} from '../types/protocol';

// Задержка звука: запас на неровную доставку и потолок очереди воспроизведения
const PLAYBACK_LEAD_S = 0.06;
const MAX_PLAYBACK_QUEUE_S = 0.2;
// Видео 12 к/с вместо 20: JPEG-кадры не должны вытеснять звук из общего сокета
const VIDEO_FPS = 12;

export interface SfuConnectionCallbacks {
  onNodeConnected: (nodeId: string, nodeName: string) => void;
  onRemoteVideoFrame: (peerId: string, dataUrl: string) => void;
  onRemotePeerLeft: (peerId: string) => void;
  onE2eeStatsUpdated: (encryptedPackets: number, decryptedPackets: number) => void;
}

/**
 * Высокопроизводительный клиент медиа-ноды (SFU) без P2P:
 * Передаёт чистый звук (PCM16 16kHz) и видео / демонстрацию экрана (до 1280x720, 12 FPS)
 * строго через серверную ноду `liaper-node` с контролем буфера сокета.
 */
export class SfuMediaNodeClient {
  private ws: WebSocket | null = null;
  private nodeWsUrl = '';
  private roomId: string;
  private userId: string;
  private username: string;
  private displayName: string;
  private getRoomKey: () => RoomSecretKeyBundle | null;
  private getJoinTicket: () => Promise<string | null>;
  private localStream: MediaStream | null = null;
  private callbacks: SfuConnectionCallbacks;
  private encryptedCount = 0;
  private decryptedCount = 0;
  private manuallyClosed = false;
  private reconnectTimer: number | null = null;

  // Аудио-движок (16 кГц моно PCM16)
  private audioCtx: AudioContext | null = null;
  private nextPlayTime = 0;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micProcessor: ScriptProcessorNode | null = null;

  // Захват HD видео / демонстрации экрана
  private captureVideoEl: HTMLVideoElement | null = null;
  private captureCanvas: HTMLCanvasElement | null = null;
  private videoInterval: number | null = null;
  private audioEnabled = true;
  private videoEnabled = false;
  private isScreenShare = false;

  constructor(params: {
    roomId: string;
    userId: string;
    username: string;
    displayName: string;
    getRoomKey: () => RoomSecretKeyBundle | null;
    /** Подписанный сервером управления допуск в медиа-комнату (null в режиме разработки) */
    getJoinTicket: () => Promise<string | null>;
    callbacks: SfuConnectionCallbacks;
  }) {
    this.getJoinTicket = params.getJoinTicket;
    this.roomId = params.roomId;
    this.userId = params.userId;
    this.username = params.username;
    this.displayName = params.displayName;
    this.getRoomKey = params.getRoomKey;
    this.callbacks = params.callbacks;
  }

  public connect(
    nodeWsUrl: string,
    localStream: MediaStream | null,
    audioEnabled = true,
    videoEnabled = false,
    isScreenShare = false
  ): void {
    this.nodeWsUrl = nodeWsUrl;
    this.localStream = localStream;
    this.audioEnabled = audioEnabled;
    this.videoEnabled = videoEnabled;
    this.isScreenShare = isScreenShare;
    this.manuallyClosed = false;

    this.initAudioContext();
    this.setupOutgoingMediaPipelines(localStream);
    this.openSocket();
  }

  private openSocket(): void {
    if (this.manuallyClosed || !this.nodeWsUrl) return;
    try {
      this.ws?.close();
    } catch {}

    const ws = new WebSocket(this.nodeWsUrl);
    this.ws = ws;

    ws.onopen = async () => {
      const key = this.getRoomKey();
      let ticket: string | null = null;
      try {
        ticket = await this.getJoinTicket();
      } catch {
        // Без допуска нода закроет соединение, сработает повторное подключение
      }
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      this.send({
        type: 'join_sfu_room',
        payload: {
          room_id: this.roomId,
          user_id: this.userId,
          username: this.username,
          display_name: this.displayName,
          e2ee_enabled: false,
          room_key_id: key?.roomKeyId ?? 'AES256',
          ticket,
        },
      });
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as NodeToClientMsg;
        this.handleNodeMessage(msg);
      } catch {
        // Игнорируем некорректный пакет
      }
    };

    ws.onclose = () => {
      if (!this.manuallyClosed && this.ws === ws) {
        this.reconnectTimer = window.setTimeout(() => this.openSocket(), 1500);
      }
    };
  }

  public setMediaFlags(
    audioEnabled: boolean,
    videoEnabled: boolean,
    isScreenShare = this.isScreenShare
  ): void {
    this.audioEnabled = audioEnabled;
    this.videoEnabled = videoEnabled;
    this.isScreenShare = isScreenShare;
  }

  public async replaceLocalStream(
    newStream: MediaStream | null,
    audioEnabled = this.audioEnabled,
    videoEnabled = this.videoEnabled,
    isScreenShare = false
  ): Promise<void> {
    this.localStream = newStream;
    this.audioEnabled = audioEnabled;
    this.videoEnabled = videoEnabled;
    this.isScreenShare = isScreenShare;
    this.setupOutgoingMediaPipelines(newStream);
  }

  public disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.videoInterval !== null) {
      clearInterval(this.videoInterval);
      this.videoInterval = null;
    }
    this.teardownOutgoingMedia();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({
        type: 'leave_sfu_room',
        payload: { room_id: this.roomId },
      });
    }
    this.ws?.close();
    this.ws = null;

    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  private initAudioContext(): void {
    if (!this.audioCtx) {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioContextCtor({ sampleRate: 16000 });
      this.nextPlayTime = 0;
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
  }

  private teardownOutgoingMedia(): void {
    if (this.videoInterval !== null) { clearInterval(this.videoInterval); this.videoInterval = null; }
    this.captureCanvas = null;
    try {
      this.micProcessor?.disconnect();
      this.micSource?.disconnect();
    } catch {}
    this.micProcessor = null;
    this.micSource = null;

    if (this.captureVideoEl) {
      this.captureVideoEl.srcObject = null;
      this.captureVideoEl = null;
    }
  }

  private setupOutgoingMediaPipelines(stream: MediaStream | null): void {
    this.teardownOutgoingMedia();
    if (!stream) return;

    this.initAudioContext();

    // 1. Захват микрофона (16kHz PCM16)
    if (stream.getAudioTracks().length > 0 && this.audioCtx) {
      try {
        this.micSource = this.audioCtx.createMediaStreamSource(stream);
        // 512 сэмплов = 32 мс: меньше порция — меньше задержка на захвате (было 128 мс)
        this.micProcessor = this.audioCtx.createScriptProcessor(512, 1, 1);
        this.micProcessor.onaudioprocess = (ev) => {
          if (!this.audioEnabled || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
          }
          // Сокет забит: старый звук уже не нужен, лучше пропустить порцию, чем копить задержку
          if (this.ws.bufferedAmount > 64 * 1024) return;

          const input = ev.inputBuffer.getChannelData(0);
          const pcm16 = new Int16Array(input.length);
          let sumSq = 0;
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            sumSq += s * s;
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          const rms = Math.sqrt(sumSq / input.length);
          if (rms < 0.0015) return;

          const bytes = new Uint8Array(pcm16.buffer);
          const b64 = bytesToBase64(bytes);
          this.encryptedCount += 1;
          this.callbacks.onE2eeStatsUpdated(this.encryptedCount, this.decryptedCount);

          this.send({
            type: 'encrypted_media_frame',
            payload: {
              room_id: this.roomId,
              kind: 'audio_pcm16',
              ciphertext_b64: b64,
              iv_b64: 'pcm16-16000-mono',
              room_key_id: this.getRoomKey()?.roomKeyId ?? 'AES256',
              timestamp_ms: Date.now(),
            },
          });
        };
        this.micSource.connect(this.micProcessor);
        this.micProcessor.connect(this.audioCtx.destination);
      } catch {
        // Аудиоустройство недоступно
      }
    }

    // 2. Высококачественный захват видео / демонстрации экрана (HD 720p для экрана, 20 FPS)
    if (stream.getVideoTracks().length > 0) {
      const videoEl = document.createElement('video');
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.autoplay = true;
      videoEl.srcObject = stream;
      videoEl.play().catch(() => {});
      this.captureVideoEl = videoEl;

      const canvas = document.createElement('canvas');
      this.captureCanvas = canvas;

      if (this.videoInterval !== null) {
        clearInterval(this.videoInterval);
      }

      // VIDEO_FPS кадров/сек; кадр пропускается, пока буфер сокета не освободится
      this.videoInterval = window.setInterval(() => {
        if (
          !this.videoEnabled ||
          !this.captureVideoEl ||
          !this.captureCanvas ||
          !this.ws ||
          this.ws.readyState !== WebSocket.OPEN
        ) {
          return;
        }
        // Видео не должно стоять в сокете перед звуком: кадр пропускаем, пока очередь не уйдёт
        if (this.ws.bufferedAmount > 32 * 1024) return;
        if (this.captureVideoEl.readyState < 2) return;

        const srcW = this.captureVideoEl.videoWidth || 1280;
        const srcH = this.captureVideoEl.videoHeight || 720;
        const maxWidth = this.isScreenShare ? 1280 : 640;
        const scale = Math.min(1, maxWidth / srcW);
        const targetW = Math.max(320, Math.round(srcW * scale));
        const targetH = Math.max(200, Math.round(srcH * scale));

        if (this.captureCanvas.width !== targetW || this.captureCanvas.height !== targetH) {
          this.captureCanvas.width = targetW;
          this.captureCanvas.height = targetH;
        }

        const ctx = this.captureCanvas.getContext('2d');
        if (!ctx) return;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this.captureVideoEl, 0, 0, targetW, targetH);

        const quality = this.isScreenShare ? 0.8 : 0.65;
        const dataUrl = this.captureCanvas.toDataURL('image/jpeg', quality);
        const b64 = dataUrl.split(',')[1];
        if (!b64) return;

        this.encryptedCount += 1;
        this.callbacks.onE2eeStatsUpdated(this.encryptedCount, this.decryptedCount);

        this.send({
          type: 'encrypted_media_frame',
          payload: {
            room_id: this.roomId,
            kind: 'video_jpeg',
            ciphertext_b64: b64,
            iv_b64: 'jpeg-hd',
            room_key_id: this.getRoomKey()?.roomKeyId ?? 'AES256',
            timestamp_ms: Date.now(),
          },
        });
      }, 1000 / VIDEO_FPS);
    }
  }

  private playIncomingPcm16(b64: string): void {
    this.initAudioContext();
    if (!this.audioCtx) return;

    try {
      const bytes = base64ToBytes(b64);
      const sampleCount = Math.floor(bytes.byteLength / 2);
      if (sampleCount <= 0) return;

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const floatSamples = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        const int16 = view.getInt16(i * 2, true);
        floatSamples[i] = int16 / 32768.0;
      }

      const audioBuffer = this.audioCtx.createBuffer(1, sampleCount, 16000);
      audioBuffer.getChannelData(0).set(floatSamples);

      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioCtx.destination);

      const now = this.audioCtx.currentTime;
      if (this.nextPlayTime < now) {
        // Очередь опустела: небольшой запас на неровную доставку
        this.nextPlayTime = now + PLAYBACK_LEAD_S;
      } else if (this.nextPlayTime > now + MAX_PLAYBACK_QUEUE_S) {
        // Пришла пачка с опозданием — выбрасываем, чтобы не говорить «в прошлом»
        return;
      }
      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;
    } catch {
      // Игнорируем повреждённый чанк
    }
  }

  private send(msg: ClientToNodeMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleNodeMessage(msg: NodeToClientMsg): void {
    switch (msg.type) {
      case 'sfu_room_joined': {
        this.callbacks.onNodeConnected(msg.payload.node_id, msg.payload.node_name);
        break;
      }

      case 'peer_left_sfu': {
        this.callbacks.onRemotePeerLeft(msg.payload.user_id);
        break;
      }

      case 'relayed_encrypted_media_frame': {
        this.decryptedCount += 1;
        this.callbacks.onE2eeStatsUpdated(this.encryptedCount, this.decryptedCount);

        const { from_peer_id, kind, ciphertext_b64 } = msg.payload;
        if (kind === 'audio_pcm16') {
          this.playIncomingPcm16(ciphertext_b64);
        } else if (kind === 'video_jpeg' || kind === 'video') {
          this.callbacks.onRemoteVideoFrame(
            from_peer_id,
            `data:image/jpeg;base64,${ciphertext_b64}`
          );
        }
        break;
      }
    }
  }
}
