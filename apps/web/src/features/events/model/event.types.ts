/**
 * =====================================================================================
 * ARQUIVO: src/features/events/model/event.types.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T00:55:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Modelo e tradutores semânticos para a linha do tempo de auditoria
 *            (`devices/{deviceId}/history`).
 * CHANGELOG:
 * - v5.36.0 (2026-11-24 UTC): guarda `status` e `event_code` do histórico; comando de
 *            convidado aparece como "Demonstração (convidado)" (WEB-01); novo motivo
 *            `no_ack_timeout` (comando sem confirmação, Scheduler_Logic v5.27.0).
 * - v5.26.0 (Fase 3C item 9, 2026-11-23 UTC):
 *            1. Origem `unregistered` (ACK sem registro no servidor) vira alerta de
 *               seguranca, com origem e resultado traduzidos;
 *            2. Novos motivos do firmware 5.25.x e da Lambda Ack traduzidos;
 *            3. `translateOtaStatus` traduz o status do ciclo OTA (ex.: verifying).
 * - v5.25.0: [Auditoria 03]
 *            1. `ota_rebooting` traduzido como "Binário Gravado (Aguardando Self-Test)"
 *               em vez de anunciar sucesso final antes do reboot;
 *            2. Preserva `timestamp: null` quando ausente sem fabricar `new Date()`;
 *            3. `translateEventReason` informa "Motivo não informado" quando vazio.
 * =====================================================================================
 */

import { parseFirestoreDate } from '../../devices/model/device.schema';

export type EventFilterKey = 'all' | 'schedule' | 'command' | 'alerts';

export interface ActivityLogModel {
  id: string;
  timestamp: Date | null;
  updatedAt?: Date | null;
  deviceEventAt?: Date | null;
  terminalEventId?: string | null;
  scheduleLabel?: string | null;
  type: string;
  source: string;
  message: string;
  result: string | null;
  reason: string | null;
  commandId: string | null;
  details: Record<string, unknown> | null;
  isFromSchedule: boolean;
  isManualCommand: boolean;
  isSecurityOrAlert: boolean;
  /** v5.26.0 (Fase 3C item 9): ACK de comando que o servidor nunca registrou. */
  isUnregistered?: boolean;
  /** v5.36.0: status bruto do histórico (ex.: `unconfirmed`) e código do evento. */
  status?: string | null;
  eventCode?: string | null;
}

