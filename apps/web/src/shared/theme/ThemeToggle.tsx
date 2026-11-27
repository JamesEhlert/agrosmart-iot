/**
 * =====================================================================================
 * ARQUIVO: src/shared/theme/ThemeToggle.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-25T06:30:00Z (UTC)
 * VERSÃO: v5.42.0
 * PROPÓSITO: Botão sol/lua do cabeçalho com menu Claro / Escuro / Automático.
 *            Acessível: teclado (Esc fecha), leitor de tela (menuitemradio) e toque.
 * =====================================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeProvider';
import { THEME_LABEL, ThemeMode } from './theme';

const ORDER: ThemeMode[] = ['light', 'dark', 'system'];
const ICON = { light: Sun, dark: Moon, system: Monitor } as const;

interface Props {
  /** 'onDark' = sobre o cabeçalho verde; 'onLight' = sobre fundo claro (página pública). */
  tone?: 'onDark' | 'onLight';
}

export function ThemeToggle({ tone = 'onDark' }: Props) {
  const { mode, resolved, setMode } = useTheme();
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const CurrentIcon = resolved === 'dark' ? Moon : Sun;
  const btn =
    tone === 'onDark'
      ? 'bg-white/10 hover:bg-white/20 border border-white/20 text-white'
      : 'bg-surface hover:bg-sunken border border-line text-ink';

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Tema: ${THEME_LABEL[mode]}. Trocar tema`}
        title={`Tema: ${THEME_LABEL[mode]}`}
        data-testid="theme-toggle"
        className={`inline-flex items-center justify-center w-10 h-10 rounded-xl transition ${btn}`}
      >
        <CurrentIcon className="w-[18px] h-[18px]" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Tema da interface"
          className="absolute right-0 mt-2 w-48 rounded-xl border border-line bg-surface text-ink shadow-xl p-1.5 z-50 anim-pop origin-top-right"
        >
          <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-extrabold uppercase tracking-wider text-ink-muted">Aparência</p>
          {ORDER.map((m) => {
            const Icon = ICON[m];
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  setMode(m);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-semibold transition ${
                  active ? 'bg-brand-tint text-brand-strong' : 'hover:bg-sunken'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="flex-1 text-left">{THEME_LABEL[m]}</span>
                {active && <Check className="w-4 h-4" />}
              </button>
            );
          })}
          {mode === 'system' && (
            <p className="px-2.5 pt-1.5 pb-1 text-xs text-ink-muted">Segue o tema do seu aparelho.</p>
          )}
        </div>
      )}
    </div>
  );
}
