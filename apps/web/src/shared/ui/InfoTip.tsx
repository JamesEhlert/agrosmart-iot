/**
 * =====================================================================================
 * ARQUIVO: src/shared/ui/InfoTip.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T22:30:00Z (UTC)
 * VERSÃO: v5.40.0
 * PROPÓSITO: Ícone ⓘ com explicação curta (WEB-15). Abre ao passar o mouse, ao focar pelo
 *            teclado ou ao tocar (celular); Esc ou toque fora fecham. Não propaga o clique
 *            (funciona dentro de cartões clicáveis). Texto vem do `GLOSSARY`.
 * =====================================================================================
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { GLOSSARY, GlossaryKey } from '../glossary';

interface InfoTipProps {
  k: GlossaryKey;
  /** Alinhamento do balão em relação ao ícone. */
  align?: 'center' | 'left' | 'right';
  className?: string;
}

export function InfoTip({ k, align = 'center', className = '' }: InfoTipProps) {
  const entry = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pos = align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2';

  return (
    <span
      ref={ref}
      className={`relative inline-flex align-middle ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`O que é: ${entry.term}`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => e.stopPropagation()}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-[#78909C] hover:text-brand focus:text-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2E7D32]/40"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`absolute ${pos} bottom-full mb-2 z-50 w-64 max-w-[80vw] rounded-xl bg-[#1C252C] text-white text-xs leading-snug font-medium normal-case tracking-normal text-left px-3 py-2 shadow-xl pointer-events-none`}
        >
          <strong className="block text-[#A5D6A7] mb-0.5">{entry.term}</strong>
          {entry.text}
        </span>
      )}
    </span>
  );
}
