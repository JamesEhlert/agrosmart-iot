/**
 * =====================================================================================
 * ARQUIVO: src/app/layouts/DiagnosticsPanel.tsx
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-23 (UTC) — Fase 4.0-B
 * PROPOSITO: Painel do registro de diagnostico (rodape): sessao automatica, contagem por
 *            nivel, rotulo opcional do teste, download com nome unico e "Novo teste"
 *            com confirmacao em 2 passos (sem janelas de alerta do navegador).
 * =====================================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { Activity, Download, RotateCcw, Tag } from 'lucide-react';
import {
  type DiagnosticsSummary,
  clearWebDiagnostics,
  downloadWebDiagnosticsJsonl,
  getTestLabel,
  setTestLabel,
  subscribeWebDiagnostics,
} from '../../shared/lib/diagnostics';
import { APP_VERSION_LABEL } from '../../shared/config/appInfo';

function hhmmLocal(iso: string | null): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '--:--'
    : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function hhmmUtc(iso: string | null): string {
  return iso ? iso.slice(11, 19) : '--:--:--';
}

export function DiagnosticsPanel() {
  const [summary, setSummary] = useState<DiagnosticsSummary | null>(null);
  const [labelDraft, setLabelDraft] = useState<string>(() => getTestLabel());
  const [confirmReset, setConfirmReset] = useState(false);
  const [lastFile, setLastFile] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => subscribeWebDiagnostics(setSummary), []);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const applyLabel = () => {
    const clean = setTestLabel(labelDraft);
    setLabelDraft(clean);
  };

  const handleDownload = () => {
    applyLabel();
    setLastFile(downloadWebDiagnosticsJsonl());
  };

  const handleReset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      resetTimer.current = setTimeout(() => setConfirmReset(false), 4000);
      return;
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setConfirmReset(false);
    setLastFile(null);
    clearWebDiagnostics();
  };

  const counts = summary?.counts ?? { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };

  return (
    <section
      aria-label="Registro de diagnóstico"
      className="rounded-2xl bg-slate-900 text-slate-100 border border-slate-700 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="p-1.5 rounded-lg bg-emerald-500/15 text-emerald-300">
            <Activity className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-extrabold tracking-wide text-white">Registro de diagnóstico</p>
            <p className="text-xs text-slate-400 truncate">
              Sessão <span className="font-mono text-slate-200">{summary?.sessionId ?? '…'}</span> · desde{' '}
              {hhmmLocal(summary?.sessionStartedUtc ?? null)} ({hhmmUtc(summary?.sessionStartedUtc ?? null)} UTC) · Web{' '}
              {APP_VERSION_LABEL}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs font-bold">
          <span className="px-2 py-0.5 rounded-md bg-slate-800 text-slate-200 font-mono">{summary?.total ?? 0} eventos</span>
          <span className="px-2 py-0.5 rounded-md bg-sky-500/15 text-sky-300 font-mono">INFO {counts.INFO}</span>
          <span
            className={`px-2 py-0.5 rounded-md font-mono ${counts.WARN > 0 ? 'bg-amber-500/20 text-amber-300' : 'bg-slate-800 text-slate-400'}`}
          >
            AVISO {counts.WARN}
          </span>
          <span
            className={`px-2 py-0.5 rounded-md font-mono ${counts.ERROR > 0 ? 'bg-red-500/20 text-red-300' : 'bg-slate-800 text-slate-400'}`}
          >
            ERRO {counts.ERROR}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <label className="flex items-center gap-2 text-xs text-slate-400">
          <Tag className="w-3.5 h-3.5" />
          <span className="font-semibold">Rótulo do teste (opcional)</span>
          <input
            type="text"
            value={labelDraft}
            maxLength={32}
            placeholder="ex.: teste-velocidade"
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={applyLabel}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyLabel();
            }}
            className="px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-600 text-xs font-mono text-white placeholder:text-slate-500 w-44 focus:outline-none focus:border-emerald-400"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500 hidden md:inline">
            Último evento: <span className="font-mono text-slate-300">{summary?.lastEventName ?? '—'}</span>{' '}
            ({hhmmUtc(summary?.lastEventUtc ?? null)} UTC)
          </span>
          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-extrabold transition"
          >
            <Download className="w-3.5 h-3.5" />
            <span>Baixar registro (.jsonl)</span>
          </button>
          <button
            type="button"
            onClick={handleReset}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
              confirmReset
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
            }`}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{confirmReset ? 'Confirmar: apagar e iniciar novo teste' : 'Novo teste'}</span>
          </button>
        </div>
      </div>

      {lastFile && (
        <p className="px-4 pb-3 -mt-1 text-xs text-emerald-300">
          Arquivo salvo: <span className="font-mono">{lastFile}</span>
        </p>
      )}
    </section>
  );
}
