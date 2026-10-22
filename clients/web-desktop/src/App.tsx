import React, { useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Lock,
  Clock3,
  Check,
  ChevronLeft,
  Copy,
  Loader2,
  ShieldCheck,
  CheckCircle2,
  Flag,
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
  MoreHorizontal,
  Pencil,
  Forward,
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
  createEncryptedKeyEnvelopesForUser,
  decryptChatMessageWithKeyring,
  encryptChatText,
  generateRoomKey,
  getOrCreateIdentityKeys,
  loadSavedRoomKeyrings,
  openEncryptedKeyEnvelope,
  saveRoomKeyToLocalStore,
  serializeChatPayload,
  type IdentityCryptoBundle,
  type RoomKeyring,
  type RoomSecretKeyBundle,
} from './crypto/e2ee';
import {
  AttachmentCard,
  OutgoingTransferCard,
  type OutgoingAttachmentTransfer,
} from './components/AttachmentCard';
import {
  MediaRecorderBar,
  type ReadyAttachmentDraft,
} from './components/MediaRecorderBar';
import { AdminDashboard } from './components/AdminDashboard';
import { Modal } from './components/Modal';
import { MessageMenu, type MessageMenuState } from './components/MessageMenu';
import { Avatar } from './components/Avatar';
import { LinkifiedText } from './components/LinkifiedText';
import { Landing } from './components/Landing';
import { LogoMark } from './components/Logo';
import { StorageUsage } from './components/StorageUsage';
import { downloadAndDecryptAttachment, uploadEncryptedAttachment } from './services/attachments';
import { deriveArchiveKey, syncLessonArchives, mergeArchiveLists, type LessonArchive } from './services/lessonArchive';
import { SfuMediaNodeClient } from './services/webrtcSfu';
import { solvePow } from './services/pow';
import { primeIncomingCallAlerts, startIncomingCallAlert, stopIncomingCallAlert } from './services/incomingCallAlert';
import type {
  AppPlatform,
  AppReleaseManifest,
  AuthResponse,
  ChatAttachmentMeta,
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

const APP_VERSION = '0.2.1';
const runtimeEnv = (import.meta as unknown as { env?: { VITE_CONTROL_URL?: string; DEV?: boolean } }).env;
const DEFAULT_CONTROL_HTTP = (runtimeEnv?.VITE_CONTROL_URL ||
  ('__TAURI_INTERNALS__' in window ? 'http://127.0.0.1:4000'
    : runtimeEnv?.DEV ? `http://${window.location.hostname || '127.0.0.1'}:4000` : window.location.origin)).replace(/\/$/, '');


export type ArchivedLessonChat = LessonArchive;

const PANEL_LIMITS = { left: [260, 480], right: [300, 560] } as const;
function clampPanelWidth(side: 'left' | 'right', width: number): number {
  const [min, max] = PANEL_LIMITS[side];
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** Компактная пометка «Переслано · Имя»; откуда и когда — во всплывающей подсказке. */
function ForwardedLabel({ forwarded, onAccent = false }: { forwarded: NonNullable<DecryptedChatMessage['forwarded']>; onAccent?: boolean }) {
  const details = `Из урока «${forwarded.source}»${forwarded.username ? `, @${forwarded.username}` : ''}${forwarded.time ? `, ${forwarded.time}` : ''}`;
  return (
    <span title={details} className={`mb-1 flex items-center gap-1 text-xs font-medium ${onAccent ? 'text-indigo-100' : 'text-indigo-600'}`}>
      <Forward className="h-3 w-3 shrink-0" />
      <span className="truncate">Переслано · {forwarded.sender}</span>
    </span>
  );
}

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
  userId: string;
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
  userId,
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
  // Кадр показывается целиком (вертикальные телефоны не обрезаются), пустые поля заполняет размытая копия

  return (
    <div
      className={`relative flex flex-col justify-between rounded-2xl border border-slate-200 bg-white p-4 shadow-xs transition-all overflow-hidden ${
        isExpanded ? 'col-span-full min-h-[min(70dvh,640px)]' : 'min-h-[300px]'
      }`}
    >
      {showVideo && <div className="absolute inset-0 bg-slate-950" />}
      {showLocalVideo && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={muted}
          className={`absolute inset-0 h-full w-full object-contain ${screenShareEnabled ? '' : '-scale-x-100'}`}
        />
      )}
      {showRemoteVideo && remoteFrameUrl && (
        <>
          {!screenShareEnabled && (
            <img src={remoteFrameUrl} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl" />
          )}
          <img
            src={remoteFrameUrl}
            alt={label}
            className="absolute inset-0 h-full w-full object-contain"
          />
        </>
      )}

      {/* Верхняя строка карточки */}
      <div className="relative z-10 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium ${
              role === 'tutor'
                ? 'bg-indigo-600 text-white'
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
          <Avatar name={label} seed={userId} size={72} />
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


// Где находился пользователь (раздел, вкладка чата, открытый диалог) — восстанавливается после обновления страницы
type SavedView = {
  userId: string;
  panel: 'contacts' | 'lesson' | 'chat' | 'settings';
  chatMode: 'lesson' | 'direct' | 'archive';
  contactId: string | null;
  archiveId: string | null;
};
const VIEW_STORAGE_KEY = 'liaper_view';
function readSavedView(): SavedView | null {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) || 'null');
    if (!raw || typeof raw.userId !== 'string') return null;
    const panels = ['contacts', 'lesson', 'chat', 'settings'];
    const modes = ['lesson', 'direct', 'archive'];
    return {
      userId: raw.userId,
      panel: panels.includes(raw.panel) ? raw.panel : 'lesson',
      chatMode: modes.includes(raw.chatMode) ? raw.chatMode : 'direct',
      contactId: typeof raw.contactId === 'string' ? raw.contactId : null,
      archiveId: typeof raw.archiveId === 'string' ? raw.archiveId : null,
    };
  } catch {
    return null;
  }
}

