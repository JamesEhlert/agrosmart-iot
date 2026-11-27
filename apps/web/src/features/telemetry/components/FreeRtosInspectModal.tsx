/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/components/FreeRtosInspectModal.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T00:45:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Modal executivo "Inspeção de Telemetria & FreeRTOS" exibindo métricas de
 *            kernel, partição Dual-Bank, RAM Heap, reconexões mTLS, fila WAL e NVS.
 * CHANGELOG:
 * - v5.25.0: [Auditoria 02 + Roadmap 4.5]
 *            1. Corrigidas cores de Heap e Fila WAL quando ausentes (`null` usa tom
 *               neutro em vez de simular valor saudável);
 *            2. Não presume `app0` quando a partição não foi informada;
 *            3. Suporte a fechamento por tecla `Escape` e semântica ARIA de modal;
 *            4. Exibe tensão/nível de bateria quando reportado pelo hardware.
 * =====================================================================================
 */

import { Button, Dialog } from '../../../shared/ui';
import {
  Cpu,
  CheckCircle2,
  AlertOctagon,
  Wifi,
  HardDrive,
  Gauge,
  RefreshCw,
  CloudLightning,
  Sliders,
  BatteryCharging,
} from 'lucide-react';
import { TelemetryModel } from '../model/telemetry.types';
import {
  classifyRssiQuality,
  formatFreeHeap,
  formatPendingBytes,
  formatResetReason,
  formatUptime,
  formatWithDeviceTimezone,
} from '../../../shared/lib/formatters';

interface FreeRtosInspectModalProps {
  isOpen: boolean;
  telemetry: TelemetryModel | null;
  timezoneOffset: number;
  onClose: () => void;
}

