/**
 * ARQUIVO: src/shared/ui/Card.tsx — v5.44.0 (design system)
 * Cartão padrão (antes: o mesmo conjunto de classes copiado em 44 lugares) e cabeçalho
 * de cartão com ícone, título, subtítulo e ações.
 */
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export const CARD_BASE = 'bg-surface border border-line rounded-2xl shadow-sm';

export function Card({ className, padded = true, ...rest }: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return <div className={cn(CARD_BASE, padded && 'p-4 sm:p-5', className)} {...rest} />;
}

export interface CardHeaderProps {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
  as?: 'h1' | 'h2' | 'h3';
}

export function CardHeader({ icon, title, subtitle, actions, className, as: Tag = 'h2' }: CardHeaderProps) {
  return (
    <div className={cn('flex flex-col sm:flex-row sm:items-start gap-3', className)}>
      <div className="flex items-start gap-3 min-w-0 flex-1">
        {icon && <div className="shrink-0 w-10 h-10 rounded-xl bg-brand-tint text-brand flex items-center justify-center" aria-hidden="true">{icon}</div>}
        <div className="min-w-0">
          <Tag className="text-base font-extrabold text-ink leading-snug">{title}</Tag>
          {subtitle && <p className="mt-0.5 text-xs text-ink-muted leading-relaxed">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 sm:justify-end shrink-0">{actions}</div>}
    </div>
  );
}
