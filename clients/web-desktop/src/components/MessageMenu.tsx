import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Copy, Pencil, Trash2 } from 'lucide-react';

export type MessageMenuState = {
  x: number;
  y: number;
  canCopy: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

type Props = {
  state: MessageMenuState;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
};

/** Всплывающее меню действий с сообщением: открывается кнопкой «⋯» или правым кликом. */
export function MessageMenu({ state, onCopy, onEdit, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(state.x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(state.y, window.innerHeight - height - margin)),
    });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [state.x, state.y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const idx = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
        items[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    document.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      document.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Действия с сообщением"
      className="message-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.canCopy && (
        <button type="button" role="menuitem" className="message-menu-item" onClick={run(onCopy)}>
          <Copy className="h-4 w-4" /> Копировать текст
        </button>
      )}
      {state.canEdit && (
        <button type="button" role="menuitem" className="message-menu-item" onClick={run(onEdit)}>
          <Pencil className="h-4 w-4" /> Изменить
        </button>
      )}
      {state.canDelete && (
        <>
          {(state.canCopy || state.canEdit) && <div className="my-1 h-px bg-slate-100" role="separator" />}
          <button type="button" role="menuitem" className="message-menu-item is-danger" onClick={run(onDelete)}>
            <Trash2 className="h-4 w-4" /> Удалить
          </button>
        </>
      )}
    </div>
  );
}
