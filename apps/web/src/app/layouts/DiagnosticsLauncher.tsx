/**
 * =====================================================================================
 * ARQUIVO: src/app/layouts/DiagnosticsLauncher.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T20:30:00Z (UTC)
 * VERSÃO: v5.38.0
 * PROPÓSITO: Botão discreto no cabeçalho que abre o "Registro de diagnóstico" num painel
 *            lateral (F1.1). Só para o titular; na Demo aparece apenas com `?diag=1`.
 *            A captura de eventos continua sempre ligada na memória.
 * =====================================================================================
 */

import { useEffect, useState } from 'react';
import { Activity, X } from 'lucide-react';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { DiagnosticsSummary, subscribeWebDiagnostics } from '../../shared/lib/diagnostics';

const DIAG_FLAG_KEY = 'agrosmart.diag';

/** `?diag=1` liga o painel nesta aba (vale até fechar a aba); `?diag=0` desliga. */
export function diagnosticsRequested(): boolean {
  try {
    const flag = new URLSearchParams(window.location.search).get('diag');
    if (flag === '1') window.sessionStorage.setItem(DIAG_FLAG_KEY, '1');
    if (flag === '0') window.sessionStorage.removeItem(DIAG_FLAG_KEY);
    return window.sessionStorage.getItem(DIAG_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/** v5.47.0: abre o painel de qualquer lugar (ex.: folha "Mais" do celular). */
export const OPEN_DIAGNOSTICS_EVENT = 'agrosmart:diagnostics';
export function openDiagnostics(): void {
  window.dispatchEvent(new Event(OPEN_DIAGNOSTICS_EVENT));
}
/** O painel existe para esta conta? (titular sempre; convidado só com ?diag=1). */
export function diagnosticsAvailable(isDemoUser: boolean): boolean {
  return !isDemoUser || diagnosticsRequested();
}

export function DiagnosticsLauncher({ isDemoUser, buttonClassName = '' }: { isDemoUser: boolean; buttonClassName?: string }) {
  const [diagByUrl] = useState<boolean>(() => diagnosticsRequested());
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<DiagnosticsSummary | null>(null);

  useEffect(() => subscribeWebDiagnostics(setSummary), []);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_DIAGNOSTICS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DIAGNOSTICS_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (isDemoUser && !diagByUrl) return null;

  const errors = summary?.counts?.ERROR ?? 0;
  const warns = summary?.counts?.WARN ?? 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Registro de diagnóstico (testes de ponta a ponta)"
        aria-label="Abrir registro de diagnóstico"
        className={`relative inline-flex items-center gap-1.5 p-2 sm:px-3 sm:py-1.5 rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white text-xs font-bold transition ${buttonClassName}`}
      >
        <Activity className="w-4 h-4" />
        <span className="hidden xl:inline">Diagnóstico</span>
        {(errors > 0 || warns > 0) && (
          <span
            className={`absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-extrabold flex items-center justify-center ${
              errors > 0 ? 'bg-[#FF5252] text-white' : 'bg-amber-400 text-[#1C252C]'
            }`}
          >
            {errors > 0 ? errors : warns}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Registro de diagnóstico">
          <button type="button" aria-label="Fechar" className="absolute inset-0 bg-black/40 cursor-default" onClick={() => setOpen(false)} />
          <div className="relative w-full max-w-xl h-full bg-canvas shadow-2xl p-4 overflow-y-auto space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-extrabold text-ink">Ferramentas do titular</p>
                <p className="text-xs text-ink-muted">Registro JSONL em UTC para os testes de ponta a ponta. Não aparece para convidados.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Fechar painel" className="p-2 rounded-lg hover:bg-surface text-ink-muted">
                <X className="w-4 h-4" />
              </button>
            </div>
            <DiagnosticsPanel />
          </div>
        </div>
      )}
    </>
  );
}
