import React from 'react';

// Спокойные пары фон/текст с контрастом AA; цвет закреплён за пользователем по его id.
const PALETTE = [
  ['#e0e7ff', '#3730a3'],
  ['#dcfce7', '#166534'],
  ['#fef3c7', '#92400e'],
  ['#fce7f3', '#9d174d'],
  ['#e0f2fe', '#075985'],
  ['#ede9fe', '#5b21b6'],
  ['#ffedd5', '#9a3412'],
  ['#ccfbf1', '#115e59'],
] as const;

function colorFor(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export const Avatar: React.FC<{
  name: string;
  seed: string;
  size?: number;
  online?: boolean;
  className?: string;
}> = ({ name, seed, size = 40, online, className = '' }) => {
  const [bg, fg] = colorFor(seed);
  return (
    <span
      className={`avatar ${className}`}
      style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.round(size * 0.38) }}
      aria-hidden="true"
    >
      {initials(name)}
      {online !== undefined && <span className={`avatar-presence ${online ? 'is-online' : ''}`} />}
    </span>
  );
};
