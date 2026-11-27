// ACK web correction v1: correlated server result; unknown outcome is preserved.
/**
 * =====================================================================================
 * ARQUIVO: src/features/irrigation/components/ValveControlCard.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca / UX
 * DATA DE ATUALIZAÇÃO: 2026-11-23T22:00:00Z (UTC)
 * VERSÃO: v5.34.0 (Fase 4.0-C — botão minimalista)
 * PROPÓSITO: Card de controle manual e parada da válvula solenoide.
 * CHANGELOG:
 * - v5.34.0 (Fase 4.0-C):
 *   * O BOTÃO passa a ser o indicador de estado (azul iniciar, vermelho parar, grafite
 *     aguardando confirmação, âmbar não confirmado, cinza indisponível), com altura fixa.
 *   * Um único texto durante toda a espera do ACK (sem cronômetro, barra nem ID na tela;
 *     esses dados continuam no registro de diagnóstico).
 *   * Pausa de 1 s após o ACK silenciosa (sem "Pronto em 1s").
 *   * O card não muda de tamanho: seletor de tempo sempre visível (desabilitado durante a
 *     rega) e uma única linha de status de altura fixa no lugar das caixas coloridas.
 *   * Linha de status mostra o último comando confirmado, com horário e latência do ACK.
 *   * Regras visuais isoladas em valveControlView.ts (testes WEB-4C-*).
 * - v5.33.0 (Fase 4.0-B): botão guiado pelo ACK.
 * - v5.30.0: teto de 5 min por acionamento na sessão Demo; parada sempre disponível.
 * =====================================================================================
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  CheckCircle2,
  Clock,
  Droplets,
  Info,
  Loader2,
  Lock,
  Square,
  Timer,
  TriangleAlert,
} from 'lucide-react';
import { useAuth } from '../../auth/hooks/useAuth';
import { DeviceModel } from '../../devices/model/device.types';
import { updateDeviceOperationalSettings } from '../../devices/api/deviceRepository';
import {
  DEMO_MAX_MANUAL_MINUTES,
  OWNER_MAX_MANUAL_MINUTES,
  resolveManualValveMinutes,
  useValveControl,
} from '../hooks/useValveControl';
import {
  LastConfirmation,
  ValveButtonIcon,
  ValveButtonTone,
  ValveStatusTone,
  resolveValveButtonView,
  resolveValveStatusLine,
} from './valveControlView';
import { InfoTip } from '../../../shared/ui/InfoTip';

interface ValveControlCardProps {
  device: DeviceModel;
  onTelemetryRefreshRequested: () => void;
}

const BUTTON_TONE_CLASS: Record<ValveButtonTone, string> = {
  start: 'bg-info enabled:hover:bg-info-strong',
  stop: 'bg-danger enabled:hover:bg-danger-strong',
  busy: 'bg-[#455A64] cursor-progress',
  warning: 'bg-[#EF6C00] enabled:hover:bg-[#E65100]',
  locked: 'bg-[#90A4AE]',
  cooldown: 'bg-[#78909C]',
};

const STATUS_TONE_CLASS: Record<ValveStatusTone, string> = {
  neutral: 'text-ink-muted',
  success: 'text-brand',
  warning: 'text-warning',
  error: 'text-danger',
};

function ButtonIcon({ icon }: { icon: ValveButtonIcon }) {
  const cls = 'w-5 h-5 shrink-0';
  switch (icon) {
    case 'droplets':
      return <Droplets className={cls} aria-hidden />;
    case 'stop':
      return <Square className={`${cls} fill-current`} aria-hidden />;
    case 'spinner':
      return <Loader2 className={`${cls} animate-spin`} aria-hidden />;
    case 'alert':
      return <TriangleAlert className={cls} aria-hidden />;
    case 'lock':
      return <Lock className={cls} aria-hidden />;
    case 'timer':
      return <Timer className={cls} aria-hidden />;
  }
}

function StatusIcon({ tone }: { tone: ValveStatusTone }) {
  const cls = 'w-3.5 h-3.5 shrink-0 mt-[3px]';
  if (tone === 'success') return <CheckCircle2 className={cls} aria-hidden />;
  if (tone === 'neutral') return <Info className={cls} aria-hidden />;
  return <TriangleAlert className={cls} aria-hidden />;
}

export function ValveControlCard({
  device,
  onTelemetryRefreshRequested,
}: ValveControlCardProps) {
  const { isDemoUser } = useAuth();
  const {
    phase,
    isValveOpen,
    cooldownSec,
    confirmationUncertain,
    isValvePending,
    feedback,
    remainingText,
    triggerValveToggle,
    requestValveStop,
  } = useValveControl(device, onTelemetryRefreshRequested);

  const [selectedMinutes, setSelectedMinutes] = useState<number>(() =>
    resolveManualValveMinutes(undefined, device.settings.manualDuration, isDemoUser),
  );
  const [durationSaveNotice, setDurationSaveNotice] = useState<string | null>(null);
  const [lastConfirmation, setLastConfirmation] = useState<LastConfirmation | null>(null);
  const clickRef = useRef<{ action: LastConfirmation['action']; t0: number } | null>(null);
  const cooldownStartRef = useRef<number>(0);

  useEffect(() => {
    setSelectedMinutes(
      resolveManualValveMinutes(undefined, device.settings.manualDuration, isDemoUser),
    );
    setDurationSaveNotice(null);
  }, [device.id, device.settings.manualDuration, isDemoUser]);

  useEffect(() => {
    setLastConfirmation(null);
    clickRef.current = null;
  }, [device.id]);

  // Guarda o valor inicial de cada pausa (1 s = silenciosa; 60 s = mostra contagem).
  if (cooldownSec <= 0) cooldownStartRef.current = 0;
  else if (cooldownSec > cooldownStartRef.current) cooldownStartRef.current = cooldownSec;

  const isBusy = phase !== 'idle';

  // Ao terminar a espera com ACK de sucesso, registra horário e latência (clique -> ACK).
  useEffect(() => {
    if (phase !== 'idle' || !clickRef.current || !feedback) return;
    const click = clickRef.current;
    clickRef.current = null;
    if (feedback.type === 'success') {
      setLastConfirmation({
        action: click.action,
        atMs: Date.now(),
        latencyMs: Math.round(performance.now() - click.t0),
      });
    }
  }, [phase, feedback]);

  const quickOptions = useMemo(() => {
    const maxMins = isDemoUser ? DEMO_MAX_MANUAL_MINUTES : OWNER_MAX_MANUAL_MINUTES;
    const base = isDemoUser ? [1, 3, 5] : [1, 3, 5, 10, 15];
    if (!base.includes(selectedMinutes) && selectedMinutes >= 1 && selectedMinutes <= maxMins) {
      return [...base, selectedMinutes].sort((a, b) => a - b);
    }
    return base;
  }, [selectedMinutes, isDemoUser]);

  const otaActive = device.otaStatus.inProgress || device.otaStatus.awaitingReboot;
  const isLockedBySchedule = isValveOpen && device.state.valveOrigin === 'schedule';
  const selectorInactive = isValveOpen || isValvePending;

  const view = resolveValveButtonView({
    isBusy,
    isOnline: device.isOnline,
    otaActive,
    confirmationUncertain,
    isValveOpen,
    isValvePending,
    isLockedBySchedule,
    cooldownSec,
    cooldownStartSec: cooldownStartRef.current,
    selectedMinutes,
    remainingText,
  });

  const status = resolveValveStatusLine({
    isBusy,
    isOnline: device.isOnline,
    otaActive,
    confirmationUncertain,
    feedback,
    lastConfirmation,
  });

  const handleMainClick = () => {
    if (view.disabled || view.action === 'none') return;
    clickRef.current = { action: view.action === 'stop' ? 'parar' : 'ligar', t0: performance.now() };
    if (view.action === 'stop') requestValveStop();
    else triggerValveToggle(selectedMinutes);
  };

  const handleQuickMinutesChange = async (mins: number) => {
    const effectiveMins = resolveManualValveMinutes(mins, mins, isDemoUser);
    setSelectedMinutes(effectiveMins);
    setDurationSaveNotice(null);
    if (isDemoUser) return;
    try {
      await updateDeviceOperationalSettings(device.id, { manualDuration: effectiveMins });
    } catch {
      setDurationSaveNotice(
        `Tempo de ${effectiveMins} min selecionado para o próximo disparo (não foi possível salvar como padrão no Firestore).`,
      );
    }
  };

  // Durante a espera o registro antecipado já marca 'incerto': a etiqueta só reflete isso
  // depois que a espera termina (senão piscaria "Estado não confirmado" a cada clique).
  const pill = confirmationUncertain && !isBusy
    ? { text: 'Estado não confirmado', cls: 'bg-amber-50 text-warning', dot: 'bg-[#EF6C00]' }
    : isValveOpen
      ? { text: isLockedBySchedule ? 'Irrigando (agenda)' : 'Irrigando', cls: 'bg-blue-50 text-info', dot: 'bg-info animate-pulse' }
      : isValvePending
        ? { text: 'Reserva pendente', cls: 'bg-sunken text-ink-muted', dot: 'bg-[#90A4AE]' }
        : { text: 'Válvula desligada', cls: 'bg-sunken text-ink-muted', dot: 'bg-[#90A4AE]' };

  return (
    <div>
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted inline-flex items-center gap-1.5">
          Controle de irrigação <InfoTip k="ack" align="left" />
        </h2>
        <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full ${pill.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${pill.dot}`} aria-hidden />
          {pill.text}
        </span>
      </div>

      <div className="bg-surface rounded-2xl border border-line p-5 shadow-sm space-y-3">
        {/* Seletor de duração: sempre visível (o card não muda de tamanho). */}
        <div
          className={`flex flex-wrap items-center justify-between gap-3 bg-[#EEF2F5]/70 p-3 rounded-xl border border-[#E0E6ED] transition-opacity duration-300 ${
            selectorInactive ? 'opacity-50' : ''
          }`}
        >
          <div className="flex items-center gap-2 text-xs font-semibold text-ink">
            <Clock className="w-4 h-4 text-brand" aria-hidden />
            <span>Tempo de rega manual</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {quickOptions.map((m) => (
              <button
                key={m}
                type="button"
                disabled={isBusy || selectorInactive || cooldownSec > 0}
                aria-pressed={selectedMinutes === m}
                onClick={() => handleQuickMinutesChange(m)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold transition disabled:cursor-not-allowed ${
                  selectedMinutes === m
                    ? 'bg-brand text-white shadow-sm'
                    : 'bg-surface text-ink-muted border border-line enabled:hover:text-ink'
                }`}
              >
                {m} min
              </button>
            ))}
          </div>
        </div>

        {(isDemoUser || durationSaveNotice) && (
          <p className={`text-xs font-medium px-1 ${durationSaveNotice ? 'text-warning' : 'text-ink-muted'}`}>
            {durationSaveNotice ?? 'Limite do Usuário Teste: 5 min por acionamento'}
          </p>
        )}

        {/* Botão principal: a cor e o rótulo SÃO o estado. Altura fixa. */}
        <button
          type="button"
          disabled={view.disabled}
          aria-busy={view.tone === 'busy'}
          onClick={handleMainClick}
          className={`w-full h-14 px-5 rounded-xl text-[15px] font-semibold text-white shadow-sm flex items-center justify-center gap-2.5 transition-colors duration-300 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[#1976D2] ${
            BUTTON_TONE_CLASS[view.tone]
          } ${view.dimmed ? 'opacity-60' : ''}`}
        >
          <ButtonIcon icon={view.icon} />
          <span>{view.label}</span>
          {view.detail && (
            <>
              <span className="opacity-60" aria-hidden>·</span>
              <span className="tabular-nums">{view.detail}</span>
            </>
          )}
        </button>

        {/* Linha única de status: altura fixa, sem caixas coloridas que aparecem e somem. */}
        <p
          role="status"
          aria-live="polite"
          className={`min-h-[2.5rem] flex items-start gap-1.5 px-1 text-xs leading-5 font-medium ${STATUS_TONE_CLASS[status.tone]}`}
        >
          <StatusIcon tone={status.tone} />
          <span>{status.text}</span>
        </p>

        <p className="text-xs text-ink-muted px-1">
          A confirmação informa a ação do controlador. A vazão de água não é monitorada.
        </p>
      </div>
    </div>
  );
}