export function parseScheduleLabel(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

export function parseDeviceEventDate(value: unknown): Date | null {
  // Epoch em segundos informado pelo controlador. Zero indica relógio indisponível.
  const seconds = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(seconds) || seconds < 1577836800 || seconds > 253402300799) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

const ALERT_REASONS = new Set([
  'rain_interlock',
  'power_loss_reset',
  'failsafe_no_deadline',
  'failsafe',
  'ota_rollback',
  'ota_hash_mismatch',
  'ota_valve_busy',
  'ota_power_loss',
  'command_expired',
  'rate_limited',
  'invalid_calibration',
  // v5.26.0 (Fase 3C item 9): protecoes fisicas e de seguranca do firmware 5.25.x
  'power_unstable',
  'power_loss_rollback',
  'failsafe_guard_timer',
  'valve_task_stall',
  'valve_guard_pending',
  'unregistered_command',
  'ota_selftest_timeout',
  'ota_signature_invalid',
  'ota_signature_missing',
]);

/**
 * Desserializa um documento de `devices/{deviceId}/history/{logId}` em `ActivityLogModel`.
 */
export function parseActivityLogFromFirestore(
  data: Record<string, unknown> | undefined,
  docId: string,
): ActivityLogModel {
  const raw = data ?? {};
  const type = typeof raw.type === 'string' ? raw.type : 'info';
  const source = typeof raw.source === 'string' ? raw.source : 'system';
  const message = typeof raw.message === 'string' ? raw.message : 'Sem detalhes';
  const result = typeof raw.result === 'string' ? raw.result : null;
  const reason = typeof raw.reason === 'string' ? raw.reason : null;
  const commandId = typeof raw.command_id === 'string' ? raw.command_id : null;
  const details =
    typeof raw.details === 'object' && raw.details !== null
      ? (raw.details as Record<string, unknown>)
      : null;

  const isFromSchedule =
    source === 'schedule' ||
    (typeof raw.schedule_id === 'string' && Boolean(raw.schedule_id.trim())) ||
    ((source === 'command' || source === 'manual') &&
      Boolean(commandId && commandId.startsWith('sched-')));

  const isManualCommand =
    (source === 'command' || source === 'manual') && !isFromSchedule;

  const reasonLower = (reason ?? '').toLowerCase();
  // v5.26.0 (Fase 3C item 9): ACK de comando que o servidor nunca registrou
  // (AckToFirestore v5.30.0 grava source="unregistered" e details.unregistered=true).
  const isUnregistered =
    source === 'unregistered' ||
    details?.unregistered === true ||
    reasonLower === 'unregistered_command';
  const isSecurityOrAlert =
    isUnregistered ||
    type === 'security_alert' ||
    type === 'error' ||
    type === 'skipped' ||
    source === 'weather_ai' ||
    result === 'failed' ||
    ALERT_REASONS.has(reasonLower);

  return {
    id: docId,
    timestamp: parseFirestoreDate(raw.timestamp),
    updatedAt: parseFirestoreDate(raw.updated_at),
    deviceEventAt: parseDeviceEventDate(raw.device_ts ?? details?.device_ts),
    terminalEventId: typeof raw.terminal_event_id === 'string'
      ? raw.terminal_event_id
      : typeof details?.event_id === 'string' ? details.event_id : null,
    type,
    source,
    message,
    result,
    reason,
    commandId,
    details,
    scheduleLabel: isFromSchedule ? parseScheduleLabel(raw.schedule_label) : null,
    isFromSchedule,
    isManualCommand,
    isSecurityOrAlert,
    isUnregistered,
    status: typeof raw.status === 'string' ? raw.status : null,
    eventCode: typeof raw.event_code === 'string' ? raw.event_code : null,
  };
}

/**
 * Formata durações em segundos ("por 120 s") em minutos legíveis ("por 2 min").
 */
export function formatLogMessageDuration(message: string): string {
  return message.replace(/por (\d+)\s*s/g, (_match, secStr) => {
    const secs = parseInt(String(secStr), 10);
    if (Number.isNaN(secs)) return _match;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    if (mins === 0) return `por ${secs} s`;
    if (rem === 0) return `por ${mins} min`;
    return `por ${mins} min e ${rem} s`;
  });
}

/**
 * Traduz a origem técnica (`source`) do evento para português claro.
 */
export function translateEventSource(log: ActivityLogModel): string {
  if (log.isUnregistered || log.source === 'unregistered') {
    return 'Não registrado no servidor (possível injeção)';
  }
  if (log.type === 'ota_verification') return 'Self-Test de Boot (OTA)';
  if (log.isManualCommand && isOtaEvent(log)) return 'Atualização de Firmware (OTA)';
  // v5.36.0 (WEB-01): o servidor carimba `demo-` no command_id dos convidados.
  if (log.commandId && log.commandId.startsWith('demo-')) return 'Demonstração (convidado)';
  if (log.isManualCommand) return 'Acionamento Manual (App / Web)';
  // v5.41.0: botões físicos (AckToFirestore v5.33.0 grava source="local_button").
  if (log.source === 'local_button' || log.type === 'local_action') return 'Botão físico da estação';
  if (log.isFromSchedule) return 'Automação por Agendamento';

  switch (log.source) {
    case 'weather_ai':
      return 'Inteligência Climática (Chuva / Open-Meteo)';
    case 'system':
      return 'Sistema de Segurança Embarcado';
    default:
      return log.source.toUpperCase();
  }
}

/** AGRO_E1: motivos de recusa por proteção (anti-rajada, pausa do relé, confirmações). */
export const PROTECTIVE_EVENT_REASONS: ReadonlySet<string> = new Set([
  'rate_limited',
  'valve_cooldown',
  'device_rate_limited',
  'ack_outbox_busy',
  'valve_guard_pending',
]);

/** AGRO_E1: evento de atualização de firmware (OTA), para não aparecer como "manual". */
export function isOtaEvent(log: ActivityLogModel): boolean {
  const r = (log.reason ?? '').toLowerCase();
  const action = typeof log.details?.action === 'string' ? log.details.action.toLowerCase() : '';
  return r.startsWith('ota_') || log.type.toLowerCase().startsWith('ota') || action === 'ota';
}

/**
 * Traduz o resultado técnico (`result` / `type` / `reason`) para português claro.
 */
export function translateEventResult(log: ActivityLogModel): string {
  const r = (log.reason ?? '').toLowerCase();
  if (log.isUnregistered || log.source === 'unregistered') {
    return log.result === 'failed'
      ? 'Alerta de Segurança: comando sem registro (falhou na estação)'
      : 'Alerta de Segurança: executado pela estação sem registro no servidor';
  }
  if (r === 'rain_interlock') return 'Proteção Ativada (Chuva no Local)';
  if (r === 'power_loss_reset' || r === 'ota_power_loss') {
    return 'Recuperação de Queda de Energia (Crash Recovery)';
  }
  if (r === 'ota_rollback') return 'Revertido Automaticamente (Auto-Rollback)';
  if (r === 'ota_updated') {
    return 'Firmware Atualizado e Validado no Boot';
  }
  if (r === 'ota_rebooting') {
    return 'Binário Gravado (Reiniciando para Self-Test)';
  }
  if (r === 'config_updated') return 'Calibração Confirmada pelo ESP32';
  // AGRO_E1: recusa de proteção não é falha da estação.
  if (PROTECTIVE_EVENT_REASONS.has(r)) return 'Recusado pela proteção da estação';
  if (log.result === 'failed' || log.type === 'error') {
    return 'Interrompido / Falha na Execução';
  }
  if (log.result === 'success') return 'Concluído com Sucesso';
  if (log.type === 'skipped') return 'Pulado Automaticamente (Prevenção)';
  return 'Informação Registrada';
}

/** v5.42.0: código desconhecido → texto legível ("valve_busy_x" → "Valve busy x"), nunca vazio. */
export function humanizeReasonCode(code: string): string {
  const clean = code.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Motivo específico não informado';
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * Traduz os códigos de motivo (`reason`) gerados pelo Firmware ESP32 e pelas Lambdas AWS.
 */
export function translateEventReason(reason?: string | null): string {
  if (!reason || !reason.trim()) return 'Motivo específico não informado';
  switch (reason.trim().toLowerCase()) {
    case 'duration_elapsed':
      return 'Tempo programado concluído com precisão';
    case 'timeout':
      return 'Tempo limite atingido (Timeout)';
    case 'manual_stop':
    case 'manual_off':
      return 'Desligado manualmente pelo operador';
    case 'already_off':
      return 'A válvula já se encontrava fechada';
    case 'valve_not_on':
      return 'Falha física ao acionar a válvula solenoide';
    case 'rain_interlock':
      return 'Interlock na borda: sensor físico detectou chuva';
    case 'power_loss_reset':
      return 'Crash Recovery: queda de energia durante a rega';
    case 'duplicate_ignored':
      return 'Idempotência: comando repetido ignorado com segurança';
    case 'command_expired':
      return 'Proteção TTL: comando descartado pois expirou na rede';
    case 'rate_limited':
      return 'Anti-rajada da estação: muitos LIGAR seguidos (até 6, depois 1 a cada 30 s)';
    case 'device_rate_limited':
      return 'Anti-rajada do servidor: muitos LIGAR seguidos (até 6, depois 1 a cada 30 s)';
    case 'valve_cooldown':
      return 'Pausa de proteção do relé: menos de 2 s desde o último desligamento';
    case 'ack_outbox_busy':
      return 'Estação ainda enviando confirmações anteriores (memória de ACK ocupada)';
    case 'ack_storage_unavailable':
      return 'Memória de confirmações indisponível: LIGAR bloqueado por segurança';
    case 'config_updated':
      return 'Parâmetros de calibração e intervalo aplicados na estação';
    case 'invalid_calibration':
      return 'Calibração recusada: margem entre seco e molhado menor que 100';
    case 'payload_too_large':
      return 'Proteção de memória: pacote JSON excedeu o limite do buffer';
    case 'failsafe_no_deadline':
    case 'failsafe':
      return 'Desligamento de emergência (Failsafe de Hardware)';
    case 'ota_updated':
      return 'OTA concluído: nova partição validada no Self-Test pós-boot';
    case 'ota_rebooting':
      return 'OTA: binário gravado, fila drenada e SHA-256 conferido (reiniciando)';
    case 'ota_same_version':
      return 'OTA ignorado: a estação já estava com esta versão instalada';
    case 'ota_valve_busy':
      return 'Safety Interlock: OTA recusado pois a válvula estava aberta';
    case 'ota_low_heap':
      return 'OTA recusado: memória RAM livre insuficiente no momento';
    case 'ota_hash_mismatch':
      return 'Segurança OTA: assinatura SHA-256 inválida (arquivo descartado)';
    case 'ota_http_failed':
      return 'Falha de rede durante download HTTPS do Amazon S3 (após 3 tentativas)';
    case 'ota_flash_error':
      return 'Falha de escrita na partição OTA da memória Flash';
    case 'ota_power_loss':
      return 'Queda de energia durante download OTA (partição original mantida intacta)';
    case 'ota_rollback':
      return 'Bootloader reverteu para a partição anterior (Auto-Rollback)';
    case 'ota_signature_invalid':
      return 'Firmware recusado: assinatura digital inválida';
    case 'ota_signature_missing':
      return 'Firmware recusado: release sem assinatura digital';
    case 'ota_downgrade_blocked':
      return 'Atualização recusada: versão mais antiga bloqueada (anti-downgrade)';
    case 'ota_version_blocked':
      return 'Versão bloqueada na estação após falha anterior';
    case 'ota_selftest_timeout':
      return 'Nova versão não conectou à AWS no prazo; estação voltou à versão anterior';
    case 'ota_current_version_unknown':
      return 'Versão atual da estação desconhecida; atualização não iniciada';
    // v5.26.0 (Fase 3C item 9): motivos do firmware 5.25.x e da Lambda Ack
    case 'ota_observing':
      return 'Observando a nova versão: 90 s contínuos conectada à AWS (prazo de 10 min)';
    case 'power_unstable':
      return 'Bloqueado por energia instável (quedas repetidas); válvula mantida fechada';
    case 'power_loss_rollback':
      return 'Queda de energia: a válvula voltou ao estado seguro (fechada)';
    case 'failsafe_guard_timer':
      return 'Guarda independente fechou a válvula (prazo máximo excedido)';
    case 'valve_task_stall':
      return 'Guarda independente fechou a válvula (controle da válvula travado)';
    case 'valve_guard_pending':
      return 'Recusado: proteção da válvula ainda em andamento';
    case 'unregistered_command':
      return 'Comando sem registro no servidor (possível injeção ou teste)';
    case 'cancelled_by_off':
    case 'superseded_by_off':
      return 'Encerrado por um comando de desligar (OFF)';
    case 'valve_already_open':
      return 'A válvula já se encontrava aberta';
    case 'no_ack_timeout':
      return 'A estação não confirmou o comando a tempo (provável queda de energia ou de internet)';
    // v5.42.0: display e botões físicos (firmware 5.27.0)
    case 'display_on':
      return 'Tela da estação acesa pelo botão físico';
    case 'display_off':
      return 'Tela da estação apagada pelo botão físico';
    case 'display_updated':
      return 'Ajuste do display aplicado e gravado na estação';
    case 'buttons_updated':
      return 'Duração do botão de irrigação gravada na estação';
    case 'local_config_updated':
      return 'Ajustes do display e do botão aplicados na estação';
    case 'local_button_stop':
      return 'Desligado no botão físico da estação';
    case 'button_stuck':
      return 'Botão travado (apertado por mais de 10 s): válvula fechada por segurança';
    case 'raining_before_activation':
    case 'raining_now':
      return 'Chuva detectada no local: irrigação não iniciada';
    case 'valve_busy':
      return 'Válvula ocupada por outra operação';
    case 'valve_failed_to_start':
      return 'A válvula não conseguiu iniciar';
    case 'ota_busy':
    case 'ota_in_progress':
      return 'Atualização de firmware em andamento: ação bloqueada';
    case 'brownout_safe_mode':
      return 'Modo seguro por quedas de energia: irrigação bloqueada';
    case 'durable_reservation_failed':
      return 'Memória de confirmações cheia: ação bloqueada por segurança';
    case 'nvs_write_error':
    case 'failed_to_persist_config':
      return 'A estação não conseguiu gravar o ajuste na memória';
    case 'invalid_display_mode':
    case 'display_minutes_out_of_range':
    case 'display_minutes_required':
    case 'display_minutes_only_with_on':
    case 'display_minutes_without_mode':
    case 'btn_irrig_min_invalid':
    case 'btn_irrig_min_out_of_range':
    case 'invalid_config':
      return 'Ajuste recusado pela estação: valor fora da faixa permitida';
    case 'empty_local_config':
      return 'Ajuste vazio: nada a aplicar';
    default:
      return humanizeReasonCode(reason.trim());
  }
}

/**
 * v5.26.0 (Fase 3C item 9): traduz o status do ciclo OTA (`ota_status.status`) para o
 * painel, em vez de exibir o código técnico em maiúsculas.
 */
export function translateOtaStatus(status?: string | null): string {
  const s = (status ?? '').trim().toLowerCase();
  switch (s) {
    case 'pending':
    case 'received':
      return 'Solicitado';
    case 'started':
      return 'Baixando e validando';
    case 'rebooting':
      return 'Reiniciando';
    case 'done':
      return 'Gravado';
    case 'verifying':
      return 'Verificando';
    case 'verified_online':
      return 'Verificado';
    case 'rolled_back':
      return 'Revertido';
    case 'failed':
    case 'error':
      return 'Falhou';
    case 'publish_failed':
      return 'Falha ao publicar';
    default:
      return s ? s.toUpperCase() : '—';
  }
}
