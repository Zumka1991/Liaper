import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowRight,
  BookOpen,
  Check,
  ClipboardCheck,
  Download,
  FileText,
  FolderOpen,
  GraduationCap,
  Laptop,
  ListChecks,
  Lock,
  MessageCircle,
  MessageSquare,
  Mic,
  MonitorUp,
  NotebookPen,
  PhoneOff,
  Play,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react';
import type { UserRole } from '../types/protocol';
import { LogoMark } from './Logo';

type Props = { onRegister: (role?: UserRole) => void; onLogin: () => void };

const SUBJECTS = ['Математика', 'Английский', 'Физика', 'Русский язык', 'Химия', 'Программирование', 'Музыка', 'ЕГЭ и ОГЭ'];

const BEFORE = [
  { icon: MessageCircle, name: 'Мессенджер', text: 'задания теряются среди чатов' },
  { icon: Video, name: 'Видеосвязь', text: 'ссылку на звонок каждый раз ищут заново' },
  { icon: FolderOpen, name: 'Облачный диск', text: 'материалы лежат отдельно от переписки' },
  { icon: NotebookPen, name: 'Заметки', text: 'что проходили — приходится вспоминать' },
];

const AFTER = [
  'Звонок ученику — одной кнопкой из списка',
  'Файлы, голосовые и кружки прямо в переписке',
  'Переписка каждого урока сохраняется в архив',
  'Писать могут только ваши ученики',
];

const EXTRAS = [
  { icon: Users, title: 'Группы до 10 учеников', text: 'Разбор домашки или подготовка к экзамену мини-группой.' },
  { icon: ShieldCheck, title: 'Шифрование переписки', text: 'Сообщения и файлы шифруются на устройстве до отправки.' },
  { icon: Laptop, title: 'На всех устройствах', text: 'Браузер, Windows, Linux и Android — без настройки.' },
  { icon: Lock, title: 'Только свои', text: 'Связаться можно лишь после приглашения по @нику.' },
];

const AI_TABS = [
  {
    id: 'plan', icon: NotebookPen, title: 'План урока',
    prompt: 'Квадратные уравнения, 8 класс, 60 минут',
    output: ['Разминка: устный счёт и формулы сокращённого умножения — 5 мин', 'Дискриминант: вывод формулы на примере — 15 мин', 'Решаем вместе: 4 уравнения от простого к сложному — 20 мин', 'Самостоятельная работа с проверкой в чате — 15 мин', 'Итоги и домашнее задание — 5 мин'],
  },
  {
    id: 'homework', icon: ListChecks, title: 'Домашнее задание',
    prompt: '5 задач на дискриминант, средний уровень',
    output: ['1. x² − 7x + 12 = 0', '2. 2x² + 3x − 2 = 0', '3. x² − 6x + 9 = 0', '4. 3x² − x + 4 = 0', '5. Задача: площадь прямоугольника 24 см²…', 'Ответы — только для вас, в отдельном файле'],
  },
  {
    id: 'summary', icon: FileText, title: 'Конспект урока',
    prompt: 'Итоги урока с Иваном для родителей',
    output: ['Тема: квадратные уравнения', 'Иван уверенно находит дискриминант', 'Ошибается в знаке при b < 0 — повторим', 'Домашнее задание: 5 задач, срок — четверг'],
  },
  {
    id: 'check', icon: ClipboardCheck, title: 'Проверка решения',
    prompt: 'Фото решения задачи №3',
    output: ['Шаг 1 верно: D = 36 − 36 = 0', 'Шаг 2: при D = 0 корень один, а не два', 'Подсказка ученику: вспомни, что значит D = 0', 'Итог: 4 из 5, ошибка в выводе'],
  },
];

const FAQ = [
  ['Нужно ли что-то устанавливать?', 'Нет, Liaper работает в браузере. Для удобства есть приложения для Windows, Linux и Android.'],
  ['Сколько учеников можно добавить?', 'До 10 учеников на одного репетитора. Групповой урок вмещает всех сразу.'],
  ['Где хранятся файлы?', 'Файлы шифруются на вашем устройстве и хранятся месяц с момента загрузки — 5 ГБ на аккаунт. Переписка урока остаётся в архиве.'],
  ['Может ли ученику написать посторонний?', 'Нет. Переписка и звонки возможны только между репетитором и учениками, которые приняли его приглашение.'],
  ['Когда появится ИИ-помощник?', 'Мы уже работаем над ним. Зарегистрируйтесь — вы узнаете о запуске первыми.'],
];

