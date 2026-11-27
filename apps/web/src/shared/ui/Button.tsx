/**
 * =====================================================================================
 * ARQUIVO: src/shared/ui/Button.tsx — v5.44.0 (design system)
 * Botão único do site. Variantes por intenção (não por cor):
 *   primary   ação principal da tela (verde da marca)
 *   secondary ação comum (fundo neutro com borda)
 *   ghost     ação discreta (só texto)
 *   danger    ação destrutiva (excluir, encerrar)
 *   water     irrigar (azul da água; reservado à válvula)
 * Sempre `type="button"` por padrão (não envia formulário sem querer), foco visível,
 * estado "carregando" que bloqueia clique duplo e anuncia ao leitor de tela.
 * =====================================================================================
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'water';
export type ButtonSize = 'sm' | 'md' | 'lg';

export const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 font-bold rounded-xl transition select-none ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-white shadow-sm hover:bg-brand-strong',
  secondary: 'bg-surface text-ink border border-line hover:bg-sunken',
  ghost: 'text-ink-muted hover:bg-sunken hover:text-ink',
  danger: 'bg-surface text-danger border border-danger/40 hover:bg-danger hover:text-white',
  water: 'bg-info text-white shadow-sm hover:bg-info-strong',
};

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, icon, fullWidth, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], BUTTON_SIZES[size], fullWidth && 'w-full', className)}
      {...rest}
    >
      {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'icon' | 'children' | 'fullWidth'> {
  /** Obrigatório: o botão só tem ícone, então o nome vem daqui (leitor de tela e dica). */
  label: string;
  children: ReactNode;
}

/** Botão só com ícone. 40 px no mouse; em tela de toque, no mínimo 44 px (classe tap-target, v5.47.0). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', className, children, ...rest },
  ref,
) {
  const box = size === 'sm' ? 'w-8 h-8' : size === 'lg' ? 'w-11 h-11' : 'w-10 h-10';
  const { type = 'button', loading, disabled, ...other } = rest;
  return (
    <button ref={ref} type={type} aria-label={label} title={label} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cn(BUTTON_BASE, BUTTON_VARIANTS[variant], box, 'shrink-0 tap-target', className)} {...other}>
      {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : children}
    </button>
  );
});
