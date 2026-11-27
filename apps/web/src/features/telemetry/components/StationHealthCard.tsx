/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/components/StationHealthCard.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T00:45:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Card "Saúde da Estação (Diagnóstico)" com Banner de Integridade de Hardware,
 *            métricas do bloco `sys` e abertura do Modal de Inspeção FreeRTOS.
 * CHANGELOG:
 * - v5.25.0: [Auditoria 02]
 *            1. Corrigida cor da fila SD (WAL) e do RSSI quando os campos são `null`
 *               (exibe tom neutro em vez de verde "Sincronizado" ou vermelho de erro);
 *            2. Exibe partição como "partição n/d" quando ausente, sem presumir `app0`.
 * =====================================================================================
 */

import { useState } from 'react';
import {
  Cpu,
  Wifi,
  Clock,
  HardDrive,
  RotateCcw,
  ShieldCheck,
  AlertTriangle,
  Search,
  Monitor,
} from 'lucide-react';
import { StationProtections, TelemetryModel } from '../model/telemetry.types';
import { describeLocalControlsSummary, readingAgeS } from '../model/localControls';
import {
  classifyRssiQuality,
  formatPendingBytes,
  formatResetReason,
  formatUptime,
} from '../../../shared/lib/formatters';
import { FreeRtosInspectModal } from './FreeRtosInspectModal';
import { InfoTip } from '../../../shared/ui/InfoTip';
import { formatAge } from '../../../shared/lib/relativeTime';

interface StationHealthCardProps {
  telemetry: TelemetryModel | null;
  timezoneOffset: number;
}

/** AGRO_E1: capacidade da caixa de confirmações (ACK) do firmware 5.26.0. */
const ACK_OUTBOX_CAPACITY = 8;

/** AGRO_E1: linha "Proteções da estação" (só aparece com firmware 5.26.0+). */
export function describeProtections(p: StationProtections): { tone: 'ok' | 'warn' | 'alert'; items: string[] } {
  const items: string[] = [];
  if (p.ackOutboxUsed !== null) {
    items.push(`Confirmações: ${Math.max(0, ACK_OUTBOX_CAPACITY - p.ackOutboxUsed)} de ${ACK_OUTBOX_CAPACITY} vagas livres`);
  }
  items.push(p.floodRejects > 0 ? `Anti-rajada: ${p.floodRejects} LIGAR recusado(s) desde o boot` : 'Anti-rajada: nenhuma recusa desde o boot');
  if (p.ackWriteFail > 0 || p.ackAbandoned > 0) {
    items.push(`Memória de ACK: ${p.ackWriteFail} falha(s) de gravação, ${p.ackAbandoned} abandonada(s)`);
  }
  if (p.nvsFree !== null) items.push(`NVS: ${p.nvsFree} entradas livres`);
  const tone = p.ackOutboxFault ? 'alert' : p.ackWriteFail > 0 || p.ackAbandoned > 0 ? 'warn' : 'ok';
  if (p.ackOutboxFault) items.unshift('Memória de confirmações em falha: LIGAR bloqueado por segurança');
  return { tone, items };
}

