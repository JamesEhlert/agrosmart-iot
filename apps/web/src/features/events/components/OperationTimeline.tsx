import { useEffect, useState } from 'react';
import { fetchOperationDocument } from '../api/eventRepository';
import { ActivityLogModel, parseDeviceEventDate, parseScheduleLabel } from '../model/event.types';
import { parseFirestoreDate } from '../../devices/model/device.schema';
import { formatWithDeviceTimezone } from '../../../shared/lib/formatters';
import { InfoTip } from '../../../shared/ui/InfoTip';

interface Props {
  log: ActivityLogModel;
  deviceId?: string;
  timezoneOffset: number;
}

/** v5.42.0: nome do momento final conforme o motivo (texto curto, sem código técnico). */
export function terminalLabel(reason: string | null | undefined): string {
  switch ((reason ?? '').toLowerCase()) {
    case 'rain_interlock':
      return 'Interrupção por chuva';
    case 'manual_off':
    case 'manual_stop':
      return 'Parada pelo site';
    case 'local_button_stop':
      return 'Parada no botão da estação';
    case 'button_stuck':
      return 'Botão travado detectado';
    case 'duration_elapsed':
      return 'Tempo programado concluído';
    case 'display_on':
    case 'display_off':
      return 'Botão do display apertado';
    case 'display_updated':
    case 'buttons_updated':
    case 'local_config_updated':
    case 'config_updated':
      return 'Ajuste aplicado';
    default:
      return 'Evento final';
  }
}

export function OperationTimeline({ log, deviceId, timezoneOffset }: Props) {
  const [operation, setOperation] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(Boolean(deviceId && log.commandId && log.type !== 'skipped'));
  const [readFailed, setReadFailed] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');

  useEffect(() => {
    if (!deviceId || !log.commandId || log.type === 'skipped') return;
    let active = true;
    setLoading(true);
    fetchOperationDocument(deviceId, log.commandId)
      .then((value) => { if (active) setOperation(value); })
      .catch(() => { if (active) setReadFailed(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [deviceId, log.commandId, log.type]);

  const startedAt = parseFirestoreDate(operation?.started_at);
  const finishedAt = parseFirestoreDate(operation?.finished_at);
  const deviceEnd = log.deviceEventAt ?? (
    operation?.status === 'done' || operation?.status === 'failed'
      ? parseDeviceEventDate(operation.device_ts) : null
  );
  const plannedSeconds = operation?.requested_duration ??
    (log.details?.requested as Record<string, unknown> | undefined)?.duration;
  const eventId = log.terminalEventId ??
    (typeof operation?.terminal_event_id === 'string' ? operation.terminal_event_id : null);

  const schedule = operation?.schedule;
  const commandScheduleLabel = schedule && typeof schedule === 'object' && 'label' in schedule
    ? parseScheduleLabel(schedule.label)
    : null;
  // O histórico tem prioridade; para registros antigos, o comando pode ter o nome original.
  const scheduleLabel = log.scheduleLabel ?? commandScheduleLabel;

  const isLocal = /^loc-/.test(log.commandId ?? '');
  const points = [
    {
      label: isLocal ? 'Aperto do botão recebido pelo servidor' : 'Pedido registrado no servidor',
      date: parseFirestoreDate(operation?.created_at),
    },
    { label: isLocal ? 'Irrigação iniciada pelo botão' : 'Início confirmado no servidor', date: startedAt },
    { label: `${terminalLabel(log.reason)} · horário da estação`, date: deviceEnd },
    { label: 'Resultado registrado no servidor', date: finishedAt },
  ]
    .filter((point) => point.date !== null)
    // Botão da estação: o aperto acontece antes de chegar ao servidor → ordem cronológica.
    .sort((a, b) => (isLocal ? a.date!.getTime() - b.date!.getTime() : 0));

  const copyId = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice('Identificador copiado.');
    } catch {
      setCopyNotice('Selecione o identificador abaixo para copiar.');
    }
  };

  return (
    <section aria-label="Linha do tempo da operação" className="mb-5 rounded-2xl border border-line bg-slate-50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-ink inline-flex items-center gap-1.5">Linha do tempo <InfoTip k="linhaDoTempo" align="left" /></h3>
        {typeof plannedSeconds === 'number' && plannedSeconds > 0 && (
          <span className="rounded-full bg-surface border border-line px-2 py-1 text-xs font-semibold">
            Programado · {plannedSeconds % 60 === 0 ? `${plannedSeconds / 60} min` : `${plannedSeconds} s`}
          </span>
        )}
      </div>
      {log.isFromSchedule && (
        <div className="mb-3 rounded-lg border border-line bg-surface px-3 py-2">
          <span className="block text-xs text-ink-muted">Agenda</span>
          <p className="break-words text-sm font-semibold text-ink">
            {scheduleLabel ?? (loading ? 'Consultando nome…' : readFailed ? 'Nome indisponível' : 'Nome não registrado')}
          </p>
        </div>
      )}
      {loading && <p role="status" className="text-xs text-ink-muted">Carregando detalhes da operação…</p>}
      {readFailed && <p role="status" className="text-xs text-amber-800">Não foi possível consultar o comando. Os dados do histórico continuam disponíveis.</p>}
      {points.length > 0 ? (
        <ol className="space-y-3 border-l-2 border-emerald-200 pl-4">
          {points.map((point) => (
            <li key={point.label} className="text-xs">
              <span className="block text-ink-muted">{point.label}</span>
              <span className="font-semibold text-ink">{formatWithDeviceTimezone(point.date, timezoneOffset)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-xs text-ink-muted">
          {log.type === 'skipped' ? 'Operação bloqueada antes do envio ao controlador.' : 'Horários da execução ainda indisponíveis neste registro.'}
        </p>
      )}
      {log.type !== 'skipped' && (
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          Horários da estação dependem do relógio do controlador. Confirmações no servidor podem chegar após a reconexão.
        </p>
      )}
      <div className="mt-3 space-y-2 border-t border-line pt-3">
        {([
          ['Operação', log.commandId, 'operacao'],
          ['Evento terminal', eventId, 'eventoTerminal'],
          ['Registro de auditoria', log.id, 'registroAuditoria'],
        ] as const).filter((item) => item[1]).map(([label, value, tip]) => (
          <div key={label} className="text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="text-ink-muted inline-flex items-center gap-1">{label} <InfoTip k={tip} align="left" /></span>
              <button type="button" className="font-semibold text-brand hover:underline" onClick={() => copyId(value!)}>Copiar ID</button>
            </div>
            <code className="block break-all select-all text-ink">{value}</code>
          </div>
        ))}
        {copyNotice && <p role="status" className="text-xs text-ink-muted">{copyNotice}</p>}
      </div>
    </section>
  );
}
