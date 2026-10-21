import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  Cpu,
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
  Sparkles,
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
  MediaNodeInfo,
  RoomInfo,
  UpdateCheckResponse,
  UserPublicProfile,
  UserRole,
} from './types/protocol';

const APP_VERSION = '0.1.0';
const DEFAULT_CONTROL_HTTP =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_CONTROL_URL ||
  'http://127.0.0.1:4000';

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
  const showRemoteVideo = Boolean(!isSelf && remoteFrameUrl);
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
            title={isExpanded ? 'Свернуть' : 'Развернуть крупно'}
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
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [usernameInput, setUsernameInput] = useState('');
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [roleInput, setRoleInput] = useState<UserRole>('tutor');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);

  const [token, setToken] = useState<string | null>(() => localStorage.getItem('liaper_token'));
  const [currentUser, setCurrentUser] = useState<UserPublicProfile | null>(() => {
    const raw = localStorage.getItem('liaper_user');
    return raw ? (JSON.parse(raw) as UserPublicProfile) : null;
  });

  // Взаимные контакты и заявки
  const [contacts, setContacts] = useState<UserPublicProfile[]>([]);
  const [incomingRequests, setIncomingRequests] = useState<ContactRequestInfo[]>([]);
  const [outgoingRequests, setOutgoingRequests] = useState<ContactRequestInfo[]>([]);
  const [addContactNick, setAddContactNick] = useState('');
  const [searchNick, setSearchNick] = useState('');

  // Медиа-ноды и комнаты
  const [mediaNodes, setMediaNodes] = useState<MediaNodeInfo[]>([]);
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

  // Правая панель
  const [rightTab, setRightTab] = useState<'chat' | 'nodes' | 'releases'>('chat');
  const [systemBanner, setSystemBanner] = useState<string | null>(null);

  // Реестр релизов
  const [releases, setReleases] = useState<AppReleaseManifest[]>([]);
  const [updateCheckResult, setUpdateCheckResult] = useState<UpdateCheckResponse | null>(null);
  const [selectedUpdatePlatform, setSelectedUpdatePlatform] =
    useState<AppPlatform>('windows_x86_64');
  const [newReleaseVersion, setNewReleaseVersion] = useState('0.2.0');
  const [newReleaseNotes, setNewReleaseNotes] = useState(
    'Улучшено качество демонстрации экрана (HD 720p) и добавлены взаимные контакты.'
  );
  const [publishStatus, setPublishStatus] = useState<string | null>(null);

  const controlWsRef = useRef<WebSocket | null>(null);
  const sfuClientRef = useRef<SfuMediaNodeClient | null>(null);
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
    });
    fetchReleases();
  }, []);

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
    try {
      const res = await fetch(
        `${DEFAULT_CONTROL_HTTP}/api/releases/check?platform=${platform}&version=${APP_VERSION}`
      );
      if (res.ok) {
        const data = (await res.json()) as UpdateCheckResponse;
        setUpdateCheckResult(data);
      }
    } catch {
      setSystemBanner('Не удалось связаться с реестром обновлений');
    }
  };

  const publishNewRelease = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishStatus(null);
    const ext =
      selectedUpdatePlatform === 'windows_x86_64'
        ? 'exe'
        : selectedUpdatePlatform === 'linux_x86_64'
          ? 'AppImage'
          : 'apk';

    const manifest: AppReleaseManifest = {
      platform: selectedUpdatePlatform,
      version: newReleaseVersion.trim(),
      build_number: 2,
      release_notes: newReleaseNotes.trim(),
      download_url: `${DEFAULT_CONTROL_HTTP}/releases/liaper-${selectedUpdatePlatform}-v${newReleaseVersion.trim()}.${ext}`,
      sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      signature: 'dW50cnVzdGVkIGNvbW1lbnQ6IGxpYXBlci1lZDI1NTE5LXNpZ25hdHVyZS12Mg==',
      file_size_bytes: 9_150_000,
      mandatory: false,
      published_at: new Date().toISOString(),
    };

    try {
      const res = await fetch(`${DEFAULT_CONTROL_HTTP}/api/releases/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          admin_secret: 'liaper-release-secret-2026',
          manifest,
        }),
      });
      if (res.ok) {
        await fetchReleases();
        await checkAppUpdate(selectedUpdatePlatform);
        setPublishStatus(`Версия v${manifest.version} опубликована!`);
      }
    } catch {
      setPublishStatus('Ошибка при публикации релиза');
    }
  };

  // Подключение к WebSocket центрального сервера
  useEffect(() => {
    if (!token || !identityKeys) return;

    const wsUrl = `${DEFAULT_CONTROL_HTTP.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    controlWsRef.current = ws;

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data as string) as ControlToClientMsg;
        await handleControlMessage(msg);
      } catch {}
    };

    ws.onclose = () => {
      controlWsRef.current = null;
    };

    return () => {
      ws.close();
    };
  }, [token, identityKeys]);

  // Автоматическая расшифровка сообщений чата комнаты
  useEffect(() => {
    if (!currentRoom) {
      setDecryptedMessages([]);
      return;
    }
    const roomId = currentRoom.id;
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
            plaintext: msg.ciphertext_b64,
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
  }, [rawMessages, currentRoom]);

  const sendControl = (msg: ClientToControlMsg) => {
    if (controlWsRef.current && controlWsRef.current.readyState === WebSocket.OPEN) {
      controlWsRef.current.send(JSON.stringify(msg));
    }
  };

  const connectToAssignedMediaNode = async (
    room: RoomInfo,
    withAudio: boolean,
    withVideo: boolean
  ) => {
    const me = currentUserRef.current;
    if (!me) return;

    if (sfuClientRef.current && currentRoomRef.current?.id === room.id) {
      return;
    }

    sfuClientRef.current?.disconnect();

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
      setLocalStream(null);
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
    sfu.connect(room.assigned_node.ws_url, stream, withAudio, withVideo, false);
  };

  const handleControlMessage = async (msg: ControlToClientMsg) => {
    switch (msg.type) {
      case 'welcome': {
        setCurrentUser(msg.payload.self_profile);
        setContacts(msg.payload.contacts);
        setIncomingRequests(msg.payload.incoming_requests);
        setOutgoingRequests(msg.payload.outgoing_requests);
        setMediaNodes(msg.payload.media_nodes);
        break;
      }

      case 'contacts_updated': {
        setContacts(msg.payload.contacts);
        setIncomingRequests(msg.payload.incoming_requests);
        setOutgoingRequests(msg.payload.outgoing_requests);
        break;
      }

      case 'nodes_updated': {
        setMediaNodes(msg.payload.nodes);
        break;
      }

      case 'room_updated': {
        const room = msg.payload.room;
        const wasInRoom = currentRoomRef.current?.id === room.id;
        setCurrentRoom(room);

        if (!wasInRoom) {
          await connectToAssignedMediaNode(room, audioEnabled, videoEnabled);
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
        setRawMessages((prev) => [...prev, msg.payload.message]);
        break;
      }

      case 'room_chat_history': {
        setRawMessages(msg.payload.messages);
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
              username: usernameInput,
              display_name: displayNameInput || usernameInput,
              password: passwordInput,
              role: roleInput,
              e2ee_public_key: identityKeys.publicKeySpkiB64,
              key_fingerprint: identityKeys.fingerprint,
            }
          : {
              username: usernameInput,
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

  const handleLogout = () => {
    sfuClientRef.current?.disconnect();
    controlWsRef.current?.close();
    localStorage.removeItem('liaper_token');
    localStorage.removeItem('liaper_user');
    setToken(null);
    setCurrentUser(null);
    setCurrentRoom(null);
  };

  // Действия с контактами
  const handleSendContactRequest = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = addContactNick.trim().replace(/^@/, '');
    if (!clean) return;
    sendControl({
      type: 'send_contact_request',
      payload: { target_username: clean },
    });
    setAddContactNick('');
  };

  const handleRespondContactRequest = (requestId: string, accept: boolean) => {
    sendControl({
      type: 'respond_contact_request',
      payload: { request_id: requestId, accept },
    });
  };

  const handleRemoveContact = (contactUserId: string) => {
    sendControl({
      type: 'remove_contact',
      payload: { contact_user_id: contactUserId },
    });
  };

  // Действия со звонками
  const startCallByNick = (targetUsername: string, withVideo: boolean) => {
    const clean = targetUsername.trim().replace(/^@/, '');
    if (!clean) return;
    setAudioEnabled(true);
    setVideoEnabled(withVideo);
    setRawMessages([]);
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
    setAudioEnabled(true);
    setVideoEnabled(false);
    setRawMessages([]);
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
    setRawMessages([]);
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

  const leaveCurrentRoom = () => {
    if (!currentRoom) return;
    sendControl({
      type: 'leave_room',
      payload: { room_id: currentRoom.id },
    });
    sfuClientRef.current?.disconnect();
    sfuClientRef.current = null;
    localStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
    setRemoteVideoFrames({});
    setCurrentRoom(null);
    setConnectedNodeLabel(null);
    setScreenShareEnabled(false);
    setExpandedUserId(null);
  };

  const toggleMicrophone = () => {
    const next = !audioEnabled;
    setAudioEnabled(next);
    sfuClientRef.current?.setMediaFlags(next, videoEnabled || screenShareEnabled, screenShareEnabled);
    if (localStream) {
      localStream.getAudioTracks().forEach((t) => {
        t.enabled = next;
      });
    }
    if (currentRoom) {
      sendControl({
        type: 'update_media_state',
        payload: {
          room_id: currentRoom.id,
          audio_enabled: next,
          video_enabled: videoEnabled,
          screen_share_enabled: screenShareEnabled,
          speaking: false,
        },
      });
    }
  };

  const toggleCamera = async () => {
    const next = !videoEnabled;
    setVideoEnabled(next);
    setScreenShareEnabled(false);

    if (currentRoom) {
      try {
        if (next) {
          const newStream = await navigator.mediaDevices.getUserMedia({
            audio: audioEnabled,
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          });
          localStream?.getTracks().forEach((t) => t.stop());
          setLocalStream(newStream);
          await sfuClientRef.current?.replaceLocalStream(newStream, audioEnabled, true, false);
        } else {
          localStream?.getVideoTracks().forEach((t) => t.stop());
          sfuClientRef.current?.setMediaFlags(audioEnabled, false, false);
        }
      } catch {
        setSystemBanner('Веб-камера не обнаружена или доступ запрещён');
      }

      sendControl({
        type: 'update_media_state',
        payload: {
          room_id: currentRoom.id,
          audio_enabled: audioEnabled,
          video_enabled: next,
          screen_share_enabled: false,
          speaking: false,
        },
      });
    }
  };

  const toggleScreenShare = async () => {
    if (!currentRoom) return;
    const next = !screenShareEnabled;

    if (next) {
      try {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 24 },
          },
          audio: true,
        });
        setScreenShareEnabled(true);
        setVideoEnabled(false);
        setLocalStream(displayStream);
        await sfuClientRef.current?.replaceLocalStream(displayStream, audioEnabled, true, true);

        sendControl({
          type: 'update_media_state',
          payload: {
            room_id: currentRoom.id,
            audio_enabled: audioEnabled,
            video_enabled: false,
            screen_share_enabled: true,
            speaking: false,
          },
        });
      } catch {
        // Отменено пользователем
      }
    } else {
      localStream?.getVideoTracks().forEach((t) => t.stop());
      setScreenShareEnabled(false);
      sfuClientRef.current?.setMediaFlags(audioEnabled, false, false);
      sendControl({
        type: 'update_media_state',
        payload: {
          room_id: currentRoom.id,
          audio_enabled: audioEnabled,
          video_enabled: false,
          screen_share_enabled: false,
          speaking: false,
        },
      });
    }
  };

  const handleSendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRoom || !chatInput.trim()) return;

    let roomKey = roomKeysRef.current.get(currentRoom.id);
    if (!roomKey) {
      roomKey = await deriveRoomKeyFromId(currentRoom.id);
      roomKeysRef.current.set(currentRoom.id, roomKey);
    }

    const encrypted = await encryptChatText(chatInput.trim(), roomKey);
    sendControl({
      type: 'send_encrypted_chat',
      payload: {
        room_id: currentRoom.id,
        ciphertext_b64: encrypted.ciphertextB64,
        iv_b64: encrypted.ivB64,
        room_key_id: encrypted.roomKeyId,
      },
    });
    setChatInput('');
  };

  const handleInviteByNick = (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentRoom || !inviteNickInput.trim()) return;
    sendControl({
      type: 'invite_by_nick',
      payload: {
        room_id: currentRoom.id,
        target_username: inviteNickInput.trim(),
      },
    });
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
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
                  Ваш никнейм (@username)
                </label>
                <div className="mt-2 flex items-center rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 focus-within:border-slate-900">
                  <span className="text-sm font-medium text-slate-400">@</span>
                  <input
                    type="text"
                    required
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
                    <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
                      Имя и Фамилия
                    </label>
                    <input
                      type="text"
                      required
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
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-600">
                  Пароль
                </label>
                <input
                  type="password"
                  required
                  placeholder="••••••••"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              {authError && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs font-medium text-rose-700">
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
    <div className="flex h-screen w-screen overflow-hidden bg-slate-50 text-slate-900">
      {/* Модальное окно входящего звонка */}
      {incomingCall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-6 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-xl">
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
          </div>
        </div>
      )}

      {/* Модальное окно создания группового урока */}
      {showGroupModal && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-6 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-7 shadow-xl">
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
          </div>
        </div>
      )}

      {/* ==================================================================== */}
      {/* ЛЕВАЯ КОЛОНКА: Профиль, Заявки в Контакты и Список Контактов (330px) */}
      {/* ==================================================================== */}
      <aside className="flex w-[330px] shrink-0 flex-col border-r border-slate-200 bg-white">
        {/* Профиль */}
        <div className="border-b border-slate-200 p-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-sm font-semibold text-white">
                {currentUser.display_name.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  {currentUser.display_name}
                </div>
                <div className="text-xs text-slate-500">
                  @{currentUser.username} •{' '}
                  {currentUser.role === 'tutor' ? 'Репетитор' : 'Ученик'}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleLogout}
              title="Выйти из аккаунта"
              className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Добавление в контакты по @нику */}
        <div className="border-b border-slate-200 p-5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Добавить в контакты по @нику
          </span>

          <form onSubmit={handleSendContactRequest} className="mt-2.5 flex gap-2">
            <div className="flex flex-1 items-center rounded-lg border border-slate-300 bg-slate-50/60 px-3 py-2 focus-within:border-slate-900 focus-within:bg-white">
              <span className="text-xs font-medium text-slate-400">@</span>
              <input
                type="text"
                placeholder="ник_пользователя"
                value={addContactNick}
                onChange={(e) => setAddContactNick(e.target.value)}
                className="ml-1 w-full bg-transparent text-sm text-slate-900 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              title="Отправить заявку в контакты"
              className="flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-medium text-white hover:bg-slate-800"
            >
              <UserPlus className="h-4 w-4" />
              Добавить
            </button>
          </form>

          <button
            type="button"
            onClick={() => setShowGroupModal(true)}
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
                      title="Принять заявку"
                      className="rounded-lg bg-emerald-600 p-1.5 text-white hover:bg-emerald-500"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRespondContactRequest(req.id, false)}
                      title="Отклонить"
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
              placeholder="Фильтр по контактам..."
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
                  У вас пока нет добавленных контактов
                </p>
                <p className="mt-1 text-[11px] text-slate-400">
                  Введите @ник ученика или преподавателя выше и отправьте заявку в контакты.
                </p>
              </div>
            ) : (
              filteredContacts.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between rounded-xl border border-slate-200/90 bg-white p-3.5 transition hover:border-slate-300"
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
                      onClick={() => startCallByNick(u.username, false)}
                      title={`Позвонить @${u.username}`}
                      className="rounded-lg border border-slate-200 p-2 text-slate-700 hover:bg-slate-900 hover:text-white"
                    >
                      <Phone className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => startCallByNick(u.username, true)}
                      title={`Видеозвонок @${u.username}`}
                      className="rounded-lg border border-slate-200 p-2 text-slate-700 hover:bg-slate-900 hover:text-white"
                    >
                      <Video className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveContact(u.id)}
                      title="Удалить из контактов"
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
      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-7 py-4">
          <div>
            <h1 className="text-base font-semibold text-slate-900">
              {currentRoom ? currentRoom.title : 'Рабочее пространство урока'}
            </h1>
            <div className="mt-1 flex items-center gap-3 text-xs text-slate-500">
              {currentRoom ? (
                <span className="flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5 text-slate-700" />
                  Сервер звонка:{' '}
                  <strong className="font-medium text-slate-800">
                    {connectedNodeLabel || currentRoom.assigned_node.name}
                  </strong>
                </span>
              ) : (
                <span>
                  Выберите человека из списка ваших контактов слева, чтобы начать звонок или групповой урок
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

        {systemBanner && (
          <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-7 py-2.5 text-xs font-medium text-amber-900">
            <span>{systemBanner}</span>
            <button
              type="button"
              onClick={() => setSystemBanner(null)}
              className="text-amber-700 underline"
            >
              Закрыть
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-7">
          {!currentRoom ? (
            <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white p-10 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-800">
                <Sparkles className="h-7 w-7" />
              </div>
              <h2 className="mt-5 text-lg font-semibold text-slate-900">
                Готово к проведению занятий
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
                Добавьте учеников в контакты по <code className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-800">@нику</code>.
                После взаимного подтверждения вы сможете звонить в один клик, включать демонстрацию экрана в высоком разрешении и общаться в чате.
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
      <aside className="flex w-[360px] shrink-0 flex-col border-l border-slate-200 bg-white">
        <div className="grid grid-cols-3 border-b border-slate-200 p-2 gap-1 bg-slate-50">
          <button
            type="button"
            onClick={() => setRightTab('chat')}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              rightTab === 'chat'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Чат урока
          </button>
          <button
            type="button"
            onClick={() => setRightTab('nodes')}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              rightTab === 'nodes'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Cpu className="h-3.5 w-3.5" />
            Ноды ({mediaNodes.length})
          </button>
          <button
            type="button"
            onClick={() => {
              setRightTab('releases');
              fetchReleases();
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition ${
              rightTab === 'releases'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Download className="h-3.5 w-3.5" />
            Обновления
          </button>
        </div>

        {/* ВКЛАДКА 1: Чат Урока */}
        {rightTab === 'chat' && (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 space-y-3 overflow-y-auto p-5">
              {!currentRoom ? (
                <div className="flex h-full flex-col items-center justify-center text-center text-xs text-slate-400">
                  <MessageSquare className="mb-2 h-6 w-6 stroke-1" />
                  Начните звонок или урок, чтобы обмениваться сообщениями
                </div>
              ) : decryptedMessages.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-xs text-slate-400">
                  Сообщений пока нет. Отправьте ссылку, задание или заметку к уроку!
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
                        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
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
            </div>

            <form
              onSubmit={handleSendChatMessage}
              className="border-t border-slate-200 p-4"
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  disabled={!currentRoom}
                  placeholder={
                    currentRoom
                      ? 'Написать сообщение...'
                      : 'Чат доступен во время звонка'
                  }
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  className="flex-1 rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm focus:border-slate-900 focus:outline-none disabled:bg-slate-100"
                />
                <button
                  type="submit"
                  disabled={!currentRoom || !chatInput.trim()}
                  className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ВКЛАДКА 2: Серверные Медиа-ноды */}
        {rightTab === 'nodes' && (
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Серверные ноды звонков
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                Звонок автоматически направляется на самый свободный сервер.
              </p>
            </div>

            <div className="space-y-3">
              {mediaNodes.map((node, index) => (
                <div
                  key={node.node_id}
                  className={`rounded-xl border p-4 ${
                    index === 0
                      ? 'border-emerald-300 bg-emerald-50/40'
                      : 'border-slate-200 bg-white'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-900">
                      {node.name}
                    </span>
                    <span
                      className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                        node.healthy
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-rose-100 text-rose-700'
                      }`}
                    >
                      {node.healthy ? 'Онлайн' : 'Недоступна'}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-2.5 text-center text-xs">
                    <div>
                      <div className="text-[10px] text-slate-400">Нагрузка</div>
                      <div className="font-semibold text-slate-900">
                        {node.load_score}%
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">Регион</div>
                      <div className="font-semibold text-slate-900">
                        {node.region}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-400">Участники</div>
                      <div className="font-semibold text-slate-900">
                        {node.active_peers}/{node.max_peers}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ВКЛАДКА 3: Обновления Приложений */}
        {rightTab === 'releases' && (
          <div className="flex-1 space-y-5 overflow-y-auto p-5">
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
                    setSelectedUpdatePlatform(e.target.value as AppPlatform)
                  }
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                >
                  <option value="windows_x86_64">Windows (.exe)</option>
                  <option value="linux_x86_64">Linux (.AppImage)</option>
                  <option value="android_arm64">Android (.apk)</option>
                </select>
                <button
                  type="button"
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
                      {rel.platform}
                    </span>
                    <span className="rounded bg-slate-900 px-2 py-0.5 text-[11px] text-white">
                      v{rel.version}
                    </span>
                  </div>
                  <p className="mt-1 text-slate-600">{rel.release_notes}</p>
                </div>
              ))}
            </div>

            <form
              onSubmit={publishNewRelease}
              className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
            >
              <div className="text-xs font-semibold text-slate-800">
                Выпустить новую версию в реестр
              </div>
              <input
                type="text"
                value={newReleaseVersion}
                onChange={(e) => setNewReleaseVersion(e.target.value)}
                placeholder="Версия (например, 0.2.0)"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
              />
              <textarea
                rows={2}
                value={newReleaseNotes}
                onChange={(e) => setNewReleaseNotes(e.target.value)}
                placeholder="Описание изменений"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
              />
              <button
                type="submit"
                className="w-full rounded-lg bg-slate-900 py-2 text-xs font-medium text-white hover:bg-slate-800"
              >
                Опубликовать релиз
              </button>
              {publishStatus && (
                <div className="text-[11px] font-medium text-emerald-700">
                  {publishStatus}
                </div>
              )}
            </form>
          </div>
        )}
      </aside>
    </div>
  );
}
export default App;