export function App() {
  const [identityKeys, setIdentityKeys] = useState<IdentityCryptoBundle | null>(null);

  // Авторизация
  const [authMode, setAuthMode] = useState<'login' | 'register'>(() => (window.location.hash === '#register' ? 'register' : 'login'));
  // Лендинг показывается только в браузере и только тем, кто ещё не открывал форму входа
  const [showLanding, setShowLanding] = useState(
    () => !('__TAURI_INTERNALS__' in window) && !['#login', '#register'].includes(window.location.hash),
  );
  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash;
      if (h === '#login' || h === '#register') { setAuthMode(h === '#register' ? 'register' : 'login'); setShowLanding(false); }
      else if (!('__TAURI_INTERNALS__' in window) && (h === '' || h === '#top')) setShowLanding(true);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [usernameInput, setUsernameInput] = useState('');
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [roleInput, setRoleInput] = useState<UserRole>('tutor');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authCheckingRobot, setAuthCheckingRobot] = useState(false);
  // Задача proof-of-work решается заранее, пока человек заполняет форму регистрации
  const powRef = useRef<{ promise: Promise<{ challenge: string; solution: string }>; expiresAt: number } | null>(null);

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
  // Урок, который этот аккаунт сейчас проводит на другом устройстве
  const [otherDeviceCall, setOtherDeviceCall] = useState<RoomInfo | null>(null);
  // Урок, который продолжается после обновления страницы и ждёт возвращения
  const [resumeCall, setResumeCall] = useState<RoomInfo | null>(null);
  // Редактирование темы идущего урока (null — не редактируем)
  const [topicDraft, setTopicDraft] = useState<string | null>(null);
  const [videoEnabled, setVideoEnabled] = useState(false);
  const [screenShareEnabled, setScreenShareEnabled] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteVideoFrames, setRemoteVideoFrames] = useState<Record<string, string>>({});
  const [connectedNodeLabel, setConnectedNodeLabel] = useState<string | null>(null);

  // Ключи комнат (случайные 256-битные AES-GCM ключи с обменом через X25519 конверты)
  const roomKeyringsRef = useRef<Map<string, RoomKeyring>>(new Map());
  const [keyringVersion, setKeyringVersion] = useState(0);
  const sentEnvelopesRef = useRef<Set<string>>(new Set());
  const contactsRef = useRef<UserPublicProfile[]>([]);
  const identityKeysRef = useRef<IdentityCryptoBundle | null>(null);
  const [outgoingTransfers, setOutgoingTransfers] = useState<OutgoingAttachmentTransfer[]>([]);
  const uploadAbortRef = useRef<Map<string, AbortController>>(new Map());
  const [storageRefreshTrigger, setStorageRefreshTrigger] = useState(0);
  const [rawMessages, setRawMessages] = useState<EncryptedChatMessage[]>([]);
  const [decryptedMessages, setDecryptedMessages] = useState<DecryptedChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [selectedChatContact, setSelectedChatContact] = useState<UserPublicProfile | null>(null);
  const savedViewRef = useRef<SavedView | null>(null);
  if (savedViewRef.current === null) {
    const saved = readSavedView();
    // Чужой сохранённый вид (другой аккаунт на этом устройстве) не применяем
    savedViewRef.current = saved && saved.userId === currentUser?.id ? saved : { userId: '', panel: 'lesson', chatMode: 'direct', contactId: null, archiveId: null };
  }
  // Урок после перезагрузки не продолжается сам — открываем личные чаты
  const [chatMode, setChatMode] = useState<'lesson' | 'direct' | 'archive'>(() => (savedViewRef.current?.chatMode === 'archive' ? 'archive' : 'direct'));
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(() => savedViewRef.current?.archiveId ?? null);
  const [selectedArchiveMsgKeys, setSelectedArchiveMsgKeys] = useState<string[]>([]);
  // Окно пересылки из архива: выбранные сообщения, выбранный чат, комментарий и поиск
  const [forwardDialog, setForwardDialog] = useState<{ archive: ArchivedLessonChat; messages: ArchivedLessonChat['messages'] } | null>(null);
  const [forwardTargetValue, setForwardTargetValue] = useState<string>('');
  const [forwardComment, setForwardComment] = useState('');
  const [forwardSearch, setForwardSearch] = useState('');
  const [forwardingArchiveMsgs, setForwardingArchiveMsgs] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportReason, setReportReason] = useState('Оскорбления / нарушение правил занятия');
  const [submittingReport, setSubmittingReport] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiCategoryIdx, setEmojiCategoryIdx] = useState(0);
  const [editingMessage, setEditingMessage] = useState<DecryptedChatMessage | null>(null);
  const [messageMenu, setMessageMenu] = useState<(MessageMenuState & { message: DecryptedChatMessage }) | null>(null);
  const [deletingMessage, setDeletingMessage] = useState<DecryptedChatMessage | null>(null);
  const closeMessageMenu = React.useCallback(() => setMessageMenu(null), []);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // Поле сообщения растёт вместе с текстом (до ~8 строк), дальше — прокрутка внутри
  useEffect(() => {
    const el = chatInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [chatInput]);

  const EMOJI_CATEGORIES = [
    {
      label: '😀 Эмоции',
      items: [
        '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
        '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😋', '😛', '😜',
        '🤪', '🤨', '🧐', '🤓', '😎', '🥳', '😏', '😒', '😞', '😔',
        '😟', '😕', '🙁', '😣', '😖', '😫', '🥺', '😢', '😭', '😤',
        '😠', '😡', '🤯', '😳', '😱', '🤗', '🤔', '🤭', '🤫', '😶',
        '😐', '🙄', '😯', '😮', '😲', '🥱', '😴', '🤤', '😷', '🤒',
      ],
    },
    {
      label: '🎓 Учёба и жесты',
      items: [
        '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉',
        '👆', '👇', '☝️', '✋', '👋', '🤝', '🙏', '✍️', '💪', '🧠',
        '👀', '💡', '📚', '📖', '📝', '✏️', '🖊️', '📐', '📏', '📊',
        '📈', '📌', '📎', '🔍', '🎓', '🏫', '🏆', '🥇', '🥈', '🥉',
        '🎯', '✅', '❌', '❓', '❗', '💯', '🔥', '⭐', '🌟', '✨',
        '🎉', '🎊', '👏', '🙌', '🫶', '🫡', '💻', '🖥️', '📱', '🎧',
      ],
    },
    {
      label: '❤️ Сердца и разное',
      items: [
        '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
        '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☀️',
        '🌈', '☁️', '❄️', '⚡', '🌸', '🌺', '🌻', '🍀', '🍎', '🍓',
        '🍕', '☕', '🍵', '🍰', '🍫', '🚀', '✈️', '⏰', '⏳', '🔔',
        '💬', '💭', '🎵', '🎶', '🎨', '🧩', '🎲', '🐱', '🐶', '🦊',
      ],
    },
  ];

  const insertEmojiIntoChat = (emoji: string) => {
    setChatInput((prev) => {
      const next = prev + emoji;
      if (activeChatRoomId) {
        draftsRef.current[activeChatRoomId] = next;
      }
      return next;
    });
    chatInputRef.current?.focus();
  };
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
  const [panel, setPanel] = useState<'contacts' | 'lesson' | 'chat' | 'settings'>(() => savedViewRef.current?.panel ?? 'lesson');
  // Открытый диалог восстанавливаем, когда сервер прислал список контактов
  const pendingContactIdRef = useRef<string | null>(savedViewRef.current?.contactId ?? null);
  useEffect(() => {
    const id = pendingContactIdRef.current;
    if (!id || contacts.length === 0) return;
    pendingContactIdRef.current = null;
    const contact = contacts.find((c) => c.id === id);
    if (contact) setSelectedChatContact((cur) => cur ?? contact);
  }, [contacts]);
  useEffect(() => {
    if (!currentUser) return;
    const view: SavedView = {
      userId: currentUser.id,
      panel,
      chatMode,
      contactId: selectedChatContact?.id ?? pendingContactIdRef.current,
      archiveId: selectedArchiveId,
    };
    try { localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view)); } catch { /* не критично */ }
  }, [currentUser, panel, chatMode, selectedChatContact, selectedArchiveId]);

  // Входящий звонок: рингтон, системное уведомление, мигание окна/вкладки
  const hasUser = currentUser !== null;
  useEffect(() => {
    if (hasUser) primeIncomingCallAlerts();
  }, [hasUser]);
  useEffect(() => {
    if (!incomingCall) {
      stopIncomingCallAlert();
      return;
    }
    startIncomingCallAlert({
      key: incomingCall.room.id,
      callerName: incomingCall.caller.display_name || `@${incomingCall.caller.username}`,
      roomTitle: incomingCall.room.title,
      withVideo: incomingCall.withVideo,
    });
  }, [incomingCall]);
  useEffect(() => () => stopIncomingCallAlert(), []);

  // Ширина боковых панелей (перетаскиванием), запоминается на устройстве
  const [panelWidths, setPanelWidths] = useState<{ left: number; right: number }>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('liaper_panel_widths') || 'null');
      if (saved && typeof saved.left === 'number' && typeof saved.right === 'number') return saved;
    } catch {
      // хранилище недоступно — используем значения по умолчанию
    }
    return { left: 320, right: 360 };
  });
  useEffect(() => {
    try { localStorage.setItem('liaper_panel_widths', JSON.stringify(panelWidths)); } catch { /* не критично */ }
  }, [panelWidths]);
  const startPanelResize = (side: 'left' | 'right') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidths[side];
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('is-resizing');
    const onMove = (ev: PointerEvent) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      setPanelWidths((prev) => ({ ...prev, [side]: clampPanelWidth(side, startW + delta) }));
    };
    const onUp = () => {
      document.body.classList.remove('is-resizing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };
  const resizeHandleProps = (side: 'left' | 'right') => ({
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-label': side === 'left' ? 'Ширина панели контактов' : 'Ширина панели сообщений',
    'aria-valuenow': panelWidths[side],
    'aria-valuemin': PANEL_LIMITS[side][0],
    'aria-valuemax': PANEL_LIMITS[side][1],
    title: 'Потяните, чтобы изменить ширину. Двойной щелчок — по умолчанию',
    tabIndex: 0,
    className: `panel-resizer is-${side}`,
    onPointerDown: startPanelResize(side),
    onDoubleClick: () => setPanelWidths((prev) => ({ ...prev, [side]: side === 'left' ? 320 : 360 })),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const grow = (e.key === 'ArrowRight') === (side === 'left');
      setPanelWidths((prev) => ({ ...prev, [side]: clampPanelWidth(side, prev[side] + (grow ? 24 : -24)) }));
    },
  });
  const isAdminAccount = Boolean(
    currentUser &&
      ['napsy', 'admin'].includes(currentUser.username.trim().toLowerCase())
  );
  const [showAdminDashboard, setShowAdminDashboard] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      (window.location.search.includes('admin=1') || window.location.hash === '#admin')
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyA') {
        e.preventDefault();
        setShowAdminDashboard((prev) => !prev);
      }
    };
    const onHashChange = () => {
      if (window.location.hash === '#admin') {
        setShowAdminDashboard(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);
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
    contactsRef.current = contacts;
  }, [contacts]);

  useEffect(() => {
    identityKeysRef.current = identityKeys;
  }, [identityKeys]);

  useEffect(() => {
    getOrCreateIdentityKeys().then((bundle) => {
      identityKeysRef.current = bundle;
      setIdentityKeys(bundle);
    }).catch(() => setAuthError('Не удалось подготовить устройство. Откройте приложение через HTTPS или localhost.'));
    loadSavedRoomKeyrings().then((loaded) => {
      for (const [roomId, keyring] of Object.entries(loaded)) {
        roomKeyringsRef.current.set(roomId, keyring);
      }
      setKeyringVersion((v) => v + 1);
    }).catch(() => {});
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
  // Во время урока по умолчанию показываем его чат; после завершения возвращаемся к личным диалогам
  const currentRoomId = currentRoom?.id ?? null;
  useEffect(() => {
    setChatMode((mode) => (currentRoomId ? (mode === 'archive' ? mode : 'lesson') : mode === 'lesson' ? 'direct' : mode));
  }, [currentRoomId]);
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
      const keyring = roomKeyringsRef.current.get(roomId) ?? null;
      const result: DecryptedChatMessage[] = [];
      for (const msg of rawMessages) {
        if (msg.room_id !== roomId) continue;
        try {
          const dec = await decryptChatMessageWithKeyring({
            roomId,
            ciphertextB64: msg.ciphertext_b64,
            ivB64: msg.iv_b64,
            roomKeyId: msg.room_key_id,
            keyring,
          });
          result.push({
            ...msg,
            plaintext: dec.plaintext,
            attachment: dec.attachment,
            forwarded: dec.forwarded,
            verified_e2ee: dec.verifiedE2ee,
          });
        } catch {
          result.push({
            ...msg,
            plaintext: 'Ожидание ключа шифрования или сообщение не удалось расшифровать',
            verified_e2ee: false,
          });
        }
      }
      if (!cancelled) {
        setDecryptedMessages(result);
      }
    }

    void decryptAll();
    return () => {
      cancelled = true;
    };
  }, [rawMessages, activeChatRoomId, keyringVersion]);

  const sendControl = (msg: ClientToControlMsg): boolean => {
    if (controlWsRef.current?.readyState === WebSocket.OPEN) {
      controlWsRef.current.send(JSON.stringify(msg));
      return true;
    }
    setSystemBanner('Нет связи с сервером. Дождитесь подключения и повторите действие.');
    return false;
  };

  const registerRoomKeyInMemory = (
    roomId: string,
    bundle: RoomSecretKeyBundle,
    makeActive = true
  ) => {
    const existing = roomKeyringsRef.current.get(roomId);
    if (existing) {
      existing.keysById[bundle.roomKeyId] = bundle;
      if (makeActive) {
        existing.activeKey = bundle;
      }
    } else {
      roomKeyringsRef.current.set(roomId, {
        activeKey: bundle,
        keysById: { [bundle.roomKeyId]: bundle },
      });
    }
    saveRoomKeyToLocalStore(roomId, bundle, makeActive);
    setKeyringVersion((v) => v + 1);
  };

  const ensureAndDistributeRoomKey = async (
    roomId: string,
    forceRotate = false
  ): Promise<RoomSecretKeyBundle> => {
    let keyring = roomKeyringsRef.current.get(roomId);
    let activeKey = keyring?.activeKey ?? null;
    if (!activeKey || forceRotate) {
      activeKey = await generateRoomKey();
      registerRoomKeyInMemory(roomId, activeKey, true);
      keyring = roomKeyringsRef.current.get(roomId);
    }

    const me = currentUserRef.current;
    const idKeys = identityKeysRef.current;
    if (me && idKeys && controlWsRef.current?.readyState === WebSocket.OPEN) {
      const recipients: Array<{ id: string; username: string; pubKeysField: string }> = [
        {
          id: me.id,
          username: me.username,
          pubKeysField: [me.e2ee_public_key, idKeys.publicKeySpkiB64].filter(Boolean).join(','),
        },
      ];

      if (currentRoomRef.current && currentRoomRef.current.id === roomId) {
        for (const p of currentRoomRef.current.participants) {
          if (!recipients.some((r) => r.id === p.user_id)) {
            const contactProfile = contactsRef.current.find((c) => c.id === p.user_id);
            recipients.push({
              id: p.user_id,
              username: p.username,
              pubKeysField: [p.e2ee_public_key, contactProfile?.e2ee_public_key]
                .filter(Boolean)
                .join(','),
            });
          }
        }
      } else {
        for (const c of contactsRef.current) {
          if (computeDmRoomId(me.id, c.id) === roomId) {
            if (!recipients.some((r) => r.id === c.id)) {
              recipients.push({
                id: c.id,
                username: c.username,
                pubKeysField: c.e2ee_public_key,
              });
            }
          }
        }
      }

      for (const rec of recipients) {
        const envelopes = await createEncryptedKeyEnvelopesForUser({
          roomId,
          senderId: me.id,
          senderUsername: me.username,
          senderPublicKeyB64: idKeys.publicKeySpkiB64,
          myPrivateKey: idKeys.privateKey,
          recipientId: rec.id,
          recipientUsername: rec.username,
          recipientPublicKeysField: rec.pubKeysField,
          roomKeyBundle: activeKey,
        });
        for (const envelope of envelopes) {
          const dedupKey = `${roomId}:${activeKey.roomKeyId}:${rec.id}:${envelope.encrypted_room_key_b64.slice(0, 16)}`;
          // Check by recipient + pubkey implicitly via roomId + roomKeyId + recipientId + senderPublicKey
          const pubCacheKey = `${roomId}:${activeKey.roomKeyId}:${rec.id}:${rec.pubKeysField}`;
          if (!sentEnvelopesRef.current.has(pubCacheKey) || forceRotate) {
            controlWsRef.current.send(
              JSON.stringify({
                type: 'send_key_envelope',
                payload: { envelope },
              } satisfies ClientToControlMsg)
            );
          }
          void dedupKey;
        }
        const pubCacheKey = `${roomId}:${activeKey.roomKeyId}:${rec.id}:${rec.pubKeysField}`;
        sentEnvelopesRef.current.add(pubCacheKey);
      }
    }

    return activeKey;
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

    const keyBundle = await ensureAndDistributeRoomKey(room.id, false);

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
      getRoomKey: () => roomKeyringsRef.current.get(room.id)?.activeKey ?? keyBundle,
      getJoinTicket: async () => {
        const res = await fetch(`${DEFAULT_CONTROL_HTTP}/api/rooms/${room.id}/sfu-ticket`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('liaper_token') ?? ''}` },
        });
        if (!res.ok) throw new Error(`SFU ticket: HTTP ${res.status}`);
        return ((await res.json()) as { ticket: string | null }).ticket;
      },
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
        currentUserRef.current = msg.payload.self_profile;
        contactsRef.current = msg.payload.contacts;
        setCurrentUser(msg.payload.self_profile);
        setContacts(msg.payload.contacts);
        setIncomingRequests(msg.payload.incoming_requests);
        setOutgoingRequests(msg.payload.outgoing_requests);

        // Урок, из которого нас «выбило» обновлением страницы или обрывом сети, ещё ждёт возвращения
        const activeRoom = msg.payload.active_rooms[0];
        if (activeRoom && currentRoomRef.current?.id === activeRoom.id) {
          // Переподключились без перезагрузки: звонок здесь же, просто подтверждаем устройство
          sendControl({ type: 'join_room', payload: { room_id: activeRoom.id, audio_enabled: mediaFlagsRef.current.audio, video_enabled: mediaFlagsRef.current.video } });
        } else if (activeRoom && !currentRoomRef.current) {
          setResumeCall(activeRoom);
        }

        const idKeys = identityKeysRef.current;
        if (idKeys && controlWsRef.current?.readyState === WebSocket.OPEN) {
          controlWsRef.current.send(
            JSON.stringify({
              type: 'update_public_key',
              payload: {
                e2ee_public_key: idKeys.publicKeySpkiB64,
                key_fingerprint: idKeys.fingerprint,
              },
            } satisfies ClientToControlMsg)
          );
        }
        break;
      }

      case 'contacts_updated': {
        contactsRef.current = msg.payload.contacts;
        setContacts(msg.payload.contacts);
        setIncomingRequests(msg.payload.incoming_requests);
        setOutgoingRequests(msg.payload.outgoing_requests);

        // Если у нас уже есть активный ключ для личного чата с контактом, отправляем конверт на новые устройства
        const me = currentUserRef.current;
        if (me) {
          for (const c of msg.payload.contacts) {
            const dmId = computeDmRoomId(me.id, c.id);
            if (roomKeyringsRef.current.has(dmId)) {
              void ensureAndDistributeRoomKey(dmId, false);
            }
          }
        }
        break;
      }

      case 'key_envelope_received': {
        const idKeys = identityKeysRef.current;
        if (!idKeys) break;
        try {
          const unwrapped = await openEncryptedKeyEnvelope(
            msg.payload.envelope,
            idKeys.privateKey
          );
          registerRoomKeyInMemory(msg.payload.envelope.room_id, unwrapped, true);
        } catch {
          // Конверт предназначался для другого устройства этого аккаунта
        }
        break;
      }

      case 'nodes_updated': {
        break;
      }

      case 'room_updated': {
        const room = msg.payload.room;
        const prevRoom = currentRoomRef.current;
        const wasInRoom = prevRoom?.id === room.id;
        const prevCount = wasInRoom ? prevRoom?.participants.length ?? 0 : 0;
        currentRoomRef.current = room;
        setCurrentRoom(room);
        setIncomingCall(null);
        setOtherDeviceCall(null);
        setResumeCall(null);

        const me = currentUserRef.current;
        if (wasInRoom && room.participants.length < prevCount && me) {
          // Участник покинул комнату — ротируем ключ комнаты
          if (room.host_id === me.id || room.participants[0]?.user_id === me.id) {
            await ensureAndDistributeRoomKey(room.id, true);
          }
        } else if (me && (room.host_id === me.id || roomKeyringsRef.current.has(room.id))) {
          await ensureAndDistributeRoomKey(room.id, false);
        }

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

      case 'call_on_other_device': {
        const { room_id: roomId, room } = msg.payload;
        setIncomingCall((cur) => (cur?.room.id === roomId ? null : cur));
        if (!room) {
          setOtherDeviceCall((cur) => (cur?.id === roomId ? null : cur));
          setResumeCall((cur) => (cur?.id === roomId ? null : cur));
          break;
        }
        setResumeCall(null);
        setOtherDeviceCall(room);
        if (currentRoomRef.current?.id === roomId) {
          // Звонок перенесли на другое устройство: отключаемся здесь, не выходя из урока
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
          setSystemBanner('Урок продолжается на другом устройстве.');
        }
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

      case 'encrypted_chat_edited': {
        const edited = msg.payload.message;
        setRawMessages((prev) =>
          prev.map((m) => (m.id === edited.id ? edited : m))
        );
        break;
      }

      case 'encrypted_chat_deleted': {
        const { message_id } = msg.payload;
        setRawMessages((prev) => prev.filter((m) => m.id !== message_id));
        setEditingMessage((prev) => (prev?.id === message_id ? null : prev));
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

  const preparePow = () => {
    const cur = powRef.current;
    if (cur && cur.expiresAt - 30 > Date.now() / 1000) return cur.promise;
    const entry = { expiresAt: Date.now() / 1000 + 240, promise: null as unknown as Promise<{ challenge: string; solution: string }> };
    entry.promise = (async () => {
      const res = await fetch(`${DEFAULT_CONTROL_HTTP}/api/auth/challenge`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не удалось начать проверку на робота');
      entry.expiresAt = data.expires_at;
      const solution = await solvePow({ challenge: data.challenge, difficulty: data.difficulty });
      return { challenge: data.challenge as string, solution };
    })();
    entry.promise.catch(() => { if (powRef.current === entry) powRef.current = null; });
    powRef.current = entry;
    return entry.promise;
  };
  useEffect(() => {
    if (!token && authMode === 'register') void preparePow().catch(() => undefined);
    // preparePow сам кеширует задачу, зависимости — только смена экрана
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, authMode]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identityKeys) return;
    setAuthError(null);
    setAuthLoading(true);

    try {
      let pow: { challenge: string; solution: string } | null = null;
      if (authMode === 'register') {
        setAuthCheckingRobot(true);
        try {
          pow = await preparePow();
        } catch (err) {
          setAuthError(err instanceof Error && err.message ? err.message : 'Не удалось пройти проверку на робота');
          setAuthLoading(false);
          return;
        } finally {
          setAuthCheckingRobot(false);
          powRef.current = null; // задача одноразовая
        }
      }
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
              pow_challenge: pow?.challenge,
              pow_solution: pow?.solution,
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
        if (authMode === 'register') void preparePow().catch(() => undefined);
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
    setOtherDeviceCall(null);
    setResumeCall(null);
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
    roomKeyringsRef.current.clear();
    sentEnvelopesRef.current.clear();
    uploadAbortRef.current.forEach((c) => c.abort());
    uploadAbortRef.current.clear();
    setOutgoingTransfers([]);
    setPanel('lesson');
    controlWsRef.current?.close();
    const revokedToken = localStorage.getItem('liaper_token');
    if (revokedToken) {
      void fetch(`${DEFAULT_CONTROL_HTTP}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${revokedToken}` },
      }).catch(() => {});
    }
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

  // Забрать идущий урок с другого устройства на это
  const takeOverCall = () => {
    if (!otherDeviceCall) return;
    setChatMode('lesson');
    setPanel('lesson');
    sendControl({
      type: 'join_room',
      payload: {
        room_id: otherDeviceCall.id,
        audio_enabled: mediaFlagsRef.current.audio,
        video_enabled: mediaFlagsRef.current.video,
      },
    });
    setOtherDeviceCall(null);
  };

  const resumeLesson = () => {
    if (!resumeCall) return;
    setChatMode('lesson');
    setPanel('lesson');
    sendControl({
      type: 'join_room',
      payload: { room_id: resumeCall.id, audio_enabled: mediaFlagsRef.current.audio, video_enabled: mediaFlagsRef.current.video },
    });
    setResumeCall(null);
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
    if (roomMsgs.length === 0) {
      if (!quiet) setSystemBanner(`В чате урока «${currentRoom.title}» пока нет сообщений — сохранять нечего`);
      return;
    }
    const keyring = roomKeyringsRef.current.get(currentRoom.id) ?? null;

    const formatted: ArchivedLessonChat['messages'] = [];
    for (const msg of roomMsgs) {
      let text = 'Не удалось расшифровать сообщение';
      let attachment: ChatAttachmentMeta | undefined;
      try {
        const dec = await decryptChatMessageWithKeyring({
          roomId: currentRoom.id,
          ciphertextB64: msg.ciphertext_b64,
          ivB64: msg.iv_b64,
          roomKeyId: msg.room_key_id,
          keyring,
        });
        text = dec.plaintext;
        if (dec.attachment) {
          attachment = dec.attachment;
        }
      } catch {}
      formatted.push({
        id: msg.id,
        sender_id: msg.sender_id,
        sentAt: msg.created_at,
        sender: msg.sender_display_name,
        username: msg.sender_username,
        text,
        time: new Date(msg.created_at).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        ...(attachment ? { attachment } : {}),
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
      setSystemBanner(`Чат урока «${currentRoom.title}» сохранён в архив`);
    }
  };

  const forwardArchiveMessages = async (
    archive: ArchivedLessonChat,
    messagesToForward: ArchivedLessonChat['messages'],
    resolvedTarget: string,
    comment: string,
  ) => {
    if (!currentUser || !token || !connected || messagesToForward.length === 0 || forwardingArchiveMsgs) {
      return;
    }

    if (!resolvedTarget) {
      setSystemBanner('Выберите контакт или начните урок для пересылки сообщений.');
      return;
    }

    let targetRoomId = '';
    let targetMode: 'lesson' | 'direct' = 'lesson';
    let targetContact: UserPublicProfile | null = null;

    if (resolvedTarget.startsWith('lesson:') && currentRoom) {
      targetRoomId = currentRoom.id;
      targetMode = 'lesson';
    } else if (resolvedTarget.startsWith('dm:')) {
      const contactId = resolvedTarget.slice(3);
      targetContact = contacts.find((c) => c.id === contactId) ?? null;
      if (!targetContact) {
        setSystemBanner('Контакт для пересылки не найден.');
        return;
      }
      targetRoomId = computeDmRoomId(currentUser.id, targetContact.id);
      targetMode = 'direct';
    } else {
      setSystemBanner('Выберите чат для пересылки.');
      return;
    }

    setForwardingArchiveMsgs(true);
    try {
      const roomKey = await ensureAndDistributeRoomKey(targetRoomId, false);
      let sentCount = 0;
      const sendPlain = async (serialized: string) => {
        const encrypted = await encryptChatText(serialized, roomKey);
        return sendControl({
          type: 'send_encrypted_chat',
          payload: {
            room_id: targetRoomId,
            ciphertext_b64: encrypted.ciphertextB64,
            iv_b64: encrypted.ivB64,
            room_key_id: encrypted.roomKeyId,
          },
        });
      };
      if (comment.trim()) await sendPlain(comment.trim());

      for (const m of messagesToForward) {
        const forwarded = { source: archive.title, sender: m.sender, username: m.username || undefined, time: m.time || undefined };

        let finalAttachment: ChatAttachmentMeta | undefined = m.attachment;
        if (m.attachment) {
          try {
            const plainBytes = await downloadAndDecryptAttachment({
              controlBase: DEFAULT_CONTROL_HTTP,
              token,
              meta: m.attachment,
            });
            finalAttachment = await uploadEncryptedAttachment({
              controlBase: DEFAULT_CONTROL_HTTP,
              token,
              roomId: targetRoomId,
              fileName: m.attachment.name,
              mimeType: m.attachment.mime_type,
              kind: m.attachment.kind,
              plaintextBytes: plainBytes,
              durationMs: m.attachment.duration_ms,
              width: m.attachment.width,
              height: m.attachment.height,
            });
          } catch {
            finalAttachment = m.attachment;
          }
        }

        const ok = await sendPlain(serializeChatPayload(m.text, finalAttachment, forwarded));
        if (ok) sentCount++;
      }

      setSelectedArchiveMsgKeys([]);
      setSelectedArchiveId(null);
      setForwardDialog(null);
      setForwardComment('');
      setForwardSearch('');
      if (targetMode === 'direct' && targetContact) {
        setSelectedChatContact(targetContact);
      }
      setChatMode(targetMode);
      const where = targetContact ? `в чат с ${targetContact.display_name}` : 'в чат урока';
      setSystemBanner(sentCount === messagesToForward.length ? `Переслано ${where}: ${sentCount}` : `Переслано ${sentCount} из ${messagesToForward.length}. Проверьте соединение.`);
    } catch {
      setSystemBanner('Не удалось переслать выбранные сообщения.');
    } finally {
      setForwardingArchiveMsgs(false);
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
    setTopicDraft(null);
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
      const roomKey = await ensureAndDistributeRoomKey(activeChatRoomId, false);
      if (editingMessage && editingMessage.room_id === activeChatRoomId) {
        const payloadText = editingMessage.attachment
          ? serializeChatPayload(draft.trim(), editingMessage.attachment)
          : draft.trim();
        const encrypted = await encryptChatText(payloadText, roomKey);
        if (
          sendControl({
            type: 'edit_encrypted_chat',
            payload: {
              room_id: activeChatRoomId,
              message_id: editingMessage.id,
              ciphertext_b64: encrypted.ciphertextB64,
              iv_b64: encrypted.ivB64,
              room_key_id: encrypted.roomKeyId,
            },
          })
        ) {
          setEditingMessage(null);
          delete draftsRef.current[activeChatRoomId];
          setChatInput('');
        }
      } else {
        const encrypted = await encryptChatText(draft.trim(), roomKey);
        if (sendControl({ type: 'send_encrypted_chat', payload: {
          room_id: activeChatRoomId, ciphertext_b64: encrypted.ciphertextB64,
          iv_b64: encrypted.ivB64, room_key_id: encrypted.roomKeyId,
        } })) {
          delete draftsRef.current[activeChatRoomId];
          setChatInput((value) => value === draft ? '' : value);
        }
      }
    } catch { setSystemBanner('Не удалось отправить сообщение. Текст сохранён в поле ввода.'); }
    finally { setSendingChat(false); }
  };

  const startEditingChatMessage = (m: DecryptedChatMessage) => {
    const defaultAutoCaption =
      m.attachment &&
      (m.plaintext.startsWith('Вложение: ') ||
        m.plaintext.startsWith('Голосовое сообщение') ||
        m.plaintext.startsWith('Видеокружок'));
    setEditingMessage(m);
    setChatInput(defaultAutoCaption ? '' : m.plaintext);
    window.setTimeout(() => chatInputRef.current?.focus(), 20);
  };

  const handleDeleteChatMessage = (m: DecryptedChatMessage) => {
    sendControl({
      type: 'delete_encrypted_chat',
      payload: {
        room_id: m.room_id,
        message_id: m.id,
      },
    });
    setRawMessages((prev) => prev.filter((item) => item.id !== m.id));
    if (editingMessage?.id === m.id) {
      setEditingMessage(null);
      setChatInput('');
    }
  };

  const executeAttachmentTransfer = async (transfer: OutgoingAttachmentTransfer) => {
    if (!token) return;
    const controller = new AbortController();
    uploadAbortRef.current.set(transfer.localId, controller);

    setOutgoingTransfers((prev) =>
      prev.map((item) =>
        item.localId === transfer.localId
          ? { ...item, status: 'uploading', progress: 0.05, errorMessage: undefined }
          : item
      )
    );

    try {
      const roomKey = await ensureAndDistributeRoomKey(transfer.roomId, false);
      const meta = await uploadEncryptedAttachment({
        controlBase: DEFAULT_CONTROL_HTTP,
        token,
        roomId: transfer.roomId,
        fileName: transfer.fileName,
        mimeType: transfer.mimeType,
        kind: transfer.kind,
        plaintextBytes: transfer.plaintextBytes,
        durationMs: transfer.durationMs,
        width: transfer.width,
        height: transfer.height,
        onProgress: (fraction) => {
          setOutgoingTransfers((prev) =>
            prev.map((item) =>
              item.localId === transfer.localId ? { ...item, progress: fraction } : item
            )
          );
        },
        signal: controller.signal,
      });

      setStorageRefreshTrigger((n) => n + 1);

      const payloadText = serializeChatPayload(transfer.captionText, meta);
      const encrypted = await encryptChatText(payloadText, roomKey);
      const sent = sendControl({
        type: 'send_encrypted_chat',
        payload: {
          room_id: transfer.roomId,
          ciphertext_b64: encrypted.ciphertextB64,
          iv_b64: encrypted.ivB64,
          room_key_id: encrypted.roomKeyId,
        },
      });
      if (!sent) {
        throw new Error('Вложение загружено, но нет связи с сервером чата. Нажмите «Повторить».');
      }

      setOutgoingTransfers((prev) => prev.filter((item) => item.localId !== transfer.localId));
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        setOutgoingTransfers((prev) => prev.filter((item) => item.localId !== transfer.localId));
        return;
      }
      const message = err instanceof Error ? err.message : 'Ошибка загрузки вложения';
      setOutgoingTransfers((prev) =>
        prev.map((item) =>
          item.localId === transfer.localId
            ? { ...item, status: 'error', errorMessage: message }
            : item
        )
      );
    } finally {
      uploadAbortRef.current.delete(transfer.localId);
    }
  };

  const handleReadyAttachment = (draft: ReadyAttachmentDraft) => {
    if (!activeChatRoomId) {
      setSystemBanner('Сначала выберите контакт или начните урок');
      return;
    }
    const caption = chatInput.trim();
    if (caption) {
      delete draftsRef.current[activeChatRoomId];
      setChatInput('');
    }
    const transfer: OutgoingAttachmentTransfer = {
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      roomId: activeChatRoomId,
      fileName: draft.fileName,
      mimeType: draft.mimeType,
      kind: draft.kind,
      plaintextBytes: draft.plaintextBytes,
      captionText: caption,
      durationMs: draft.durationMs,
      width: draft.width,
      height: draft.height,
      progress: 0.05,
      status: 'uploading',
    };
    setOutgoingTransfers((prev) => [...prev, transfer]);
    void executeAttachmentTransfer(transfer);
  };

  const cancelAttachmentTransfer = (localId: string) => {
    const ctrl = uploadAbortRef.current.get(localId);
    if (ctrl) {
      ctrl.abort();
      uploadAbortRef.current.delete(localId);
    }
    setOutgoingTransfers((prev) => prev.filter((item) => item.localId !== localId));
  };

  const retryAttachmentTransfer = (localId: string) => {
    const found = outgoingTransfers.find((item) => item.localId === localId);
    if (found) {
      void executeAttachmentTransfer(found);
    }
  };

  const dismissAttachmentTransfer = (localId: string) => {
    setOutgoingTransfers((prev) => prev.filter((item) => item.localId !== localId));
  };

  const handleSubmitChatReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !activeChatRoomId || !reportReason.trim()) return;
    setSubmittingReport(true);
    try {
      await ensureAndDistributeRoomKey(activeChatRoomId, false);
      const keyring = roomKeyringsRef.current.get(activeChatRoomId);
      const disclosedKeys = keyring
        ? Object.values(keyring.keysById).map((k) => ({
            key_id: k.roomKeyId,
            raw_key_b64: k.rawKeyB64,
            created_at: new Date().toISOString(),
          }))
        : [];
      const roomTitle =
        chatMode === 'lesson' && currentRoom
          ? `Урок: ${currentRoom.title}`
          : selectedChatContact
            ? `Личный чат: ${selectedChatContact.display_name} (@${selectedChatContact.username})`
            : `Чат ${activeChatRoomId.slice(0, 8)}`;

      const res = await fetch(`${DEFAULT_CONTROL_HTTP}/api/reports`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          room_id: activeChatRoomId,
          room_title: roomTitle,
          reason: reportReason.trim(),
          disclosed_keys: disclosedKeys,
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      await ensureAndDistributeRoomKey(activeChatRoomId, true);
      setShowReportModal(false);
      setSystemBanner(
        'Жалоба отправлена в Админку. Ключ переписки раскрыт модератору, а для новых сообщений выпущен новый ключ E2EE.'
      );
    } catch {
      setSystemBanner('Не удалось отправить жалобу. Проверьте соединение с сервером.');
    } finally {
      setSubmittingReport(false);
    }
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
  if (!token && showLanding) {
    return (
      <Landing
        onRegister={(role) => { if (role) setRoleInput(role); window.location.hash = 'register'; }}
        onLogin={() => { window.location.hash = 'login'; }}
        controlBase={DEFAULT_CONTROL_HTTP}
      />
    );
  }

  if (!token || !currentUser) {
    const isRegister = authMode === 'register';
    const passwordTooShort = isRegister && passwordInput.length > 0 && passwordInput.length < 8;
    return (
      <div className="auth-shell">
        <aside className="auth-hero" aria-hidden="true">
          <div className="relative z-10 flex items-center gap-3">
            <LogoMark size={40} />
            <span className="text-xl font-semibold tracking-tight">Liaper</span>
          </div>
          <div className="relative z-10 max-w-md">
            <h2 className="text-4xl font-semibold leading-tight tracking-tight">
              Занятия, переписка и материалы — в одном месте
            </h2>
            <p className="mt-4 text-base leading-relaxed text-indigo-100">
              Видеоуроки один на один и в группе, личные чаты с учениками и архив каждого занятия.
            </p>
            <div className="mt-10 space-y-6">
              <div className="auth-feature">
                <span><Video className="h-5 w-5" /></span>
                <div><p className="font-semibold">Уроки по видеосвязи</p><p className="text-sm text-indigo-100">Камера, микрофон и демонстрация экрана в один клик.</p></div>
              </div>
              <div className="auth-feature">
                <span><MessageSquare className="h-5 w-5" /></span>
                <div><p className="font-semibold">Чаты и вложения</p><p className="text-sm text-indigo-100">Файлы, голосовые и видеокружки прямо в переписке.</p></div>
              </div>
              <div className="auth-feature">
                <span><ShieldCheck className="h-5 w-5" /></span>
                <div><p className="font-semibold">Шифрование переписки</p><p className="text-sm text-indigo-100">Сообщения и файлы шифруются на вашем устройстве.</p></div>
              </div>
            </div>
          </div>
          <p className="relative z-10 text-xs text-indigo-200">Версия {APP_VERSION}</p>
        </aside>

        <main className="flex flex-col justify-center px-5 py-10 sm:px-10">
          <div className="mx-auto w-full max-w-[420px]">
            <div className="mb-8 flex items-center gap-3 min-[960px]:hidden">
              <LogoMark size={44} />
              <div>
                <div className="text-xl font-semibold tracking-tight text-slate-900">Liaper</div>
                <div className="text-sm text-slate-500">Платформа для занятий с репетитором</div>
              </div>
            </div>

            {!('__TAURI_INTERNALS__' in window) && (
              <button type="button" onClick={() => { window.history.replaceState(null, '', window.location.pathname); setShowLanding(true); }} className="mb-6 inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-900">
                <ChevronLeft className="h-4 w-4" />На главную
              </button>
            )}
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
              {isRegister ? 'Создайте аккаунт' : 'С возвращением!'}
            </h1>
            <p className="mt-1.5 text-sm text-slate-500">
              {isRegister ? 'Пара полей — и можно начинать занятия.' : 'Войдите, чтобы продолжить занятия.'}
            </p>

            <div className="mt-6 grid grid-cols-2 gap-1 rounded-xl bg-slate-200/60 p-1" role="tablist" aria-label="Режим">
              {(['login', 'register'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={authMode === mode}
                  onClick={() => { setAuthMode(mode); setAuthError(null); window.history.replaceState(null, '', `#${mode}`); }}
                  className={`rounded-lg py-2 text-sm font-medium transition ${
                    authMode === mode ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {mode === 'login' ? 'Вход' : 'Регистрация'}
                </button>
              ))}
            </div>

            <form onSubmit={handleAuthSubmit} className="mt-6 space-y-5" noValidate={false}>
              {isRegister && (
                <fieldset>
                  <legend className="text-sm font-medium text-slate-700">Я —</legend>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <button type="button" className="role-card" aria-pressed={roleInput === 'tutor'} onClick={() => setRoleInput('tutor')}>
                      <GraduationCap className="h-5 w-5" />
                      <span className="text-sm font-semibold text-slate-900">Репетитор</span>
                      <span className="text-xs leading-snug text-slate-500">Приглашаю учеников и веду уроки</span>
                    </button>
                    <button type="button" className="role-card" aria-pressed={roleInput === 'student'} onClick={() => setRoleInput('student')}>
                      <BookOpen className="h-5 w-5" />
                      <span className="text-sm font-semibold text-slate-900">Ученик</span>
                      <span className="text-xs leading-snug text-slate-500">Занимаюсь с преподавателем</span>
                    </button>
                  </div>
                </fieldset>
              )}

              <div>
                <label htmlFor="username" className="block text-sm font-medium text-slate-700">Никнейм</label>
                <div className="mt-2 flex items-center rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 transition focus-within:border-indigo-500 focus-within:ring-4 focus-within:ring-indigo-100">
                  <span className="text-sm font-medium text-slate-400">@</span>
                  <input
                    type="text"
                    required
                    id="username"
                    autoComplete="username" autoCapitalize="none" spellCheck={false}
                    placeholder="elena_math"
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    aria-describedby={isRegister ? 'username-hint' : undefined}
                    className="ml-1.5 w-full bg-transparent text-sm text-slate-900 focus:outline-none"
                  />
                </div>
                {isRegister && <p id="username-hint" className="mt-1.5 text-xs text-slate-500">Латиница, цифры и «_», от 3 символов. По нику вас найдёт преподаватель.</p>}
              </div>

              {isRegister && (
                <div>
                  <label htmlFor="display-name" className="block text-sm font-medium text-slate-700">Как вас зовут</label>
                  <input
                    type="text"
                    required
                    id="display-name" autoComplete="name"
                    placeholder={roleInput === 'tutor' ? 'Елена Сергеевна' : 'Иван Петров'}
                    value={displayNameInput}
                    onChange={(e) => setDisplayNameInput(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 transition focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-100"
                  />
                </div>
              )}

              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="password" className="block text-sm font-medium text-slate-700">Пароль</label>
                  <button type="button" className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}{showPassword ? 'Скрыть' : 'Показать'}
                  </button>
                </div>
                <input
                  id="password" type={showPassword ? 'text' : 'password'}
                  minLength={isRegister ? 8 : undefined}
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  required
                  placeholder={isRegister ? 'Не меньше 8 символов' : '••••••••'}
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  aria-invalid={passwordTooShort || undefined}
                  aria-describedby={isRegister ? 'password-hint' : undefined}
                  className={`mt-2 w-full rounded-xl border px-3.5 py-2.5 text-sm text-slate-900 transition focus:outline-none focus:ring-4 ${
                    passwordTooShort ? 'border-amber-400 focus:border-amber-500 focus:ring-amber-100' : 'border-slate-300 focus:border-indigo-500 focus:ring-indigo-100'
                  }`}
                />
                {isRegister && (
                  <p id="password-hint" className={`mt-1.5 text-xs ${passwordTooShort ? 'text-amber-700' : 'text-slate-500'}`}>
                    {passwordTooShort ? `Ещё ${8 - passwordInput.length} — минимум 8 символов.` : 'Этим же паролем открывается архив уроков на других устройствах.'}
                  </p>
                )}
              </div>

              {authError && (
                <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading || !identityKeys || passwordTooShort}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-indigo-600/20 transition hover:bg-indigo-500 disabled:opacity-50"
              >
                {authLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                {authCheckingRobot ? 'Проверяем, что вы не робот…' : authLoading ? 'Подключаемся…' : isRegister ? 'Создать аккаунт' : 'Войти'}
              </button>
              <p className="text-center text-sm text-slate-500">
                {isRegister ? 'Уже есть аккаунт? ' : 'Впервые здесь? '}
                <button type="button" className="font-semibold text-indigo-600 hover:text-indigo-500" onClick={() => { setAuthMode(isRegister ? 'login' : 'register'); setAuthError(null); }}>
                  {isRegister ? 'Войти' : 'Зарегистрироваться'}
                </button>
              </p>
            </form>
          </div>
        </main>
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
  const directUnreadTotal = contacts.reduce(
    (sum, c) => sum + (unreadChats[computeDmRoomId(currentUser.id, c.id)] ?? 0),
    0,
  );

  const openMessageMenu = (m: DecryptedChatMessage, x: number, y: number, captionHidden: boolean) => {
    const isMine = m.sender_id === currentUser.id;
    const canCopy = !captionHidden && Boolean(m.plaintext.trim());
    if (!canCopy && !isMine) return;
    setMessageMenu({ message: m, x, y, canCopy, canEdit: isMine, canDelete: isMine });
  };

  const copyMessageText = (m: DecryptedChatMessage) => {
    void navigator.clipboard?.writeText(m.plaintext).then(
      () => setSystemBanner('Текст сообщения скопирован.'),
      () => setSystemBanner('Не удалось скопировать текст.'),
    );
  };

  const copyOwnNick = () => {
    const nick = `@${currentUser.username}`;
    void navigator.clipboard?.writeText(nick).then(
      () => setSystemBanner(`Ник ${nick} скопирован — отправьте его преподавателю.`),
      () => setSystemBanner(`Ваш ник: ${nick}`),
    );
  };

  return (
    <div
      className="app-shell"
      data-panel={panel}
      style={{ '--left-w': `${panelWidths.left}px`, '--right-w': `${panelWidths.right}px` } as React.CSSProperties}
    >
      {showAdminDashboard && (
        <AdminDashboard
          controlBase={DEFAULT_CONTROL_HTTP}
          token={token}
          currentUsername={currentUser?.username}
          onClose={() => {
            setShowAdminDashboard(false);
            if (window.location.hash === '#admin') {
              window.history.replaceState(null, '', window.location.pathname + window.location.search);
            }
          }}
        />
      )}
      <header className="app-topbar">
        <a className="app-brand" href="#" onClick={(e) => { e.preventDefault(); setPanel('lesson'); }} aria-label="Liaper — рабочее пространство">
          <LogoMark size={38} /><span>Liaper<small>Учебное пространство</small></span>
        </a>
        <nav className="workspace-nav" aria-label="Основная навигация">
          {([
            ['contacts', currentUser.role === 'tutor' ? 'Ученики' : 'Преподаватели', Users], ['lesson', 'Урок', GraduationCap],
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
        <div className="flex items-center gap-2">
          {isAdminAccount && (
            <button
              type="button"
              onClick={() => setShowAdminDashboard(true)}
              title="Админка владельца (Ctrl+Shift+A)"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100"
            >
              <Server className="h-3.5 w-3.5" />
              Админка
            </button>
          )}
          <span className={`connection-status ${connected ? 'is-connected' : ''}`} role="status">
            <span />{connected ? 'На связи' : 'Подключение…'}
          </span>
        </div>
      </header>
      {!connected && <div className="connection-banner" role="status">
        Нет связи с сервером. Переподключаемся автоматически.
        <button type="button" onClick={() => setConnectionAttempt((n) => n + 1)}>Повторить</button>
        <button type="button" onClick={handleLogout}>Войти заново</button>
      </div>}
      {systemBanner && <div className="notification-banner" role="status"><span>{systemBanner}</span>
        <button type="button" aria-label="Закрыть уведомление" onClick={() => setSystemBanner(null)}><X size={18} /></button>
      </div>}
      {resumeCall && !currentRoom && !otherDeviceCall && (
        <div className="other-device-banner" role="status">
          <span className="other-device-dot" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            <strong>Урок продолжается</strong>
            <span className="hidden sm:inline"> · {resumeCall.title}</span>
          </span>
          <button type="button" onClick={() => {
            sendControl({ type: 'leave_room', payload: { room_id: resumeCall.id } });
            setResumeCall(null);
          }} className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100">
            Выйти
          </button>
          <button type="button" onClick={resumeLesson} className="other-device-btn">
            <Video className="h-4 w-4" /> Вернуться в урок
          </button>
        </div>
      )}
      {otherDeviceCall && !currentRoom && (
        <div className="other-device-banner" role="status">
          <span className="other-device-dot" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">
            <strong>Урок идёт на другом устройстве</strong>
            <span className="hidden sm:inline"> · {otherDeviceCall.title}</span>
          </span>
          <button type="button" onClick={takeOverCall} className="other-device-btn">
            <Monitor className="h-4 w-4" /> Перенести сюда
          </button>
        </div>
      )}
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
                  className="mt-2 w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm focus:border-indigo-500 focus:outline-none"
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
                  className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500"
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
              <Avatar name={currentUser.display_name} seed={currentUser.id} size={42} />
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
            <div className="flex flex-1 items-center rounded-lg border border-slate-300 bg-slate-50/60 px-3 py-2 focus-within:border-indigo-500 focus-within:bg-white">
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
              className="flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-500"
            >
              <UserPlus className="h-4 w-4" />
              Добавить
            </button>
          </form>
          </> : <div className="text-sm text-slate-700"><p className="font-semibold">Приглашения от преподавателей</p><p className="mt-2 text-xs text-slate-500">Сообщите преподавателю свой @{currentUser.username} и примите его заявку ниже.</p></div>}

          {currentUser.role === 'tutor' && (
          <button
            type="button"
            onClick={() => setShowGroupModal(true)}
            disabled={!connected || Boolean(currentRoom)}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 transition hover:bg-slate-50"
          >
            <Plus className="h-4 w-4" />
            Создать групповой урок
          </button>
          )}
        </div>

        {/* Входящие заявки в контакты */}
        {incomingRequests.length > 0 && (
          <div className="border-b border-slate-200 bg-amber-50/50 p-4">
            <div className="text-xs font-semibold text-slate-800">
              Приглашения ({incomingRequests.length})
            </div>
            <div className="mt-2.5 space-y-2">
              {incomingRequests.map((req) => (
                <div
                  key={req.id}
                  className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3"
                >
                  <div className="flex min-w-0 items-center gap-2.5 pr-2">
                    <Avatar name={req.from_user.display_name} seed={req.from_user.id} size={34} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900">
                        {req.from_user.display_name}
                      </div>
                      <div className="text-xs text-slate-500">
                        @{req.from_user.username} • {req.from_user.role === 'tutor' ? 'преподаватель' : 'ученик'}
                      </div>
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
              {currentUser.role === 'tutor' ? 'Мои ученики' : 'Мои преподаватели'} ({filteredContacts.length})
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
                <p className="mt-1 text-xs text-slate-400">
                  {searchNick.trim() ? 'Попробуйте другое имя или никнейм.' : currentUser.role === 'tutor' ? 'Введите @ник ученика выше. После подтверждения заявки можно начать урок.' : 'Преподаватель появится здесь после того, как вы примете его заявку.'}
                </p>
              </div>
            ) : (
              filteredContacts.map((u) => (
                <div
                  key={u.id}
                  className="contact-card rounded-2xl border border-slate-200/80 bg-white p-3 transition hover:border-indigo-200 hover:shadow-sm"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-3 pr-2">
                    <Avatar name={u.display_name} seed={u.id} size={38} online={u.online} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-900">
                        {u.display_name}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-slate-500">
                        @{u.username} • {u.online ? <span className="text-emerald-600">в сети</span> : u.role === 'tutor' ? 'репетитор' : 'ученик'}
                      </div>
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
                      className={`rounded-lg p-2 transition ${
                        selectedChatContact?.id === u.id && chatMode === 'direct'
                          ? 'border-indigo-600 bg-indigo-600 text-white'
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
                      className="rounded-lg bg-slate-50 p-2 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600"
                    >
                      <Phone className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => startCallByNick(u.username, true)}
                      disabled={!connected || Boolean(currentRoom)}
                      aria-label={`Видеозвонок @${u.username}`} title={`Видеозвонок @${u.username}`}
                      className="rounded-lg bg-slate-50 p-2 text-slate-600 hover:bg-indigo-50 hover:text-indigo-600"
                    >
                      <Video className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemovingContact(u)}
                      aria-label="Удалить из контактов" title="Удалить из контактов"
                      className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}

            {outgoingRequests.length > 0 && (
              <div className="pt-3">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
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
                      <span className="text-xs text-slate-400">Заявка отправлена</span>
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
      <div {...resizeHandleProps('left')} />

      {/* Отдельная страница контактов для широких экранов */}
      <section className="contacts-page" aria-label="Контакты">
        <div className="mx-auto w-full max-w-5xl px-6 py-7 lg:px-10">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
                {currentUser.role === 'tutor' ? 'Мои ученики' : 'Мои преподаватели'}
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                {currentUser.role === 'tutor'
                  ? `${studentCount} из 10 учеников · ${contacts.filter((c) => c.online).length} в сети`
                  : `${contacts.length} ${contacts.length === 1 ? 'преподаватель' : 'преподавателей'} · ${contacts.filter((c) => c.online).length} в сети`}
              </p>
            </div>
            {currentUser.role === 'tutor' ? (
              <form onSubmit={handleSendContactRequest} className="flex w-full max-w-sm gap-2">
                <div className="flex flex-1 items-center rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 transition focus-within:border-indigo-500 focus-within:ring-4 focus-within:ring-indigo-100">
                  <span className="text-sm text-slate-400">@</span>
                  <input
                    type="text"
                    placeholder="ник ученика"
                    aria-label="Ник ученика для приглашения"
                    value={addContactNick}
                    disabled={!connected || studentCount >= 10}
                    onChange={(e) => setAddContactNick(e.target.value)}
                    className="ml-1 w-full bg-transparent text-sm text-slate-900 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!connected || studentCount >= 10 || !addContactNick.trim()}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  <UserPlus className="h-4 w-4" />Пригласить
                </button>
              </form>
            ) : (
              <button type="button" onClick={copyOwnNick} className="inline-flex items-center gap-2 rounded-xl bg-indigo-50 px-4 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-100">
                <Copy className="h-4 w-4" />Мой ник: @{currentUser.username}
              </button>
            )}
          </div>

          {currentUser.role === 'tutor' && (
            <div className="mt-5 h-2 w-full overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Заполнение лимита учеников" aria-valuenow={studentCount} aria-valuemin={0} aria-valuemax={10}>
              <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-all" style={{ width: `${studentCount * 10}%` }} />
            </div>
          )}

          {incomingRequests.length > 0 && (
            <div className="mt-7">
              <h2 className="text-sm font-semibold text-slate-900">Приглашения · {incomingRequests.length}</h2>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {incomingRequests.map((req) => (
                  <div key={req.id} className="flex items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                    <Avatar name={req.from_user.display_name} seed={req.from_user.id} size={44} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold text-slate-900">{req.from_user.display_name}</div>
                      <div className="truncate text-xs text-slate-500">@{req.from_user.username} приглашает вас заниматься</div>
                    </div>
                    <button type="button" onClick={() => handleRespondContactRequest(req.id, false)} className="rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-white">Отклонить</button>
                    <button type="button" onClick={() => handleRespondContactRequest(req.id, true)} className="rounded-xl bg-indigo-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-indigo-500">Принять</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {contacts.length === 0 ? (
              <div className="col-span-full rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
                <Users className="mx-auto h-8 w-8 text-slate-300" />
                <p className="mt-3 font-semibold text-slate-800">{currentUser.role === 'tutor' ? 'Пока нет учеников' : 'Пока нет преподавателей'}</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
                  {currentUser.role === 'tutor' ? 'Попросите ученика зарегистрироваться и прислать свой @ник, затем пригласите его выше.' : 'Отправьте преподавателю свой @ник — его приглашение появится здесь.'}
                </p>
              </div>
            ) : (
              [...contacts]
                .sort((a, b) => Number(b.online) - Number(a.online) || a.display_name.localeCompare(b.display_name, 'ru'))
                .map((u) => {
                  const unread = unreadChats[computeDmRoomId(currentUser.id, u.id)] ?? 0;
                  return (
                    <article key={u.id} className="group flex flex-col rounded-2xl border border-slate-200 bg-white p-5 transition hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-900/5">
                      <div className="flex items-start gap-3.5">
                        <Avatar name={u.display_name} seed={u.id} size={52} online={u.online} />
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-base font-semibold text-slate-900">{u.display_name}</h3>
                          <p className="truncate text-sm text-slate-500">@{u.username}</p>
                          <p className={`mt-1 text-xs font-medium ${u.online ? 'text-emerald-600' : 'text-slate-400'}`}>{u.online ? 'В сети' : 'Не в сети'}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setRemovingContact(u)}
                          aria-label={`Удалить @${u.username} из контактов`}
                          title="Удалить из контактов"
                          className="rounded-lg p-1.5 text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                      <div className="mt-5 grid grid-cols-[1fr_auto_auto] gap-2">
                        <button
                          type="button"
                          onClick={() => startCallByNick(u.username, true)}
                          disabled={!connected || Boolean(currentRoom)}
                          className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
                        >
                          <Video className="h-4 w-4" />{currentUser.role === 'tutor' ? 'Начать урок' : 'Видеозвонок'}
                        </button>
                        <button
                          type="button"
                          onClick={() => startCallByNick(u.username, false)}
                          disabled={!connected || Boolean(currentRoom)}
                          aria-label={`Аудиозвонок @${u.username}`}
                          title="Аудиозвонок"
                          className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-700 hover:bg-indigo-50 hover:text-indigo-600"
                        >
                          <Phone className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => { setSelectedChatContact(u); setChatMode('direct'); setPanel('chat'); }}
                          aria-label={`Написать @${u.username}`}
                          title="Написать"
                          className="relative grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-700 hover:bg-indigo-50 hover:text-indigo-600"
                        >
                          <MessageSquare className="h-4 w-4" />
                          {unread > 0 && <span className="nav-badge absolute -right-1.5 -top-1.5">{unread}</span>}
                        </button>
                      </div>
                    </article>
                  );
                })
            )}
          </div>

          {outgoingRequests.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-slate-900">Ожидают подтверждения · {outgoingRequests.length}</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                {outgoingRequests.map((req) => (
                  <span key={req.id} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-3 text-sm text-slate-600">
                    <Avatar name={req.to_user.display_name} seed={req.to_user.id} size={26} />
                    {req.to_user.display_name}
                    <Clock3 className="h-3.5 w-3.5 text-slate-400" />
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <main className="lesson-panel" aria-label="Урок">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-7 py-4">
          <div>
            {currentRoom && topicDraft !== null ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const title = topicDraft.trim();
                  if (title && title !== currentRoom.title) {
                    sendControl({ type: 'rename_room', payload: { room_id: currentRoom.id, title } });
                  }
                  setTopicDraft(null);
                }}
              >
                <input
                  autoFocus
                  value={topicDraft}
                  maxLength={80}
                  onChange={(e) => setTopicDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setTopicDraft(null); }}
                  placeholder="Например: Квадратные уравнения"
                  aria-label="Тема урока"
                  className="w-72 max-w-full rounded-lg border border-indigo-300 px-2.5 py-1 text-base font-semibold text-slate-900 focus:border-indigo-500 focus:outline-none"
                />
                <button type="submit" className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500">Сохранить</button>
                <button type="button" onClick={() => setTopicDraft(null)} className="rounded-lg px-2 py-1.5 text-sm text-slate-500 hover:bg-slate-100">Отмена</button>
              </form>
            ) : (
              <div className="flex items-center gap-1.5">
                <h1 className="text-base font-semibold text-slate-900">
                  {currentRoom ? currentRoom.title : 'Ваше учебное пространство'}
                </h1>
                {currentRoom && (currentUser.role === 'tutor' || currentRoom.host_id === currentUser.id) && (
                  <button
                    type="button"
                    onClick={() => setTopicDraft(currentRoom.title)}
                    title="Изменить тему урока"
                    aria-label="Изменить тему урока"
                    className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-xs font-medium text-slate-400 hover:bg-indigo-50 hover:text-indigo-700"
                  >
                    <Pencil className="h-3.5 w-3.5" /> Тема
                  </button>
                )}
              </div>
            )}
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
                className="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-500"
              >
                Позвать
              </button>
            </form>
          )}
        </header>

        <div className="flex-1 overflow-y-auto p-7">
          {!currentRoom ? (
            <div className="mx-auto flex max-w-xl flex-col items-center py-6 text-center sm:py-12">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
                <GraduationCap className="h-8 w-8" />
              </div>
              <h2 className="mt-5 text-xl font-semibold tracking-tight text-slate-900">
                {currentUser.role === 'tutor'
                  ? contacts.length > 0 ? 'Готовы к уроку' : 'Добро пожаловать в Liaper!'
                  : contacts.length > 0 ? 'Всё готово к занятию' : 'Добро пожаловать в Liaper!'}
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">
                {currentUser.role === 'tutor'
                  ? contacts.length > 0 ? 'Позвоните ученику из списка контактов или соберите групповой урок.' : 'Три шага до первого занятия:'
                  : contacts.length > 0 ? 'Когда преподаватель начнёт урок, появится окно входящего звонка.' : 'Три шага до первого занятия:'}
              </p>
              {contacts.length === 0 && (
                <ol className="mt-6 w-full max-w-sm space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-xs">
                  {currentUser.role === 'tutor' ? <>
                    <li className={`onboarding-step ${outgoingRequests.length > 0 ? 'is-done' : ''}`}><b>{outgoingRequests.length > 0 ? <Check className="h-3.5 w-3.5" /> : 1}</b><div><p className="text-sm font-semibold text-slate-900">Пригласите ученика по @нику</p><p className="text-xs text-slate-500">Попросите ученика зарегистрироваться и прислать свой ник.</p></div></li>
                    <li className="onboarding-step"><b>2</b><div><p className="text-sm font-semibold text-slate-900">Дождитесь подтверждения</p><p className="text-xs text-slate-500">Ученик примет её в своём разделе «Преподаватели».</p></div></li>
                    <li className="onboarding-step"><b>3</b><div><p className="text-sm font-semibold text-slate-900">Начните урок</p><p className="text-xs text-slate-500">Звонок, видео, демонстрация экрана и чат урока.</p></div></li>
                  </> : <>
                    <li className="onboarding-step"><b>1</b><div><p className="text-sm font-semibold text-slate-900">Отправьте преподавателю свой ник</p>
                      <button type="button" onClick={copyOwnNick} className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-2.5 py-1 text-sm font-semibold text-indigo-700 hover:bg-indigo-100"><Copy className="h-3.5 w-3.5" />@{currentUser.username}</button></div></li>
                    <li className={`onboarding-step ${incomingRequests.length > 0 ? 'is-done' : ''}`}><b>{incomingRequests.length > 0 ? <Check className="h-3.5 w-3.5" /> : 2}</b><div><p className="text-sm font-semibold text-slate-900">Примите приглашение</p><p className="text-xs text-slate-500">{incomingRequests.length > 0 ? 'Приглашение пришло — откройте «Преподаватели».' : 'Оно появится в разделе «Преподаватели».'}</p></div></li>
                    <li className="onboarding-step"><b>3</b><div><p className="text-sm font-semibold text-slate-900">Присоединяйтесь к уроку</p><p className="text-xs text-slate-500">Преподаватель позвонит, вам останется нажать «Принять».</p></div></li>
                  </>}
                </ol>
              )}
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                {currentUser.role === 'tutor' ? (
                  <button type="button" onClick={() => { setPanel('contacts'); window.setTimeout(() => document.getElementById('add-contact')?.focus(), 50); }} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-indigo-600/20 hover:bg-indigo-500"><UserPlus size={18} />Пригласить ученика</button>
                ) : incomingRequests.length > 0 ? (
                  <button type="button" onClick={() => setPanel('contacts')} className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-500"><Users size={18} />Открыть приглашения</button>
                ) : null}
                {contacts.length > 0 && currentUser.role === 'tutor' && (
                  <button type="button" disabled={!connected} onClick={() => setShowGroupModal(true)} className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50"><Plus size={18} />Групповой урок</button>
                )}
              </div>
              <p className="mt-8 inline-flex items-center gap-1.5 text-xs text-slate-400"><ShieldCheck className="h-3.5 w-3.5" />Камера и микрофон включаются только во время звонка</p>
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
                    userId={p.user_id}
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
          <footer className="call-footer flex items-center justify-between border-t border-slate-200 bg-white px-7 py-3">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <UserCheck className="h-4 w-4 text-emerald-600" />
              <span>Участников на уроке: {currentRoom.participants.length}</span>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                aria-pressed={audioEnabled} aria-label={audioEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
                title={audioEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
                onClick={toggleMicrophone}
                className={`call-btn ${audioEnabled ? 'is-on' : 'is-off'}`}
              >
                {audioEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
                <span className="call-label">{audioEnabled ? 'Микрофон' : 'Без звука'}</span>
              </button>
              <button
                type="button"
                aria-pressed={videoEnabled} aria-label={videoEnabled ? 'Выключить камеру' : 'Включить камеру'}
                title={videoEnabled ? 'Выключить камеру' : 'Включить камеру'}
                onClick={toggleCamera}
                className={`call-btn ${videoEnabled ? 'is-on' : 'is-off'}`}
              >
                {videoEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
                <span className="call-label">Камера</span>
              </button>
              <button
                type="button"
                aria-pressed={screenShareEnabled}
                aria-label={screenShareEnabled ? 'Остановить показ экрана' : 'Показать экран'}
                title={screenShareEnabled ? 'Остановить показ экрана' : 'Показать экран'}
                onClick={toggleScreenShare}
                className={`call-btn ${screenShareEnabled ? 'is-active' : 'is-on'}`}
              >
                {screenShareEnabled ? <MonitorOff className="h-5 w-5" /> : <Monitor className="h-5 w-5" />}
                <span className="call-label">{screenShareEnabled ? 'Остановить показ' : 'Экран'}</span>
              </button>
              <button
                type="button"
                onClick={leaveCurrentRoom}
                aria-label="Завершить урок"
                title="Завершить урок"
                className="call-btn is-danger"
              >
                <PhoneOff className="h-5 w-5" />
                <span className="call-label">Завершить</span>
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
      <div {...resizeHandleProps('right')} />
      <aside className="chat-panel" aria-label={panel === 'settings' ? 'Настройки' : 'Сообщения'}>
        <div className="panel-heading"><h2>{panel === 'settings' ? 'Настройки' : 'Сообщения'}</h2>
          <span>{panel === 'settings' ? `Версия ${APP_VERSION}` : 'Личные чаты и уроки'}</span></div>

        {/* ВКЛАДКА 1: Чат (Урок, Личный диалог с контактом и Архив уроков) */}
        {panel !== 'settings' && (
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Переключатель режима чата */}
            <div className="border-b border-slate-200 bg-white px-4 py-3 space-y-3">
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1" role="tablist" aria-label="Тип переписки">
                {([
                  ['direct', 'Личные', directUnreadTotal],
                  ['lesson', 'Урок', currentRoom ? unreadChats[currentRoom.id] ?? 0 : 0],
                  ['archive', archivedChats.length ? `Архив · ${archivedChats.length}` : 'Архив', 0],
                ] as const).map(([mode, label, unread]) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={chatMode === mode}
                    onClick={() => {
                      setChatMode(mode);
                      setSelectedArchiveId(null);
                      setSelectedArchiveMsgKeys([]);
                    }}
                    className={`relative inline-flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[13px] font-semibold transition ${
                      chatMode === mode ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label}
                    {mode === 'lesson' && currentRoom && <span className="live-dot" />}
                    {unread > 0 && <span className="nav-badge">{unread}</span>}
                  </button>
                ))}
              </div>

              {chatMode === 'lesson' && currentRoom && (
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-slate-600">
                    <strong className="text-slate-900">{currentRoom.title}</strong>
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void saveCurrentLessonToArchive(false, false, false)}
                      title="Сохранить переписку урока в архив"
                      className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                    >
                      <Download className="h-3.5 w-3.5" />
                      В архив
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowReportModal(true)}
                      aria-label="Пожаловаться на переписку"
                      title="Пожаловаться на переписку"
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    >
                      <Flag className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {chatMode === 'direct' && selectedChatContact && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedChatContact(null)}
                    aria-label="Ко всем диалогам"
                    title="Ко всем диалогам"
                    className="-ml-1 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <Avatar name={selectedChatContact.display_name} seed={selectedChatContact.id} size={34} online={selectedChatContact.online} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-900">{selectedChatContact.display_name}</div>
                    <div className="truncate text-xs text-slate-500">{selectedChatContact.online ? 'в сети' : `@${selectedChatContact.username}`}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => startCallByNick(selectedChatContact.username, true)}
                    disabled={!connected || Boolean(currentRoom)}
                    aria-label={`Видеозвонок @${selectedChatContact.username}`}
                    title="Видеозвонок"
                    className="rounded-lg p-2 text-slate-500 hover:bg-indigo-50 hover:text-indigo-600"
                  >
                    <Video className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowReportModal(true)}
                    aria-label="Пожаловаться на переписку"
                    title="Пожаловаться на переписку"
                    className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Flag className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            {chatMode === 'direct' && !selectedChatContact ? (
              <div className="flex-1 overflow-y-auto p-2">
                {contacts.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                    <MessageSquare className="h-8 w-8 text-slate-300" />
                    <p className="mt-3 text-sm font-medium text-slate-700">Диалогов пока нет</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {currentUser.role === 'tutor' ? 'Пригласите ученика — после подтверждения здесь появится переписка.' : 'Примите приглашение преподавателя, чтобы начать переписку.'}
                    </p>
                  </div>
                ) : (
                  [...contacts]
                    .sort((a, b) => {
                      const ua = unreadChats[computeDmRoomId(currentUser.id, a.id)] ?? 0;
                      const ub = unreadChats[computeDmRoomId(currentUser.id, b.id)] ?? 0;
                      return ub - ua || Number(b.online) - Number(a.online) || a.display_name.localeCompare(b.display_name, 'ru');
                    })
                    .map((c) => {
                      const unread = unreadChats[computeDmRoomId(currentUser.id, c.id)] ?? 0;
                      return (
                        <button key={c.id} type="button" className="conversation" onClick={() => setSelectedChatContact(c)}>
                          <Avatar name={c.display_name} seed={c.id} size={42} online={c.online} />
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-sm ${unread ? 'font-bold text-slate-900' : 'font-semibold text-slate-800'}`}>{c.display_name}</span>
                            <span className="block truncate text-xs text-slate-500">
                              {unread ? `Новых сообщений: ${unread}` : `@${c.username} • ${c.role === 'tutor' ? 'репетитор' : 'ученик'}`}
                            </span>
                          </span>
                          {unread > 0 && <span className="nav-badge">{unread}</span>}
                        </button>
                      );
                    })
                )}
              </div>
            ) : chatMode === 'archive' ? (
              (() => {
                const openedArchive = selectedArchiveId
                  ? archivedChats.find((a) => a.id === selectedArchiveId) ?? null
                  : null;

                if (openedArchive) {
                  const allKeys = openedArchive.messages.map(
                    (m, idx) => m.id || `idx-${idx}`
                  );
                  const allSelected =
                    allKeys.length > 0 &&
                    selectedArchiveMsgKeys.length === allKeys.length;
                  const selectedMsgs = openedArchive.messages.filter((m, idx) =>
                    selectedArchiveMsgKeys.includes(m.id || `idx-${idx}`)
                  );

                  return (
                    <div className="flex flex-1 flex-col overflow-hidden">
                      <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedArchiveId(null);
                              setSelectedArchiveMsgKeys([]);
                            }}
                            className="text-xs font-semibold text-slate-700 hover:text-slate-900"
                          >
                            ← К списку архивов
                          </button>
                          <div className="truncate text-xs font-semibold text-slate-900">
                            {openedArchive.title}
                          </div>
                          <div className="text-xs text-slate-500">
                            Сообщений: {openedArchive.messages.length} · нажмите на сообщения, чтобы выбрать
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {openedArchive.messages.length > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedArchiveMsgKeys(allSelected ? [] : allKeys)
                              }
                              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                            >
                              {allSelected ? 'Снять' : 'Выбрать все'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => downloadArchiveAsTxt(openedArchive)}
                            title="Скачать текстовую копию (.txt)"
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >
                            <Download className="h-3 w-3" />
                            .txt
                          </button>
                        </div>
                      </div>

                      <div className="flex-1 space-y-3 overflow-y-auto p-4">
                        {openedArchive.messages.length === 0 ? (
                          <div className="flex h-full items-center justify-center text-center text-xs text-slate-400">
                            В этом уроке не было сообщений в чате.
                          </div>
                        ) : (
                          openedArchive.messages.map((m, idx) => {
                            const msgKey = m.id || `idx-${idx}`;
                            const isSelected = selectedArchiveMsgKeys.includes(msgKey);
                            const isMine = Boolean(
                              (m.sender_id && m.sender_id === currentUser.id) ||
                                (m.username &&
                                  m.username.toLowerCase() ===
                                    currentUser.username.toLowerCase())
                            );
                            const hideDefaultCaption =
                              Boolean(m.attachment) &&
                              (m.text.startsWith('Вложение: ') ||
                                m.text.startsWith('Голосовое сообщение') ||
                                m.text.startsWith('Видеокружок'));

                            return (
                              <div
                                key={msgKey}
                                onClick={() => {
                                  setSelectedArchiveMsgKeys((prev) =>
                                    prev.includes(msgKey)
                                      ? prev.filter((k) => k !== msgKey)
                                      : [...prev, msgKey]
                                  );
                                }}
                                role="checkbox"
                                aria-checked={isSelected}
                                aria-label={`Выбрать сообщение от ${m.sender}`}
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === ' ' || e.key === 'Enter') {
                                    e.preventDefault();
                                    e.currentTarget.click();
                                  }
                                }}
                                className={`archive-msg group flex cursor-pointer items-center gap-2.5 rounded-2xl p-1.5 transition ${
                                  isSelected ? 'is-selected bg-indigo-50/80' : 'hover:bg-slate-50'
                                } ${isMine ? 'justify-end' : 'justify-start'}`}
                              >
                                <span className="archive-check" aria-hidden="true">
                                  {isSelected && <Check className="h-3 w-3" strokeWidth={3} />}
                                </span>
                                <div
                                  className={`flex max-w-[85%] flex-col ${
                                    isMine ? 'items-end' : 'items-start'
                                  }`}
                                >
                                  <div className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
                                    <span className="font-medium text-slate-700">
                                      {isMine ? 'Вы' : m.sender}
                                    </span>
                                    <span>@{m.username}</span>
                                    {m.time && <span>• {m.time}</span>}
                                  </div>
                                  {(!hideDefaultCaption && m.text) || !m.attachment ? (
                                    <div
                                      className={`w-full whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                                        isMine
                                          ? 'bg-indigo-600 text-white'
                                          : 'border border-slate-200 bg-white text-slate-800'
                                      }`}
                                    >
                                      <LinkifiedText text={m.text} />
                                    </div>
                                  ) : null}
                                  {m.attachment && token && (
                                    <div
                                      className={(!hideDefaultCaption && m.text) ? 'mt-1.5' : ''}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <AttachmentCard
                                        meta={m.attachment}
                                        controlBase={DEFAULT_CONTROL_HTTP}
                                        token={token}
                                        isMine={isMine}
                                      />
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })
                        )}
                      </div>

                      <div className="border-t border-slate-200 bg-slate-100 px-4 py-3">
                        {selectedMsgs.length === 0 ? (
                          <div className="text-center text-xs font-medium text-slate-500">
                            <Lock className="mr-1.5 inline h-3.5 w-3.5 -translate-y-px" />Архив урока — только для чтения. Отметьте сообщения, чтобы переслать их в чат.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2 text-xs">
                              <span className="font-semibold text-slate-900">
                                Выбрано сообщений: {selectedMsgs.length}
                              </span>
                              <button
                                type="button"
                                onClick={() => setSelectedArchiveMsgKeys([])}
                                className="text-slate-500 hover:text-slate-900"
                              >
                                Сбросить
                              </button>
                            </div>
                            <button
                              type="button"
                              disabled={!connected}
                              onClick={() => {
                                setForwardTargetValue(currentRoom ? `lesson:${currentRoom.id}` : selectedChatContact ? `dm:${selectedChatContact.id}` : '');
                                setForwardDialog({ archive: openedArchive, messages: selectedMsgs });
                              }}
                              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                            >
                              <Forward className="h-4 w-4" />
                              Переслать…
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                return (
                  <div className="flex-1 space-y-3 overflow-y-auto p-4">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                      <p role="status">{archiveSyncStatus}</p>
                      <button
                        type="button"
                        className="mt-2 font-medium text-slate-900 underline"
                        onClick={() => {
                          if (archiveUnlocked) void syncArchives();
                          else {
                            setArchiveUnlockError(null);
                            setShowArchiveUnlock(true);
                          }
                        }}
                      >
                        {archiveUnlocked ? 'Синхронизировать' : 'Разблокировать архив'}
                      </button>
                    </div>
                    {archivedChats.length === 0 ? (
                      <div className="flex h-full flex-col items-center justify-center text-center text-xs text-slate-400">
                        <Download className="mb-2 h-6 w-6 stroke-1" />
                        Сохранённых архивов уроков пока нет. В конце урока чат сохраняется автоматически или по кнопке «В архив».
                      </div>
                    ) : (
                      archivedChats.map((arch) => (
                        <div
                          key={`${arch.id}-${arch.savedAt}`}
                          onClick={() => {
                            setSelectedArchiveId(arch.id);
                            setSelectedArchiveMsgKeys([]);
                          }}
                          className="cursor-pointer rounded-xl border border-slate-200 bg-white p-3.5 space-y-2 transition hover:border-slate-400"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-xs font-semibold text-slate-900">
                                {arch.title}
                              </div>
                              <div className="text-xs text-slate-500">
                                {new Date(arch.savedAt).toLocaleString('ru-RU')} • Сообщений:{' '}
                                {arch.messages.length}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedArchiveId(arch.id);
                                setSelectedArchiveMsgKeys([]);
                              }}
                              className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
                            >
                              Открыть чат
                            </button>
                          </div>
                          {arch.messages.length > 0 && (
                            <div className="truncate text-xs text-slate-600">
                              <strong className="text-slate-800">
                                {arch.messages[arch.messages.length - 1].sender}:
                              </strong>{' '}
                              {arch.messages[arch.messages.length - 1].text}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                );
              })()
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
                  ) : decryptedMessages.length === 0 &&
                    outgoingTransfers.filter((t) => t.roomId === activeChatRoomId).length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 p-5 text-center text-xs text-slate-400">
                      Сообщений пока нет. Напишите сообщение или прикрепите вложение!
                    </div>
                  ) : (
                    <>
                      {decryptedMessages.map((m) => {
                        const isMine = m.sender_id === currentUser.id;
                        const hideDefaultCaption =
                          Boolean(m.attachment) &&
                          (m.plaintext.startsWith('Вложение: ') ||
                            m.plaintext.startsWith('Голосовое сообщение') ||
                            m.plaintext.startsWith('Видеокружок'));
                        const hasTextBubble =
                          (!hideDefaultCaption && Boolean(m.plaintext.trim())) || !m.attachment;
                        const msgTime = m.created_at
                          ? new Date(m.created_at).toLocaleTimeString('ru-RU', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : '';

                        return (
                          <div
                            key={m.id}
                            className={`group flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                          >
                            <div className="mb-1 flex items-center gap-1.5 text-xs text-slate-500">
                              <span className="font-medium text-slate-700">
                                {isMine ? 'Вы' : m.sender_display_name}
                              </span>
                              <span>@{m.sender_username}</span>
                              {msgTime && <span>• {msgTime}</span>}
                              {m.edited_at && (
                                <span className="italic text-slate-400" title="Сообщение изменено">
                                  (изм.)
                                </span>
                              )}
                            </div>

                            <div className={`flex w-full items-center gap-1 ${isMine ? 'flex-row-reverse' : ''}`}>
                              <div
                                className={`flex min-w-0 max-w-[85%] flex-col ${isMine ? 'items-end' : 'items-start'} ${
                                  messageMenu?.message.id === m.id ? 'is-menu-target' : ''
                                }`}
                                onContextMenu={(e) => {
                                  if (window.getSelection()?.toString()) return;
                                  e.preventDefault();
                                  openMessageMenu(m, e.clientX, e.clientY, hideDefaultCaption);
                                }}
                              >
                                {m.forwarded && !hasTextBubble && (
                                  <ForwardedLabel forwarded={m.forwarded} />
                                )}
                                {hasTextBubble && (
                                  <div
                                    className={`message-bubble whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                                      isMine
                                        ? 'bg-indigo-600 text-white'
                                        : 'border border-slate-200 bg-slate-50 text-slate-900'
                                    }`}
                                  >
                                    {m.forwarded && <ForwardedLabel forwarded={m.forwarded} onAccent={isMine} />}
                                    <LinkifiedText text={m.plaintext} />
                                  </div>
                                )}

                                {m.attachment && token && (
                                  <div className={`max-w-full ${hasTextBubble ? 'mt-1.5' : ''}`}>
                                    <AttachmentCard
                                      meta={m.attachment}
                                      controlBase={DEFAULT_CONTROL_HTTP}
                                      token={token}
                                      isMine={isMine}
                                    />
                                  </div>
                                )}
                              </div>
                              {(isMine || (!hideDefaultCaption && m.plaintext.trim())) && (
                                <button
                                  type="button"
                                  aria-label="Действия с сообщением"
                                  aria-haspopup="menu"
                                  aria-expanded={messageMenu?.message.id === m.id}
                                  title={isMine ? 'Изменить или удалить' : 'Действия'}
                                  onClick={(e) => {
                                    if (messageMenu?.message.id === m.id) { closeMessageMenu(); return; }
                                    const r = e.currentTarget.getBoundingClientRect();
                                    openMessageMenu(m, isMine ? r.right - 200 : r.left, r.bottom + 4, hideDefaultCaption);
                                  }}
                                  className={`message-more ${messageMenu?.message.id === m.id ? 'is-open' : ''}`}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {outgoingTransfers
                        .filter((t) => t.roomId === activeChatRoomId)
                        .map((transfer) => (
                          <OutgoingTransferCard
                            key={transfer.localId}
                            transfer={transfer}
                            onCancel={cancelAttachmentTransfer}
                            onRetry={retryAttachmentTransfer}
                            onDismiss={dismissAttachmentTransfer}
                          />
                        ))}
                    </>
                  )}
                  <div ref={chatEndRef} />
                </div>

                <form
                  onSubmit={handleSendChatMessage}
                  className="relative border-t border-slate-200 p-4"
                >
                  {editingMessage && (
                    <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50/80 px-3 py-1.5 text-xs text-indigo-950">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 font-semibold text-indigo-700">
                          <Pencil className="h-3.5 w-3.5 shrink-0" />
                          <span>Редактирование сообщения</span>
                        </div>
                        <p className="truncate text-xs text-slate-600">
                          {editingMessage.plaintext}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMessage(null);
                          setChatInput('');
                        }}
                        className="rounded-lg p-1 text-slate-500 hover:bg-indigo-100 hover:text-slate-900"
                        title="Отменить редактирование"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  {showEmojiPicker && activeChatRoomId && (
                    <div className="mb-2.5 rounded-2xl border border-slate-200 bg-slate-50 p-2.5 shadow-xs">
                      <div className="mb-2 flex items-center justify-between gap-1 border-b border-slate-200 pb-1.5">
                        <div className="flex flex-wrap gap-1">
                          {EMOJI_CATEGORIES.map((cat, idx) => (
                            <button
                              key={cat.label}
                              type="button"
                              onClick={() => setEmojiCategoryIdx(idx)}
                              className={`rounded-lg px-2 py-1 text-xs font-semibold transition ${
                                emojiCategoryIdx === idx
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-white text-slate-600 hover:bg-slate-200/70'
                              }`}
                            >
                              {cat.label}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowEmojiPicker(false)}
                          className="rounded-md p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                          title="Закрыть панель эмодзи"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="grid max-h-36 grid-cols-10 gap-1 overflow-y-auto pr-1">
                        {EMOJI_CATEGORIES[emojiCategoryIdx].items.map((emoji, i) => (
                          <button
                            key={`${emoji}-${i}`}
                            type="button"
                            onClick={() => insertEmojiIntoChat(emoji)}
                            className="flex h-8 w-8 items-center justify-center rounded-lg text-lg transition hover:scale-110 hover:bg-white"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <MediaRecorderBar
                      disabled={!activeChatRoomId || !connected}
                      onReadyAttachment={handleReadyAttachment}
                      onError={(msg) => setSystemBanner(msg)}
                      onToggleEmoji={() => setShowEmojiPicker((v) => !v)}
                      emojiOpen={showEmojiPicker}
                    />
                    <textarea
                      ref={chatInputRef}
                      rows={1}
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
                      onKeyDown={(e) => {
                        // Enter — отправить, Shift+Enter — новая строка (во время набора IME Enter не трогаем)
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                      title="Enter — отправить, Shift+Enter — новая строка"
                      className="max-h-[200px] min-w-0 flex-1 resize-none overflow-y-auto rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm leading-5 focus:border-indigo-500 focus:outline-none disabled:bg-slate-100"
                    />
                    <button
                      type="submit"
                      aria-label="Отправить сообщение"
                      disabled={!activeChatRoomId || !chatInput.trim() || !connected || sendingChat}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white hover:bg-indigo-500 disabled:opacity-40"
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
            <section className="rounded-2xl border border-slate-200 bg-white p-5" aria-label="Профиль">
              <div className="flex items-center gap-4">
                <Avatar name={currentUser.display_name} seed={currentUser.id} size={56} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-semibold text-slate-900">{currentUser.display_name}</div>
                  <div className="mt-0.5 text-sm text-slate-500">{currentUser.role === 'tutor' ? 'Репетитор' : 'Ученик'}</div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button type="button" onClick={copyOwnNick} title="Скопировать ник" className="inline-flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100">
                  <Copy className="h-4 w-4" />@{currentUser.username}
                </button>
                <button type="button" onClick={handleLogout} className="ml-auto inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  <LogOut className="h-4 w-4" />Выйти
                </button>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                {currentUser.role === 'tutor' ? 'Ученики находят вас по этому нику, а вы их — по их нику.' : 'Отправьте этот ник преподавателю, чтобы он пригласил вас в контакты.'}
              </p>
            </section>
            {token && (
              <StorageUsage
                key={currentUser?.id}
                baseUrl={DEFAULT_CONTROL_HTTP}
                token={token}
                refreshTrigger={storageRefreshTrigger}
              />
            )}
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  Приложения
                </h3>
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                  v{APP_VERSION}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                Liaper для Windows, Linux и Android: проверьте, установлена ли последняя версия.
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
                  className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-500"
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
                    <span className="rounded bg-slate-900 px-2 py-0.5 text-xs text-white">
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
      {messageMenu && (
        <MessageMenu
          state={messageMenu}
          onClose={closeMessageMenu}
          onCopy={() => copyMessageText(messageMenu.message)}
          onEdit={() => startEditingChatMessage(messageMenu.message)}
          onDelete={() => setDeletingMessage(messageMenu.message)}
        />
      )}
      {forwardDialog && (() => {
        const q = forwardSearch.trim().toLowerCase().replace(/^@/, '');
        const targets = [
          ...(currentRoom ? [{ value: `lesson:${currentRoom.id}`, title: 'Чат урока', subtitle: currentRoom.title, contact: null as UserPublicProfile | null }] : []),
          ...contacts.map((c) => ({ value: `dm:${c.id}`, title: c.display_name, subtitle: `@${c.username}`, contact: c as UserPublicProfile | null })),
        ].filter((t) => !q || t.title.toLowerCase().includes(q) || t.subtitle.toLowerCase().includes(q));
        const n = forwardDialog.messages.length;
        const first = forwardDialog.messages[0];
        return (
          <Modal label="Переслать сообщения" onClose={() => { if (!forwardingArchiveMsgs) setForwardDialog(null); }}>
            <h2 className="text-lg font-semibold">Переслать {n === 1 ? 'сообщение' : `${n} ${n < 5 ? 'сообщения' : 'сообщений'}`}</h2>
            <div className="mt-3 rounded-xl border-l-4 border-indigo-400 bg-slate-50 px-3 py-2 text-sm">
              <div className="text-xs font-semibold text-indigo-700">{first.sender}{n > 1 ? ` и ещё ${n - 1}` : ''}</div>
              <div className="line-clamp-2 text-slate-700">{first.attachment && !first.text ? first.attachment.name : first.text || first.attachment?.name}</div>
            </div>
            <label className="mt-4 flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2 focus-within:border-indigo-500">
              <Search className="h-4 w-4 text-slate-400" />
              <input value={forwardSearch} onChange={(e) => setForwardSearch(e.target.value)} placeholder="Найти чат" aria-label="Найти чат" className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </label>
            <div role="radiogroup" aria-label="Куда переслать" className="mt-2 max-h-64 space-y-1 overflow-y-auto">
              {targets.length === 0 && <p className="py-6 text-center text-sm text-slate-500">{contacts.length === 0 && !currentRoom ? 'Пока не с кем переписываться.' : 'Ничего не найдено.'}</p>}
              {targets.map((t) => {
                const active = forwardTargetValue === t.value;
                return (
                  <button key={t.value} type="button" role="radio" aria-checked={active} onClick={() => setForwardTargetValue(t.value)}
                    className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition ${active ? 'bg-indigo-50 ring-1 ring-indigo-200' : 'hover:bg-slate-50'}`}>
                    {t.contact ? <Avatar name={t.contact.display_name} seed={t.contact.id} size={36} online={t.contact.online} />
                      : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700"><Video className="h-4 w-4" /></span>}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900">{t.title}</span>
                      <span className="block truncate text-xs text-slate-500">{t.subtitle}</span>
                    </span>
                    <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${active ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300'}`}>{active && <Check className="h-3 w-3" strokeWidth={3} />}</span>
                  </button>
                );
              })}
            </div>
            <input value={forwardComment} onChange={(e) => setForwardComment(e.target.value)} maxLength={2000} placeholder="Комментарий (необязательно)" aria-label="Комментарий" className="mt-3 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            <div className="mt-5 flex justify-end gap-3">
              <button type="button" disabled={forwardingArchiveMsgs} onClick={() => setForwardDialog(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50">Отмена</button>
              <button type="button" disabled={!forwardTargetValue || forwardingArchiveMsgs || !connected}
                onClick={() => void forwardArchiveMessages(forwardDialog.archive, forwardDialog.messages, forwardTargetValue, forwardComment)}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
                {forwardingArchiveMsgs ? <Loader2 className="h-4 w-4 animate-spin" /> : <Forward className="h-4 w-4" />}
                {forwardingArchiveMsgs ? 'Пересылаем…' : 'Переслать'}
              </button>
            </div>
          </Modal>
        );
      })()}
      {deletingMessage && <Modal label="Удалить сообщение" onClose={() => setDeletingMessage(null)}>
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-50 text-rose-600"><Trash2 className="h-5 w-5" /></span>
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">Удалить сообщение?</h2>
            <p className="mt-1 text-sm text-slate-600">Оно исчезнет у всех участников чата{deletingMessage.attachment ? ' вместе с вложением' : ''}. Отменить удаление нельзя.</p>
          </div>
        </div>
        {(deletingMessage.plaintext.trim() && !deletingMessage.attachment) && (
          <p className="mt-4 line-clamp-3 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700">{deletingMessage.plaintext}</p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button type="button" autoFocus onClick={() => setDeletingMessage(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50">Отмена</button>
          <button type="button" className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500" onClick={() => {
            handleDeleteChatMessage(deletingMessage); setDeletingMessage(null);
          }}>Удалить</button>
        </div>
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
      {showReportModal && activeChatRoomId && (
        <Modal label="Пожаловаться на переписку" onClose={() => setShowReportModal(false)}>
          <div className="flex items-center gap-2 text-rose-700">
            <Flag className="h-5 w-5" />
            <h2 className="text-lg font-semibold">Жалоба с раскрытием ключа E2EE</h2>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-slate-600">
            По умолчанию переписка зашифрована сквозным шифрованием (AES-256-GCM) и недоступна серверу.
            При отправке жалобы вы добровольно передаёте в Админку <strong>ключи текущей комнаты</strong> и
            снимок сообщений для модерации. Сразу после отправки ключ комнаты будет автоматически <strong>ротирован</strong>.
          </p>
          <form onSubmit={handleSubmitChatReport} className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Причина обращения / комментарий
              </label>
              <textarea
                rows={3}
                required
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Опишите нарушение или причину жалобы..."
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowReportModal(false)}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={submittingReport || !reportReason.trim()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              >
                <Flag className="h-3.5 w-3.5" />
                {submittingReport ? 'Отправка…' : 'Раскрыть ключ и отправить жалобу'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
export default App;
