/**
 * =====================================================================================
 * ARQUIVO: src/features/irrigation/components/valveControlView.ts
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-23 (UTC) — Fase 4.0-C (botão minimalista)
 * PROPÓSITO: Regras PURAS de apresentação do controle da válvula (sem React), para que
 *            o visual seja previsível e testável:
 *   - O BOTÃO é o indicador de estado: azul (iniciar), vermelho (parar), grafite
 *     (aguardando confirmação), âmbar (estado não confirmado), cinza (indisponível).
 *   - Um único texto durante toda a espera ("Aguardando confirmação"), sem trocar de
 *     mensagem a cada fração de segundo.
 *   - A pausa curta de segurança após o ACK (1 s) é silenciosa: o botão já mostra a
 *     próxima ação e só ignora cliques. Pausas longas (ex.: limite de uso, 60 s) mostram
 *     a contagem, porque aí dá tempo de ler.
 *   - Uma única linha de status, de altura fixa, com prioridade definida.
 * =====================================================================================
 */

export type ValveButtonTone = 'start' | 'stop' | 'busy' | 'warning' | 'locked' | 'cooldown';
export type ValveButtonIcon = 'droplets' | 'stop' | 'spinner' | 'alert' | 'lock' | 'timer';

export interface ValveButtonView {
  tone: ValveButtonTone;
  icon: ValveButtonIcon;
  label: string;
  /** Complemento à direita (ex.: tempo restante). Opcional. */
  detail: string | null;
  disabled: boolean;
  /** Indisponível de verdade (desbotado). A pausa curta de 1 s NÃO desbota o botão. */
  dimmed: boolean;
  /** Ação que o clique executa quando o botão está livre. */
  action: 'start' | 'stop' | 'none';
}

export interface ValveButtonInput {
  isBusy: boolean;
  isOnline: boolean;
  otaActive: boolean;
  confirmationUncertain: boolean;
  isValveOpen: boolean;
  isValvePending: boolean;
  isLockedBySchedule: boolean;
  cooldownSec: number;
  /** Valor inicial da pausa atual (para distinguir a pausa curta da longa). */
  cooldownStartSec: number;
  selectedMinutes: number;
  remainingText: string;
}

/** Pausas até este valor são silenciosas (não mostram contagem no botão). */
export const SILENT_COOLDOWN_MAX_SEC = 3;

export function resolveValveButtonView(i: ValveButtonInput): ValveButtonView {
  if (i.isBusy) {
    return { tone: 'busy', icon: 'spinner', label: 'Aguardando confirmação', detail: null, disabled: true, dimmed: false, action: 'none' };
  }
  const wantsStop = i.confirmationUncertain || i.isValveOpen || i.isValvePending;

  if (!i.isOnline && !wantsStop) {
    return { tone: 'locked', icon: 'lock', label: 'Estação offline', detail: null, disabled: true, dimmed: true, action: 'none' };
  }
  if (i.otaActive) {
    return { tone: 'locked', icon: 'lock', label: 'Atualização em andamento', detail: null, disabled: true, dimmed: true, action: 'none' };
  }

  const cooling = i.cooldownSec > 0;
  const longCooldown = cooling && i.cooldownStartSec > SILENT_COOLDOWN_MAX_SEC;
  // A parada nunca fica presa atrás de uma pausa longa (segurança física).
  const disabledByCooldown = cooling && !(wantsStop && longCooldown);
  const disabled = disabledByCooldown || !i.isOnline;
  const dimmed = !i.isOnline;

  if (i.confirmationUncertain) {
    return { tone: 'warning', icon: 'alert', label: 'Enviar parada de segurança', detail: null, disabled, dimmed, action: 'stop' };
  }
  if (i.isValveOpen) {
    const detail = i.remainingText && i.remainingText !== '--:--' ? i.remainingText : null;
    return {
      tone: 'stop',
      icon: 'stop',
      label: i.isLockedBySchedule ? 'Parar irrigação agendada' : 'Parar irrigação',
      detail,
      disabled,
      dimmed,
      action: 'stop',
    };
  }
  if (i.isValvePending) {
    return { tone: 'stop', icon: 'stop', label: 'Cancelar reserva', detail: null, disabled, dimmed, action: 'stop' };
  }
  if (longCooldown) {
    return { tone: 'cooldown', icon: 'timer', label: 'Disponível em', detail: `${i.cooldownSec} s`, disabled: true, dimmed: false, action: 'none' };
  }
  return {
    tone: 'start',
    icon: 'droplets',
    label: 'Iniciar irrigação',
    detail: `${i.selectedMinutes} min`,
    disabled,
    dimmed,
    action: 'start',
  };
}

export type ValveStatusTone = 'neutral' | 'success' | 'warning' | 'error';

export interface ValveStatusLine {
  tone: ValveStatusTone;
  text: string;
}

export interface LastConfirmation {
  action: 'ligar' | 'parar';
  atMs: number;
  latencyMs: number;
}

export interface ValveStatusInput {
  isBusy: boolean;
  isOnline: boolean;
  otaActive: boolean;
  confirmationUncertain: boolean;
  feedback: { type: 'success' | 'warning' | 'error'; message: string } | null;
  lastConfirmation: LastConfirmation | null;
  /** Formata o horário local (injetável para teste). */
  formatTime?: (ms: number) => string;
}

export function formatLatency(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  return `${s.toFixed(1).replace('.', ',')} s`;
}

function defaultFormatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function resolveValveStatusLine(i: ValveStatusInput): ValveStatusLine {
  const fmt = i.formatTime ?? defaultFormatTime;
  if (!i.isOnline) {
    return { tone: 'error', text: 'Estação offline. O acionamento remoto fica bloqueado por segurança.' };
  }
  if (i.otaActive) {
    return { tone: 'warning', text: 'Atualização de firmware em andamento. A válvula fica bloqueada até o fim.' };
  }
  if (i.confirmationUncertain && !i.isBusy) {
    return {
      tone: 'warning',
      text: 'A estação não confirmou o último comando. Envie uma parada; se não houver resposta, verifique energia e internet no local.',
    };
  }
  if (i.feedback && i.feedback.type !== 'success' && !i.isBusy) {
    return { tone: i.feedback.type, text: i.feedback.message };
  }
  if (i.lastConfirmation) {
    const c = i.lastConfirmation;
    return {
      tone: 'success',
      text: `Último comando (${c.action}) confirmado pela estação às ${fmt(c.atMs)} · ${formatLatency(c.latencyMs)}`,
    };
  }
  return { tone: 'neutral', text: 'Cada comando é confirmado pela própria estação (ACK).' };
}
