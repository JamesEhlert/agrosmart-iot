/**
 * =====================================================================================
 * ARQUIVO: src/features/events/components/LogMaintenanceModals.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * DATA DE CRIAÇÃO: 2026-11-24 (UTC) — Web v5.36.0
 * PROPÓSITO: Janelas de confirmação da manutenção do histórico (somente titular):
 *            1) excluir os registros selecionados;
 *            2) limpar registros mais antigos que N dias (exige digitar EXCLUIR).
 *            O servidor (regras do Firestore v5.32.0) continua sendo a barreira real.
 * =====================================================================================
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, Eraser, Lock, ShieldCheck, Trash2 } from 'lucide-react';
import { Dialog } from '../../../shared/ui';
import {
  CLEANUP_AGE_OPTIONS,
  CLEANUP_CONFIRM_WORD,
  DeletionSummary,
} from '../model/logFilters';

function ModalFrame(props: {
  titleId: string;
  title: string;
  kicker: string;
  onClose: () => void;
  closeDisabled?: boolean;
  children: ReactNode;
}) {
  // v5.46.0: usa a janela padrão (foco preso, Esc, folha no celular); bloqueada enquanto exclui
  return (
    <Dialog
      open
      onClose={props.onClose}
      dismissible={!props.closeDisabled}
      size="sm"
      eyebrow={<span className="text-danger">{props.kicker}</span>}
      title={props.title}
    >
      {props.children}
    </Dialog>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="h-2 rounded-full bg-sunken overflow-hidden">
        <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs font-semibold text-ink-muted">
        {value} de {max} ({pct}%)
      </p>
    </div>
  );
}

export function SummaryNote({ summary }: { summary: DeletionSummary }) {
  return (
    <div className="p-3.5 rounded-xl bg-brand-soft/40 border border-brand/30 text-xs text-brand-strong space-y-1">
      <p className="font-bold flex items-center gap-1.5">
        <ShieldCheck className="w-4 h-4" /> {summary.deleted} registro(s) excluído(s).
      </p>
      {summary.protectedKept > 0 && (
        <p>{summary.protectedKept} alerta(s) de segurança recente(s) mantido(s) (proteção de 30 dias).</p>
      )}
      {summary.denied > 0 && (
        <p className="text-danger font-semibold">
          {summary.denied} registro(s) recusado(s) pelo servidor e mantido(s).
        </p>
      )}
    </div>
  );
}

export function DeleteSelectedModal(props: {
  count: number;
  protectedCount: number;
  onConfirm: (onProgress: (done: number, total: number) => void) => Promise<DeletionSummary>;
  onClose: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [summary, setSummary] = useState<DeletionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deletable = props.count - props.protectedCount;

  const confirm = async () => {
    setRunning(true);
    setError(null);
    try {
      setSummary(await props.onConfirm((done, total) => setProgress({ done, total })));
    } catch (err: unknown) {
      setError((err as Error)?.message || 'Não foi possível excluir agora. Tente novamente.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <ModalFrame
      titleId="logs-delete-selected-title"
      kicker="Excluir registros"
      title={`Excluir ${props.count} registro(s) selecionado(s)?`}
      onClose={props.onClose}
      closeDisabled={running}
    >
      {summary ? (
        <div className="space-y-4">
          <SummaryNote summary={summary} />
          <button
            type="button"
            onClick={props.onClose}
            className="w-full py-2.5 rounded-xl bg-brand text-white text-sm font-bold hover:bg-brand-strong"
          >
            Concluir
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink">
            Os registros serão removidos do histórico da estação. <strong>Não é possível desfazer.</strong>
          </p>
          {props.protectedCount > 0 && (
            <p className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-warning-strong flex gap-2">
              <Lock className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {props.protectedCount} alerta(s) de segurança com menos de 30 dias ficam mantidos: eles servem de
                prova se alguém usar a sua conta indevidamente.
              </span>
            </p>
          )}
          {running && <ProgressBar value={progress.done} max={progress.total || deletable} />}
          {error && <p className="text-xs font-semibold text-danger">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={props.onClose}
              disabled={running}
              className="flex-1 py-2.5 rounded-xl border border-line text-sm font-bold text-ink-muted hover:bg-sunken disabled:opacity-40"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={running || deletable <= 0}
              className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-danger text-white text-sm font-bold hover:bg-danger-strong disabled:opacity-40"
            >
              <Trash2 className="w-4 h-4" />
              {running ? 'Excluindo…' : `Excluir ${deletable}`}
            </button>
          </div>
        </div>
      )}
    </ModalFrame>
  );
}

export function CleanupOlderModal(props: {
  countOlderThan: (days: number) => Promise<number>;
  onConfirm: (days: number, onProgress: (done: number) => void) => Promise<DeletionSummary>;
  onClose: () => void;
}) {
  const [days, setDays] = useState<number>(30);
  const [count, setCount] = useState<number | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [summary, setSummary] = useState<DeletionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setCount(null);
    setCountError(null);
    props
      .countOlderThan(days)
      .then((n) => alive && setCount(n))
      .catch(() => alive && setCountError('Não foi possível contar os registros agora.'));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const canRun = typed.trim().toUpperCase() === CLEANUP_CONFIRM_WORD && (count ?? 0) > 0 && !running;

  const confirm = async () => {
    setRunning(true);
    setError(null);
    try {
      setSummary(await props.onConfirm(days, setDone));
    } catch (err: unknown) {
      setError((err as Error)?.message || 'A limpeza foi interrompida. Tente novamente.');
    } finally {
      setRunning(false);
    }
  };

  return (
    <ModalFrame
      titleId="logs-cleanup-title"
      kicker="Limpeza do histórico"
      title="Excluir registros antigos"
      onClose={props.onClose}
      closeDisabled={running}
    >
      {summary ? (
        <div className="space-y-4">
          <SummaryNote summary={summary} />
          <button
            type="button"
            onClick={props.onClose}
            className="w-full py-2.5 rounded-xl bg-brand text-white text-sm font-bold hover:bg-brand-strong"
          >
            Concluir
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-xs font-bold text-ink-muted mb-2">Excluir registros com</p>
            <div className="grid grid-cols-3 gap-2">
              {CLEANUP_AGE_OPTIONS.map((opt) => (
                <button
                  key={opt.days}
                  type="button"
                  disabled={running}
                  aria-pressed={days === opt.days}
                  onClick={() => setDays(opt.days)}
                  className={`py-2 rounded-xl text-xs font-bold border transition ${
                    days === opt.days
                      ? 'bg-[#FFEBEE] border-danger text-[#B71C1C]'
                      : 'bg-surface border-line text-ink-muted hover:bg-sunken'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-sunken/70 border border-line text-sm">
            {countError ? (
              <span className="text-danger text-xs font-semibold">{countError}</span>
            ) : count === null ? (
              <span className="text-xs text-ink-muted">Contando registros…</span>
            ) : (
              <span>
                <strong>{count}</strong> registro(s) com {CLEANUP_AGE_OPTIONS.find((o) => o.days === days)?.label}.
              </span>
            )}
          </div>

          <p className="text-xs text-ink-muted flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-warning" />
            <span>
              Não é possível desfazer. Alertas de segurança com menos de 30 dias são sempre mantidos. Comandos e
              confirmações da estação não são apagados (só a linha do tempo).
            </span>
          </p>

          <label className="block">
            <span className="text-xs font-bold text-ink">
              Para confirmar, digite <span className="font-mono text-danger">{CLEANUP_CONFIRM_WORD}</span>
            </span>
            <input
              type="text"
              value={typed}
              disabled={running}
              autoComplete="off"
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1.5 w-full px-3 py-2 rounded-xl border border-line text-sm font-mono focus:outline-none focus:border-danger"
            />
          </label>

          {running && <ProgressBar value={done} max={Math.max(done, count ?? 0)} />}
          {error && <p className="text-xs font-semibold text-danger">{error}</p>}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={props.onClose}
              disabled={running}
              className="flex-1 py-2.5 rounded-xl border border-line text-sm font-bold text-ink-muted hover:bg-sunken disabled:opacity-40"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={!canRun}
              className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-xl bg-danger text-white text-sm font-bold hover:bg-danger-strong disabled:opacity-40"
            >
              <Eraser className="w-4 h-4" />
              {running ? 'Excluindo…' : 'Excluir antigos'}
            </button>
          </div>
        </div>
      )}
    </ModalFrame>
  );
}