/** Плавное появление блоков при прокрутке; без анимации, если пользователь её отключил. */
function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('.lp-reveal'));
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      items.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
      }),
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return ref;
}

const SectionTitle: React.FC<{ eyebrow: string; title: React.ReactNode; text?: string; center?: boolean }> = ({ eyebrow, title, text, center }) => (
  <div className={`lp-reveal max-w-2xl ${center ? 'mx-auto text-center' : ''}`}>
    <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">{eyebrow}</p>
    <h2 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">{title}</h2>
    {text && <p className="mt-4 text-lg leading-relaxed text-slate-600">{text}</p>}
  </div>
);

/* ---------- Иллюстрации интерфейса, собранные из HTML ---------- */

const LessonMock = () => (
  <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl shadow-indigo-900/15">
    <div className="flex items-center gap-1.5 border-b border-slate-100 px-4 py-3">
      <span className="h-2.5 w-2.5 rounded-full bg-rose-300" /><span className="h-2.5 w-2.5 rounded-full bg-amber-300" /><span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
      <span className="ml-3 truncate text-xs font-medium text-slate-500">Алгебра — разбор вариантов ОГЭ</span>
      <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"><span className="lp-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />идёт урок</span>
    </div>
    <div className="grid grid-cols-[1.5fr_1fr]">
      <div className="space-y-3 bg-slate-50 p-4">
        <div className="relative flex aspect-video items-end rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 p-3">
          <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-md bg-white/20 px-2 py-0.5 text-[11px] font-semibold text-white"><MonitorUp className="h-3 w-3" />Демонстрация экрана</span>
          <div className="w-full rounded-lg bg-white/95 p-3 font-mono text-[11px] leading-5 text-slate-700">
            x² − 5x + 6 = 0<br />D = 25 − 24 = 1<br /><span className="font-semibold text-indigo-700">x₁ = 3, x₂ = 2</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[['ЕС', 'Елена Сергеевна', '#e0e7ff', '#3730a3'], ['ИП', 'Иван', '#dcfce7', '#166534']].map(([ini, name, bg, fg]) => (
            <div key={name} className="flex flex-col items-center rounded-xl bg-slate-800 py-3">
              <span className="avatar" style={{ width: 34, height: 34, background: bg, color: fg, fontSize: 12 }}>{ini}</span>
              <span className="mt-1.5 text-[11px] font-medium text-slate-200">{name}</span>
            </div>
          ))}
        </div>
        <div className="flex justify-center gap-2">
          {[Mic, Video, MonitorUp].map((Icon, i) => (
            <span key={i} className="grid h-8 w-8 place-items-center rounded-full bg-white text-slate-700 shadow-sm"><Icon className="h-4 w-4" /></span>
          ))}
          <span className="grid h-8 w-8 place-items-center rounded-full bg-rose-600 text-white shadow-sm"><PhoneOff className="h-4 w-4" /></span>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-l border-slate-100 p-3 text-[11px]">
        <span className="font-semibold text-slate-900">Чат урока</span>
        <span className="self-start rounded-xl rounded-tl-sm bg-slate-100 px-2.5 py-1.5 text-slate-700">А почему дискриминант равен 1?</span>
        <span className="self-end rounded-xl rounded-tr-sm bg-indigo-600 px-2.5 py-1.5 text-white">b² − 4ac = 25 − 24</span>
        <span className="flex items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-slate-700"><FileText className="h-3.5 w-3.5 text-rose-500" />ДЗ_вариант_12.pdf</span>
        <span className="mt-auto rounded-lg border border-slate-200 px-2 py-1.5 text-slate-400">Написать сообщение…</span>
      </div>
    </div>
  </div>
);

