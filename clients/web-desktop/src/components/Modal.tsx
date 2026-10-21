import { useEffect, useRef, type ReactNode } from 'react';

// Native dialog provides focus containment, Escape and focus restoration.
export function Modal({ children, onClose, label }: {
  children: ReactNode;
  onClose: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog ref={ref} aria-label={label} onCancel={onClose}
      className="app-dialog rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
      {children}
    </dialog>
  );
}
