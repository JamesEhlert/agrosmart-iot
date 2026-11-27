/**
 * =====================================================================================
 * ARQUIVO: src/features/events/components/EventAuditModal.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T00:55:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Modal "Auditoria da Operação" exibindo todos os metadados técnicos de um
 *            evento do Firestore (`command_id`, `fw`, `part`, `heap`, `rssi` e motivo).
 * CHANGELOG:
 * - v5.25.0: [Auditoria 03] Suporte a fechamento por `Escape`, semântica ARIA de diálogo
 *            e exibição fiel quando `reason` ou `timestamp` não foram informados.
 * =====================================================================================
 */

import { Button, Dialog } from '../../../shared/ui';
import { OperationTimeline } from './OperationTimeline';
import {
  Calendar,
  Cpu,
  Gauge,
  Info,
  ShieldCheck,
  Tag,
  Wifi,
} from 'lucide-react';
import {
  ActivityLogModel,
  formatLogMessageDuration,
  translateEventReason,
} from '../model/event.types';
import { auditEventResult, auditEventSource } from '../model/auditPresentation';
import {
  formatFreeHeap,
  formatWithDeviceTimezone,
} from '../../../shared/lib/formatters';
import { InfoTip } from '../../../shared/ui/InfoTip';

interface EventAuditModalProps {
  log: ActivityLogModel | null;
  deviceId?: string;
  timezoneOffset: number;
  onClose: () => void;
}

export function EventAuditModal({
  log,
  deviceId,
  timezoneOffset,
  onClose,
}: EventAuditModalProps) {

  if (!log) return null;

  const sysMap =
    log.details && typeof log.details.sys === 'object' && log.details.sys !== null
      ? (log.details.sys as Record<string, unknown>)
      : null;

  const fwReported =
    (sysMap?.fw ?? log.details?.fw ?? log.details?.fw_after_boot)
      ? String(sysMap?.fw ?? log.details?.fw ?? log.details?.fw_after_boot).replace(
          /^[vV]/,
          '',
        )
      : null;

  const partReported =
    sysMap?.part ?? log.details?.part
      ? String(sysMap?.part ?? log.details?.part)
      : null;

  const heapBytes =
    typeof sysMap?.heap === 'number' ? sysMap.heap : null;
  const rssiDbm =
    typeof sysMap?.rssi === 'number' ? sysMap.rssi : null;

  // v5.45.0: janela padrão do design system (foco preso, Esc, folha inferior no celular)
  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Histórico de irrigação e eventos"
      title="Auditoria da operação"
      size="lg"
      footer={<Button variant="primary" onClick={onClose}>Fechar</Button>}
    >
      <div>
        <div className="p-3.5 rounded-xl bg-sunken/70 border border-line mb-4">
          <p className="text-sm font-bold text-ink">
            {formatLogMessageDuration(log.message)}
          </p>
        </div>

        <OperationTimeline
          key={`${deviceId ?? ''}:${log.id}`}
          log={log}
          deviceId={deviceId}
          timezoneOffset={timezoneOffset}
        />

        <div className="space-y-3 text-xs">
          <div className="flex items-start gap-2.5">
            <Calendar className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
            <div>
              <span className="text-ink-muted block">
                Registro no servidor (Fuso UTC{timezoneOffset >= 0 ? `+${timezoneOffset}` : timezoneOffset})
              </span>
              <span className="font-bold text-ink">
                {formatWithDeviceTimezone(log.timestamp, timezoneOffset)}
              </span>
            </div>
          </div>

          <div className="flex items-start gap-2.5">
            <Info className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
            <div>
              <span className="text-ink-muted block">Origem <InfoTip k="origem" align="left" /></span>
              <span className="font-bold text-ink">
                {auditEventSource(log)}
              </span>
            </div>
          </div>

          <div className="flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
            <div>
              <span className="text-ink-muted block">Resultado <InfoTip k="status" align="left" /></span>
              <span className="font-bold text-ink">
                {auditEventResult(log)}
              </span>
            </div>
          </div>

          {log.reason && (
            <div className="flex items-start gap-2.5">
              <Info className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
              <div>
                <span className="text-ink-muted block">Motivo <InfoTip k="motivo" align="left" /></span>
                <span className="font-bold text-ink">
                  {translateEventReason(log.reason)}
                </span>
                <code className="block mt-0.5 text-[11px] font-mono text-ink-muted">código: {log.reason}</code>
              </div>
            </div>
          )}

          {log.commandId && (
            <div className="flex items-start gap-2.5">
              <Tag className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
              <div>
                <span className="text-ink-muted block">
                  ID de Correlação (Command ID)
                </span>
                <span className="font-mono font-bold text-ink">
                  {log.commandId}
                </span>
              </div>
            </div>
          )}

          {(Boolean(fwReported) || heapBytes !== null || rssiDbm !== null) && (
          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer font-bold text-ink-muted">Detalhes técnicos da estação</summary>
            <div className="space-y-3 pt-3">
          {fwReported && (
            <div className="flex items-start gap-2.5">
              <Cpu className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
              <div>
                <span className="text-ink-muted block">Firmware da estação <InfoTip k="firmware" align="left" /></span>
                <span className="font-bold text-brand-strong">
                  v{fwReported}
                  {partReported ? ` (${partReported})` : ''}
                </span>
              </div>
            </div>
          )}

          {heapBytes !== null && (
            <div className="flex items-start gap-2.5">
              <Gauge className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
              <div>
                <span className="text-ink-muted block">Memória livre <InfoTip k="heap" align="left" /></span>
                <span className="font-bold text-ink">
                  {formatFreeHeap(heapBytes)}
                </span>
              </div>
            </div>
          )}

          {rssiDbm !== null && (
            <div className="flex items-start gap-2.5">
              <Wifi className="w-4 h-4 text-ink-muted shrink-0 mt-0.5" />
              <div>
                <span className="text-ink-muted block">Sinal Wi-Fi no momento <InfoTip k="rssi" align="left" /></span>
                <span className="font-bold text-ink">{rssiDbm <= -127 ? 'Indisponível na captura' : `${rssiDbm} dBm`}</span>
              </div>
            </div>
          )}
            </div>
          </details>
          )}
        </div>

      </div>
    </Dialog>
  );
}