import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  Eye,
  HardDrive,
  KeyRound,
  Lock,
  MessageSquare,
  RefreshCw,
  Server,
  ShieldCheck,
  Users,
  Video,
  X,
} from 'lucide-react';
import {
  decryptChatMessageWithKeyring,
  importRoomKeyFromRawB64,
  type RoomKeyring,
  type RoomSecretKeyBundle,
} from '../crypto/e2ee';
import { formatBytesRu } from '../services/attachments';
import type {
  ChatAttachmentMeta,
  EncryptedChatMessage,
  MediaNodeInfo,
  RoomInfo,
  UserRole,
} from '../types/protocol';
import { AttachmentCard } from './AttachmentCard';

interface AdminUserRow {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  online: boolean;
  ws_sessions: number;
  contacts_count: number;
  key_fingerprint: string;
  storage_used_bytes: number;
  storage_quota_bytes: number;
  attachments_count: number;
  archives_count: number;
}

interface AdminFileNode {
  node_id: string;
  public_url: string;
  online: boolean;
  stored_files: number;
  pending_uploads: number;
  stored_bytes: number;
}

interface DisclosedRoomKey {
  room_key_id: string;
  secret_key_b64: string;
}

export interface AdminChatReport {
  id: string;
  room_id: string;
  room_title: string;
  reporter_id: string;
  reporter_username: string;
  reporter_display_name: string;
  reason: string;
  disclosed_keys: DisclosedRoomKey[];
  messages_snapshot: EncryptedChatMessage[];
  status: 'open' | 'resolved' | string;
  created_at: string;
}

interface DecryptedReportMsg {
  id: string;
  sender_id: string;
  sender_username: string;
  sender_display_name: string;
  created_at: string;
  room_key_id: string;
  plaintext: string;
  attachment?: ChatAttachmentMeta;
  verifiedE2ee: boolean;
  failed: boolean;
}

interface AdminOverviewData {
  status: string;
  timestamp: string;
  version: string;
  storage_engine: string;
  database_connected: boolean;
  summary: {
    total_users: number;
    online_users: number;
    tutors_count: number;
    students_count: number;
    active_ws_connections: number;
    confirmed_contact_pairs: number;
    pending_contact_requests: number;
    active_rooms_count: number;
    media_nodes_count: number;
    file_nodes_online: number;
    total_chat_rooms: number;
    total_encrypted_messages: number;
    total_key_envelopes: number;
    total_attachments_ready: number;
    total_attachments_pending: number;
    total_attachments_bytes: number;
    total_lesson_archives: number;
    user_quota_bytes: number;
    open_reports_count?: number;
    total_reports_count?: number;
  };
  file_nodes: AdminFileNode[];
  media_nodes: MediaNodeInfo[];
  active_rooms: RoomInfo[];
  users: AdminUserRow[];
  reports?: AdminChatReport[];
  antifraud?: {
    status: string;
    active_quarantines: number;
    tracked_subjects: number;
    counters: {
      total_blocked_requests: number;
      auth_bruteforce_blocked: number;
      register_flood_blocked: number;
      ws_flood_blocked: number;
      oversized_payload_blocked: number;
      call_spam_blocked: number;
      upload_abuse_blocked: number;
      report_spam_blocked: number;
    };
    policies: Array<{
      code: string;
      title: string;
      limit: string;
    }>;
    subjects: Array<{
      subject_key: string;
      user_id?: string | null;
      username?: string | null;
      ip?: string | null;
      risk_score: number;
      violations_count: number;
      quarantined_until?: string | null;
      last_violation_at: string;
      last_reason: string;
    }>;
    incidents: Array<{
      id: string;
      timestamp: string;
      category: string;
      severity: 'low' | 'medium' | 'high' | 'critical' | string;
      subject: string;
      user_id?: string | null;
      username?: string | null;
      description: string;
      action_taken: string;
      risk_delta: number;
    }>;
  };
}

const ADMIN_PWD_SESSION_KEY = 'liaper.admin.session.pwd';