export function FreeRtosInspectModal({
  isOpen,
  telemetry,
  timezoneOffset,
  onClose,
}: FreeRtosInspectModalProps) {

  if (!isOpen || !telemetry) return null;

  const rssiInfo = classifyRssiQuality(telemetry.rssi);
  const heapToneClass =
    telemetry.freeHeap === null
      ? 'text-ink-muted'
      : telemetry.freeHeap >= 55000
        ? 'text-brand'
        : 'text-warning';

  const walToneClass =
    telemetry.pendingBytes === null
      ? 'text-ink-muted'
      : telemetry.pendingBytes === 0
        ? 'text-brand'
        : 'text-warning';

  const buses = [
    { label: 'SPI MicroSD', ok: telemetry.sdOk },
    { label: 'I2C RTC DS3231', ok: telemetry.rtcOk },
    { label: 'I2C AHT10/20', ok: telemetry.ahtOk },
    { label: 'ADC Solo (GPIO 34)', ok: !telemetry.soilFault },
  ];

  return (
    // v5.45.0: janela padrão do design system
    <Dialog open onClose={onClose} size="lg" title="Inspeção de telemetria e FreeRTOS"
      description={`Coleta da amostra: ${formatWithDeviceTimezone(telemetry.timestamp, timezoneOffset)}`}
      footer={<Button variant="primary" onClick={onClose}>Fechar</Button>}>
      <div>
        <div className="space-y-5 mt-5 text-sm">
          {/* Seção 1: Kernel FreeRTOS & Partição Flash */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted mb-2.5">
              Kernel FreeRTOS & Partição Flash Dual-Bank
            </h3>
            <div className="bg-sunken/60 rounded-xl p-3.5 space-y-2.5 border border-line">
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted flex items-center gap-2">
                  <Cpu className="w-4 h-4" /> Firmware & Partição Ativa
                </span>
                <span className="font-bold text-brand-strong">
                  {telemetry.fw ? `v${telemetry.fw}` : '--'} (
                  {telemetry.part ?? 'partição não informada'})
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted flex items-center gap-2">
                  <Gauge className="w-4 h-4" /> Memória RAM Livre (Free Heap)
                </span>
                <span className={`font-bold ${heapToneClass}`}>
                  {formatFreeHeap(telemetry.freeHeap)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted flex items-center gap-2">
                  <RefreshCw className="w-4 h-4" /> Tempo Contínuo Ativo (Uptime)
                </span>
                <span className="font-bold text-ink">
                  {formatUptime(telemetry.uptimeSeconds)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted">
                  Contador de Boots (NVS) / Reset
                </span>
                <span className="font-bold text-ink">
                  #{telemetry.bootCount ?? '--'} ({formatResetReason(telemetry.resetReason)})
                </span>
              </div>
              {telemetry.batteryVoltage !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-ink-muted flex items-center gap-2">
                    <BatteryCharging className="w-4 h-4 text-brand" /> Alimentação / Bateria
                  </span>
                  <span className="font-bold text-ink">
                    {telemetry.batteryVoltage.toFixed(2)}V
                    {telemetry.batteryPct !== null ? ` (${telemetry.batteryPct}%)` : ''}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Seção 2: Conectividade mTLS & Resiliência de Borda */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted mb-2.5">
              Conectividade mTLS & Proteções de Borda
            </h3>
            <div className="bg-sunken/60 rounded-xl p-3.5 space-y-2.5 border border-line">
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted flex items-center gap-2">
                  <Wifi className="w-4 h-4" /> Potência Wi-Fi (RSSI)
                </span>
                <span className="font-bold text-ink">
                  {telemetry.rssi !== null
                    ? `${telemetry.rssi} dBm (${rssiInfo.label})`
                    : 'Não informado'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted">
                  Quedas de Wi-Fi / Reconexões MQTT
                </span>
                <span className="font-bold text-ink">
                  {telemetry.wifiDisconnects !== null ? `${telemetry.wifiDisconnects} Wi-Fi` : 'n/d'}{' '}
                  •{' '}
                  {telemetry.mqttReconnects !== null ? `${telemetry.mqttReconnects} MQTT` : 'n/d'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted flex items-center gap-2">
                  <CloudLightning className="w-4 h-4" /> Atuações do Edge Rain Interlock
                </span>
                <span className="font-bold text-ink">
                  {telemetry.rainInterlocks} bloqueio(s) na borda
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted">
                  Leitura ADC 12-bit (Solo / Chuva)
                </span>
                <span className="font-bold text-ink">
                  Solo: {telemetry.soilRaw ?? '--'} • Chuva: {telemetry.rainRaw} ({telemetry.rainPct}%)
                </span>
              </div>
            </div>
          </div>

          {/* Seção 3: Calibração NVS e Fila WAL MicroSD */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-ink-muted mb-2.5">
              Fila WAL MicroSD, NVS & Barramentos Físicos
            </h3>
            <div className="bg-sunken/60 rounded-xl p-3.5 space-y-2.5 border border-line">
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted flex items-center gap-2">
                  <HardDrive className="w-4 h-4" /> Fila Offline Write-Ahead Log (SD)
                </span>
                <span className={`font-bold ${walToneClass}`}>
                  {formatPendingBytes(telemetry.pendingBytes)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-muted">
                  Erros SPI SD / Linhas Corrompidas Isoladas
                </span>
                <span className="font-bold text-ink">
                  {telemetry.sdErrors} erro(s) • {telemetry.corruptLines} isolada(s)
                </span>
              </div>
              {telemetry.teleIntMs !== null && (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-ink-muted flex items-center gap-2">
                    <Sliders className="w-4 h-4" /> Calibração Gravada na Flash NVS
                  </span>
                  <span className="font-bold text-ink">
                    {Math.round(telemetry.teleIntMs / 1000)}s | Seco: {telemetry.soilDry ?? '--'} | Molhado:{' '}
                    {telemetry.soilWet ?? '--'}
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
              {buses.map((bus) => (
                <div
                  key={bus.label}
                  className={`px-2.5 py-2 rounded-xl border text-xs font-bold flex items-center gap-1.5 ${
                    bus.ok
                      ? 'bg-emerald-50 border-emerald-200 text-brand'
                      : 'bg-red-50 border-red-200 text-danger'
                  }`}
                >
                  {bus.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <AlertOctagon className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="truncate">{bus.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </Dialog>
  );
}