const ChatMock = () => (
  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xl shadow-indigo-900/5">
    <div className="flex items-center gap-3 border-b border-slate-100 pb-4">
      <span className="avatar" style={{ width: 38, height: 38, background: '#dcfce7', color: '#166534', fontSize: 13 }}>ИП</span>
      <div className="min-w-0"><div className="text-sm font-semibold">Иван Петров</div><div className="text-xs text-emerald-600">в сети</div></div>
    </div>
    <div className="mt-4 flex flex-col gap-3 text-sm">
      <div className="flex items-center gap-3 self-start rounded-2xl border border-slate-200 bg-white p-2.5 pr-4">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-rose-50 text-[10px] font-bold text-rose-600">PDF</span>
        <div><div className="font-medium text-slate-800">Вариант_12.pdf</div><div className="text-xs text-slate-500">1,2 МБ</div></div>
        <Download className="ml-2 h-4 w-4 text-slate-400" />
      </div>
      <div className="flex items-center gap-3 self-end rounded-2xl bg-indigo-600 px-3 py-2.5 text-white">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-white/20"><Play className="h-3.5 w-3.5 fill-current" /></span>
        <span className="flex h-6 items-center gap-[3px]">
          {[6, 14, 9, 18, 12, 20, 8, 15, 10, 17, 7, 13, 9, 16, 6].map((h, i) => <span key={i} className="w-[3px] rounded-full bg-white/80" style={{ height: h }} />)}
        </span>
        <span className="text-xs text-indigo-100">0:42</span>
      </div>
      <div className="self-start rounded-2xl rounded-tl-sm bg-slate-100 px-3.5 py-2 text-slate-800">Понял! Сейчас решу и пришлю фото 📸</div>
      <div className="relative self-end">
        <span className="block h-24 w-24 rounded-full bg-[conic-gradient(#6366f1_0_72%,#e0e7ff_72%)] p-1">
          <span className="grid h-full w-full place-items-center rounded-full bg-gradient-to-br from-slate-700 to-slate-900 text-white"><Play className="h-5 w-5 fill-current" /></span>
        </span>
        <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-slate-600 shadow">кружок · 0:18</span>
      </div>
    </div>
  </div>
);

