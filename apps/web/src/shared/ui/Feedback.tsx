/**
 * ARQUIVO: src/shared/ui/Feedback.tsx — v5.44.0 (design system)
 * Estados que toda tela precisa: carregando (Skeleton), vazio (EmptyState) e aviso (Alert).
 */
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from './cn';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('rounded-lg bg-sunken skeleton-shimmer', className)} aria-hidden="true" />;
}

export function EmptyState({ icon, title, children, action, className }: {
  icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center text-center px-6 py-10', className)}>
      {icon && <div className="w-12 h-12 rounded-2xl bg-sunken text-ink-muted flex items-center justify-center mb-3" aria-hidden="true">{icon}</div>}
      <p className="text-sm font-extrabold text-ink">{title}</p>
      {children && <p className="mt-1 text-xs text-ink-muted max-w-sm leading-relaxed">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';
const ALERT: Record<AlertTone, { cls: string; Icon: typeof Info; role: 'status' | 'alert' }> = {
  info: { cls: 'bg-blue-50 border-blue-200 text-info', Icon: Info, role: 'status' },
  success: { cls: 'bg-brand-tint border-brand/30 text-brand-strong', Icon: CheckCircle2, role: 'status' },
  warning: { cls: 'bg-amber-50 border-amber-200 text-warning', Icon: AlertTriangle, role: 'status' },
  danger: { cls: 'bg-red-50 border-red-200 text-danger', Icon: XCircle, role: 'alert' },
};

export function Alert({ tone = 'info', title, children, className }: { tone?: AlertTone; title?: string; children: ReactNode; className?: string }) {
  const { cls, Icon, role } = ALERT[tone];
  return (
    <div role={role} className={cn('flex items-start gap-2.5 px-4 py-3 rounded-xl border text-sm', cls, className)}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        {title && <p className="font-extrabold">{title}</p>}
        <div className={cn(title && 'mt-0.5', 'text-xs leading-relaxed')}>{children}</div>
      </div>
    </div>
  );
}
