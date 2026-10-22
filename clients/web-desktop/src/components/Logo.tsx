import React, { useId } from 'react';

/**
 * Знак Liaper: облачко чата (общение ученика и репетитора) с буквой «L»
 * и искрой — отсылка к будущему ИИ-помощнику.
 */
export const LogoMark: React.FC<{ size?: number; className?: string }> = ({ size = 36, className = '' }) => {
  const gradientId = `liaper-logo-${useId().replace(/:/g, '')}`;
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      role="img"
      aria-label="Liaper"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6366F1" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
      </defs>
      <path
        d="M14 8h36a10 10 0 0 1 10 10v24a10 10 0 0 1-10 10H26l-12 8v-8a10 10 0 0 1-10-10V18A10 10 0 0 1 14 8z"
        fill={`url(#${gradientId})`}
      />
      <path d="M24 18v17a5 5 0 0 0 5 5h13" fill="none" stroke="#fff" strokeWidth="7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M45 15c.8 3.6 1.9 4.7 5.5 5.5-3.6.8-4.7 1.9-5.5 5.5-.8-3.6-1.9-4.7-5.5-5.5 3.6-.8 4.7-1.9 5.5-5.5z" fill="#FDE68A" />
    </svg>
  );
};

export const Logo: React.FC<{ size?: number; className?: string; textClassName?: string }> = ({
  size = 36,
  className = '',
  textClassName = 'text-xl font-semibold tracking-tight',
}) => (
  <span className={`inline-flex items-center gap-2.5 ${className}`}>
    <LogoMark size={size} />
    <span className={textClassName}>Liaper</span>
  </span>
);
