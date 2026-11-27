import { translateEventResult, translateEventSource } from './event.types';
import type { ActivityLogModel } from './event.types';

export function classifyAuditEvent(log: ActivityLogModel) {
  // O histórico legado nem sempre tem um reason estruturado.
  const message = log.message.trim().toLowerCase();
  if (log.isFromSchedule || log.source === 'schedule') {
    if (message.startsWith('agendamento: prazo expirado; execução não confirmada') ||
        message.startsWith('agendamento: início confirmado; término não confirmado no prazo') ||
        message.startsWith('início confirmado após o prazo; término ainda não confirmado') ||
        message.startsWith('falha na publicação mqtt; entrega não confirmada')) return 'unconfirmed';
    if (message.startsWith('agendamento em processamento') ||
        message.startsWith('comando publicado; aguardando confirmação')) return 'waiting';
    if (message.startsWith('início da irrigação confirmado')) return 'started';
  }
  // v5.36.0 (WEB-09): comando manual que a estação não confirmou (Scheduler_Logic v5.27.0).
  if (
    log.status === 'unconfirmed' ||
    (log.reason ?? '').toLowerCase() === 'no_ack_timeout' ||
    log.eventCode === 'CMD_NO_ACK_TIMEOUT'
  ) return 'unconfirmed';
  if (log.type === 'skipped') {
    if (log.source === 'weather_ai' && message.startsWith('ignorado: sensor físico')) return 'weather_sensor';
    if (log.source === 'weather_ai' && message.startsWith('cancelado: alta chance de chuva')) return 'weather_forecast';
    if (/^ignorado: solo já h[úû]mido|^ignorado: solo já úmido/.test(message)) return 'wet_soil';
  }
  return 'default';
}

export function auditEventSource(log: ActivityLogModel) {
  switch (classifyAuditEvent(log)) {
    case 'weather_sensor': return 'Automação por agendamento · sensor de chuva';
    case 'weather_forecast': return 'Automação por agendamento · previsão de chuva';
    default: return translateEventSource(log);
  }
}

export function auditEventResult(log: ActivityLogModel) {
  switch (classifyAuditEvent(log)) {
    case 'unconfirmed':
      return log.isFromSchedule || log.source === 'schedule'
        ? 'Confirmação pendente ou expirada'
        : 'Sem confirmação da estação';
    case 'waiting': return 'Aguardando confirmação do controlador';
    case 'started': return 'Início confirmado pelo controlador';
    case 'weather_sensor': return 'Agenda bloqueada por chuva detectada';
    case 'weather_forecast': return 'Agenda bloqueada pela previsão de chuva';
    case 'wet_soil': return 'Agenda bloqueada por umidade na meta ou acima';
    default: return translateEventResult(log);
  }
}
