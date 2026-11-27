/**
 * ARQUIVO: src/shared/ui/Badge.tsx — v5.44.0 (design system)
 * Selo de status. O tom diz o significado (não só a cor): neutro, marca, sucesso,
 * atenção, perigo e informação. Pode levar um ponto pulsante para "ao vivo".
 */
import type { ReactNode } from 'react';
import { cn } from './cn';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

export const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-sunken text-ink-muted',
  brand: 'bg-brand-tint text-brand-strong',
  success: 'bg-brand-soft text-brand-strong',
  warning: 'bg-amber-100 text-warning',
  danger: 'bg-red-50 text-danger',
  info: 'bg-blue-50 text-info',
};

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-[#78909C]', brand: 'bg-brand', success: 'bg-brand', warning: 'bg-amber-500', danger: 'bg-danger', info: 'bg-info',
};

export function Badge({ tone = 'neutral', dot, pulse, icon, children, className }: {
  tone?: BadgeTone; dot?: boolean; pulse?: boolean; icon?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-bold whitespace-nowrap', BADGE_TONES[tone], className)}>
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full', DOT[tone], pulse && 'motion-safe:animate-pulse')} aria-hidden="true" />}
      {icon}
      {children}
    </span>
  );
}
