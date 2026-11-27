// ACK web correction v1: correlated server result; unknown outcome is preserved.
/**
 * =====================================================================================
 * ARQUIVO: src/features/irrigation/model/command.types.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T00:55:00-03:00
 * VERSÃO: v5.26.1-diag (ACK Web v1)
 * PROPÓSITO: Contratos do ciclo de vida de comandos (`POST /command` + ACK Firestore).
 * CHANGELOG:
 * - v5.25.0: [Auditoria 03]
 *            1. Adicionado campo `result` (`success` | `failed`) e status `publish_failed`;
 *            2. Corrigida tradução de `ota_valve_busy` e preservado código técnico
 *               quando o motivo de recusa não for reconhecido.
 * =====================================================================================
 */

export type CommandAction = 'on' | 'off' | 'config' | 'ota';

export type AckLifecycleStatus =
  | 'pending'
  | 'received'
  | 'started'
  | 'done'
  | 'failed'
  | 'error'
  | 'publish_failed'
  | 'unknown';

export interface SendCommandResponse {
  ok: boolean;
  commandId: string;
  message: string;
  version?: string;
  sha256?: string;
  fileSize?: number;
  expiresAt?: number;
}

export interface CommandAckEvent {
  commandId: string;
  status: AckLifecycleStatus;
  result: string | null;
  action: string | null;
  duration: number | null;
  reason: string | null;
  error: string | null;
  updatedAt: Date | null;
  evidence?: string | null;
  terminalEventId?: string | null;
  ackProtocol?: number | null;
  interruptedCommandId?: string | null;
  resolvedBy?: 'command_doc';
  confirmedByServer?: boolean;
}

/** AGRO_E1: motivos em que a estação recusou para se proteger (não é defeito). */
export const PROTECTIVE_REJECTION_REASONS: ReadonlySet<string> = new Set([
  'rate_limited',
  'valve_cooldown',
  'device_rate_limited',
  'ack_outbox_busy',
  'valve_guard_pending',
]);

/** Motivo de proteção (anti-rajada, pausa do relé, caixa de confirmações cheia). */
export function isProtectiveRejection(reason?: string | null): boolean {
  return PROTECTIVE_REJECTION_REASONS.has((reason ?? '').trim().toLowerCase());
}

/**
 * Lê o tempo de espera que o firmware 5.26.0+ manda no campo `error`
 * (ex.: `retry_after_s=23`). Devolve `null` quando não houver um valor válido.
 */
export function parseAckRetryAfterSec(error?: string | null): number | null {
  const m = /retry_after_s=(\d{1,5})/.exec(error ?? '');
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3600) : null;
}

function waitText(retryAfterSec?: number | null): string {
  return retryAfterSec && retryAfterSec > 0 ? `aguarde ${retryAfterSec} s` : 'aguarde alguns segundos';
}

/**
 * Traduz o código de recusa de abertura da válvula enviado pelo ESP32 em mensagem clara.
 * AGRO_E1: aceita o tempo de espera para mostrar ao usuário quanto falta.
 */
export function translateValveRejectionReason(reason?: string | null, retryAfterSec?: number | null): string {
  const clean = (reason ?? '').trim();
  switch (clean.toLowerCase()) {
    case 'rain_interlock':
      return 'Proteção ativada na borda: o sensor físico detectou chuva no local!';
    case 'valve_already_open':
      return 'A válvula já se encontra aberta em outra operação.';
    case 'ota_in_progress':
      return 'Atualização OTA em andamento. Aguarde a conclusão.';
    case 'ota_valve_busy':
      return 'Operação bloqueada por segurança mútua entre válvula e motor OTA.';
    case 'rate_limited':
    case 'device_rate_limited':
      return `Muitos acionamentos seguidos. Para proteger a válvula e o relé, ${waitText(retryAfterSec)} para ligar de novo. Desligar continua liberado.`;
    case 'valve_cooldown':
      return `A válvula acabou de fechar. Para proteger o relé, ${waitText(retryAfterSec)} antes de ligar de novo.`;
    case 'ack_outbox_busy':
      return 'A estação ainda está enviando as confirmações anteriores. Aguarde alguns segundos e tente de novo.';
    case 'valve_guard_pending':
      return 'A proteção da válvula ainda está finalizando o ciclo anterior. Aguarde alguns segundos.';
    case 'command_expired':
      return 'O comando expirou na rede (TTL excedido). Tente novamente.';
    case 'execution_unknown_after_reset':
    case 'power_loss_reset':
      return 'Resultado não confirmado após reinício. Não é possível determinar a duração executada.';
    case 'network_supervisor_stop':
      return 'O controlador informou interrupção após perda prolongada de conexão.';
    case 'ack_storage_unavailable':
      return 'Acionamento bloqueado por segurança: a memória de confirmações da estação está indisponível. Desligar continua liberado.';
    case 'clock_or_ttl_invalid':
      return 'Acionamento bloqueado: relógio ou validade do comando não confirmados.';
    case 'publish_failed':
      return 'Falha ao publicar comando no broker MQTT da AWS.';
    default:
      return clean
        ? `A estação recusou ou falhou ao acionar a válvula (${clean}).`
        : 'A estação recusou ou falhou ao acionar a válvula.';
  }
}
/** Unknown outcome is not proof that irrigation never occurred. */
export function isUnknownCommandOutcome(ack: CommandAckEvent): boolean {
  return ack.evidence === 'unknown_after_reset' || ack.reason === 'execution_unknown_after_reset' || ack.reason === 'power_loss_reset';
}
