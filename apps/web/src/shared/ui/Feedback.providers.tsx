/**
 * =====================================================================================
 * ARQUIVO: src/shared/ui/Feedback.providers.tsx — v5.46.0 (design system)
 * Dois serviços para o site inteiro:
 *  - useConfirm(): pergunta "tem certeza?" numa janela acessível e devolve uma Promise
 *    (true = confirmou). Substitui o window.confirm do navegador (feio e sem padrão).
 *  - useToast(): aviso flutuante no canto (sucesso, erro, info) que some sozinho e é
 *    lido pelo leitor de tela (aria-live). Erros ficam mais tempo na tela.
 *  v5.47.0: os avisos usam a camada de topo do navegador (atributo `popover`), então
 *    aparecem por cima até de uma janela aberta; o texto para o leitor de tela fica numa
 *    região separada que existe sempre (uma região aria-live que nasce junto com o aviso
 *    costuma não ser lida).
 * =====================================================================================
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { cn } from './cn';

/* ------------------------------ Confirmação ------------------------------ */
export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger = ação destrutiva (botão vermelho); primary = ação comum */
  tone?: 'danger' | 'primary';
}
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmCtx);
  // Fora do provedor (não acontece no site): por segurança, responde "não confirmou".
  return fn ?? (async () => false);
}

/* -------------------------------- Avisos -------------------------------- */
export type ToastTone = 'success' | 'error' | 'info' | 'warning';
export interface ToastItem { id: number; tone: ToastTone; title: string; message?: string }
type ToastFn = (t: Omit<ToastItem, 'id'>) => void;
const ToastCtx = createContext<ToastFn | null>(null);

export function useToast(): ToastFn {
  return useContext(ToastCtx) ?? (() => undefined);
}

/** Quanto tempo cada aviso fica na tela (ms). Exportado para teste. */
export function toastDuration(tone: ToastTone, text: string): number {
  const base = tone === 'error' ? 7000 : tone === 'warning' ? 5500 : 3500;
  return Math.min(base + Math.max(0, text.length - 60) * 40, 12000);
}

/** O navegador tem a camada de topo para avisos (popover)? Exportado para teste. */
export function supportsPopover(el: unknown): el is HTMLElement & { showPopover: () => void; hidePopover: () => void } {
  return !!el && typeof (el as { showPopover?: unknown }).showPopover === 'function';
}

/** Texto lido pelo leitor de tela para um aviso. Exportado para teste. */
export function toastAnnouncement(t: Pick<ToastItem, 'tone' | 'title' | 'message'>): string {
  const prefix = t.tone === 'error' ? 'Erro: ' : t.tone === 'warning' ? 'Atenção: ' : '';
  return `${prefix}${t.title}${t.message ? `. ${t.message}` : ''}`;
}

const TOAST_STYLE: Record<ToastTone, { Icon: typeof Info; cls: string }> = {
  success: { Icon: CheckCircle2, cls: 'text-brand' },
  error: { Icon: XCircle, cls: 'text-danger' },
  warning: { Icon: AlertTriangle, cls: 'text-warning' },
  info: { Icon: Info, cls: 'text-info' },
};

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const cancelRef = useRef<HTMLButtonElement>(null); // foco começa em "Cancelar" (escolha segura)

  const confirm = useCallback<ConfirmFn>((opts) => new Promise<boolean>((resolve) => setConfirmState({ ...opts, resolve })), []);
  const close = (v: boolean) => { confirmState?.resolve(v); setConfirmState(null); };

  const dismiss = useCallback((id: number) => setToasts((l) => l.filter((t) => t.id !== id)), []);
  const toast = useCallback<ToastFn>((t) => {
    const id = ++seq.current;
    setToasts((l) => [...l.slice(-3), { ...t, id }]); // no máximo 4 ao mesmo tempo
    window.setTimeout(() => dismiss(id), toastDuration(t.tone, `${t.title} ${t.message ?? ''}`));
  }, [dismiss]);

  const toastValue = useMemo(() => toast, [toast]);

  // Camada de topo: mostra o contêiner quando há aviso e o "levanta" a cada aviso novo
  // (assim fica acima de uma janela aberta depois dele).
  const stackRef = useRef<HTMLDivElement>(null);
  const lastId = toasts.length ? toasts[toasts.length - 1].id : 0;
  useEffect(() => {
    const el = stackRef.current;
    if (!supportsPopover(el)) return;
    if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
    try {
      if (el.matches(':popover-open')) el.hidePopover();
      if (toasts.length) el.showPopover();
    } catch { /* navegador sem suporte completo: fica como camada comum */ }
  }, [lastId, toasts.length]);
  const latest = toasts.length ? toastAnnouncement(toasts[toasts.length - 1]) : '';

  return (
    <ConfirmCtx.Provider value={confirm}>
      <ToastCtx.Provider value={toastValue}>
        {children}
        <Dialog
          open={!!confirmState}
          onClose={() => close(false)}
          size="sm"
          initialFocus={cancelRef}
          title={confirmState?.title ?? ''}
          footer={confirmState && (
            <>
              <Button ref={cancelRef} variant="ghost" onClick={() => close(false)}>{confirmState.cancelLabel ?? 'Cancelar'}</Button>
              <Button variant={confirmState.tone === 'danger' ? 'danger' : 'primary'} onClick={() => close(true)} data-testid="confirm-ok">
                {confirmState.confirmLabel ?? 'Confirmar'}
              </Button>
            </>
          )}
        >
          {confirmState?.message && <div className="text-sm text-ink leading-relaxed">{confirmState.message}</div>}
        </Dialog>
        <div className="sr-only" aria-live="polite" role="status" data-testid="toast-live">{latest}</div>
        <div ref={stackRef} className="fixed inset-auto w-auto h-auto m-0 p-0 border-0 bg-transparent overflow-visible z-[80] bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:bottom-6 right-4 left-4 sm:left-auto sm:w-[360px] flex flex-col gap-2 pointer-events-none" data-testid="toast-stack" data-toast-stack="">
          {toasts.map((t) => {
            const { Icon, cls } = TOAST_STYLE[t.tone];
            return (
              <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-surface shadow-xl px-4 py-3 anim-pop" data-testid="toast">
                <Icon className={cn('w-5 h-5 shrink-0 mt-0.5', cls)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-ink">{t.title}</p>
                  {t.message && <p className="text-xs text-ink-muted mt-0.5 leading-relaxed">{t.message}</p>}
                </div>
                <button type="button" onClick={() => dismiss(t.id)} aria-label="Fechar aviso" className="shrink-0 -mr-1.5 -mt-1 w-9 h-9 rounded-lg text-ink-muted hover:bg-sunken flex items-center justify-center">
                  <X className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      </ToastCtx.Provider>
    </ConfirmCtx.Provider>
  );
}
