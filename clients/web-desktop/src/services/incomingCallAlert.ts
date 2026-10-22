// Оповещение о входящем звонке: рингтон по кругу, системное уведомление,
// мигание окна (Tauri) / заголовка вкладки (браузер).

const RINGTONE_URL = '/sounds/ringtone.wav';
// Звонящий может бросить трубку, а сервер об этом не сообщает — не звоним бесконечно
const RING_TIMEOUT_MS = 45_000;
const TITLE_BLINK_MS = 1000;

const isTauri = () => '__TAURI_INTERNALS__' in window;

let audio: HTMLAudioElement | null = null;
let rampTimer: number | null = null;
let stopTimer: number | null = null;
let titleTimer: number | null = null;
let savedTitle: string | null = null;
let browserNotification: Notification | null = null;
let activeKey: string | null = null;
let retryOnGesture: (() => void) | null = null;

function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(RINGTONE_URL);
    audio.loop = true;
    audio.preload = 'auto';
  }
  return audio;
}

function playRingtone() {
  const el = getAudio();
  el.currentTime = 0;
  // Плавно нарастаем, чтобы звонок не пугал, но к ~6 с звучал в полную громкость
  el.volume = 0.35;
  if (rampTimer !== null) window.clearInterval(rampTimer);
  rampTimer = window.setInterval(() => {
    el.volume = Math.min(1, el.volume + 0.05);
    if (el.volume >= 1 && rampTimer !== null) {
      window.clearInterval(rampTimer);
      rampTimer = null;
    }
  }, 500);
  el.play().catch(() => {
    // Автовоспроизведение заблокировано до первого действия пользователя — доиграем по клику
    const key = activeKey;
    retryOnGesture = () => {
      if (activeKey && activeKey === key) el.play().catch(() => {});
    };
    window.addEventListener('pointerdown', retryOnGesture, { once: true, capture: true });
    window.addEventListener('keydown', retryOnGesture, { once: true, capture: true });
  });
}

function startTitleBlink(text: string) {
  if (titleTimer !== null) return;
  savedTitle = document.title;
  let on = false;
  titleTimer = window.setInterval(() => {
    on = !on;
    document.title = on ? text : savedTitle ?? '';
  }, TITLE_BLINK_MS);
}

function stopTitleBlink() {
  if (titleTimer !== null) {
    window.clearInterval(titleTimer);
    titleTimer = null;
  }
  if (savedTitle !== null) {
    document.title = savedTitle;
    savedTitle = null;
  }
}

async function notifyTauri(title: string, body: string) {
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.unminimize().catch(() => {});
    // Мигание на панели задач до тех пор, пока окно не получит фокус
    await win.requestUserAttention(UserAttentionType.Critical).catch(() => {});
    if (await win.isFocused().catch(() => false)) return;
  } catch {
    /* окно недоступно — остаётся уведомление */
  }
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import('@tauri-apps/plugin-notification');
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  } catch {
    /* уведомления не поддерживаются — достаточно звука и мигания */
  }
}

function notifyBrowser(title: string, body: string, tag: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return;
  try {
    browserNotification = new Notification(title, { body, tag, requireInteraction: true, icon: '/favicon.svg' });
    browserNotification.onclick = () => {
      window.focus();
      browserNotification?.close();
    };
  } catch {
    /* напр. мобильный браузер без конструктора Notification */
  }
}

/** Запросить разрешение на уведомления заранее (браузеры требуют действия пользователя). */
export function primeIncomingCallAlerts() {
  if (isTauri()) return;
  const ask = () => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    // Заодно «разблокируем» аудио, чтобы рингтон не упёрся в политику автовоспроизведения
    const el = getAudio();
    el.muted = true;
    el.play().then(() => { el.pause(); el.muted = false; }).catch(() => { el.muted = false; });
  };
  window.addEventListener('pointerdown', ask, { once: true, capture: true });
}

export function startIncomingCallAlert(opts: { key: string; callerName: string; roomTitle: string; withVideo: boolean }) {
  if (activeKey === opts.key) return;
  stopIncomingCallAlert();
  activeKey = opts.key;

  const title = opts.withVideo ? 'Входящий видеозвонок' : 'Входящий звонок';
  const body = `${opts.callerName} — ${opts.roomTitle}`;

  playRingtone();
  startTitleBlink(`📞 ${opts.callerName} звонит…`);
  if (isTauri()) void notifyTauri(title, body);
  else notifyBrowser(title, body, opts.key);

  stopTimer = window.setTimeout(() => {
    // Звук глушим, но окно звонка остаётся — можно принять позже
    audio?.pause();
    stopTitleBlink();
  }, RING_TIMEOUT_MS);
}

export function stopIncomingCallAlert() {
  activeKey = null;
  if (rampTimer !== null) window.clearInterval(rampTimer);
  if (stopTimer !== null) window.clearTimeout(stopTimer);
  rampTimer = null;
  stopTimer = null;
  if (retryOnGesture) {
    window.removeEventListener('pointerdown', retryOnGesture, { capture: true });
    window.removeEventListener('keydown', retryOnGesture, { capture: true });
    retryOnGesture = null;
  }
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
  }
  stopTitleBlink();
  browserNotification?.close();
  browserNotification = null;
  if (isTauri()) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().requestUserAttention(null))
      .catch(() => {});
  }
}
