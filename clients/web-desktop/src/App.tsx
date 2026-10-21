import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Settings,
  Eye,
  EyeOff,
  GraduationCap,
  Download,
  LogOut,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  Phone,
  PhoneIncoming,
  PhoneOff,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import {
  decryptChatText,
  deriveRoomKeyFromId,
  encryptChatText,
  getOrCreateIdentityKeys,
  type IdentityCryptoBundle,
  type RoomSecretKeyBundle,
} from './crypto/e2ee';
import { Modal } from './components/Modal';
import { StorageUsage } from './components/StorageUsage';
import { deriveArchiveKey, syncLessonArchives, mergeArchiveLists, type LessonArchive } from './services/lessonArchive';
import { SfuMediaNodeClient } from './services/webrtcSfu';
import type {
  AppPlatform,
  AppReleaseManifest,
  AuthResponse,
  ClientToControlMsg,
  ContactRequestInfo,
  ControlToClientMsg,
  DecryptedChatMessage,
  EncryptedChatMessage,
  RoomInfo,
  UpdateCheckResponse,
  UserPublicProfile,
  UserRole,
} from './types/protocol';

const APP_VERSION = '0.1.0';
const runtimeEnv = (import.meta as unknown as { env?: { VITE_CONTROL_URL?: string; DEV?: boolean } }).env;
const DEFAULT_CONTROL_HTTP = (runtimeEnv?.VITE_CONTROL_URL ||
  ('__TAURI_INTERNALS__' in window ? 'http://127.0.0.1:4000'
    : runtimeEnv?.DEV ? `http://${window.location.hostname || '127.0.0.1'}:4000` : window.location.origin)).replace(/\/$/, '');


export type ArchivedLessonChat = LessonArchive;

function computeDmRoomId(u1: string, u2: string): string {
  const s1 = u1.toLowerCase();
  const s2 = u2.toLowerCase();
  const [first, second] = s1 <= s2 ? [s1, s2] : [s2, s1];
  return `${first.slice(0, 18)}${second.slice(18, 36)}`;
}

const VideoTile: React.FC<{
  stream: MediaStream | null;
  remoteFrameUrl?: string | null;
  muted?: boolean;
  label: string;
  username: string;
  role: UserRole;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenShareEnabled: boolean;
  isSelf?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
}> = ({
  stream,
  remoteFrameUrl,
  muted,
  label,
  username,
  role,
  audioEnabled,
  videoEnabled,
  screenShareEnabled,
  isSelf,
  isExpanded,
  onToggleExpand,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(() => {});
    }
  }, [stream, videoEnabled, screenShareEnabled]);

  const showLocalVideo = Boolean(isSelf && stream && (videoEnabled || screenShareEnabled));
  const showRemoteVideo = Boolean(!isSelf && remoteFrameUrl && (videoEnabled || screenShareEnabled));
  const showVideo = showLocalVideo || showRemoteVideo;
  const fitMode = screenShareEnabled ? 'object-contain' : 'object-cover';

  return (
    <div
      className={`relative flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-5 shadow-xs transition-all overflow-hidden ${
        isExpanded ? 'col-span-full min-h-[520px]' : 'min-h-[260px]'
      }`}
    >
      {showLocalVideo && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          className={`absolute inset-0 h-full w-full ${fitMode} bg-slate-950`}
        />
      )}
      {showRemoteVideo && remoteFrameUrl && (
        <img
          src={remoteFrameUrl}
          alt={label}
          className={`absolute inset-0 h-full w-full ${fitMode} bg-slate-950`}
        />
      )}

      {/* Верхняя строка карточки */}
      <div className="relative z-10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium ${
              role === 'tutor'
                ? 'bg-slate-900 text-white'
                : 'bg-slate-100 text-slate-700 border border-slate-200'
            }`}
          >
            {role === 'tutor' ? 'Репетитор' : 'Ученик'}
          </span>
          {screenShareEnabled && (
            <span className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white">
              <Monitor className="h-3.5 w-3.5" />
              Демонстрация экрана
            </span>
          )}
        </div>

        {showVideo && onToggleExpand && (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-label={isExpanded ? 'Свернуть' : 'Развернуть крупно'} title={isExpanded ? 'Свернуть' : 'Развернуть крупно'}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900/80 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-xs hover:bg-slate-900"
          >
            {isExpanded ? (
              <>
                <Minimize2 className="h-3.5 w-3.5" />
                Свернуть
              </>
            ) : (
              <>
                <Maximize2 className="h-3.5 w-3.5" />
                Крупно
              </>
            )}
          </button>
        )}
      </div>

      {/* Центральный аватар при выключенной камере */}
      {!showVideo && (
        <div className="my-auto flex flex-col items-center justify-center py-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-full border border-slate-200 bg-slate-100 text-xl font-semibold text-slate-800">
            {label.slice(0, 2).toUpperCase()}
          </div>
          <div className="mt-3 text-sm font-medium text-slate-900">
            {label} {isSelf ? '(Вы)' : ''}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">@{username}</div>
        </div>
      )}

      {/* Нижняя строка карточки */}
      <div className="relative z-10 flex items-center justify-between gap-2 pt-3">
        <div
          className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium ${
            showVideo
              ? 'bg-slate-900/80 text-white backdrop-blur-xs'
              : 'bg-slate-50 text-slate-700 border border-slate-200/80'
          }`}
        >
          <span>{label}</span>
          <span className="opacity-70">@{username}</span>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${
              audioEnabled
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-rose-200 bg-rose-50 text-rose-600'
            }`}
          >
            {audioEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          </span>
          <span
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border ${
              videoEnabled || showRemoteVideo
                ? 'border-slate-300 bg-slate-900 text-white'
                : 'border-slate-200 bg-slate-100 text-slate-400'
            }`}
          >
            {videoEnabled || showRemoteVideo ? (
              <Video className="h-4 w-4" />
            ) : (
              <VideoOff className="h-4 w-4" />
            )}
          </span>
        </div>
      </div>
    </div>
  );
};

