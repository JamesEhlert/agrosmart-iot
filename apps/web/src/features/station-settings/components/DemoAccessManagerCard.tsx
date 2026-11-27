/**
 * =====================================================================================
 * ARQUIVO: src/features/station-settings/components/DemoAccessManagerCard.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1C — Rotulo Brasilia + Revogar)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T19:03:00Z (UTC)
 * VERSÃO: v5.31.0 (Rotulo Puro Brasilia HH:MM:SS + Botao Revogar Visivel no Bloqueio)
 * PROPÓSITO: Painel exclusivo do proprietário para gerar ou revogar passes temporários
 *            de Uso Único (`AGRO-XXXX-XXXX`) via backend AWS (`SendCommand`), exibindo
 *            apenas o resumo não-sensível (`device.demoSummary`).
 * CHANGELOG:
 * - v5.31.0:
 *   * Exporta função pura `formatDemoLockUntilBrasilia(lockedUntilEpoch)` retornando
 *     `"Bloqueado até HH:MM:SS (Brasília)"` durante o lockout, no lugar de `0/30`.
 *   * Mantém o botão de revogação (`Revogar Acesso`) visível e habilitado durante o
 *     bloqueio temporário.
 * - v5.30.0: Lockout temporário com auto-desbloqueio, contador `/30` e preset 24 h.
 * =====================================================================================
 */

import { useEffect, useState } from 'react';
import {
  KeyRound,
  Clock,
  Copy,
  Check,
  ShieldOff,
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
} from 'lucide-react';
import {
  DeviceModel,
  MAX_DEMO_FAILED_ATTEMPTS,
} from '../../devices/model/device.types';
import {
  generateDemoPassOnServer,
  revokeDemoPassOnServer,
} from '../../irrigation/api/commandApi';
import { useConfirm, useToast } from '../../../shared/ui/Feedback.providers';

interface DemoAccessManagerCardProps {
  device: DeviceModel;
}

const DURATION_PRESETS = [
  { minutes: 30, label: '30 Minutos (Teste Rápido)' },
  { minutes: 60, label: '1 Hora (Teste Completo)' },
  { minutes: 120, label: '2 Horas (Sessão Estendida)' },
  { minutes: 1440, label: '24 Horas (Acesso Diário)' },
] as const;

const LOCK_COUNTDOWN_REFRESH_MS = 30_000;
const BRASILIA_OFFSET_SEC = -3 * 3600;

/**
 * Formata o carimbo `lockedUntilEpoch` (epoch em segundos UTC) como
 * `"Bloqueado até HH:MM:SS (Brasília)"` de forma pura e determinística.
 */