export function StationHealthCard({
  telemetry,
  timezoneOffset,
}: StationHealthCardProps) {
  const [isInspectOpen, setIsInspectOpen] = useState(false);

  if (!telemetry) return null;

  const rssiInfo = classifyRssiQuality(telemetry.rssi);
  const isHealthy = !telemetry.hasHardwareFault && telemetry.hardwareAlerts.length === 0;
  const partSuffix = telemetry.part ? ` (${telemetry.part})` : ' (partição n/d)';

  const rssiBadgeClass =
    rssiInfo.tone === 'success'
      ? 'bg-emerald-100 text-brand'
      : rssiInfo.tone === 'warning'
        ? 'bg-amber-100 text-warning'
        : rssiInfo.tone === 'error'
          ? 'bg-red-100 text-danger'
          : 'bg-slate-200 text-ink-muted';

  const walBadgeClass = !telemetry.sdOk
    ? 'bg-red-100 text-danger'
    : telemetry.pendingBytes === null
      ? 'bg-slate-200 text-ink-muted'
      : telemetry.pendingBytes === 0
        ? 'bg-emerald-100 text-brand'
        : 'bg-amber-100 text-warning';

  const protectionInfo = telemetry.protections ? describeProtections(telemetry.protections) : null;
  const protectionClass =
    protectionInfo?.tone === 'alert'
      ? 'bg-red-50 border-red-200 text-danger'
      : protectionInfo?.tone === 'warn'
        ? 'bg-amber-50 border-amber-200 text-warning'
        : 'bg-emerald-50 border-emerald-200 text-brand';

  return (
    <div>
      <div className="flex items-center justify-between mb-3 px-1">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Saúde da estação</h2>
          <p className="text-xs text-ink-muted">
            Última leitura: <strong className="text-ink">{formatAge(telemetry.timestamp)}</strong> <InfoTip k="ultimaLeitura" align="left" />
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsInspectOpen(true)}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-brand hover:text-brand-strong transition"
        >
          <Search className="w-3.5 h-3.5" />
          <span>Inspecionar RAM & FreeRTOS</span>
        </button>
      </div>

      <div
        onClick={() => setIsInspectOpen(true)}
        role="button"
        tabIndex={0}
        aria-label="Abrir inspeção detalhada de telemetria e FreeRTOS"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsInspectOpen(true);
          }
        }}
        className="bg-surface rounded-2xl border border-line p-5 shadow-sm hover:shadow-md transition cursor-pointer"
      >
        {/* Banner de Integridade Física dos Periféricos */}
        {isHealthy ? (
          <div className="mb-4 px-3.5 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 flex items-center gap-2.5 text-xs font-semibold text-brand">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>Periféricos físicos íntegros (SD, RTC DS3231 e Sensores OK)</span>
          </div>
        ) : (
          <div className="mb-4 p-3.5 rounded-xl bg-red-50 border border-red-200 text-xs text-danger space-y-1.5">
            <div className="flex items-center gap-2 font-bold">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>Alerta de Hardware Detectado na Estação</span>
            </div>
            <ul className="list-disc list-inside space-y-0.5 text-ink">
              {telemetry.hardwareAlerts.map((alert, idx) => (
                <li key={idx}>{alert}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Grid de Métricas do Bloco SYS */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="p-3 rounded-xl bg-sunken/60 border border-line flex items-center gap-3">
            <div className="p-2 rounded-lg bg-brand/10 text-brand">
              <Cpu className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-medium text-ink-muted block">
                Firmware (Partição) <InfoTip k="firmware" align="left" />
              </span>
              <span className="text-sm font-bold text-ink truncate block">
                {telemetry.fw ? `v${telemetry.fw}${partSuffix}` : 'Não informado'}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-sunken/60 border border-line flex items-center gap-3">
            <div className={`p-2 rounded-lg ${rssiBadgeClass}`}>
              <Wifi className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-medium text-ink-muted block">
                Wi-Fi ({rssiInfo.label}) <InfoTip k="rssi" align="left" />
              </span>
              <span className="text-sm font-bold text-ink truncate block">
                {telemetry.rssi !== null ? `${telemetry.rssi} dBm` : '--'}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-sunken/60 border border-line flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100 text-info">
              <Clock className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-medium text-ink-muted block">
                Tempo ativo <InfoTip k="uptime" align="left" />
              </span>
              <span className="text-sm font-bold text-ink truncate block">
                {formatUptime(telemetry.uptimeSeconds)}
              </span>
            </div>
          </div>

          <div className="p-3 rounded-xl bg-sunken/60 border border-line flex items-center gap-3">
            <div className={`p-2 rounded-lg ${walBadgeClass}`}>
              <HardDrive className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <span className="text-xs font-medium text-ink-muted block">
                Fila no cartão SD <InfoTip k="wal" align="left" />
              </span>
              <span className="text-sm font-bold text-ink truncate block">
                {!telemetry.sdOk
                  ? 'ERRO NO CARTÃO SD'
                  : formatPendingBytes(telemetry.pendingBytes)}
              </span>
            </div>
          </div>
        </div>

        {/* Linha Inferior: Contagem de Boots e Reset */}
        <div className="mt-3 p-3 rounded-xl bg-sunken/60 border border-line flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <RotateCcw className="w-4 h-4 text-ink-muted shrink-0" />
            <span className="text-xs font-medium text-ink-muted">Reinícios / último motivo <InfoTip k="boot" align="left" /></span>
          </div>
          <span className="text-xs font-bold text-ink truncate">
            #{telemetry.bootCount ?? '--'} • {formatResetReason(telemetry.resetReason)}
          </span>
        </div>

        {/* AGRO_E1: Proteções da estação (firmware 5.26.0+) */}
        {protectionInfo && (
          <div className={`mt-3 p-3 rounded-xl border text-xs ${protectionClass}`}>
            <div className="flex items-center gap-2 font-bold mb-1">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>Proteções da estação</span>
              <InfoTip k="protecoes" align="left" />
            </div>
            <ul className="space-y-0.5 text-ink">
              {protectionInfo.items.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        {telemetry.localControls && (() => {
          const lcInfo = describeLocalControlsSummary(telemetry.localControls, readingAgeS(telemetry.timestamp));
          return (
            <div
              data-testid="health-local-controls"
              className={`mt-3 p-3 rounded-xl border text-xs flex items-start gap-2 ${
                lcInfo.tone === 'warn' ? 'bg-amber-50 border-amber-200 text-warning' : 'bg-subtle border-line text-ink-soft'
              }`}
            >
              <Monitor className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="font-semibold">{lcInfo.text}</span>
              <InfoTip k="displayEstacao" align="right" className="ml-auto" />
            </div>
          );
        })()}

        <p className="text-xs text-center text-ink-muted mt-3">
          Clique no card para inspecionar RAM FreeRTOS, reconexões MQTT, ADC 12-bit e NVS
        </p>
      </div>

      <FreeRtosInspectModal
        isOpen={isInspectOpen}
        telemetry={telemetry}
        timezoneOffset={timezoneOffset}
        onClose={() => setIsInspectOpen(false)}
      />
    </div>
  );
}