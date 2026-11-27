/**
 * =====================================================================================
 * ARQUIVO: src/shared/ui/Dialog.tsx — v5.47.0 (janela nativa do navegador)
 * Janela modal acessível. Desde a 5.47.0 usa o elemento nativo <dialog> com showModal():
 *   - o resto da página fica INERTE de verdade (leitor de tela e Tab não "vazam" para trás);
 *   - fica na camada de topo (top layer): nada aparece por cima por erro de z-index;
 *   - no celular, o gesto/botão VOLTAR do Android fecha a janela (antes saía da página);
 *   - foco entra na janela, Tab/Shift+Tab circulam dentro dela e o foco volta a quem abriu;
 *   - Esc e clique fora fecham (pode desligar com `dismissible={false}` em ações críticas);
 *   - com janelas empilhadas (ex.: "Descartar alterações?" sobre um formulário), Esc fecha
 *     só a de cima (o teclado é tratado na própria janela, não no documento);
 *   - no celular vira "folha" presa embaixo (bottom sheet), no computador fica centralizada.
 * =====================================================================================
 */
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from './cn';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Para onde o foco vai ao apertar Tab (ou Shift+Tab) no primeiro/último item. Exportado para teste. */
export function trapFocusTarget(index: number, total: number, shift: boolean): number | null {
  if (total === 0) return null;
  if (shift && index <= 0) return total - 1;
  if (!shift && index === total - 1) return 0;
  return null;
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Linha pequena acima do título (categoria), ex.: "Histórico de irrigação e eventos". */
  eyebrow?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  dismissible?: boolean;
  /** v5.46.0: elemento que recebe o foco ao abrir (ex.: campo de busca). Padrão: primeiro focável. */
  initialFocus?: RefObject<HTMLElement | null>;
}

const FIELD = 'input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),select:not([disabled]),textarea:not([disabled])';

function isCoarsePointer(): boolean {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
}

/**
 * v5.47.0: onde o foco começa. No computador, no 1º campo do formulário (já dá para digitar);
 * no celular, no 1º botão (abrir o teclado sozinho cobriria metade da tela). Sem campo: 1º
 * item focável, como antes. Exportado para teste.
 */
export function pickInitialFocus(root: Pick<ParentNode, 'querySelector'> | null, coarse: boolean): HTMLElement | null {
  if (!root) return null;
  if (!coarse) {
    const field = root.querySelector<HTMLElement>(FIELD);
    if (field) return field;
  }
  return root.querySelector<HTMLElement>(FOCUSABLE);
}

/** Abre como modal nativo; navegador antigo sem showModal() recebe só o atributo `open`. Exportado para teste. */
export function openNativeModal(dlg: Pick<HTMLDialogElement, 'open' | 'setAttribute'> & { showModal?: () => void }): 'modal' | 'fallback' | 'already' {
  if (dlg.open) return 'already';
  if (typeof dlg.showModal === 'function') {
    try { dlg.showModal(); return 'modal'; } catch { /* elemento fora do documento: cai no atributo */ }
  }
  dlg.setAttribute('open', '');
  return 'fallback';
}

export function Dialog({ open, onClose, title, eyebrow, description, children, footer, size = 'md', dismissible = true, initialFocus }: DialogProps) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  // onClose e dismissible em ref: se a tela recriar a função a cada render, os efeitos não
  // rodam de novo (o foco não pula para o primeiro botão a cada atualização).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;

  // Abre como modal ANTES da pintura (sem piscar) e guarda quem tinha o foco.
  useLayoutEffect(() => {
    if (!open || !dialogRef.current) return;
    opener.current = document.activeElement;
    openNativeModal(dialogRef.current);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dlg = dialogRef.current;
    if (!dlg) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (initialFocus?.current ?? pickInitialFocus(panel.current, isCoarsePointer()) ?? panel.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc tratado aqui (e não pelo navegador) para fechar só a janela de cima.
        e.preventDefault();
        e.stopPropagation();
        if (dismissRef.current) closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const target = trapFocusTarget(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
      if (target !== null) { e.preventDefault(); items[target].focus(); }
    };
    // "cancel" = pedido de fechar do sistema (voltar do Android, Esc sem foco na janela).
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (dismissRef.current) closeRef.current();
    };
    // Se o navegador fechar à força (ex.: dois "voltar" seguidos numa ação crítica),
    // reabre a janela que não pode ser fechada; as demais avisam a tela que fecharam.
    const onNativeClose = () => {
      if (!dialogRef.current) return;
      if (dismissRef.current) closeRef.current();
      else openNativeModal(dialogRef.current);
    };
    dlg.addEventListener('keydown', onKey);
    dlg.addEventListener('cancel', onCancel);
    dlg.addEventListener('close', onNativeClose);
    return () => {
      dlg.removeEventListener('keydown', onKey);
      dlg.removeEventListener('cancel', onCancel);
      dlg.removeEventListener('close', onNativeClose);
      document.body.style.overflow = prevOverflow;
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  const width = size === 'sm' ? 'sm:max-w-sm' : size === 'lg' ? 'sm:max-w-2xl' : 'sm:max-w-lg';
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      className="fixed inset-0 m-0 p-0 border-0 w-full h-full max-w-none max-h-none bg-transparent text-ink overflow-hidden backdrop:bg-transparent"
      data-testid="dialog-root"
    >
      <div className="absolute inset-0 flex items-end sm:items-center justify-center sm:p-4">
        <div className="absolute inset-0 bg-black/50 motion-safe:animate-[fadeIn_.15s_ease-out]" onClick={dismissible ? onClose : undefined} aria-hidden="true" />
        <div
          ref={panel}
          tabIndex={-1}
          className={cn('relative w-full bg-surface border border-line shadow-2xl outline-none flex flex-col',
            'max-h-[92dvh] rounded-t-3xl sm:rounded-2xl anim-sheet sm:anim-pop', width)}
        >
          <div className="sm:hidden mx-auto mt-2 h-1.5 w-10 rounded-full bg-line" aria-hidden="true" />
          <div className="flex items-start gap-3 px-5 pt-4 pb-3 border-b border-line">
            <div className="min-w-0 flex-1">
              {eyebrow && <p className="text-[11px] font-extrabold uppercase tracking-wider text-brand mb-0.5">{eyebrow}</p>}
              <h2 id={titleId} className="text-base font-extrabold text-ink">{title}</h2>
              {description && <p id={descId} className="mt-0.5 text-xs text-ink-muted">{description}</p>}
            </div>
            {dismissible && (
              <button type="button" onClick={onClose} aria-label="Fechar"
                className="shrink-0 w-11 h-11 sm:w-9 sm:h-9 -mr-2 -mt-1 sm:mt-0 rounded-xl text-ink-muted hover:bg-sunken hover:text-ink flex items-center justify-center">
                <X className="w-5 h-5 sm:w-4 sm:h-4" aria-hidden="true" />
              </button>
            )}
          </div>
          <div className={cn('px-5 py-4 overflow-y-auto overscroll-contain', !footer && 'pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-4')}>{children}</div>
          {footer && <div className="px-5 py-3 border-t border-line flex flex-wrap justify-end gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-3">{footer}</div>}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