export function formatDemoLockUntilBrasilia(lockedUntilEpoch: number): string {
  if (
    typeof lockedUntilEpoch !== 'number' ||
    !Number.isFinite(lockedUntilEpoch) ||
    lockedUntilEpoch <= 0
  ) {
    return 'Bloqueado temporariamente (Brasília)';
  }

  const utcDate = new Date(Math.trunc(lockedUntilEpoch) * 1000);
  try {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(utcDate);

    const hh = parts.find((p) => p.type === 'hour')?.value;
    const mm = parts.find((p) => p.type === 'minute')?.value;
    const ss = parts.find((p) => p.type === 'second')?.value;
    if (hh && mm && ss) {
      return `Bloqueado até ${hh}:${mm}:${ss} (Brasília)`;
    }
  } catch {
    // Fallback determinístico UTC-3 caso o runtime não disponha de dados ICU
  }

  const shifted = new Date((Math.trunc(lockedUntilEpoch) + BRASILIA_OFFSET_SEC) * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  const ss = String(shifted.getUTCSeconds()).padStart(2, '0');
  return `Bloqueado até ${hh}:${mm}:${ss} (Brasília)`;
}

function formatLockCountdown(remainingSec: number): string {
  const safeSec = Math.max(0, Math.ceil(remainingSec));
  const mins = Math.floor(safeSec / 60);
  const secs = safeSec % 60;
  if (mins > 0) {
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  return `${secs}s`;
}

export function DemoAccessManagerCard({ device }: DemoAccessManagerCardProps) {
  const [selectedMinutes, setSelectedMinutes] = useState<number>(60);
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const confirm = useConfirm();
  const toast = useToast();
  const [remainingLabel, setRemainingLabel] = useState<string>('Desativado');
  const [isPassActive, setIsPassActive] = useState<boolean>(false);
  const [lockNowMs, setLockNowMs] = useState<number>(() => Date.now());

  // Mantém o código em texto puro SOMENTE na memória RAM desta aba do proprietário
  const [ephemeralPlainCode, setEphemeralPlainCode] = useState<string | null>(null);

  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const summary = device.demoSummary;
  const isSummaryActive = summary.active;
  const tokenHint = summary.tokenHint;
  const tokenHashPrefix = summary.tokenHashPrefix;
  const expiresEpoch = summary.expiresEpoch;
  const isClaimed = summary.passClaimed;
  const failedAttempts = summary.failedAttempts;
  const lockedUntilEpoch = summary.lockedUntilEpoch;

  const isLockedByBruteForce =
    lockedUntilEpoch > 0
      ? lockedUntilEpoch * 1000 > lockNowMs
      : summary.lockedBruteForce;

  const lockedBrasiliaLabel =
    lockedUntilEpoch > 0 ? formatDemoLockUntilBrasilia(lockedUntilEpoch) : null;
  const lockRemainingSec =
    lockedUntilEpoch > 0
      ? Math.max(0, Math.ceil((lockedUntilEpoch * 1000 - lockNowMs) / 1000))
      : 0;

  useEffect(() => {
    setEphemeralPlainCode(null);
  }, [device.id]);

  // Atualiza a contagem regressiva do bloqueio a cada 30 s e agenda a liberação exata
  useEffect(() => {
    const nowMs = Date.now();
    setLockNowMs(nowMs);
    if (lockedUntilEpoch <= 0) return;

    const remainingMs = lockedUntilEpoch * 1000 - nowMs;
    if (remainingMs <= 0) return;

    const intervalId = window.setInterval(() => {
      setLockNowMs(Date.now());
    }, LOCK_COUNTDOWN_REFRESH_MS);

    const expiryTimeoutId = window.setTimeout(() => {
      setLockNowMs(Date.now());
    }, remainingMs + 250);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(expiryTimeoutId);
    };
  }, [lockedUntilEpoch]);

  useEffect(() => {
    if (isLockedByBruteForce) {
      setIsPassActive(false);
      if (lockedBrasiliaLabel) {
        setRemainingLabel(lockedBrasiliaLabel);
      } else {
        setRemainingLabel('BLOQUEADO (Anti-Força Bruta)');
      }
      return;
    }

    const updateCountdown = () => {
      if (!isSummaryActive || !expiresEpoch) {
        setIsPassActive(false);
        setRemainingLabel('Nenhum passe ativo no momento');
        return;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const diffSec = expiresEpoch - nowSec;
      if (diffSec <= 0) {
        setIsPassActive(false);
        setRemainingLabel('Expirado (Acesso bloqueado)');
        return;
      }
      setIsPassActive(true);
      const hours = Math.floor(diffSec / 3600);
      const mins = Math.floor((diffSec % 3600) / 60);
      const secs = diffSec % 60;
      const prefix = isClaimed ? 'Em Uso (Sessão Ativa)' : 'Disponível (1º Acesso)';
      if (hours > 0) {
        setRemainingLabel(`${prefix} • Expira em ${hours}h ${mins}m`);
      } else {
        setRemainingLabel(`${prefix} • Expira em ${mins}m ${secs}s`);
      }
    };

    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [
    isSummaryActive,
    expiresEpoch,
    isClaimed,
    isLockedByBruteForce,
    lockedBrasiliaLabel,
  ]);

  const handleGenerateNewPass = async () => {
    // v5.46.0: se já existe convidado ativo, gerar outro derruba o atual — perguntar antes
    if (isPassActive) {
      const ok = await confirm({
        title: 'Encerrar o passe atual e gerar outro?',
        message: 'Quem estiver usando o código atual perde o acesso na hora. As agendas criadas pelo convidado são pausadas.',
        confirmLabel: 'Gerar novo código',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setFeedback(null);
    setIsUpdating(true);
    try {
      const res = await generateDemoPassOnServer({
        deviceId: device.id,
        durationMinutes: selectedMinutes,
      });

      setEphemeralPlainCode(res.plainCode);
      const pausedSuffix =
        res.oldDemoSchedulesPaused > 0
          ? ` ${res.oldDemoSchedulesPaused} agenda(s) demo anterior(es) foram pausadas.`
          : '';
      setFeedback({
        type: 'success',
        message: `Passe "${res.plainCode}" gerado no servidor! O hash SHA-256 foi isolado em private/demo_auth (inacessível a clientes). Copie o código agora para enviar ao avaliador.${pausedSuffix}`,
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: (err as Error)?.message || 'Falha ao gerar passe temporário no servidor.',
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRevokePass = async () => {
    // v5.46.0: revogar é imediato e não tem volta (o código deixa de valer)
    const ok = await confirm({
      title: 'Revogar o acesso do convidado?',
      message: 'O código deixa de valer na hora e a sessão do convidado é encerrada. Para dar acesso de novo, gere outro passe.',
      confirmLabel: 'Revogar acesso',
      tone: 'danger',
    });
    if (!ok) return;
    setFeedback(null);
    setIsUpdating(true);
    try {
      const res = await revokeDemoPassOnServer({
        deviceId: device.id,
      });
      setEphemeralPlainCode(null);
      const pausedSuffix =
        res.oldDemoSchedulesPaused > 0
          ? ` ${res.oldDemoSchedulesPaused} agenda(s) demo foram pausadas.`
          : '';
      setFeedback({
        type: 'success',
        message: `Acesso de Usuário Teste revogado imediatamente no servidor!${pausedSuffix}`,
      });
    } catch (err: unknown) {
      setFeedback({
        type: 'error',
        message: (err as Error)?.message || 'Falha ao revogar passe no servidor.',
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleCopyInvite = async () => {
    if (!ephemeralPlainCode || isLockedByBruteForce) return;
    const url = `${window.location.origin}/login?device=${encodeURIComponent(device.id)}`;
    const text = `🌱 AgroSmart Precision IoT V5 — Acesso de Usuário Teste\n🔗 Link: ${url}\n🔑 Código de Uso Único: ${ephemeralPlainCode}\n📟 Estação: ${device.id}\n(Na tela de login, selecione a aba "Usuário Teste" e digite o código acima).`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
      toast({ tone: 'success', title: 'Convite copiado', message: 'Cole no WhatsApp ou e-mail do avaliador.' });
    } catch {
      // Ignora se a área de transferência não estiver disponível
    }
  };

  return (
    <div className="bg-surface rounded-2xl border-2 border-brand/30 p-6 shadow-sm space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-brand-soft/70 text-brand-strong">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <span className="text-[11px] font-extrabold uppercase tracking-wider text-brand block">
              Exclusivo do Proprietário • Zero-Credential Server-Side (SHA-256)
            </span>
            <h2 className="text-base font-extrabold text-ink">
              Gerador de Passe de Uso Único — Modo Usuário Teste
            </h2>
            <p className="text-xs text-ink-muted">
              Gera o token no backend AWS (<code>AGRO-XXXX-XXXX</code>), isola o hash e a sessão em <code>private/demo_auth</code> e serve uma projeção sanitizada para a Demo
            </p>
          </div>
        </div>

        <span
          className={`px-3 py-1 rounded-full text-xs font-extrabold flex items-center gap-1.5 ${
            isLockedByBruteForce
              ? 'bg-red-100 text-danger'
              : isPassActive
                ? 'bg-emerald-100 text-brand-strong'
                : 'bg-slate-200 text-ink-muted'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>{remainingLabel}</span>
        </span>
      </div>

      {/* Exibição do Passe Ativo */}
      {isPassActive && !isLockedByBruteForce ? (
        <div className="p-4 rounded-2xl bg-gradient-to-r from-brand-strong to-brand text-white flex flex-wrap items-center justify-between gap-4 shadow-sm">
          <div className="space-y-1">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-200 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>
                {isClaimed
                  ? 'Passe Resgatado — Sessão de Usuário Teste em Andamento (Uso Único Consumido)'
                  : ephemeralPlainCode
                    ? 'Código Gerado (Visível apenas agora — Copie antes de sair desta tela)'
                    : 'Passe Ativo no Servidor (Isolado em private/demo_auth)'}
              </span>
            </span>
            <span className="text-2xl sm:text-3xl font-mono font-extrabold tracking-widest block">
              {!isClaimed && ephemeralPlainCode
                ? ephemeralPlainCode
                : tokenHint || 'AGRO-****-****'}
            </span>
            <span className="text-xs text-emerald-100/90 block font-mono">
              SHA-256: {tokenHashPrefix ? `${tokenHashPrefix}...` : 'isolado no backend'} • Tentativas inválidas:{' '}
              {failedAttempts}/{MAX_DEMO_FAILED_ATTEMPTS}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!isClaimed && ephemeralPlainCode && (
              <button
                type="button"
                onClick={handleCopyInvite}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-surface text-brand-strong hover:bg-emerald-50 text-xs font-extrabold shadow-sm transition"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'Convite Copiado!' : 'Copiar Link + Código'}</span>
              </button>
            )}

            <button
              type="button"
              disabled={isUpdating}
              onClick={handleRevokePass}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-extrabold shadow-sm transition disabled:opacity-50"
            >
              <ShieldOff className="w-4 h-4" />
              <span>Encerrar Acesso Agora</span>
            </button>
          </div>
        </div>
      ) : (
        <div
          className={`p-4 rounded-xl border text-xs ${
            isLockedByBruteForce
              ? 'bg-red-50 border-red-200 text-danger font-semibold flex flex-wrap items-center justify-between gap-4'
              : 'bg-sunken/70 border-line text-ink-muted'
          }`}
        >
          {isLockedByBruteForce ? (
            <>
              <div className="space-y-1 flex-1 min-w-[220px]">
                <span className="block">
                  <strong>Alerta de Segurança:</strong>{' '}
                  <strong>{lockedBrasiliaLabel || 'Bloqueado temporariamente (Brasília)'}</strong>
                  {lockRemainingSec > 0 ? ` (restam ${formatLockCountdown(lockRemainingSec)})` : ''}.
                </span>
                <span className="block font-normal text-[#991B1B]">
                  O passe continua preservado e voltará automaticamente ao normal após o prazo — ou
                  use os controles para revogar imediatamente ou gerar um novo código.
                </span>
              </div>

              <button
                type="button"
                disabled={isUpdating}
                onClick={handleRevokePass}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-extrabold shadow-sm transition disabled:opacity-50 shrink-0"
              >
                <ShieldOff className="w-4 h-4" />
                <span>Revogar Acesso</span>
              </button>
            </>
          ) : (
            <span>
              No momento, <strong>nenhum Usuário Teste</strong> possui acesso ativo. Escolha a
              duração abaixo e clique em <strong>Gerar Novo Passe Temporário</strong> quando quiser
              liberar um login único protegido no servidor.
            </span>
          )}
        </div>
      )}

      {/* Seletor de Validade e Botão Gerador */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2 flex-1 min-w-[240px]">
          <span className="block text-xs font-bold text-ink">
            Duração do Acesso de Teste:
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {DURATION_PRESETS.map((item) => {
              const active = selectedMinutes === item.minutes;
              return (
                <button
                  key={item.minutes}
                  type="button"
                  onClick={() => setSelectedMinutes(item.minutes)}
                  className={`p-2.5 rounded-xl border text-left text-xs font-bold transition ${
                    active
                      ? 'bg-brand-soft/50 border-brand text-brand-strong'
                      : 'bg-surface border-line text-ink-muted hover:text-ink'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          disabled={isUpdating}
          onClick={handleGenerateNewPass}
          className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-brand hover:bg-brand-strong text-white text-xs font-extrabold shadow-sm transition disabled:opacity-50"
        >
          {isUpdating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
          <span>
            {isPassActive
              ? 'Gerar novo código (encerra o atual)'
              : 'Gerar novo passe temporário'}
          </span>
        </button>
      </div>

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className={`p-3.5 rounded-xl border flex items-center gap-2.5 text-xs font-semibold ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-brand'
              : 'bg-red-50 border-red-200 text-danger'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}
    </div>
  );
}