const ArchiveMock = () => (
  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xl shadow-indigo-900/5">
    <div className="flex items-center gap-2 text-sm font-semibold"><Archive className="h-4 w-4 text-indigo-600" />Архив уроков</div>
    <div className="mt-4 space-y-2.5">
      {[
        ['Квадратные уравнения', 'Сегодня, 17:00', 'Иван: Понял, D = 0 значит один корень', true],
        ['Теорема Виета', 'Вт, 16:30', 'Вы: ДЗ — номера 12–15', false],
        ['Пробный вариант ОГЭ', 'Пт, 18:00', 'Мария: Можно разобрать 21-е?', false],
      ].map(([title, date, last, active]) => (
        <div key={title as string} className={`rounded-xl border p-3 ${active ? 'border-indigo-200 bg-indigo-50/60' : 'border-slate-200'}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-slate-900">{title}</span>
            <span className="shrink-0 text-xs text-slate-500">{date}</span>
          </div>
          <div className="mt-1 truncate text-xs text-slate-600">{last}</div>
        </div>
      ))}
    </div>
  </div>
);

const PhoneMock = () => (
  <div className="relative mx-auto w-[220px] rounded-[2.2rem] border-[7px] border-slate-900 bg-slate-900 shadow-2xl shadow-indigo-900/25">
    <div className="absolute left-1/2 top-2 z-10 h-4 w-16 -translate-x-1/2 rounded-full bg-slate-900" />
    <div className="relative aspect-[9/19] overflow-hidden rounded-[1.7rem] bg-gradient-to-b from-indigo-400 via-violet-500 to-indigo-700">
      <div className="absolute inset-0 grid place-items-center">
        <span className="avatar" style={{ width: 72, height: 72, background: '#e0e7ff', color: '#3730a3', fontSize: 24 }}>ЕС</span>
      </div>
      <div className="absolute right-3 top-9 h-24 w-16 overflow-hidden rounded-xl border-2 border-white/70 bg-gradient-to-br from-emerald-300 to-teal-500">
        <span className="grid h-full place-items-center text-xs font-bold text-white">Вы</span>
      </div>
      <div className="absolute inset-x-0 bottom-4 flex justify-center gap-2">
        <span className="grid h-9 w-9 place-items-center rounded-full bg-white/25 text-white backdrop-blur"><Mic className="h-4 w-4" /></span>
        <span className="grid h-9 w-9 place-items-center rounded-full bg-white/25 text-white backdrop-blur"><Video className="h-4 w-4" /></span>
        <span className="grid h-9 w-9 place-items-center rounded-full bg-rose-600 text-white"><PhoneOff className="h-4 w-4" /></span>
      </div>
    </div>
  </div>
);

const SHOWCASE = [
  {
    eyebrow: 'Урок', title: 'Звонок ученику — одной кнопкой',
    text: 'Никаких ссылок и кодов конференций. Откройте карточку ученика и нажмите «Начать урок»: у него зазвонит приложение. Камера, микрофон и демонстрация экрана — встроены.',
    points: ['Демонстрация экрана для решения задач', 'Групповые уроки до 10 человек', 'Вертикальное видео с телефона без обрезки'],
    mock: <PhoneMock />,
  },
  {
    eyebrow: 'Переписка', title: 'Материалы не теряются в мессенджере',
    text: 'Отправляйте PDF, Word, фото решений, голосовые объяснения и видеокружки. Всё лежит в одном диалоге с учеником, а не в десяти разных чатах.',
    points: ['Файлы до 128 МБ, 5 ГБ на аккаунт', 'Голосовые и видеокружки', 'Шифрование на устройстве'],
    mock: <ChatMock />,
  },
  {
    eyebrow: 'Архив', title: 'Каждый урок остаётся в истории',
    text: 'После занятия переписка урока сохраняется в архив. Перед следующей встречей легко вспомнить, что проходили и какое задание дали.',
    points: ['Автосохранение в конце урока', 'Пересылка сообщений из архива', 'Архив защищён паролем аккаунта'],
    mock: <ArchiveMock />,
  },
];

const AiDemo = () => {
  const [active, setActive] = useState(AI_TABS[0].id);
  const tab = AI_TABS.find((t) => t.id === active) ?? AI_TABS[0];
  return (
    <div className="lp-reveal relative mt-10 grid gap-5 lg:grid-cols-[280px_1fr]">
      <div role="tablist" aria-label="Возможности ИИ-помощника" className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
        {AI_TABS.map(({ id, icon: Icon, title }) => (
          <button
            key={id} type="button" role="tab" aria-selected={id === active} aria-controls="ai-panel"
            onClick={() => setActive(id)}
            className={`flex shrink-0 items-center gap-3 rounded-xl px-4 py-3 text-left text-sm font-semibold transition ${id === active ? 'bg-white text-indigo-700 shadow-lg' : 'bg-white/10 text-white ring-1 ring-white/15 hover:bg-white/15'}`}
          >
            <Icon className="h-5 w-5" />{title}
          </button>
        ))}
      </div>
      <div id="ai-panel" role="tabpanel" className="rounded-2xl bg-white/95 p-5 text-slate-800 shadow-2xl ring-1 ring-white/20 sm:p-6">
        <div className="flex items-center gap-3 rounded-xl bg-slate-100 px-4 py-3 text-sm text-slate-600">
          <Sparkles className="h-4 w-4 shrink-0 text-indigo-600" />
          <span className="truncate">{tab.prompt}</span>
        </div>
        <ul key={tab.id} className="mt-4 space-y-2">
          {tab.output.map((line, i) => (
            <li key={line} className="lp-type flex gap-2.5 text-sm leading-relaxed" style={{ animationDelay: `${i * 90}ms` }}>
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500" />{line}
            </li>
          ))}
        </ul>
        <p className="mt-5 border-t border-slate-100 pt-4 text-xs text-slate-500">Пример того, как будет работать помощник. Репетитор всегда проверяет и правит результат.</p>
      </div>
    </div>
  );
};

/** Публичная страница продукта для незарегистрированных посетителей Web-версии. */
export const Landing: React.FC<Props> = ({ onRegister, onLogin }) => {
  const rootRef = useReveal();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 480);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div ref={rootRef} className="landing min-h-dvh overflow-x-hidden bg-white text-slate-900">
      <header className={`sticky top-0 z-30 border-b bg-white/85 backdrop-blur transition ${scrolled ? 'border-slate-200/80 shadow-sm' : 'border-transparent'}`}>
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-5">
          <a href="#top" className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
            <LogoMark size={34} />
            Liaper
          </a>
          <nav className="hidden items-center gap-7 text-sm font-medium text-slate-600 md:flex" aria-label="Разделы">
            <a href="#features" className="hover:text-slate-900">Возможности</a>
            <a href="#how" className="hover:text-slate-900">Как начать</a>
            <a href="#ai" className="hover:text-slate-900">ИИ-помощник</a>
            <a href="#faq" className="hover:text-slate-900">Вопросы</a>
          </nav>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onLogin} className="rounded-xl px-3.5 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100">Войти</button>
            <button type="button" onClick={() => onRegister()} className="hidden rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-indigo-600/25 hover:bg-indigo-500 sm:inline-flex">Создать аккаунт</button>
          </div>
        </div>
      </header>

      <main id="top">
        {/* Первый экран */}
        <section className="relative">
          <div className="lp-grid pointer-events-none absolute inset-0 -z-0" />
          <div className="pointer-events-none absolute inset-x-0 -top-24 h-[560px] bg-[radial-gradient(55%_60%_at_50%_0%,#e0e7ff_0%,transparent_70%)]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pb-20 pt-12 md:pt-20 lg:grid-cols-[1fr_1.05fr]">
            <div>
              <span className="lp-rise inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-white/80 px-3 py-1 text-xs font-semibold text-indigo-700 shadow-sm">
                <span className="rounded-full bg-indigo-600 px-1.5 py-px text-[10px] text-white">Новое</span> Скоро: ИИ-помощник репетитора
              </span>
              <h1 className="lp-rise mt-6 text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl lg:text-[3.6rem]" style={{ animationDelay: '60ms' }}>
                Онлайн-уроки без хаоса из{' '}
                <span className="relative whitespace-nowrap">
                  <span className="relative z-10 bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text text-transparent">пяти приложений</span>
                  <svg className="absolute -bottom-2 left-0 z-0 h-3 w-full text-amber-300" viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true"><path d="M2 9 C 50 2, 150 2, 198 8" stroke="currentColor" strokeWidth="5" fill="none" strokeLinecap="round" /></svg>
                </span>
              </h1>
              <p className="lp-rise mt-6 max-w-xl text-lg leading-relaxed text-slate-600" style={{ animationDelay: '120ms' }}>
                Звонок, переписка, материалы и история занятий — в одном окне. Liaper сделан для репетиторов
                и их учеников: всё просто, понятно и под рукой.
              </p>
              <div className="lp-rise mt-8 grid gap-3 sm:flex sm:flex-wrap" style={{ animationDelay: '180ms' }}>
                <button type="button" onClick={() => onRegister('tutor')} className="group inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3.5 text-base font-semibold text-white shadow-lg shadow-indigo-600/30 transition hover:-translate-y-0.5 hover:bg-indigo-500">
                  <GraduationCap className="h-5 w-5" /> Я репетитор <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                </button>
                <button type="button" onClick={() => onRegister('student')} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-base font-semibold text-slate-800 transition hover:-translate-y-0.5 hover:border-slate-400">
                  <BookOpen className="h-5 w-5 text-indigo-600" /> Я ученик
                </button>
              </div>
              <ul className="lp-rise mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm text-slate-600" style={{ animationDelay: '240ms' }}>
                {['Регистрация за минуту', 'Работает в браузере', 'Без рекламы'].map((t) => (
                  <li key={t} className="flex items-center gap-1.5"><Check className="h-4 w-4 text-emerald-600" />{t}</li>
                ))}
              </ul>
            </div>

            <div className="lp-rise relative" style={{ animationDelay: '150ms' }} aria-hidden="true">
              <div className="absolute -inset-8 -z-10 rounded-[2.5rem] bg-gradient-to-br from-indigo-300/50 via-violet-200/40 to-amber-100/40 blur-3xl" />
              <LessonMock />
              <div className="lp-float absolute -left-8 -top-6 hidden items-center gap-2.5 rounded-2xl border border-slate-100 bg-white px-3.5 py-2.5 shadow-xl sm:flex">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-emerald-100 text-emerald-700"><UserPlus className="h-4 w-4" /></span>
                <div className="text-xs"><div className="font-semibold text-slate-900">Мария приняла приглашение</div><div className="text-slate-500">только что</div></div>
              </div>
              <div className="lp-float absolute -bottom-6 right-4 hidden items-center gap-2.5 rounded-2xl border border-slate-100 bg-white px-3.5 py-2.5 shadow-xl sm:flex" style={{ animationDelay: '-2.5s' }}>
                <span className="grid h-8 w-8 place-items-center rounded-full bg-indigo-100 text-indigo-700"><Archive className="h-4 w-4" /></span>
                <div className="text-xs"><div className="font-semibold text-slate-900">Урок сохранён в архив</div><div className="text-slate-500">24 сообщения · 3 файла</div></div>
              </div>
            </div>
          </div>
        </section>

        {/* Бегущая строка предметов */}
        <section className="border-y border-slate-100 bg-slate-50/80 py-5" aria-label="Предметы">
          <div className="lp-marquee relative overflow-hidden">
            <div className="lp-marquee-track flex w-max gap-3">
              {[...SUBJECTS, ...SUBJECTS].map((t, i) => (
                <span key={i} aria-hidden={i >= SUBJECTS.length} className="rounded-full border border-slate-200 bg-white px-4 py-1.5 text-sm font-medium text-slate-600">{t}</span>
              ))}
            </div>
          </div>
        </section>

        {/* Было / стало */}
        <section className="mx-auto max-w-6xl px-5 py-20 sm:py-24">
          <SectionTitle center eyebrow="Зачем это нужно" title="Одно окно вместо пяти вкладок" text="Знакомо? Задание в мессенджере, звонок в другом приложении, файлы на диске. Мы собрали всё вместе." />
          <div className="mt-12 grid items-stretch gap-5 lg:grid-cols-2">
            <div className="lp-reveal rounded-3xl border border-slate-200 bg-slate-50 p-6 sm:p-8">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-500"><X className="h-4 w-4 text-rose-500" />Как обычно</div>
              <ul className="mt-5 space-y-3">
                {BEFORE.map(({ icon: Icon, name, text }) => (
                  <li key={name} className="flex items-center gap-3 rounded-2xl bg-white p-3.5 ring-1 ring-slate-200/70">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500"><Icon className="h-5 w-5" /></span>
                    <div className="min-w-0 text-sm"><div className="font-semibold text-slate-800">{name}</div><div className="text-slate-500">{text}</div></div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="lp-reveal relative overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-600 to-violet-700 p-6 text-white shadow-xl shadow-indigo-600/20 sm:p-8" style={{ transitionDelay: '120ms' }}>
              <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
              <div className="relative flex items-center gap-2 text-sm font-semibold text-indigo-100"><LogoMark size={22} />С Liaper</div>
              <ul className="relative mt-5 space-y-3">
                {AFTER.map((t) => (
                  <li key={t} className="flex items-center gap-3 rounded-2xl bg-white/10 p-3.5 ring-1 ring-white/15">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-indigo-600"><Check className="h-5 w-5" /></span>
                    <span className="text-[15px] font-medium">{t}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* Возможности крупным планом */}
        <section id="features" className="scroll-mt-20 bg-gradient-to-b from-white via-indigo-50/40 to-white py-20 sm:py-24">
          <div className="mx-auto max-w-6xl px-5">
            <SectionTitle eyebrow="Возможности" title="Всё для занятий — и ничего лишнего" />
            <div className="mt-14 space-y-20 sm:space-y-28">
              {SHOWCASE.map((item, idx) => (
                <div key={item.title} className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
                  <div className={`lp-reveal ${idx % 2 ? 'lg:order-2' : ''}`}>
                    <span className="inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-semibold text-indigo-700">{item.eyebrow}</span>
                    <h3 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">{item.title}</h3>
                    <p className="mt-4 text-lg leading-relaxed text-slate-600">{item.text}</p>
                    <ul className="mt-6 space-y-2.5">
                      {item.points.map((p) => <li key={p} className="flex items-center gap-2.5 text-slate-700"><span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-100"><Check className="h-3.5 w-3.5 text-emerald-700" /></span>{p}</li>)}
                    </ul>
                  </div>
                  <div className={`lp-reveal relative ${idx % 2 ? 'lg:order-1' : ''}`} style={{ transitionDelay: '120ms' }} aria-hidden="true">
                    <div className="absolute inset-6 -z-10 rounded-[2rem] bg-indigo-200/40 blur-3xl" />
                    <div className="mx-auto max-w-md">{item.mock}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-24 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {EXTRAS.map(({ icon: Icon, title, text }, i) => (
                <article key={title} className="lp-reveal rounded-2xl border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-900/5" style={{ transitionDelay: `${i * 60}ms` }}>
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600"><Icon className="h-5 w-5" /></span>
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{text}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Как начать */}
        <section id="how" className="scroll-mt-20 py-20 sm:py-24">
          <div className="mx-auto max-w-6xl px-5">
            <SectionTitle center eyebrow="Как начать" title="Первый урок — уже сегодня" />
            <ol className="relative mt-14 grid gap-8 md:grid-cols-3 md:gap-6">
              <div className="absolute left-[16.6%] right-[16.6%] top-7 hidden h-0.5 bg-gradient-to-r from-indigo-200 via-violet-200 to-indigo-200 md:block" aria-hidden="true" />
              {[
                [UserPlus, 'Зарегистрируйтесь', 'Выберите роль «Репетитор», придумайте @ник и пароль. Меньше минуты.'],
                [MessageSquare, 'Пригласите учеников', 'Ученик присылает свой @ник, вы отправляете приглашение — он принимает.'],
                [Video, 'Проводите уроки', 'Звоните, показывайте экран, отправляйте материалы. Всё сохраняется.'],
              ].map(([Icon, title, text], i) => {
                const I = Icon as typeof UserPlus;
                return (
                  <li key={title as string} className="lp-reveal relative text-center" style={{ transitionDelay: `${i * 100}ms` }}>
                    <span className="relative mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30">
                      <I className="h-6 w-6" />
                      <span className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-amber-300 text-xs font-bold text-slate-900 ring-4 ring-white">{i + 1}</span>
                    </span>
                    <h3 className="mt-5 text-lg font-semibold">{title as string}</h3>
                    <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-slate-600">{text as string}</p>
                  </li>
                );
              })}
            </ol>
            <div className="mt-16 grid gap-5 md:grid-cols-2">
              <div className="lp-reveal rounded-3xl bg-slate-50 p-6 ring-1 ring-slate-200 sm:p-8">
                <div className="flex items-center gap-2 text-lg font-semibold"><GraduationCap className="h-5 w-5 text-indigo-600" />Репетитору</div>
                <ul className="mt-4 space-y-2.5 text-slate-600">
                  {['Все ученики и переписка с ними — в одном списке', 'Групповые уроки до 10 человек', 'Материалы и голосовые объяснения прямо в чате', 'Архив занятий: легко вспомнить, что проходили'].map((t) => <li key={t} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />{t}</li>)}
                </ul>
                <button type="button" onClick={() => onRegister('tutor')} className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-700 hover:text-indigo-500">Зарегистрироваться как репетитор <ArrowRight className="h-4 w-4" /></button>
              </div>
              <div className="lp-reveal rounded-3xl bg-slate-50 p-6 ring-1 ring-slate-200 sm:p-8" style={{ transitionDelay: '100ms' }}>
                <div className="flex items-center gap-2 text-lg font-semibold"><BookOpen className="h-5 w-5 text-indigo-600" />Ученику</div>
                <ul className="mt-4 space-y-2.5 text-slate-600">
                  {['Урок начинается одной кнопкой «Принять»', 'Можно заниматься с телефона на Android', 'Задания и объяснения не теряются', 'Никаких незнакомцев: писать могут только ваши преподаватели'].map((t) => <li key={t} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />{t}</li>)}
                </ul>
                <button type="button" onClick={() => onRegister('student')} className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-700 hover:text-indigo-500">Зарегистрироваться как ученик <ArrowRight className="h-4 w-4" /></button>
              </div>
            </div>
          </div>
        </section>

        {/* ИИ — скоро */}
        <section id="ai" className="scroll-mt-20 px-5 pb-20 sm:pb-24">
          <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-[radial-gradient(120%_120%_at_0%_0%,#6366f1_0%,#4338ca_45%,#1e1b4b_100%)] px-5 py-14 text-white sm:px-12 sm:py-16">
            <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full bg-violet-400/30 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-32 left-1/3 h-72 w-72 rounded-full bg-amber-300/15 blur-3xl" />
            <div className="lp-reveal relative max-w-2xl">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold"><Sparkles className="h-3.5 w-3.5 text-amber-300" /> Скоро</span>
              <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">ИИ-помощник репетитора</h2>
              <p className="mt-4 text-lg text-indigo-100">Возьмёт на себя рутину: план урока, подбор задач, конспект для родителей и черновик проверки. Вам останется главное — объяснять.</p>
            </div>
            <AiDemo />
            <button type="button" onClick={() => onRegister('tutor')} className="relative mt-10 inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-indigo-700 shadow-lg transition hover:-translate-y-0.5 hover:bg-indigo-50">
              Зарегистрироваться и узнать первым <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </section>

        {/* Устройства */}
        <section className="mx-auto max-w-6xl px-5 pb-20">
          <div className="lp-reveal grid items-center gap-6 rounded-3xl border border-slate-200 p-6 sm:p-8 md:grid-cols-[1fr_auto]">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">Занимайтесь с чего удобно</h2>
              <p className="mt-2 text-slate-600">Начните в браузере — приложения для компьютера и телефона можно скачать в настройках после входа.</p>
            </div>
            <div className="flex flex-wrap gap-2.5">
              {[[Laptop, 'Браузер'], [MonitorUp, 'Windows'], [Laptop, 'Linux'], [Smartphone, 'Android']].map(([Icon, name]) => {
                const I = Icon as typeof Laptop;
                return <span key={name as string} className="inline-flex items-center gap-2 rounded-xl bg-slate-50 px-4 py-2.5 text-sm font-semibold text-slate-700 ring-1 ring-slate-200"><I className="h-4 w-4 text-indigo-600" />{name as string}</span>;
              })}
            </div>
          </div>
        </section>

        {/* Вопросы */}
        <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-5 pb-24">
          <SectionTitle center eyebrow="Вопросы" title="Частые вопросы" />
          <div className="lp-reveal mt-10 space-y-3">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group rounded-2xl border border-slate-200 bg-white px-5 py-4 transition open:border-indigo-200 open:shadow-md open:shadow-indigo-900/5 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                  {q}
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-100 text-lg leading-none text-slate-500 transition group-open:rotate-45 group-open:bg-indigo-600 group-open:text-white">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-slate-600">{a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Финальный призыв */}
        <section className="px-5 pb-24">
          <div className="lp-reveal relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-slate-900 px-6 py-16 text-center text-white">
            <div className="lp-grid lp-grid-dark pointer-events-none absolute inset-0" />
            <div className="pointer-events-none absolute left-1/2 top-0 h-64 w-[36rem] -translate-x-1/2 rounded-full bg-indigo-500/40 blur-3xl" />
            <div className="relative">
              <LogoMark size={56} className="mx-auto" />
              <h2 className="mt-6 text-3xl font-semibold tracking-tight sm:text-4xl">Готовы провести первый урок?</h2>
              <p className="mx-auto mt-3 max-w-xl text-lg text-slate-300">Создайте аккаунт и пригласите первого ученика — это займёт пару минут.</p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <button type="button" onClick={() => onRegister('tutor')} className="inline-flex items-center gap-2 rounded-xl bg-white px-7 py-3.5 text-base font-semibold text-slate-900 shadow-lg transition hover:-translate-y-0.5">
                  Создать аккаунт <ArrowRight className="h-4 w-4" />
                </button>
                <button type="button" onClick={onLogin} className="rounded-xl px-6 py-3.5 text-base font-semibold text-white ring-1 ring-white/25 hover:bg-white/10">Войти</button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-6 pb-24 text-sm text-slate-500 sm:pb-6">
          <span className="flex items-center gap-2"><LogoMark size={24} />Liaper © {new Date().getFullYear()}</span>
          <span>Платформа для репетиторов и учеников</span>
        </div>
      </footer>

      {/* Кнопка регистрации, закреплённая внизу на телефоне */}
      <div className={`fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 p-3 backdrop-blur transition-transform duration-300 sm:hidden ${scrolled ? 'translate-y-0' : 'translate-y-full'}`}>
        <button type="button" onClick={() => onRegister()} tabIndex={scrolled ? 0 : -1} className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3.5 text-base font-semibold text-white shadow-lg shadow-indigo-600/25">
          Создать аккаунт <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
