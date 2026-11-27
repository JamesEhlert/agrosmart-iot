/**
 * ARQUIVO: src/shared/ui/Chip.tsx — v5.44.0 (design system)
 * Chip de filtro liga/desliga (aria-pressed) e Segmented: escolha única entre poucas
 * opções (período, visualização), navegável por setas do teclado.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from './cn';

export function Chip({ selected, onClick, children, count, className }: {
  selected: boolean; onClick: () => void; children: ReactNode; count?: number; className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-xs font-bold border transition',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        selected ? 'bg-brand-tint border-brand text-brand-strong' : 'bg-sunken border-transparent text-ink-muted hover:text-ink',
        className,
      )}
    >
      {children}
      {count !== undefined && <span className={cn('px-1.5 rounded-full text-[11px]', selected ? 'bg-surface' : 'bg-surface/70')}>{count}</span>}
    </button>
  );
}

export interface SegmentedOption<T extends string> { value: T; label: ReactNode; }

/** Próximo índice ao usar setas (circular). Exportado para teste. */
export function nextSegmentIndex(current: number, key: string, total: number): number {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % total;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + total) % total;
  if (key === 'Home') return 0;
  if (key === 'End') return total - 1;
  return current;
}

export function Segmented<T extends string>({ options, value, onChange, label, className }: {
  options: SegmentedOption<T>[]; value: T; onChange: (v: T) => void; label: string; className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const onKey = (e: KeyboardEvent) => {
    const n = nextSegmentIndex(idx, e.key, options.length);
    if (n !== idx) { e.preventDefault(); onChange(options[n].value); refs.current[n]?.focus(); }
  };
  return (
    <div role="radiogroup" aria-label={label} className={cn('inline-flex p-1 rounded-xl bg-sunken gap-1 max-w-full overflow-x-auto', className)} onKeyDown={onKey}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'shrink-0 h-8 px-3 rounded-lg text-xs font-bold transition whitespace-nowrap',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus',
              on ? 'bg-surface text-brand shadow-sm' : 'text-ink-muted hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