function encodeUtf8B64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function AdminDashboard({
  controlBase,
  token,
  currentUsername,
  onClose,
}: {
  controlBase: string;
  token: string | null;
  currentUsername?: string;
  onClose: () => void;
}) {
  const [authChecking, setAuthChecking] = useState(true);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [passwordConfigured, setPasswordConfigured] = useState(true);
  const [adminPassword, setAdminPassword] = useState<string>(
    () => sessionStorage.getItem(ADMIN_PWD_SESSION_KEY) ?? ''
  );
  const [unlocked, setUnlocked] = useState<boolean>(
    () => Boolean(sessionStorage.getItem(ADMIN_PWD_SESSION_KEY))
  );
  const [pwdInput, setPwdInput] = useState('');
  const [pwdConfirmInput, setPwdConfirmInput] = useState('');
  const [currentPwdInput, setCurrentPwdInput] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [showChangePwdModal, setShowChangePwdModal] = useState(false);

  const [data, setData] = useState<AdminOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [openedReportId, setOpenedReportId] = useState<string | null>(null);
  const [decryptedReportMsgs, setDecryptedReportMsgs] = useState<DecryptedReportMsg[]>([]);
  const [decryptingReport, setDecryptingReport] = useState(false);

  function buildAdminHeaders(pwdOverride?: string, extra?: Record<string, string>) {
    const pwd = pwdOverride ?? adminPassword;
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(pwd ? { 'X-Admin-Password-B64': encodeUtf8B64(pwd) } : {}),
      ...(extra ?? {}),
    };
  }

  useEffect(() => {
    let cancelled = false;
    async function checkAdminStatus() {
      if (!token) {
        setIsAdminUser(false);
        setAuthChecking(false);
        return;
      }
      setAuthChecking(true);
      try {
        const res = await fetch(`${controlBase}/api/admin/auth-status`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
          if (!cancelled) {
            setIsAdminUser(false);
            setAuthError(
              errBody?.error ||
                'Доступ к админке разрешён только владельцу системы (@napsy)'
            );
          }
          return;
        }
        const statusJson = (await res.json()) as {
          is_admin: boolean;
          username: string;
          password_configured: boolean;
        };
        if (!cancelled) {
          setIsAdminUser(Boolean(statusJson.is_admin));
          setPasswordConfigured(Boolean(statusJson.password_configured));
          if (!statusJson.password_configured) {
            setUnlocked(false);
          }
        }
      } catch {
        if (!cancelled) {
          setAuthError('Не удалось связаться с сервером управления');
        }
      } finally {
        if (!cancelled) {
          setAuthChecking(false);
        }
      }
    }
    void checkAdminStatus();
    return () => {
      cancelled = true;
    };
  }, [controlBase, token]);

  async function fetchOverview(pwdOverride?: string): Promise<boolean> {
    const pwd = pwdOverride ?? adminPassword;
    if (!token || !pwd) return false;
    try {
      const res = await fetch(`${controlBase}/api/admin/overview`, {
        headers: buildAdminHeaders(pwd),
        signal: AbortSignal.timeout(6000),
      });
      if (res.status === 401 || res.status === 403 || res.status === 428) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        sessionStorage.removeItem(ADMIN_PWD_SESSION_KEY);
        setUnlocked(false);
        if (res.status === 428) {
          setPasswordConfigured(false);
        }
        setAuthError(errBody?.error || 'Неверный мастер-пароль администратора');
        return false;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = (await res.json()) as AdminOverviewData;
      setData(json);
      setError(null);
      setAuthError(null);
      setLastUpdated(
        new Date().toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      );
      return true;
    } catch (err) {
      setError(
        err instanceof Error
          ? `Не удалось получить телеметрию кластера (${err.message})`
          : 'Ошибка соединения с сервером управления'
      );
      return false;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!authChecking && isAdminUser && passwordConfigured && unlocked && adminPassword) {
      void fetchOverview(adminPassword);
    }
  }, [authChecking, isAdminUser, passwordConfigured, unlocked, controlBase]);

  useEffect(() => {
    if (!autoRefresh || !unlocked || !isAdminUser || !adminPassword) return;
    const id = window.setInterval(() => {
      void fetchOverview(adminPassword);
    }, 3000);
    return () => window.clearInterval(id);
  }, [autoRefresh, unlocked, isAdminUser, adminPassword, controlBase]);

  async function handleUnlockSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = pwdInput.trim();
    if (!trimmed) return;
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const ok = await fetchOverview(trimmed);
      if (ok) {
        setAdminPassword(trimmed);
        sessionStorage.setItem(ADMIN_PWD_SESSION_KEY, trimmed);
        setUnlocked(true);
        setPwdInput('');
      }
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function handleSetupOrChangePassword(e: React.FormEvent) {
    e.preventDefault();
    const newPwd = pwdInput.trim();
    if (newPwd.length < 4) {
      setAuthError('Мастер-пароль должен содержать минимум 4 символа');
      return;
    }
    if (newPwd !== pwdConfirmInput.trim()) {
      setAuthError('Пароли не совпадают');
      return;
    }
    setAuthSubmitting(true);
    setAuthError(null);
    try {
      const res = await fetch(`${controlBase}/api/admin/setup-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          current_password: passwordConfigured
            ? currentPwdInput.trim() || adminPassword
            : undefined,
          new_password: newPwd,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setAuthError(errBody?.error || `Ошибка сохранения пароля (${res.status})`);
        return;
      }
      setPasswordConfigured(true);
      setAdminPassword(newPwd);
      sessionStorage.setItem(ADMIN_PWD_SESSION_KEY, newPwd);
      setUnlocked(true);
      setShowChangePwdModal(false);
      setPwdInput('');
      setPwdConfirmInput('');
      setCurrentPwdInput('');
      await fetchOverview(newPwd);
    } catch {
      setAuthError('Не удалось сохранить мастер-пароль на сервере');
    } finally {
      setAuthSubmitting(false);
    }
  }

  function lockAdminDashboard() {
    sessionStorage.removeItem(ADMIN_PWD_SESSION_KEY);
    setAdminPassword('');
    setUnlocked(false);
    setData(null);
    setPwdInput('');
  }

  const openedReport =
    openedReportId && data?.reports
      ? data.reports.find((r) => r.id === openedReportId) ?? null
      : null;

  useEffect(() => {
    let cancelled = false;
    async function decryptOpenedReport(rep: AdminChatReport) {
      setDecryptingReport(true);
      try {
        const keysById: Record<string, RoomSecretKeyBundle> = {};
        let activeKey: RoomSecretKeyBundle | null = null;
        for (const dk of rep.disclosed_keys) {
          try {
            const bundle = await importRoomKeyFromRawB64(dk.secret_key_b64);
            keysById[dk.room_key_id] = bundle;
            keysById[bundle.roomKeyId] = bundle;
            activeKey = bundle;
          } catch {}
        }
        const keyring: RoomKeyring | null = activeKey
          ? { activeKey, keysById }
          : null;

        const out: DecryptedReportMsg[] = [];
        for (const msg of rep.messages_snapshot) {
          try {
            const dec = await decryptChatMessageWithKeyring({
              roomId: rep.room_id,
              ciphertextB64: msg.ciphertext_b64,
              ivB64: msg.iv_b64,
              roomKeyId: msg.room_key_id,
              keyring,
            });
            out.push({
              id: msg.id,
              sender_id: msg.sender_id,
              sender_username: msg.sender_username,
              sender_display_name: msg.sender_display_name,
              created_at: msg.created_at,
              room_key_id: msg.room_key_id,
              plaintext: dec.plaintext,
              attachment: dec.attachment ?? undefined,
              verifiedE2ee: dec.verifiedE2ee,
              failed: false,
            });
          } catch {
            out.push({
              id: msg.id,
              sender_id: msg.sender_id,
              sender_username: msg.sender_username,
              sender_display_name: msg.sender_display_name,
              created_at: msg.created_at,
              room_key_id: msg.room_key_id,
              plaintext: 'Не удалось расшифровать сообщение раскрытым ключом',
              verifiedE2ee: false,
              failed: true,
            });
          }
        }
        if (!cancelled) {
          setDecryptedReportMsgs(out);
        }
      } finally {
        if (!cancelled) {
          setDecryptingReport(false);
        }
      }
    }

    if (openedReport) {
      void decryptOpenedReport(openedReport);
    } else {
      setDecryptedReportMsgs([]);
    }
    return () => {
      cancelled = true;
    };
  }, [openedReportId, data?.reports?.length]);

  async function toggleReportResolved(reportId: string) {
    try {
      await fetch(`${controlBase}/api/admin/reports/${reportId}/resolve`, {
        method: 'POST',
        headers: buildAdminHeaders(),
      });
      await fetchOverview();
    } catch {}
  }

  async function unblockSubject(subjectKey: string) {
    try {
      await fetch(`${controlBase}/api/admin/antifraud/unblock`, {
        method: 'POST',
        headers: buildAdminHeaders(undefined, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ subject_key: subjectKey }),
      });
      await fetchOverview();
    } catch {}
  }

  async function quarantineUser(userId: string, username: string) {
    try {
      await fetch(`${controlBase}/api/admin/antifraud/quarantine`, {
        method: 'POST',
        headers: buildAdminHeaders(undefined, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          subject_key: `user:${userId}`,
          user_id: userId,
          username,
          duration_secs: 900,
          reason: `Ручной карантин администратором для @${username} (15 мин.)`,
        }),
      });
      await fetchOverview();
    } catch {}
  }

  if (authChecking) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-4 text-slate-100">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center shadow-2xl">
          <Lock className="mx-auto h-8 w-8 animate-pulse text-emerald-400" />
          <p className="mt-3 text-sm font-medium text-slate-300">
            Проверка прав доступа владельца (@napsy)…
          </p>
        </div>
      </div>
    );
  }

  if (!token || !isAdminUser) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-4 text-slate-100">
        <div className="w-full max-w-md rounded-2xl border border-rose-500/40 bg-slate-900 p-6 shadow-2xl">
          <div className="flex items-center gap-3 text-rose-400">
            <Lock className="h-6 w-6 shrink-0" />
            <h2 className="text-base font-bold text-white">Доступ к Админке закрыт</h2>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-slate-300">
            {authError ||
              'Панель мониторинга и модерации привязана исключительно к аккаунту владельца (@napsy) и защищена отдельным мастер-паролем на сервере.'}
          </p>
          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-white px-4 py-2 text-xs font-semibold text-slate-900 hover:bg-slate-200"
            >
              Закрыть
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!passwordConfigured || !unlocked) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/95 p-4 text-slate-100">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-800 pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
                <KeyRound className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-sm font-bold text-white">
                  {passwordConfigured
                    ? 'Вход в Админку системы'
                    : 'Установка мастер-пароля Админки'}
                </h2>
                <p className="text-[11px] text-slate-400">
                  Владелец: @{currentUsername || 'napsy'} • Защита /api/admin/*
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {!passwordConfigured ? (
            <form onSubmit={handleSetupOrChangePassword} className="mt-4 space-y-3.5">
              <p className="text-xs leading-relaxed text-slate-300">
                Задайте отдельный <strong>мастер-пароль администратора</strong>. Он хранится на
                сервере в виде SHA-256 хэша с солью и будет требоваться при открытии админки.
              </p>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-300">
                  Новый мастер-пароль админки
                </label>
                <input
                  type="password"
                  required
                  minLength={4}
                  autoFocus
                  value={pwdInput}
                  onChange={(e) => setPwdInput(e.target.value)}
                  placeholder="Минимум 4 символа..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-xs text-white focus:border-emerald-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-300">
                  Повторите мастер-пароль
                </label>
                <input
                  type="password"
                  required
                  minLength={4}
                  value={pwdConfirmInput}
                  onChange={(e) => setPwdConfirmInput(e.target.value)}
                  placeholder="Повторите пароль..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-xs text-white focus:border-emerald-400 focus:outline-none"
                />
              </div>
              {authError && (
                <div className="rounded-xl border border-rose-500/40 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
                  {authError}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  <ShieldCheck className="h-4 w-4" />
                  {authSubmitting ? 'Сохранение…' : 'Сохранить и войти'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleUnlockSubmit} className="mt-4 space-y-3.5">
              <p className="text-xs leading-relaxed text-slate-300">
                Введите мастер-пароль администратора для расшифровки телеметрии кластера и
                доступа к модерации жалоб.
              </p>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-300">
                  Мастер-пароль админки
                </label>
                <input
                  type="password"
                  required
                  autoFocus
                  value={pwdInput}
                  onChange={(e) => setPwdInput(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3.5 py-2.5 text-xs text-white focus:border-emerald-400 focus:outline-none"
                />
              </div>
              {authError && (
                <div className="rounded-xl border border-rose-500/40 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
                  {authError}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={authSubmitting || !pwdInput.trim()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  <Lock className="h-3.5 w-3.5" />
                  {authSubmitting ? 'Проверка…' : 'Разблокировать админку'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  const s = data?.summary;
  const fileNode = data?.file_nodes?.[0];
  const reports = data?.reports ?? [];
  const af = data?.antifraud;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950 text-slate-100">
      {/* Верхняя шапка админки */}
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 bg-slate-900/90 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
            <Activity className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-bold tracking-tight text-white">
                Liaper Admin — Мониторинг всей системы и Модерация жалоб
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                  !error && data
                    ? 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30'
                    : 'bg-rose-500/15 text-rose-400 ring-1 ring-rose-500/30'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    !error && data ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
                  }`}
                />
                {!error && data ? 'КЛАСТЕР АКТИВЕН' : 'НЕТ СВЯЗИ'}
              </span>
              {(s?.open_reports_count ?? 0) > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300 ring-1 ring-amber-500/40">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Новых жалоб: {s?.open_reports_count}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              Control Server: {controlBase} • Версия: v{data?.version || '0.1.0'}{' '}
              {lastUpdated && `• Обновлено в ${lastUpdated}`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-700">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-700"
            />
            Автообновление (3 с)
          </label>
          <button
            type="button"
            onClick={() => {
              setAuthError(null);
              setPwdInput('');
              setPwdConfirmInput('');
              setCurrentPwdInput('');
              setShowChangePwdModal((prev) => !prev);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <KeyRound className="h-3.5 w-3.5 text-emerald-400" />
            Мастер-пароль
          </button>
          <button
            type="button"
            onClick={lockAdminDashboard}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20"
            title="Заблокировать сессию админки (потребуется повторный ввод пароля)"
          >
            <Lock className="h-3.5 w-3.5" />
            Заблокировать
          </button>
          <button
            type="button"
            onClick={() => void fetchOverview()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Обновить
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-900 hover:bg-slate-200"
          >
            <X className="h-4 w-4" />
            Закрыть админку
          </button>
        </div>
      </header>

      {showChangePwdModal && (
        <div className="border-b border-slate-800 bg-slate-900 px-6 py-4">
          <form
            onSubmit={handleSetupOrChangePassword}
            className="mx-auto flex max-w-4xl flex-wrap items-end gap-3"
          >
            <div className="min-w-[180px] flex-1">
              <label className="mb-1 block text-[11px] font-medium text-slate-400">
                Текущий мастер-пароль
              </label>
              <input
                type="password"
                required
                value={currentPwdInput}
                onChange={(e) => setCurrentPwdInput(e.target.value)}
                placeholder="Текущий пароль..."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <div className="min-w-[180px] flex-1">
              <label className="mb-1 block text-[11px] font-medium text-slate-400">
                Новый мастер-пароль
              </label>
              <input
                type="password"
                required
                minLength={4}
                value={pwdInput}
                onChange={(e) => setPwdInput(e.target.value)}
                placeholder="Минимум 4 символа..."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <div className="min-w-[180px] flex-1">
              <label className="mb-1 block text-[11px] font-medium text-slate-400">
                Повторите новый пароль
              </label>
              <input
                type="password"
                required
                minLength={4}
                value={pwdConfirmInput}
                onChange={(e) => setPwdConfirmInput(e.target.value)}
                placeholder="Повторите пароль..."
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-white focus:border-emerald-400 focus:outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={authSubmitting}
              className="rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              {authSubmitting ? 'Сохранение…' : 'Сменить пароль'}
            </button>
            <button
              type="button"
              onClick={() => setShowChangePwdModal(false)}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              Отмена
            </button>
            {authError && (
              <div className="w-full text-xs text-rose-400">{authError}</div>
            )}
          </form>
        </div>
      )}

      {/* Основной контент */}
      <div className="flex-1 space-y-6 overflow-y-auto p-6">
        {error && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/50 p-4 text-xs text-rose-200">
            {error}
          </div>
        )}

        {/* 0. Антифрод и защита кластера (Liaper Shield) */}
        <section className="rounded-2xl border border-emerald-500/30 bg-slate-900/90 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3.5">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-bold text-white">
                    Liaper Shield — Многоуровневая Антифрод и Анти-DDoS защита
                  </h2>
                  <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-[10px] font-bold uppercase text-emerald-300">
                    Защита активна
                  </span>
                  {(af?.active_quarantines ?? 0) > 0 && (
                    <span className="rounded-full bg-rose-500/20 px-2.5 py-0.5 text-[10px] font-bold uppercase text-rose-300">
                      В карантине: {af?.active_quarantines}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-400">
                  Автоматическое пресечение брутфорса паролей, ботоферм, Memory Bomb в чате, Call Bombing и исчерпания квот файловой ноды
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5">
                Отражено атак:{' '}
                <strong className="text-emerald-400">
                  {af?.counters.total_blocked_requests ?? 0}
                </strong>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5">
                Брутфорс:{' '}
                <strong className="text-white">
                  {af?.counters.auth_bruteforce_blocked ?? 0}
                </strong>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5">
                WS-флуд / Memory Bomb:{' '}
                <strong className="text-white">
                  {(af?.counters.ws_flood_blocked ?? 0) +
                    (af?.counters.oversized_payload_blocked ?? 0)}
                </strong>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-1.5">
                Call / Upload спам:{' '}
                <strong className="text-white">
                  {(af?.counters.call_spam_blocked ?? 0) +
                    (af?.counters.upload_abuse_blocked ?? 0)}
                </strong>
              </div>
            </div>
          </div>

          {/* Активные правила защиты */}
          <div className="mt-4 grid grid-cols-1 gap-2.5 md:grid-cols-2 lg:grid-cols-3">
            {(af?.policies ?? []).map((pol) => (
              <div
                key={pol.code}
                className="rounded-xl border border-slate-800 bg-slate-950/70 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-white">{pol.title}</span>
                  <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
                </div>
                <div className="mt-1 text-[11px] text-slate-400">{pol.limit}</div>
              </div>
            ))}
          </div>

          {/* Нарушители в карантине и журнал инцидентов */}
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200">
                  Субъекты под наблюдением / Карантин ({af?.subjects.length ?? 0})
                </span>
                <span className="text-[11px] text-slate-400">
                  Порог авто-карантина: Risk Score ≥ 100
                </span>
              </div>
              {!af?.subjects || af.subjects.length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-500">
                  Подозрительной активности не зафиксировано — все профили имеют Risk Score 0.
                </div>
              ) : (
                <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                  {af.subjects.map((sub) => {
                    const isQuarantined =
                      Boolean(sub.quarantined_until) &&
                      new Date(sub.quarantined_until!).getTime() > Date.now();
                    return (
                      <div
                        key={sub.subject_key}
                        className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-white">
                              {sub.username ? `@${sub.username}` : sub.subject_key}
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                isQuarantined
                                  ? 'bg-rose-500/20 text-rose-300'
                                  : 'bg-amber-500/20 text-amber-300'
                              }`}
                            >
                              Risk: {sub.risk_score}
                            </span>
                            {isQuarantined && (
                              <span className="rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
                                КАРАНТИН
                              </span>
                            )}
                          </div>
                          <div className="truncate text-[11px] text-slate-400">
                            {sub.last_reason} • Нарушений: {sub.violations_count}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void unblockSubject(sub.subject_key)}
                          className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/25"
                        >
                          Снять карантин
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200">
                  Журнал отражённых атак ({af?.incidents.length ?? 0})
                </span>
                <span className="text-[11px] text-slate-400">Кольцевой буфер (200 событий)</span>
              </div>
              {!af?.incidents || af.incidents.length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-500">
                  Атак и попыток обхода лимитов пока не обнаружено.
                </div>
              ) : (
                <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                  {af.incidents.map((inc) => (
                    <div
                      key={inc.id}
                      className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-rose-300">
                          [{inc.severity.toUpperCase()}] {inc.category}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(inc.timestamp).toLocaleTimeString('ru-RU')}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-200">
                        {inc.description}
                      </div>
                      <div className="mt-0.5 text-[10px] text-emerald-400">
                        Действие: {inc.action_taken}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* 1. Жалобы и раскрытые переписки (E2EE Key Disclosure) */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              1. Жалобы и добровольно раскрытые ключи переписок ({reports.length})
            </h2>
            <span className="text-[11px] text-slate-400">
              Ключ комнаты передаётся только по жалобе участника; подлинность сообщений проверяется по AES-256-GCM
            </span>
          </div>

          {reports.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-xs text-slate-400">
              Жалоб от участников пока не поступало. Все чаты остаются полностью закрытыми сквозным шифрованием (E2EE).
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {reports.map((rep) => {
                  const isOpen = rep.status === 'open';
                  const isSelected = openedReportId === rep.id;
                  return (
                    <div
                      key={rep.id}
                      className={`rounded-xl border p-4 transition ${
                        isSelected
                          ? 'border-amber-400 bg-slate-900 ring-1 ring-amber-400/40'
                          : 'border-slate-800 bg-slate-900/90 hover:border-slate-700'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                                isOpen
                                  ? 'bg-amber-500/20 text-amber-300'
                                  : 'bg-emerald-500/20 text-emerald-300'
                              }`}
                            >
                              {isOpen ? 'Открыта' : 'Рассмотрена'}
                            </span>
                            <span className="text-sm font-bold text-white">
                              {rep.room_title}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-slate-300">
                            Отправитель жалобы:{' '}
                            <strong className="text-white">
                              {rep.reporter_display_name} (@{rep.reporter_username})
                            </strong>{' '}
                            • {new Date(rep.created_at).toLocaleString('ru-RU')}
                          </div>
                          <div className="mt-1.5 rounded-lg border border-amber-500/20 bg-amber-950/30 px-3 py-1.5 text-xs text-amber-200">
                            <strong>Причина:</strong> {rep.reason}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              setOpenedReportId(isSelected ? null : rep.id)
                            }
                            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                          >
                            <Eye className="h-3.5 w-3.5" />
                            {isSelected ? 'Скрыть чат' : 'Открыть переписку'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void toggleReportResolved(rep.id)}
                            className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-700"
                          >
                            {isOpen ? 'Отметить решённой' : 'Вернуть в работу'}
                          </button>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-2.5 text-[11px] text-slate-400">
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <KeyRound className="h-3.5 w-3.5" />
                          Раскрыто ключей комнаты: {rep.disclosed_keys.length} (
                          {rep.disclosed_keys.map((k) => k.room_key_id).join(', ') || 'нет'})
                        </span>
                        <span>•</span>
                        <span>
                          Сообщений в снимке чата: {rep.messages_snapshot.length}
                        </span>
                        <span>•</span>
                        <span className="font-mono">Room: {rep.room_id}</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Просмотр расшифрованной переписки по выбранной жалобе */}
              {openedReport && (
                <div className="rounded-2xl border border-amber-500/40 bg-slate-900 p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <KeyRound className="h-4 w-4 text-amber-400" />
                        <h3 className="text-sm font-bold text-white">
                          Расшифрованная история по жалобе: {openedReport.room_title}
                        </h3>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-400">
                        Жалоба от @{openedReport.reporter_username} • Причина: «{openedReport.reason}»
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setOpenedReportId(null)}
                      className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-300 hover:bg-slate-700"
                    >
                      Закрыть просмотр
                    </button>
                  </div>

                  {decryptingReport ? (
                    <div className="py-6 text-center text-xs text-slate-400">
                      Расшифровка сообщений раскрытым ключом комнаты (AES-256-GCM)...
                    </div>
                  ) : decryptedReportMsgs.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400">
                      В этой комнате ещё не было сохранённых сообщений на момент жалобы.
                    </div>
                  ) : (
                    <div className="max-h-96 space-y-3 overflow-y-auto rounded-xl border border-slate-800 bg-slate-950 p-4">
                      {decryptedReportMsgs.map((m) => {
                        const isReporter = m.sender_id === openedReport.reporter_id;
                        const hideDefaultCaption =
                          Boolean(m.attachment) &&
                          (m.plaintext.startsWith('Вложение: ') ||
                            m.plaintext.startsWith('Голосовое сообщение') ||
                            m.plaintext.startsWith('Видеокружок'));
                        return (
                          <div
                            key={m.id}
                            className={`flex flex-col ${
                              isReporter ? 'items-end' : 'items-start'
                            }`}
                          >
                            <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-400">
                              <span className="font-semibold text-slate-200">
                                {m.sender_display_name} (@{m.sender_username})
                              </span>
                              {isReporter && (
                                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">
                                  автор жалобы
                                </span>
                              )}
                              <span>
                                {new Date(m.created_at).toLocaleTimeString('ru-RU', {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                  second: '2-digit',
                                })}
                              </span>
                              <span
                                className={`font-mono text-[10px] ${
                                  m.verifiedE2ee ? 'text-emerald-400' : 'text-rose-400'
                                }`}
                              >
                                {m.verifiedE2ee
                                  ? `✓ GCM verified (key ${m.room_key_id})`
                                  : `key ${m.room_key_id}`}
                              </span>
                            </div>
                            <div
                              className={`max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2.5 text-sm ${
                                m.failed
                                  ? 'border border-rose-500/40 bg-rose-950/40 text-rose-200'
                                  : isReporter
                                    ? 'bg-slate-800 text-white'
                                    : 'border border-slate-700 bg-white text-slate-900'
                              }`}
                            >
                              {!hideDefaultCaption && m.plaintext && (
                                <div>{m.plaintext}</div>
                              )}
                              {m.attachment && (
                                <AttachmentCard
                                  meta={m.attachment}
                                  controlBase={controlBase}
                                  token="admin"
                                  isMine={isReporter}
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        {/* 2. Матрица состояния сервисов кластера */}
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            2. Узлы и службы кластера
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">Control Server (:4000)</span>
                <Server className="h-4 w-4 text-emerald-400" />
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm font-bold text-white">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                ONLINE (REST + WS)
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                Активных WebSocket-сессий: {s?.active_ws_connections ?? 0}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">База данных PostgreSQL 16</span>
                <Database className="h-4 w-4 text-sky-400" />
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm font-bold text-white">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    data?.database_connected ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
                {data?.database_connected ? 'POSTGRESQL АКТИВНА' : 'JSON РЕЗЕРВ'}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                Движок хранения: {data?.storage_engine || 'postgresql'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">Файловая нода (:4201)</span>
                <HardDrive className="h-4 w-4 text-indigo-400" />
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm font-bold text-white">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    fileNode?.online ? 'bg-emerald-400' : 'bg-rose-400'
                  }`}
                />
                {fileNode?.online ? 'ONLINE (AES-256-GCM)' : 'OFFLINE'}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                {fileNode?.public_url || 'http://127.0.0.1:4201'} • Вложений:{' '}
                {s?.total_attachments_ready ?? 0}
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-400">Пул SFU Медиа-нод</span>
                <Video className="h-4 w-4 text-purple-400" />
              </div>
              <div className="mt-2 flex items-center gap-2 text-sm font-bold text-white">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    (s?.media_nodes_count ?? 0) > 0 ? 'bg-emerald-400' : 'bg-rose-400'
                  }`}
                />
                Нод в пуле: {s?.media_nodes_count ?? 0}
              </div>
              <div className="mt-1 text-[11px] text-slate-400">
                Активных уроков (комнат): {s?.active_rooms_count ?? 0}
              </div>
            </div>
          </div>
        </section>

        {/* 3. Сводные метрики системы */}
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            3. Сводные показатели платформы
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Users className="h-4 w-4 text-emerald-400" />
                Пользователи и Контакты
              </div>
              <div className="mt-2 text-2xl font-bold text-white">
                {s?.online_users ?? 0}{' '}
                <span className="text-sm font-normal text-slate-400">
                  онлайн из {s?.total_users ?? 0}
                </span>
              </div>
              <div className="mt-2 space-y-0.5 text-[11px] text-slate-400">
                <div>
                  Репетиторов: <strong className="text-slate-200">{s?.tutors_count ?? 0}</strong> •
                  Учеников: <strong className="text-slate-200">{s?.students_count ?? 0}</strong>
                </div>
                <div>
                  Пар контактов:{' '}
                  <strong className="text-slate-200">{s?.confirmed_contact_pairs ?? 0}</strong> •
                  Заявок: <strong className="text-slate-200">{s?.pending_contact_requests ?? 0}</strong>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <MessageSquare className="h-4 w-4 text-sky-400" />
                E2EE Сообщения и Чаты
              </div>
              <div className="mt-2 text-2xl font-bold text-white">
                {s?.total_encrypted_messages ?? 0}
              </div>
              <div className="mt-2 space-y-0.5 text-[11px] text-slate-400">
                <div>
                  Активных диалогов/чатов:{' '}
                  <strong className="text-slate-200">{s?.total_chat_rooms ?? 0}</strong>
                </div>
                <div>
                  Ключевых E2EE-конвертов:{' '}
                  <strong className="text-slate-200">{s?.total_key_envelopes ?? 0}</strong>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <HardDrive className="h-4 w-4 text-indigo-400" />
                Зашифрованные Вложения
              </div>
              <div className="mt-2 text-2xl font-bold text-white">
                {formatBytesRu(s?.total_attachments_bytes ?? 0)}
              </div>
              <div className="mt-2 space-y-0.5 text-[11px] text-slate-400">
                <div>
                  Готовых файлов:{' '}
                  <strong className="text-slate-200">{s?.total_attachments_ready ?? 0}</strong> (в
                  загрузке: {s?.total_attachments_pending ?? 0})
                </div>
                <div>
                  Квота на пользователя:{' '}
                  <strong className="text-slate-200">
                    {formatBytesRu(s?.user_quota_bytes ?? 5 * 1024 * 1024 * 1024)}
                  </strong>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <Lock className="h-4 w-4 text-amber-400" />
                Зашифрованные Архивы Уроков
              </div>
              <div className="mt-2 text-2xl font-bold text-white">
                {s?.total_lesson_archives ?? 0}
              </div>
              <div className="mt-2 space-y-0.5 text-[11px] text-slate-400">
                <div>Хранение в PostgreSQL (PBKDF2 + AES-GCM)</div>
                <div>Синхронизация между Android, Web и Windows</div>
              </div>
            </div>
          </div>
        </section>

        {/* 4. Телеметрия SFU Медиа-нод */}
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            4. Телеметрия SFU Медиа-нод и балансировщика нагрузки
          </h2>
          {!data?.media_nodes || data.media_nodes.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-5 text-xs text-slate-400">
              Ни одна SFU медиа-нода пока не прислала heartbeat.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {data.media_nodes.map((node, idx) => (
                <div
                  key={node.node_id}
                  className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                        <span className="text-sm font-bold text-white">{node.name}</span>
                        <span className="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300">
                          {node.region}
                        </span>
                        {idx === 0 && (
                          <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                            ПРИОРИТЕТ БАЛАНСИРОВЩИКА
                          </span>
                        )}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-slate-400">
                        ID: {node.node_id} • {node.ws_url}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs font-semibold text-slate-300">
                        Load Score: {node.load_score.toFixed(1)}%
                      </div>
                      <div className="text-[11px] text-slate-400">
                        Пиры: {node.active_peers} / {node.max_peers} • Комнат: {node.active_rooms}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3 pt-1 text-xs">
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>CPU</span>
                        <span className="text-slate-200">{node.cpu_usage_percent.toFixed(1)}%</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full bg-emerald-400"
                          style={{ width: `${Math.min(100, node.cpu_usage_percent)}%` }}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>RAM</span>
                        <span className="text-slate-200">
                          {node.memory_usage_percent.toFixed(1)}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full bg-sky-400"
                          style={{ width: `${Math.min(100, node.memory_usage_percent)}%` }}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[11px] text-slate-400">
                        <span>Поток</span>
                        <span className="text-slate-200">{node.bandwidth_mbps.toFixed(1)} Мбит/с</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full bg-indigo-400"
                          style={{ width: `${Math.min(100, node.bandwidth_mbps)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 5. Активные уроки (комнаты звонков) */}
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            5. Активные уроки и звонки ({data?.active_rooms?.length ?? 0})
          </h2>
          {!data?.active_rooms || data.active_rooms.length === 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-xs text-slate-400">
              В данный момент нет активных видеозвонков.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {data.active_rooms.map((room) => (
                <div
                  key={room.id}
                  className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-bold text-white">{room.title}</div>
                      <div className="font-mono text-[11px] text-slate-400">
                        Room ID: {room.id} • Нода: {room.assigned_node.name} (
                        {room.assigned_node.region})
                      </div>
                    </div>
                    <span className="rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">
                      Участников: {room.participants.length}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    {room.participants.map((p) => (
                      <div
                        key={p.user_id}
                        className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-xs"
                      >
                        <span className="h-2 w-2 rounded-full bg-emerald-400" />
                        <span className="font-medium text-white">{p.display_name}</span>
                        <span className="text-slate-400">@{p.username}</span>
                        <span className="text-[10px] text-slate-400">
                          {p.audio_enabled ? '🎤' : '🔇'} {p.video_enabled ? '📷' : ''}{' '}
                          {p.screen_share_enabled ? '🖥️' : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 6. Таблица пользователей, сессий, ключей и квот хранилища */}
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">
            6. Пользователи, E2EE-ключи и использование квоты хранилища ({data?.users?.length ?? 0})
          </h2>
          <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-800 bg-slate-950/60 text-[11px] uppercase text-slate-400">
                <tr>
                  <th className="px-4 py-3">Статус</th>
                  <th className="px-4 py-3">Пользователь</th>
                  <th className="px-4 py-3">Роль</th>
                  <th className="px-4 py-3">Контакты</th>
                  <th className="px-4 py-3">E2EE Fingerprint</th>
                  <th className="px-4 py-3">Архивы</th>
                  <th className="px-4 py-3">Хранилище вложений (квота 5 ГиБ)</th>
                  <th className="px-4 py-3">Антифрод-управление</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {(data?.users ?? []).map((u) => {
                  const pct =
                    u.storage_quota_bytes > 0
                      ? Math.min(100, (u.storage_used_bytes / u.storage_quota_bytes) * 100)
                      : 0;
                  const subjState = af?.subjects.find(
                    (sub) => sub.subject_key === `user:${u.id}` || sub.username === u.username
                  );
                  const isUserQuarantined =
                    Boolean(subjState?.quarantined_until) &&
                    new Date(subjState!.quarantined_until!).getTime() > Date.now();
                  return (
                    <tr key={u.id} className="hover:bg-slate-800/40">
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                            u.online
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-slate-800 text-slate-400'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              u.online ? 'bg-emerald-400' : 'bg-slate-500'
                            }`}
                          />
                          {u.online ? `В сети (WS: ${u.ws_sessions})` : 'Офлайн'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-white">{u.display_name}</div>
                        <div className="text-[11px] text-slate-400">@{u.username}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                            u.role === 'tutor'
                              ? 'bg-indigo-500/20 text-indigo-300'
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {u.role === 'tutor' ? 'Репетитор' : 'Ученик'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{u.contacts_count}</td>
                      <td className="px-4 py-3 font-mono text-[11px] text-slate-400">
                        <span className="inline-flex items-center gap-1">
                          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                          {u.key_fingerprint ? u.key_fingerprint.slice(0, 24) : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{u.archives_count}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-slate-200">
                            {formatBytesRu(u.storage_used_bytes)} /{' '}
                            {formatBytesRu(u.storage_quota_bytes)}
                          </span>
                          <span className="text-slate-400">Файлов: {u.attachments_count}</span>
                        </div>
                        <div className="mt-1 h-1.5 w-48 overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full bg-indigo-400"
                            style={{ width: `${Math.max(u.storage_used_bytes > 0 ? 2 : 0, pct)}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {isUserQuarantined ? (
                          <button
                            type="button"
                            onClick={() => void unblockSubject(`user:${u.id}`)}
                            className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:bg-emerald-500/25"
                          >
                            Разблокировать
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void quarantineUser(u.id, u.username)}
                            className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1 text-[11px] font-medium text-rose-300 hover:bg-rose-500/25"
                          >
                            В карантин (15 мин)
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