export function App() {
  const [identityKeys, setIdentityKeys] = useState<IdentityCryptoBundle | null>(null);

  // Авторизация
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [usernameInput, setUsernameInput] = useState('');
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [roleInput, setRoleInput] = useState<UserRole>('tutor');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  const [token, setToken] = useState<string | null>(() => localStorage.getItem('liaper_token'));
  const [currentUser, setCurrentUser] = useState<UserPublicProfile | null>(() => {
    const raw = localStorage.getItem('liaper_user');
    try { return raw ? (JSON.parse(raw) as UserPublicProfile) : null; }
    catch { return null; }
  });

  // Взаимные контакты и заявки
  const [contacts, setContacts] = useState<UserPublicProfile[]>([]);
  const studentCount = contacts.filter((user) => user.role === 'student').length;
  const [incomingRequests, setIncomingRequests] = useState<ContactRequestInfo[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<ContactRequestInfo[]>([]);
  const [addContactNick, setAddContactNick] = useState('');
  const [searchNick, setSearchNick] = useState('');

  // Медиа-ноды и комнаты
  const [currentRoom, setCurrentRoom] = useState<RoomInfo | null>(null);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [incomingCall, setIncomingCall] = useState<{
    room: RoomInfo;
    caller: UserPublicProfile;
    withVideo: boolean;
  } | null>(null);

  // Групповой урок
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [selectedGroupNicks, setSelectedGroupNicks] = useState<string[]>([]);
  const [inviteNickInput, setInviteNickInput] = useState('');

  // Медиа-потоки
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [screenShareEnabled, setScreenShareEnabled] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteVideoFrames, setRemoteVideoFrames] = useState<Record<string, string>>({});
  const [connectedNodeLabel, setConnectedNodeLabel] = useState<string | null>(null);

  // Ключи комнат (прозрачно под капотом)
  const roomKeysRef = useRef<Map<string, RoomSecretKeyBundle>>(new Map());
  const [rawMessages, setRawMessages] = useState<EncryptedChatMessage[]>([]);
  const [decryptedMessages, setDecryptedMessages] = useState<DecryptedChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [selectedChatContact, setSelectedChatContact] = useState<UserPublicProfile | null>(null);
  const [chatMode, setChatMode] = useState<'lesson' | 'direct' | 'archive'>('lesson');
  const [archivedChats, setArchivedChats] = useState<ArchivedLessonChat[]>([]);
  const archivesRef = useRef<ArchivedLessonChat[]>([]);
  const archiveKeyRef = useRef<{ ownerId: string; key: CryptoKey } | null>(null);
  const archiveSyncBusy = useRef(false);
  const archiveSyncQueued = useRef(false);
  const [archiveUnlocked, setArchiveUnlocked] = useState(false);
  const [archiveSyncStatus, setArchiveSyncStatus] = useState('Для синхронизации разблокируйте архив паролем аккаунта');
  const [showArchiveUnlock, setShowArchiveUnlock] = useState(false);
  const [archivePassword, setArchivePassword] = useState('');
  const [archiveUnlocking, setArchiveUnlocking] = useState(false);
  const [archiveUnlockError, setArchiveUnlockError] = useState<string | null>(null);
  const [panel, setPanel] = useState<'contacts' | 'lesson' | 'chat' | 'settings'>('lesson');
  const [connected, setConnected] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [showPassword, setShowPassword] = useState(false);
  const [removingContact, setRemovingContact] = useState<UserPublicProfile | null>(null);
  const [sendingChat, setSendingChat] = useState(false);
  const [unreadChats, setUnreadChats] = useState<Record<string, number>>({});
  const chatViewRef = useRef<{ roomId: string | null; visible: boolean }>({ roomId: null, visible: false });
  const draftsRef = useRef<Record<string, string>>({});
  const [systemBanner, setSystemBanner] = useState<string | null>(null);
  const [releases, setReleases] = useState<AppReleaseManifest[]>([]);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResponse | null>(null);
  const [selectedUpdatePlatform, setSelectedUpdatePlatform] = useState<AppPlatform>('windows_x86_64');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const mediaFlagsRef = useRef({ audio: audioEnabled, video: videoEnabled, screen: screenShareEnabled });
  mediaFlagsRef.current = { audio: audioEnabled, video: videoEnabled, screen: screenShareEnabled };
  localStreamRef.current = localStream;

  useEffect(() => {
    if (!currentUser) { setArchivedChats([]); return; }
    try {
      const saved = JSON.parse(localStorage.getItem(`liaper_chat_archives:${currentUser.id}`) || '[]');
      const entries = Array.isArray(saved) ? saved : [];
      archivesRef.current = entries;
      setArchivedChats(entries);
    } catch { archivesRef.current = []; setArchivedChats([]); }
  }, [currentUser?.id]);

  const controlWsRef = useRef<WebSocket | null>(null);
  const sfuClientRef = useRef<SfuMediaNodeClient | null>(null);
  const sfuRoomIdRef = useRef<string | null>(null);
  const currentRoomRef = useRef<RoomInfo | null>(null);
  const currentUserRef = useRef<UserPublicProfile | null>(null);

  useEffect(() => {
    currentRoomRef.current = currentRoom;
  }, [currentRoom]);

  useEffect(() => {
    currentUserRef.current = currentUser;
  }, [currentUser]);

  useEffect(() => {
    getOrCreateIdentityKeys().then((bundle) => {
      setIdentityKeys(bundle);
    }).catch(() => setAuthError('Не удалось подготовить устройство. Откройте приложение через HTTPS или localhost.'));
    fetchReleases();
  }, []);

  const syncArchives = async () => {
    const ownerId = currentUserRef.current?.id;
    const bundle = archiveKeyRef.current;
    if (!ownerId || !bundle || bundle.ownerId !== ownerId || !token) return;
    if (archiveSyncBusy.current) { archiveSyncQueued.current = true; return; }
    archiveSyncBusy.current = true;
    setArchiveSyncStatus('Синхронизация…');
    try {
      const remote = await syncLessonArchives(DEFAULT_CONTROL_HTTP, token, bundle.key, ownerId, archivesRef.current);
      if (currentUserRef.current?.id !== ownerId) return;
      const combined = mergeArchiveLists(remote, archivesRef.current);
      archivesRef.current = combined;
      setArchivedChats(combined);
      localStorage.setItem(`liaper_chat_archives:${ownerId}`, JSON.stringify(combined));
      setArchiveSyncStatus('Архив синхронизирован с сервером');
    } catch (error) {
      if (currentUserRef.current?.id === ownerId) setArchiveSyncStatus(error instanceof DOMException
        ? 'Не удалось расшифровать архив. Проверьте пароль аккаунта.'
        : error instanceof Error ? error.message : 'Синхронизация недоступна. Локальная копия сохранена.');
    } finally {
      archiveSyncBusy.current = false;
      if (archiveSyncQueued.current) { archiveSyncQueued.current = false; if (currentUserRef.current?.id === ownerId) void syncArchives(); }
    }
  };

  const unlockArchives = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentUser || !token || archiveUnlocking) return;
    const ownerId = currentUser.id;
    setArchiveUnlocking(true);
    setArchiveUnlockError(null);
    try {
      const response = await fetch(`${DEFAULT_CONTROL_HTTP}/api/lesson-archives/unlock`, { method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: archivePassword }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error || 'Не удалось разблокировать архив'); }
      const key = await deriveArchiveKey(archivePassword, ownerId);
      if (currentUserRef.current?.id !== ownerId) return;
      archiveKeyRef.current = { ownerId, key };
      setArchiveUnlocked(true);
      setShowArchiveUnlock(false);
      setArchivePassword('');
      void syncArchives();
    } catch (error) { setArchiveUnlockError(error instanceof Error ? error.message : 'Нет связи с сервером'); }
    finally { setArchiveUnlocking(false); }
  };

  useEffect(() => {
    if (connected && archiveUnlocked) void syncArchives();
  }, [connected, archiveUnlocked, currentUser?.id]);

  useEffect(() => {
    if (panel === 'chat' && chatMode === 'archive' && archiveUnlocked) void syncArchives();
  }, [panel, chatMode]);

  useEffect(() => {
    if (!currentRoom) return;
    const timer = window.setTimeout(() => void saveCurrentLessonToArchive(false, true, false), 1000);
    return () => clearTimeout(timer);
  }, [currentRoom?.id, rawMessages.length]);

  const fetchReleases = async () => {
    try {
      const res = await fetch(`${DEFAULT_CONTROL_HTTP}/api/releases`);
      if (res.ok) {
        const list = (await res.json()) as AppReleaseManifest[];
        setReleases(list);
      }
    } catch {}
  };

  const checkAppUpdate = async (platform: AppPlatform) => {
    setCheckingUpdate(true);
    try {
      const res = await fetch(
        `${DEFAULT_CONTROL_HTTP}/api/releases/check?platform=${platform}&version=${APP_VERSION}`
      );
      if (res.ok) {
        const data = (await res.json()) as UpdateCheckResponse;
        setUpdateCheckResult(data);
      } else throw new Error('Update check failed');
    } catch {
      setSystemBanner('Не удалось проверить обновления. Повторите попытку позже.');
    } finally { setCheckingUpdate(false); }
  };

  // Reconnect only the current session. Old socket callbacks cannot clear a new one.
  useEffect(() => {
    if (!token || !identityKeys) return;
    let disposed = false;
    let retry: number | undefined;
    let ws: WebSocket;
    let failures = 0;
    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(`${DEFAULT_CONTROL_HTTP.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
      controlWsRef.current = ws;
      ws.onmessage = async (event) => {
        if (disposed || controlWsRef.current !== ws) return;
        try {
          const msg = JSON.parse(event.data as string) as ControlToClientMsg;
          if (msg.type === 'welcome') { failures = 0; setConnected(true); }
          await handleControlMessage(msg);
        } catch { /* Malformed packets must not break subsequent messages. */ }
      };
      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        controlWsRef.current = null;
        retry = window.setTimeout(connect, Math.min(1500 * 2 ** failures++, 15000));
      };
    };
    connect();
    return () => { disposed = true; clearTimeout(retry); ws?.close(); controlWsRef.current = null; };
  }, [token, identityKeys, connectionAttempt]);

  useEffect(() => () => {
    sfuClientRef.current?.disconnect();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const activeChatRoomId = chatMode === 'lesson' ? currentRoom?.id ?? null
    : chatMode === 'direct' && selectedChatContact && currentUser
      ? computeDmRoomId(currentUser.id, selectedChatContact.id) : null;

  chatViewRef.current = { roomId: activeChatRoomId, visible: panel === 'chat' || (window.innerWidth >= 1440 && panel !== 'settings') };
  useEffect(() => {
    setChatInput(activeChatRoomId ? draftsRef.current[activeChatRoomId] ?? '' : '');
  }, [activeChatRoomId]);
  useEffect(() => {
    if (activeChatRoomId && chatViewRef.current.visible) {
      setUnreadChats((prev) => { const next = { ...prev }; delete next[activeChatRoomId]; return next; });
    }
  }, [activeChatRoomId, panel]);
  useEffect(() => {
    if (selectedChatContact && !contacts.some((c) => c.id === selectedChatContact.id)) setSelectedChatContact(null);
  }, [contacts]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'end' });
  }, [decryptedMessages.length, activeChatRoomId, panel]);

  // Автоматическая расшифровка сообщений выбранного чата (урока или личного диалога с контактом)
  useEffect(() => {
    if (!activeChatRoomId) {
      setDecryptedMessages([]);
      return;
    }
    const roomId = activeChatRoomId;
    let cancelled = false;

    async function decryptAll() {
      let keyBundle = roomKeysRef.current.get(roomId);
      if (!keyBundle) {
        keyBundle = await deriveRoomKeyFromId(roomId);
        roomKeysRef.current.set(roomId, keyBundle);
      }

      const result: DecryptedChatMessage[] = [];
      for (const msg of rawMessages) {
        if (msg.room_id !== roomId) continue;
        try {
          const text = await decryptChatText(msg.ciphertext_b64, msg.iv_b64, keyBundle);
          result.push({
            ...msg,
            plaintext: text,
            verified_e2ee: true,
          });
        } catch {
          result.push({
            ...msg,
            plaintext: 'Не удалось расшифровать сообщение',
            verified_e2ee: false,
          });
        }
      }
      if (!cancelled) {
        setDecryptedMessages(result);
      }
    }

    decryptAll();
    return () => {
      cancelled = true;
    };
  }, [rawMessages, activeChatRoomId]);

  const sendControl = (msg: ClientToControlMsg): boolean => {
    if (controlWsRef.current?.readyState === WebSocket.OPEN) {
      controlWsRef.current.send(JSON.stringify(msg));
      return true;
    }
    setSystemBanner('Нет связи с сервером. Дождитесь подключения и повторите действие.');
    return false;
  };

  const connectToAssignedMediaNode = async (
    room: RoomInfo,
    withAudio: boolean,
    withVideo: boolean
  ) => {
    const me = currentUserRef.current;
    if (!me) return;

    if (sfuClientRef.current && sfuRoomIdRef.current === room.id) {
      return;
    }

    sfuClientRef.current?.disconnect();
    sfuClientRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());

    let keyBundle = roomKeysRef.current.get(room.id);
    if (!keyBundle) {
      keyBundle = await deriveRoomKeyFromId(room.id);
      roomKeysRef.current.set(room.id, keyBundle);
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: withAudio
          ? {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          : false,
        video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
      setLocalStream(stream);
    } catch {
      withAudio = false;
      withVideo = false;
      setAudioEnabled(false);
      setVideoEnabled(false);
      setLocalStream(null);
      setSystemBanner('Нет доступа к микрофону или камере. Проверьте разрешения устройства.');
      sendControl({ type: 'update_media_state', payload: { room_id: room.id, audio_enabled: false, video_enabled: false, screen_share_enabled: false, speaking: false } });
    }
    if (!currentUserRef.current || currentRoomRef.current?.id !== room.id) {
      stream?.getTracks().forEach((track) => track.stop());
      return;
    }

    const sfu = new SfuMediaNodeClient({
      roomId: room.id,
      userId: me.id,
      username: me.username,
      displayName: me.display_name,
      getRoomKey: () => roomKeysRef.current.get(room.id) ?? null,
      callbacks: {
        onNodeConnected: (nodeId, nodeName) => {
          setConnectedNodeLabel(`${nodeName} (${nodeId})`);
        },
        onRemoteVideoFrame: (peerId, dataUrl) => {
          setRemoteVideoFrames((prev) => ({ ...prev, [peerId]: dataUrl }));
        },
        onRemotePeerLeft: (peerId) => {
          setRemoteVideoFrames((prev) => {
            const copy = { ...prev };
            delete copy[peerId];
            return copy;
          });
        },
        onE2eeStatsUpdated: () => {},
      },
    });

    sfuClientRef.current = sfu;
    sfuRoomIdRef.current = room.id;
    sfu.connect(room.assigned_node.ws_url, stream, withAudio, withVideo, false);
  };

  const handleControlMessage = async (msg: ControlToClientMsg) => {
    switch (msg.type) {
      case 'welcome': {
        setCurrentUser(msg.payload.self_profile);
        setContacts(msg.payload.contacts);
        setIncomingRequests(msg.payload.incoming_requests);
        setOutgoingRequests(msg.payload.outgoing_requests);
        break;
      }

      case 'contacts_updated': {
        setContacts(msg.payload.contacts);
        setIncomingRequests(msg.payload.incoming_requests);
        setOutgoingRequests(msg.payload.outgoing_requests);
        break;
      }

      case 'nodes_updated': {
        break;
      }

      case 'room_updated': {
        const room = msg.payload.room;
        const wasInRoom = currentRoomRef.current?.id === room.id;
        currentRoomRef.current = room;
        setCurrentRoom(room);
        setIncomingCall(null);

        if (!wasInRoom) {
          setChatMode('lesson');
          setPanel('lesson');
          await connectToAssignedMediaNode(room, mediaFlagsRef.current.audio, mediaFlagsRef.current.video);
        }
        break;
      }

      case 'incoming_call': {
        setIncomingCall({
          room: msg.payload.room,
          caller: msg.payload.caller,
          withVideo: msg.payload.with_video,
        });
        break;
      }

      case 'call_declined': {
        setSystemBanner(`Пользователь @${msg.payload.declined_by} отклонил звонок`);
        break;
      }

      case 'encrypted_chat_received': {
        const message = msg.payload.message;
        if (message.sender_id !== currentUserRef.current?.id &&
            (!chatViewRef.current.visible || chatViewRef.current.roomId !== message.room_id)) {
          setUnreadChats((prev) => ({ ...prev, [message.room_id]: (prev[message.room_id] ?? 0) + 1 }));
        }
        setRawMessages((prev) =>
          prev.some((m) => m.id === msg.payload.message.id)
            ? prev
            : [...prev, msg.payload.message]
        );
        break;
      }

      case 'room_chat_history': {
        setRawMessages((prev) => [
          ...prev.filter((m) => m.room_id !== msg.payload.room_id),
          ...msg.payload.messages,
        ]);
        break;
      }

      case 'error': {
        setSystemBanner(msg.payload.message);
        break;
      }
    }
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identityKeys) return;
    setAuthError(null);
    setAuthLoading(true);

    try {
      const endpoint =
        authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const body =
        authMode === 'register'
          ? {
              username: usernameInput.trim().replace(/^@/, ''),
              display_name: displayNameInput || usernameInput,
              password: passwordInput,
              role: roleInput,
              e2ee_public_key: identityKeys.publicKeySpkiB64,
              key_fingerprint: identityKeys.fingerprint,
            }
          : {
              username: usernameInput.trim().replace(/^@/, ''),
              password: passwordInput,
              e2ee_public_key: identityKeys.publicKeySpkiB64,
              key_fingerprint: identityKeys.fingerprint,
            };

      const res = await fetch(`${DEFAULT_CONTROL_HTTP}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setAuthError(data.error || 'Ошибка авторизации');
        setAuthLoading(false);
        return;
      }

      const auth = data as AuthResponse;
      const archiveKey = await deriveArchiveKey(passwordInput, auth.user.id);
      archiveKeyRef.current = { ownerId: auth.user.id, key: archiveKey };
      setArchiveUnlocked(true);
      localStorage.setItem('liaper_token', auth.token);
      localStorage.setItem('liaper_user', JSON.stringify(auth.user));
      setToken(auth.token);
      setCurrentUser(auth.user);
    } catch {
      setAuthError('Сервер управления недоступен. Убедитесь, что запущен liaper-control.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    if (currentRoomRef.current) await saveCurrentLessonToArchive(false, true);
    archiveKeyRef.current = null;
    archivesRef.current = [];
    setArchivedChats([]);
    setArchiveUnlocked(false);
    setArchiveSyncStatus('Для синхронизации разблокируйте архив паролем аккаунта');
    sfuClientRef.current?.disconnect();
    sfuClientRef.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    setConnected(false);
    setIncomingCall(null);
    setContacts([]);
    setIncomingRequests([]);
    setOutgoingRequests([]);
    setRawMessages([]);
    setDecryptedMessages([]);
    setSelectedChatContact(null);
    setChatInput('');
    draftsRef.current = {};
    setUnreadChats({});
    setPasswordInput('');
    setRemoteVideoFrames({});
    roomKeysRef.current.clear();
    setPanel('lesson');
    controlWsRef.current?.close();
    localStorage.removeItem('liaper_token');
    localStorage.removeItem('liaper_user');
    setToken(null);
    setCurrentUser(null);
    setCurrentRoom(null);
    currentRoomRef.current = null;
    currentUserRef.current = null;
  };

  // Действия с контактами
  const handleSendContactRequest = (e: React.FormEvent) => {
    e.preventDefault();
    if (currentUser?.role !== 'tutor' || studentCount >= 10) return;
    const clean = addContactNick.trim().replace(/^@/, '');
    if (!clean) return;
    if (!sendControl({
      type: 'send_contact_request',
      payload: { target_username: clean },
    })) return;
    setAddContactNick('');
  };

  const handleRespondContactRequest = (requestId: string, accept: boolean) => {
    sendControl({
      type: 'respond_contact_request',
      payload: { request_id: requestId, accept },
    });
  };

  const handleRemoveContact = (contactUserId: string) => {
    if (selectedChatContact?.id === contactUserId) setSelectedChatContact(null);
    sendControl({
      type: 'remove_contact',
      payload: { contact_user_id: contactUserId },
    });
  };

  // Действия со звонками
  const startCallByNick = (targetUsername: string, withVideo: boolean) => {
    const clean = targetUsername.trim().replace(/^@/, '');
    if (!clean || currentRoom || !connected) return;
    setAudioEnabled(true);
    setVideoEnabled(withVideo);
    setChatMode('lesson');
    sendControl({
      type: 'call_by_nick',
      payload: {
        target_username: clean,
        with_video: withVideo,
      },
    });
  };

  const handleCreateGroupRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (currentRoom || !connected) return;
    setAudioEnabled(true);
    setVideoEnabled(false);
    setChatMode('lesson');
    sendControl({
      type: 'create_room',
      payload: {
        title: groupTitle.trim() || 'Групповой урок',
        invited_usernames: selectedGroupNicks,
        preferred_region: null,
      },
    });
    setShowGroupModal(false);
    setGroupTitle('');
    setSelectedGroupNicks([]);
  };

  const acceptIncomingCall = () => {
    if (!incomingCall) return;
    const { room, withVideo } = incomingCall;
    setAudioEnabled(true);
    setVideoEnabled(withVideo);
    setChatMode('lesson');
    setIncomingCall(null);
    sendControl({
      type: 'join_room',
      payload: {
        room_id: room.id,
        audio_enabled: true,
        video_enabled: withVideo,
      },
    });
  };

  const declineIncomingCall = () => {
    if (!incomingCall) return;
    sendControl({
      type: 'decline_call',
      payload: {
        room_id: incomingCall.room.id,
        reason: 'Занят',
      },
    });
    setIncomingCall(null);
  };

  const downloadArchiveAsTxt = (archive: ArchivedLessonChat) => {
    const lines = [
      `=== Архив чата урока: ${archive.title} ===`,
      `Дата сохранения: ${new Date(archive.savedAt).toLocaleString('ru-RU')}`,
      '',
      ...archive.messages.map(
        (m) => `[${m.time}] ${m.sender} (@${m.username}): ${m.text}`
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `liaper-lesson-${archive.id.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveCurrentLessonToArchive = async (downloadTxt = false, quiet = false, completed = true) => {
    if (!currentRoom) return;
    const ownerId = currentUserRef.current?.id;
    const roomMsgs = rawMessages.filter((m) => m.room_id === currentRoom.id);
    let keyBundle = roomKeysRef.current.get(currentRoom.id);
    if (!keyBundle) {
      keyBundle = await deriveRoomKeyFromId(currentRoom.id);
      roomKeysRef.current.set(currentRoom.id, keyBundle);
    }

    const formatted: ArchivedLessonChat['messages'] = [];
    for (const msg of roomMsgs) {
      let text = 'Не удалось расшифровать сообщение';
      try {
        text = await decryptChatText(msg.ciphertext_b64, msg.iv_b64, keyBundle);
      } catch {}
      formatted.push({
        id: msg.id,
        sentAt: msg.created_at,
        sender: msg.sender_display_name,
        username: msg.sender_username,
        text,
        time: new Date(msg.created_at).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      });
    }

    const archiveEntry: ArchivedLessonChat = {
      id: currentRoom.id,
      title: currentRoom.title,
      savedAt: new Date().toISOString(),
      startedAt: currentRoom.created_at,
      ...(completed ? { endedAt: new Date().toISOString() } : {}),
      messages: formatted,
    };

    if (currentUserRef.current?.id !== ownerId) return;
    const next = mergeArchiveLists(archivesRef.current, [archiveEntry]);
    try {
      localStorage.setItem(`liaper_chat_archives:${ownerId}`, JSON.stringify(next));
      archivesRef.current = next;
      setArchivedChats(next);
      void syncArchives();
    } catch {
      setSystemBanner('Не удалось сохранить архив на устройстве: недостаточно места. Скачайте чат в файл.');
      if (downloadTxt) downloadArchiveAsTxt(archiveEntry);
      return;
    }

    if (quiet) return;
    if (downloadTxt) {
      downloadArchiveAsTxt(archiveEntry);
      setSystemBanner(`Чат урока «${currentRoom.title}» сохранён в архив и скачан`);
    } else {
      setSystemBanner(`Чат урока «${currentRoom.title}» автоматически сохранён в архив`);
    }
  };

  const leaveCurrentRoom = () => {
    if (!currentRoom) return;
    void saveCurrentLessonToArchive(false);
    sendControl({
      type: 'leave_room',
      payload: { room_id: currentRoom.id },
    });
    sfuClientRef.current?.disconnect();
    sfuClientRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteVideoFrames({});
    setCurrentRoom(null);
    currentRoomRef.current = null;
    setConnectedNodeLabel(null);
    setScreenShareEnabled(false);
    setExpandedUserId(null);
  };

  const toggleMicrophone = async () => {
    const next = !audioEnabled;
    let stream = localStreamRef.current;
    if (next && !stream?.getAudioTracks().some((t) => t.readyState === 'live')) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (!currentRoomRef.current) { mic.getTracks().forEach((t) => t.stop()); return; }
        stream = new MediaStream([...mic.getAudioTracks(), ...(stream?.getVideoTracks() ?? [])]);
        setLocalStream(stream);
        localStreamRef.current = stream;
        await sfuClientRef.current?.replaceLocalStream(stream, true, videoEnabled || screenShareEnabled, screenShareEnabled);
      } catch { setSystemBanner('Микрофон недоступен. Проверьте разрешения устройства.'); return; }
    }
    stream?.getAudioTracks().forEach((t) => { t.enabled = next; });
    setAudioEnabled(next);
    sfuClientRef.current?.setMediaFlags(next, videoEnabled || screenShareEnabled, screenShareEnabled);
    if (currentRoom) sendControl({ type: 'update_media_state', payload: {
      room_id: currentRoom.id, audio_enabled: next, video_enabled: videoEnabled,
      screen_share_enabled: screenShareEnabled, speaking: false,
    } });
  };

  const publishMediaState = (video: boolean, screen: boolean) => {
    const room = currentRoomRef.current;
    if (room) sendControl({ type: 'update_media_state', payload: {
      room_id: room.id, audio_enabled: mediaFlagsRef.current.audio,
      video_enabled: video, screen_share_enabled: screen, speaking: false,
    } });
  };

  const replaceVideo = async (track: MediaStreamTrack | null, screen: boolean) => {
    const old = localStreamRef.current;
    old?.getVideoTracks().forEach((t) => { if (t !== track) t.stop(); });
    const stream = new MediaStream([...(old?.getAudioTracks() ?? []), ...(track ? [track] : [])]);
    localStreamRef.current = stream;
    setLocalStream(stream);
    setVideoEnabled(Boolean(track) && !screen);
    setScreenShareEnabled(Boolean(track) && screen);
    await sfuClientRef.current?.replaceLocalStream(stream, mediaFlagsRef.current.audio, Boolean(track), screen);
    publishMediaState(Boolean(track) && !screen, Boolean(track) && screen);
  };

  const toggleCamera = async () => {
    if (!currentRoom) return;
    if (videoEnabled) { await replaceVideo(null, false); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      if (!currentRoomRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      await replaceVideo(stream.getVideoTracks()[0], false);
    } catch { setSystemBanner('Камера недоступна. Проверьте разрешение в настройках устройства.'); }
  };

  const toggleScreenShare = async () => {
    if (!currentRoom) return;
    if (screenShareEnabled) { await replaceVideo(null, false); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setSystemBanner('Показ экрана недоступен на этом устройстве. Используйте компьютер.'); return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (!currentRoomRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      const track = stream.getVideoTracks()[0];
      track.onended = () => { if (localStreamRef.current?.getVideoTracks().includes(track)) void replaceVideo(null, false); };
      await replaceVideo(track, true);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotAllowedError'))
        setSystemBanner('Не удалось начать показ экрана. Повторите попытку.');
    }
  };

  const handleSendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeChatRoomId || !chatInput.trim() || sendingChat || !connected) return;
    const draft = chatInput;
    setSendingChat(true);
    try {
      let roomKey = roomKeysRef.current.get(activeChatRoomId);
      if (!roomKey) { roomKey = await deriveRoomKeyFromId(activeChatRoomId); roomKeysRef.current.set(activeChatRoomId, roomKey); }
      const encrypted = await encryptChatText(draft.trim(), roomKey);
      if (sendControl({ type: 'send_encrypted_chat', payload: {
        room_id: activeChatRoomId, ciphertext_b64: encrypted.ciphertextB64,
        iv_b64: encrypted.ivB64, room_key_id: encrypted.roomKeyId,
      } })) {
        delete draftsRef.current[activeChatRoomId];
        setChatInput((value) => value === draft ? '' : value);
      }
    } catch { setSystemBanner('Не удалось отправить сообщение. Текст сохранён в поле ввода.'); }
    finally { setSendingChat(false); }
  };

  const handleInviteByNick = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRoom || !inviteNickInput.trim()) return;
    if (!sendControl({
      type: 'invite_by_nick',
      payload: {
        room_id: currentRoom.id,
        target_username: inviteNickInput.trim().replace(/^@/, ''),
      },
    })) return;
    setInviteNickInput('');
  };

  // ============================================================================
  // Экран Авторизации (Чистый минималистичный корпоративный стиль)
  // ============================================================================
  if (!token || !currentUser) {
    return (
      <div className="flex min-h-screen flex-col justify-center bg-slate-50 px-6 py-12">
        <div className="mx-auto w-full max-w-md">
          <div className="flex items-center justify-between border-b border-slate-200 pb-6">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-900 text-sm font-bold text-white">
                  L
                </div>
                <span className="text-xl font-semibold tracking-tight text-slate-900">
                  Liaper
                </span>
              </div>
              <p className="mt-1.5 text-sm text-slate-500">
                Платформа для индивидуальных и групповых занятий
              </p>
            </div>
          </div>

          <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-8 shadow-xs">
            <div className="mb-6 grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('register');
                  setAuthError(null);
                }}
                className={`rounded-md py-2 text-sm font-medium transition ${
                  authMode === 'register'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Регистрация
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('login');
                  setAuthError(null);
                }}
                className={`rounded-md py-2 text-sm font-medium transition ${
                  authMode === 'login'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Вход
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-5">
              <div>
                <label htmlFor="username" className="block text-sm font-medium text-slate-700">
                  Никнейм
                </label>
                <div className="mt-2 flex items-center rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 focus-within:border-slate-900">
                  <span className="text-sm font-medium text-slate-400">@</span>
                  <input
                    type="text"
                    required
                    id="username"
                    autoComplete="username" autoCapitalize="none" spellCheck={false}
                    placeholder="elena_math"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    className="ml-1.5 w-full bg-transparent text-sm text-slate-900 focus:outline-none"
                  />
                </div>
              </div>

              {authMode === 'register' && (
                <>
                  <div>
                    <label htmlFor="display-name" className="block text-sm font-medium text-slate-700">
                      Ваше имя
                    </label>
                    <input
                      type="text"
                      required
                      id="display-name" autoComplete="name"
                      placeholder="Елена Сергеевна"
                      value={displayNameInput}
                      onChange={(e) => setDisplayNameInput(e.target.value)}
                      className="mt-2 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
                      Роль
                    </label>
                    <div className="mt-2 grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        aria-pressed={roleInput === 'tutor'}
                        onClick={() => setRoleInput('tutor')}
                        className={`flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
                          roleInput === 'tutor'
                            ? 'border-slate-900 bg-slate-900 text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        Репетитор
                      </button>
                      <button
                        type="button"
                        aria-pressed={roleInput === 'student'}
                        onClick={() => setRoleInput('student')}
                        className={`flex items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
                          roleInput === 'student'
                            ? 'border-slate-900 bg-slate-900 text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        Ученик
                      </button>
                    </div>
                  </div>
                </>
              )}

              <div>
                <label htmlFor="password" className="block text-sm font-medium text-slate-700">
                  Пароль
                </label>
                <input
                  id="password" type={showPassword ? 'text' : 'password'}
                  minLength={authMode === 'register' ? 4 : undefined}
                  autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
                  required
                  placeholder="••••••••"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <button type="button" className="inline-flex items-center gap-2 text-xs text-slate-600" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}{showPassword ? 'Скрыть пароль' : 'Показать пароль'}
              </button>
              {authError && (
                <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading || !identityKeys}
                className="w-full rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
              >
                {authLoading
                  ? 'Подключение...'
                  : authMode === 'register'
                    ? 'Зарегистрироваться'
                    : 'Войти'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const filteredContacts = contacts.filter((u) => {
    const q = searchNick.trim().replace(/^@/, '').toLowerCase();
    if (!q) return true;
    return (
      u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q)
    );
  });

  // ============================================================================
  // Основное Рабочее Пространство
  // ============================================================================
  return (
    <div className="app-shell" data-panel={panel}>
      <header className="app-topbar">
        <a className="app-brand" href="#" onClick={(e) => { e.preventDefault(); setPanel('lesson'); }} aria-label="Liaper — рабочее пространство">
          <span className="brand-mark">L</span><span>Liaper<small>Учебное пространство</small></span>
        </a>
        <nav className="workspace-nav" aria-label="Основная навигация">
          {([
            ['contacts', 'Контакты', Users], ['lesson', 'Урок', GraduationCap],
            ['chat', 'Сообщения', MessageSquare], ['settings', 'Настройки', Settings],
          ] as const).map(([id, title, Icon]) => (
            <button key={id} type="button" aria-current={panel === id ? 'page' : undefined}
              onClick={() => setPanel(id)}><Icon size={18} /><span>{title}</span>
              {id === 'contacts' && incomingRequests.length > 0 && <span className="nav-badge">{incomingRequests.length}</span>}
              {id === 'chat' && Object.values(unreadChats).reduce((a, b) => a + b, 0) > 0 && <span className="nav-badge">{Object.values(unreadChats).reduce((a, b) => a + b, 0)}</span>}
              {id === 'lesson' && currentRoom && <span className="live-dot" />}
            </button>
          ))}
        </nav>
        <span className={`connection-status ${connected ? 'is-connected' : ''}`} role="status">
          <span />{connected ? 'На связи' : 'Подключение…'}
        </span>
      </header>
      {!connected && <div className="connection-banner" role="status">
        Нет связи с сервером. Переподключаемся автоматически.
        <button type="button" onClick={() => setConnectionAttempt((n) => n + 1)}>Повторить</button>
        <button type="button" onClick={handleLogout}>Войти заново</button>
      </div>}
      {systemBanner && <div className="notification-banner" role="status"><span>{systemBanner}</span>
        <button type="button" aria-label="Закрыть уведомление" onClick={() => setSystemBanner(null)}><X size={18} /></button>
      </div>}
      <div className="workspace-layout">
      {/* Модальное окно входящего звонка */}
      {incomingCall && (
        <Modal label="Входящий звонок" onClose={declineIncomingCall}>
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                <PhoneIncoming className="h-7 w-7 animate-bounce" />
              </div>
              <div>
                <span className="inline-flex items-center rounded-md bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
                  Входящий звонок
                </span>
                <h3 className="mt-1 text-lg font-semibold text-slate-900">
                  {incomingCall.caller.display_name} (@{incomingCall.caller.username})
                </h3>
                <p className="text-xs text-slate-500">
                  {incomingCall.room.title}
                </p>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3 border-t border-slate-100 pt-5">
              <button
                type="button"
                onClick={declineIncomingCall}
                className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700 hover:bg-rose-100"
              >
                <PhoneOff className="h-4 w-4" />
                Отклонить
              </button>
              <button
                type="button"
                onClick={acceptIncomingCall}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-emerald-500"
              >
                <Phone className="h-4 w-4" />
                Принять
              </button>
            </div>
        </Modal>
      )}

      {/* Модальное окно создания группового урока */}
      {showGroupModal && (
        <Modal label="Создать групповой урок" onClose={() => setShowGroupModal(false)}>
            <h3 className="text-lg font-semibold text-slate-900">
              Создать групповой урок
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Пригласите учеников из вашего списка подтверждённых контактов.
            </p>

            <form onSubmit={handleCreateGroupRoom} className="mt-5 space-y-5">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
                  Тема занятия или название группы
                </label>
                <input
                  type="text"
                  placeholder="Алгебра — разбор вариантов"
                  value={groupTitle}
                  onChange={(e) => setGroupTitle(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
                  Участники из ваших контактов ({selectedGroupNicks.length})
                </label>
                <div className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-xl border border-slate-200 p-3">
                  {contacts.length === 0 ? (
                    <p className="py-3 text-center text-xs text-slate-400">
                      Список ваших контактов пока пуст. Сначала добавьте учеников по @нику.
                    </p>
                  ) : (
                    contacts.map((u) => {
                      const checked = selectedGroupNicks.includes(u.username);
                      return (
                        <label
                          key={u.id}
                          className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-100 px-3 py-2 hover:bg-slate-50"
                        >
                          <div className="flex items-center gap-2.5">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => {
                                setSelectedGroupNicks((prev) =>
                                  checked
                                    ? prev.filter((item) => item !== u.username)
                                    : [...prev, u.username]
                                );
                              }}
                              className="h-4 w-4 rounded border-slate-300 text-slate-900"
                            />
                            <div>
                              <div className="text-sm font-medium text-slate-800">
                                {u.display_name}
                              </div>
                              <div className="text-xs text-slate-500">@{u.username}</div>
                            </div>
                          </div>
                          <span
                            className={`h-2 w-2 rounded-full ${
                              u.online ? 'bg-emerald-500' : 'bg-slate-300'
                            }`}
                          />
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowGroupModal(false)}
                  className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                >
                  Начать занятие
                </button>
              </div>
            </form>
        </Modal>
      )}

      {/* ==================================================================== */}
      {/* ЛЕВАЯ КОЛОНКА: Профиль, Заявки в Контакты и Список Контактов (330px) */}
      {/* ==================================================================== */}
      <aside className="contacts-panel" aria-label="Контакты">
        {/* Профиль */}
        <div className="border-b border-slate-200 p-5">
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex shrink-0 h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-sm font-semibold text-white">
                {currentUser.display_name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-900" title={currentUser.display_name}>
                  {currentUser.display_name}
                </div>
                <div className="truncate text-xs text-slate-500">
                  @{currentUser.username} •{' '}
                  {currentUser.role === 'tutor' ? 'Репетитор' : 'Ученик'}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              aria-label="Выйти из аккаунта" title="Выйти из аккаунта"
              className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Добавление в контакты по @нику */}
        <div className="border-b border-slate-200 p-5">
          {currentUser.role === 'tutor' ? <>
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Ученики: {studentCount} из 10
          </span>
          <p className="mt-2 text-xs text-slate-500">{studentCount >= 10 ? 'Достигнут лимит. Удалите ученика, чтобы пригласить нового.' : 'Пригласите ученика по его @нику.'}</p>

          <form onSubmit={handleSendContactRequest} className="mt-2.5 flex gap-2">
            <div className="flex flex-1 items-center rounded-lg border border-slate-300 bg-slate-50/60 px-3 py-2 focus-within:border-slate-900 focus-within:bg-white">
              <span className="text-xs font-medium text-slate-400">@</span>
              <input
                type="text"
                placeholder="ник_пользователя"
                id="add-contact"
                aria-label="Никнейм нового контакта"
                value={addContactNick}
                disabled={!connected || studentCount >= 10}
                onChange={(e) => setAddContactNick(e.target.value)}
                className="ml-1 w-full bg-transparent text-sm text-slate-900 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={!connected || studentCount >= 10 || !addContactNick.trim()}
              aria-label="Отправить заявку в контакты" title="Отправить заявку в контакты"
              className="flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
            >
              <UserPlus className="h-4 w-4" />
              Добавить
            </button>
          </form>
          </> : <div className="text-sm text-slate-700"><p className="font-semibold">Приглашения от преподавателей</p><p className="mt-2 text-xs text-slate-500">Сообщите преподавателю свой @{currentUser.username} и примите его заявку ниже.</p></div>}

          <button
            type="button"
            onClick={() => setShowGroupModal(true)}
            disabled={!connected || Boolean(currentRoom)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
          >
            <Plus className="h-4 w-4" />
            Создать групповой урок
          </button>
        </div>

        {/* Входящие заявки в контакты */}
        {incomingRequests.length > 0 && (
          <div className="border-b border-slate-200 bg-amber-50/50 p-4">
            <div className="text-xs font-semibold text-slate-800">
              Заявки в контакты ({incomingRequests.length})
            </div>
            <div className="mt-2.5 space-y-2">
              {incomingRequests.map((req) => (
                <div
                  key={req.id}
                  className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3"
                >
                  <div className="min-w-0 pr-2">
                    <div className="truncate text-xs font-semibold text-slate-900">
                      {req.from_user.display_name}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      @{req.from_user.username}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleRespondContactRequest(req.id, true)}
                      aria-label="Принять заявку" title="Принять заявку"
                      className="rounded-lg bg-emerald-600 p-1.5 text-white hover:bg-emerald-500"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRespondContactRequest(req.id, false)}
                      aria-label="Отклонить" title="Отклонить"
                      className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 hover:bg-slate-100"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Список подтверждённых контактов */}
        <div className="flex flex-1 flex-col overflow-hidden p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
              Мои контакты ({filteredContacts.length})
            </span>
          </div>

          <div className="mt-2.5 flex items-center rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <Search className="h-4 w-4 text-slate-400" />
            <input
              type="text"
              aria-label="Поиск по контактам"
              placeholder="Найти контакт"
              value={searchNick}
              onChange={(e) => setSearchNick(e.target.value)}
              className="ml-2 w-full bg-transparent text-xs text-slate-900 focus:outline-none"
            />
          </div>

          <div className="mt-4 flex-1 space-y-2.5 overflow-y-auto pr-1">
            {filteredContacts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center">
                <Users className="mx-auto h-6 w-6 text-slate-400" />
                <p className="mt-2 text-xs font-medium text-slate-600">
                  {searchNick.trim() ? 'Ничего не найдено' : currentUser.role === 'tutor' ? 'Пригласите первого ученика' : 'Пока нет преподавателей'}
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {searchNick.trim() ? 'Попробуйте другое имя или никнейм.' : currentUser.role === 'tutor' ? 'Введите @ник ученика выше. После подтверждения заявки можно начать урок.' : 'Преподаватель появится здесь после того, как вы примете его заявку.'}
                </p>
              </div>
            ) : (
              filteredContacts.map((u) => (
                <div
                  key={u.id}
                  className="contact-card rounded-xl border border-slate-200/90 bg-white p-3.5 transition hover:border-slate-300"
                >
                  <div className="min-w-0 flex-1 pr-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          u.online ? 'bg-emerald-500' : 'bg-slate-300'
                        }`}
                      />
                      <span className="truncate text-sm font-medium text-slate-900">
                        {u.display_name}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-500">
                      <span>@{u.username}</span>
                      <span>•</span>
                      <span>{u.role === 'tutor' ? 'Репетитор' : 'Ученик'}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedChatContact(u);
                        setChatMode('direct');
                        setPanel('chat');
                      }}
                      aria-label={`Написать сообщение @${u.username}`} title={`Написать сообщение @${u.username}`}
                      className={`rounded-lg border p-2 transition ${
                        selectedChatContact?.id === u.id && chatMode === 'direct'
                          ? 'border-slate-900 bg-slate-900 text-white'
                          : 'border-slate-200 text-slate-700 hover:bg-slate-900 hover:text-white'
                      }`}
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => startCallByNick(u.username, false)}
                      disabled={!connected || Boolean(currentRoom)}
                      aria-label={`Позвонить @${u.username}`} title={`Позвонить @${u.username}`}
                      className="rounded-lg border border-slate-200 p-2 text-slate-700 hover:bg-slate-900 hover:text-white"
                    >
                      <Phone className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => startCallByNick(u.username, true)}
                      disabled={!connected || Boolean(currentRoom)}
                      aria-label={`Видеозвонок @${u.username}`} title={`Видеозвонок @${u.username}`}
                      className="rounded-lg border border-slate-200 p-2 text-slate-700 hover:bg-slate-900 hover:text-white"
                    >
                      <Video className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemovingContact(u)}
                      aria-label="Удалить из контактов" title="Удалить из контактов"
                      className="rounded-lg border border-slate-100 p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}

            {outgoingRequests.length > 0 && (
              <div className="pt-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  Ожидают подтверждения ({outgoingRequests.length})
                </div>
                <div className="mt-2 space-y-1.5">
                  {outgoingRequests.map((req) => (
                    <div
                      key={req.id}
                      className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600"
                    >
                      <span>
                        {req.to_user.display_name} (@{req.to_user.username})
                      </span>
                      <span className="text-[11px] text-slate-400">Заявка отправлена</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* ==================================================================== */}
      {/* ЦЕНТРАЛЬНАЯ КОЛОНКА: Зона Урока / Звонка */}
      {/* ==================================================================== */}
      <main className="lesson-panel" aria-label="Урок">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-7 py-4">
          <div>
            <h1 className="text-base font-semibold text-slate-900">
              {currentRoom ? currentRoom.title : 'Ваше учебное пространство'}
            </h1>
            <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
              {currentRoom ? (
                <span className="flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5 text-slate-700" />
                  Подключение к уроку:{' '}
                  <strong className="font-medium text-slate-800">
                    {connectedNodeLabel ? 'установлено' : 'подключаемся…'}
                  </strong>
                </span>
              ) : (
                <span>
                  Контакты, занятия и переписка — в одном месте
                </span>
              )}
            </div>
          </div>

          {currentRoom && (
            <form onSubmit={handleInviteByNick} className="flex items-center gap-2">
              <div className="flex items-center rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5">
                <UserPlus className="h-3.5 w-3.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Добавить контакт @ник"
                  value={inviteNickInput}
                  onChange={(e) => setInviteNickInput(e.target.value)}
                  className="ml-2 w-40 bg-transparent text-xs text-slate-900 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                className="rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
              >
                Позвать
              </button>
            </form>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-7">
          {!currentRoom ? (
            <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-10 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-800">
                <GraduationCap className="h-7 w-7" />
              </div>
              <h2 className="mt-5 text-lg font-semibold text-slate-900">
                {currentUser.role === 'tutor' ? 'Начните следующий урок' : 'Всё готово к занятию'}
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
                {currentUser.role === 'tutor' ? 'Пригласите до 10 учеников по @нику. После подтверждения заявки начните звонок или напишите сообщение.' : `Сообщите преподавателю свой @${currentUser.username}. Примите его приглашение в контактах, чтобы начать общение.`}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <button type="button" onClick={() => { setPanel('contacts'); document.getElementById('add-contact')?.focus(); }} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white"><UserPlus size={18} />{currentUser.role === 'tutor' ? 'Пригласить ученика' : 'Открыть контакты'}</button>
                <button type="button" disabled={!connected} onClick={() => setShowGroupModal(true)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-5 py-3 text-sm font-medium"><Plus size={18} />Создать урок</button>
              </div>
              <p className="mt-8 text-xs text-slate-500">Камера и микрофон включаются только во время звонка.
              </p>
            </div>
          ) : (
            <div
              className={`grid gap-6 ${
                currentRoom.participants.length <= 1
                  ? 'grid-cols-1 max-w-3xl mx-auto'
                  : currentRoom.participants.length === 2
                    ? 'grid-cols-1 lg:grid-cols-2'
                    : 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3'
              }`}
            >
              {currentRoom.participants.map((p) => {
                const isSelf = p.user_id === currentUser.id;
                const stream = isSelf ? localStream : null;
                const remoteFrameUrl = isSelf ? null : remoteVideoFrames[p.user_id] ?? null;
                const isExpanded = expandedUserId === p.user_id;
                return (
                  <VideoTile
                    key={p.user_id}
                    stream={stream}
                    remoteFrameUrl={remoteFrameUrl}
                    muted={isSelf}
                    label={p.display_name}
                    username={p.username}
                    role={p.role}
                    audioEnabled={isSelf ? audioEnabled : p.audio_enabled}
                    videoEnabled={isSelf ? videoEnabled : p.video_enabled}
                    screenShareEnabled={
                      isSelf ? screenShareEnabled : p.screen_share_enabled
                    }
                    isSelf={isSelf}
                    isExpanded={isExpanded}
                    onToggleExpand={() =>
                      setExpandedUserId(isExpanded ? null : p.user_id)
                    }
                  />
                );
              })}
            </div>
          )}
        </div>

        {currentRoom && (
          <footer className="flex items-center justify-between border-t border-slate-200 bg-white px-7 py-4">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <UserCheck className="h-4 w-4 text-emerald-600" />
              <span>Участников на уроке: {currentRoom.participants.length}</span>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-pressed={audioEnabled} aria-label={audioEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
                onClick={toggleMicrophone}
                className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                  audioEnabled
                    ? 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                    : 'bg-rose-600 text-white hover:bg-rose-500'
                }`}
              >
                {audioEnabled ? (
                  <>
                    <Mic className="h-4 w-4" />
                    Микрофон вкл
                  </>
                ) : (
                  <>
                    <MicOff className="h-4 w-4" />
                    Микрофон выкл
                  </>
                )}
              </button>

              <button
                type="button"
                aria-pressed={videoEnabled} aria-label={videoEnabled ? 'Выключить камеру' : 'Включить камеру'}
                onClick={toggleCamera}
                className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                  videoEnabled
                    ? 'bg-slate-900 text-white hover:bg-slate-800'
                    : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                }`}
              >
                {videoEnabled ? (
                  <>
                    <Video className="h-4 w-4" />
                    Камера вкл
                  </>
                ) : (
                  <>
                    <VideoOff className="h-4 w-4" />
                    Камера
                  </>
                )}
              </button>

              <button
                type="button"
                aria-pressed={screenShareEnabled}
                onClick={toggleScreenShare}
                className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition ${
                  screenShareEnabled
                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                    : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
                }`}
              >
                {screenShareEnabled ? (
                  <>
                    <MonitorOff className="h-4 w-4" />
                    Остановить показ
                  </>
                ) : (
                  <>
                    <Monitor className="h-4 w-4" />
                    Демонстрация экрана
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={leaveCurrentRoom}
                className="flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-rose-500"
              >
                <PhoneOff className="h-4 w-4" />
                Завершить
              </button>
            </div>

            <div className="text-xs text-slate-400">
              {currentRoom.assigned_node.region}
            </div>
          </footer>
        )}
      </main>

      {/* ==================================================================== */}
      {/* ПРАВАЯ КОЛОНКА: Чат Урока, Серверы и Обновления */}
      {/* ==================================================================== */}
      <aside className="chat-panel" aria-label={panel === 'settings' ? 'Настройки' : 'Сообщения'}>
        <div className="panel-heading"><h2>{panel === 'settings' ? 'Настройки' : 'Сообщения'}</h2>
          <span>{panel === 'settings' ? `Версия ${APP_VERSION}` : 'Личные чаты и уроки'}</span></div>

        {/* ВКЛАДКА 1: Чат (Урок, Личный диалог с контактом и Архив уроков) */}
        {panel !== 'settings' && (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Переключатель режима чата */}
            <div className="border-b border-slate-200 bg-white px-4 py-3 space-y-2.5">
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => setChatMode('lesson')}
                  className={`rounded-md py-1.5 text-[11px] font-semibold transition ${
                    chatMode === 'lesson'
                      ? 'bg-white text-slate-900 shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Чат урока
                </button>
                <button
                  type="button"
                  onClick={() => setChatMode('direct')}
                  className={`rounded-md py-1.5 text-[11px] font-semibold transition ${
                    chatMode === 'direct'
                      ? 'bg-white text-slate-900 shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Личный чат
                </button>
                <button
                  type="button"
                  onClick={() => setChatMode('archive')}
                  className={`rounded-md py-1.5 text-[11px] font-semibold transition ${
                    chatMode === 'archive'
                      ? 'bg-white text-slate-900 shadow-2xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Архив ({archivedChats.length})
                </button>
              </div>

              {chatMode === 'lesson' && currentRoom && (
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <span className="truncate text-xs font-medium text-slate-600">
                    Урок: <strong className="text-slate-900">{currentRoom.title}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => void saveCurrentLessonToArchive(true, false, false)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-900 hover:text-white"
                  >
                    <Download className="h-3 w-3" />
                    В архив (.txt)
                  </button>
                </div>
              )}

              {chatMode === 'direct' && (
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <select
                    value={selectedChatContact?.id ?? ''}
                    onChange={(e) => {
                      const found = contacts.find((c) => c.id === e.target.value) ?? null;
                      setSelectedChatContact(found);
                    }}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-800 focus:border-slate-900 focus:outline-none"
                  >
                    <option value="">— Выберите контакт для переписки —</option>
                    {contacts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name} (@{c.username})
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {chatMode === 'archive' ? (
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                  <p role="status">{archiveSyncStatus}</p>
                  <button type="button" className="mt-2 font-medium text-slate-900 underline" onClick={() => {
                    if (archiveUnlocked) void syncArchives(); else { setArchiveUnlockError(null); setShowArchiveUnlock(true); }
                  }}>{archiveUnlocked ? 'Синхронизировать' : 'Разблокировать архив'}</button>
                </div>
                {archivedChats.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center text-center text-xs text-slate-400">
                    <Download className="mb-2 h-6 w-6 stroke-1" />
                    Сохранённых архивов уроков пока нет. В конце урока чат сохраняется автоматически или по кнопке «В архив (.txt)».
                  </div>
                ) : (
                  archivedChats.map((arch) => (
                    <div
                      key={`${arch.id}-${arch.savedAt}`}
                      className="rounded-xl border border-slate-200 bg-slate-50/60 p-3.5 space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold text-slate-900">
                            {arch.title}
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {new Date(arch.savedAt).toLocaleString('ru-RU')} • Сообщений:{' '}
                            {arch.messages.length}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => downloadArchiveAsTxt(arch)}
                          className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-slate-800"
                        >
                          <Download className="h-3 w-3" />
                          .txt
                        </button>
                      </div>
                      <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2.5 text-[11px]">
                        {arch.messages.map((m, idx) => (
                          <div key={idx} className="text-slate-700">
                            <span className="text-slate-400">[{m.time}]</span>{' '}
                            <strong className="text-slate-900">{m.sender}:</strong> {m.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <>
                <div className="flex-1 space-y-3 overflow-y-auto p-5">
                  {!activeChatRoomId ? (
                    <div className="flex h-full flex-col items-center justify-center text-center text-xs text-slate-400">
                      <MessageSquare className="mb-2 h-6 w-6 stroke-1" />
                      {chatMode === 'direct'
                        ? 'Выберите контакт из списка слева (иконка чата) или в меню выше, чтобы начать личную переписку'
                        : 'Начните звонок или переключитесь на «Личный чат», чтобы написать контакту напрямую'}
                    </div>
                  ) : decryptedMessages.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-xs text-slate-400">
                      Сообщений пока нет. Напишите первое сообщение!
                    </div>
                  ) : (
                    decryptedMessages.map((m) => {
                      const isMine = m.sender_id === currentUser.id;
                      return (
                        <div
                          key={m.id}
                          className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                        >
                          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-500">
                            <span className="font-medium text-slate-700">
                              {m.sender_display_name}
                            </span>
                            <span>@{m.sender_username}</span>
                          </div>
                          <div
                            className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                              isMine
                                ? 'bg-slate-900 text-white'
                                : 'border border-slate-200 bg-slate-50 text-slate-900'
                            }`}
                          >
                            {m.plaintext}
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={chatEndRef} />
                </div>

                <form
                  onSubmit={handleSendChatMessage}
                  className="border-t border-slate-200 p-4"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      disabled={!activeChatRoomId || !connected}
                      placeholder={
                        activeChatRoomId
                          ? chatMode === 'direct' && selectedChatContact
                            ? `Сообщение для @${selectedChatContact.username}...`
                            : 'Написать сообщение...'
                          : 'Выберите контакт или начните урок'
                      }
                      value={chatInput}
                      onChange={(e) => { setChatInput(e.target.value); if (activeChatRoomId) draftsRef.current[activeChatRoomId] = e.target.value; }}
                      className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-slate-900 focus:outline-none disabled:bg-slate-100"
                    />
                    <button
                      type="submit"
                      aria-label="Отправить сообщение"
                      disabled={!activeChatRoomId || !chatInput.trim() || !connected || sendingChat}
                      className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                </form>
              </>
            )}
          </div>
        )}

        {/* ВКЛАДКА 3: Обновления Приложений */}
        {panel === 'settings' && (
          <div className="flex-1 space-y-5 overflow-y-auto p-5">
            {token && <StorageUsage key={currentUser?.id} baseUrl={DEFAULT_CONTROL_HTTP} token={token} />}
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  Обновления приложений
                </h3>
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                  v{APP_VERSION}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                Скачивание и проверка обновлений для Windows, Linux и Android.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className=" flex gap-2">
                <select
                  value={selectedUpdatePlatform}
                  onChange={(e) =>
                    (setSelectedUpdatePlatform(e.target.value as AppPlatform), setUpdateCheckResult(null))
                  }
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                >
                  <option value="windows_x86_64">Windows (.exe)</option>
                  <option value="linux_x86_64">Linux (.AppImage)</option>
                  <option value="android_arm64">Android (.apk)</option>
                </select>
                <button
                  type="button"
                  disabled={checkingUpdate}
                  onClick={() => checkAppUpdate(selectedUpdatePlatform)}
                  className="flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Проверить
                </button>
              </div>

              {updateCheckResult && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-xs">
                  {updateCheckResult.update_available && updateCheckResult.latest ? (
                    <div className="space-y-1.5">
                      <div className="font-semibold text-emerald-700">
                        Доступно обновление v{updateCheckResult.latest.version}
                      </div>
                      <p className="text-slate-600">
                        {updateCheckResult.latest.release_notes}
                      </p>
                      <a
                        href={updateCheckResult.latest.download_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-white hover:bg-emerald-500"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Скачать обновление
                      </a>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-slate-600">
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      Установлена последняя версия (v{updateCheckResult.current_version})
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2.5">
              {releases.map((rel) => (
                <div
                  key={rel.platform}
                  className="rounded-xl border border-slate-200 p-3.5 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900">
                      {({ windows_x86_64: 'Windows', linux_x86_64: 'Linux', android_arm64: 'Android', android_universal: 'Android', web: 'Web' })[rel.platform]}
                    </span>
                    <span className="rounded bg-slate-900 px-2 py-0.5 text-[11px] text-white">
                      v{rel.version}
                    </span>
                  </div>
                  <p className="mt-1 text-slate-600">{rel.release_notes}</p>
                </div>
              ))}
            </div>


          </div>
        )}
      </aside>
      </div>
      {showArchiveUnlock && <Modal label="Разблокировать архив" onClose={() => { setShowArchiveUnlock(false); setArchivePassword(''); }}>
        <h2 className="text-lg font-semibold">Разблокировать архив</h2>
        <p className="mt-2 text-sm text-slate-600">Введите пароль аккаунта, чтобы расшифровать историю уроков и синхронизировать её между устройствами. Ключ действует до выхода или закрытия приложения.</p>
        <form onSubmit={unlockArchives} className="mt-5 space-y-4">
          <label htmlFor="archive-password" className="block text-sm font-medium">Пароль аккаунта</label>
          <input id="archive-password" type="password" autoComplete="current-password" required value={archivePassword} onChange={(e) => setArchivePassword(e.target.value)} className="w-full rounded-lg border border-slate-300 p-3" />
          {archiveUnlockError && <p role="alert" className="text-sm text-rose-700">{archiveUnlockError}</p>}
          <button type="submit" disabled={archiveUnlocking} className="w-full rounded-lg bg-slate-900 p-3 text-sm text-white">{archiveUnlocking ? 'Разблокировка…' : 'Разблокировать'}</button>
        </form>
      </Modal>}
      {removingContact && <Modal label="Удалить контакт" onClose={() => setRemovingContact(null)}>
        <h2 className="text-lg font-semibold">Удалить {removingContact.display_name}?</h2>
        <p className="mt-3 text-sm text-slate-600">Для новых звонков и сообщений потребуется снова обменяться заявками.</p>
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={() => setRemovingContact(null)} className="rounded-lg border border-slate-300 px-4 py-2">Отмена</button>
          <button type="button" className="rounded-lg bg-rose-600 px-4 py-2 text-white" onClick={() => {
            handleRemoveContact(removingContact.id); setRemovingContact(null);
          }}>Удалить</button>
        </div>
      </Modal>}
    </div>
  );
}
export default App;
