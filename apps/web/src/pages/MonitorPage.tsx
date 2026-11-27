/**
 * =====================================================================================
 * ARQUIVO: src/pages/MonitorPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T01:05:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Página Principal ("Monitor") integrando Clima Open-Meteo, 6 Sensores AWS
 *            DynamoDB, Controle de Irrigação com ACK e Saúde da Estação (FreeRTOS).
 * CHANGELOG:
 * - v5.25.0: [Auditorias 02 e 05 - UI-03]
 *            1. Adicionado Badge de Frescor da Telemetria (`classifyTelemetryFreshness`)
 *               que avalia a idade real do pacote em relação ao `telemetryIntervalMs`
 *               da estação (30s na bancada ou 10/30 min em campo);
 *            2. Limpeza segura do timer de pós-irrigação ao desmontar a tela.
 * =====================================================================================
 */

import { useEffect, useRef } from 'react';
import {
  CloudOff,
  LayoutDashboard,
  RefreshCw,
  Clock,
  AlertCircle,
  Radio,
} from 'lucide-react';
import { useSelectedDevice } from '../features/devices/hooks/useSelectedDevice';
import { useLatestTelemetry } from '../features/telemetry/hooks/useLatestTelemetry';
import { SensorSummaryGrid } from '../features/telemetry/components/SensorSummaryGrid';
import { StationHealthCard } from '../features/telemetry/components/StationHealthCard';
import { WeatherSummaryBanner } from '../features/weather/components/WeatherSummaryBanner';
import { ValveControlCard } from '../features/irrigation/components/ValveControlCard';
import {
  classifyTelemetryFreshness,
  formatWithDeviceTimezone,
} from '../shared/lib/formatters';
import { Button, PageHeader } from '../shared/ui';

/** v5.42.0 (WEB-23): espera após LIGAR/DESLIGAR antes de buscar a leitura nova (estação mede em +2 s). */
export const TELEMETRY_REFRESH_AFTER_VALVE_MS = 3500;

export function MonitorPage() {
  const { selectedDevice } = useSelectedDevice();
  const {
    data: telemetry,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useLatestTelemetry(selectedDevice?.id ?? null);

  const refreshTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [selectedDevice?.id]);

  if (!selectedDevice) return null;

  const tzOffset = selectedDevice.settings.timezoneOffset;
  const effectiveIntervalMs =
    telemetry?.teleIntMs ?? selectedDevice.settings.telemetryIntervalMs ?? 30000;
  const freshness = classifyTelemetryFreshness(
    telemetry?.timestamp,
    effectiveIntervalMs,
  );

  const freshnessBadgeClass =
    freshness.status === 'fresh'
      ? 'bg-emerald-100 text-brand-strong border-emerald-200'
      : freshness.status === 'delayed'
        ? 'bg-amber-100 text-warning border-amber-200'
        : 'bg-red-100 text-danger border-red-200';

  return (
    <div className="space-y-6">
      {/* 1. v5.46.0: cabeçalho padrão — presença, idade da coleta e atualizar */}
      <PageHeader
        icon={<LayoutDashboard className="w-5 h-5" />}
        title="Monitoramento"
        description={
          selectedDevice.isOnline ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-brand motion-safe:animate-pulse" aria-hidden="true" />
              Online · conectada à nuvem por MQTT com certificado (mTLS)
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-danger">
              <CloudOff className="w-4 h-4" aria-hidden="true" />
              Offline · mostrando a última leitura salva
            </span>
          )
        }
        actions={
          <>
            {telemetry && (
              <>
                <span className="inline-flex items-center gap-1.5 h-10 px-3 rounded-xl bg-surface border border-line text-xs font-bold text-ink">
                  <Clock className="w-3.5 h-3.5 text-brand" aria-hidden="true" />
                  Coleta {formatWithDeviceTimezone(telemetry.timestamp, tzOffset)}
                </span>
                <span className={`inline-flex items-center h-10 px-3 rounded-xl border text-xs font-extrabold ${freshnessBadgeClass}`}>
                  {freshness.badgeText}
                </span>
              </>
            )}
            <Button
              variant="secondary"
              disabled={isFetching}
              onClick={() => refetch()}
              icon={<RefreshCw className={`w-4 h-4 text-brand ${isFetching ? 'animate-spin' : ''}`} aria-hidden="true" />}
            >
              Atualizar
            </Button>
          </>
        }
      />

      {/* Aviso explícito caso a API AWS retorne erro */}
      {isError && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-center justify-between gap-4 text-xs text-danger">
          <div className="flex items-center gap-2.5 font-semibold">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span>
              Não foi possível buscar a telemetria na AWS:{' '}
              {(error as Error)?.message || 'Erro de rede'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="px-3 py-1.5 rounded-xl bg-surface border border-red-200 font-bold text-danger hover:bg-red-100 transition shrink-0"
          >
            Tentar Novamente
          </button>
        </div>
      )}

      {/* 2. Banner de Resumo Meteorológico Hiperlocal (Open-Meteo + Modal 7 Dias) */}
      <WeatherSummaryBanner device={selectedDevice} />

      {/* 3. Grid dos 6 Sensores Ambientais e de Solo (ou Card de Estação Sem Leituras) */}
      {!isLoading && !telemetry && !isError ? (
        <div className="bg-surface rounded-2xl border border-line p-8 text-center shadow-sm">
          <Radio className="w-10 h-10 text-ink-muted mx-auto mb-3" />
          <h3 className="text-base font-bold text-ink">
            Nenhum dado de telemetria encontrado para {selectedDevice.id}
          </h3>
          <p className="text-xs text-ink-muted mt-1 max-w-md mx-auto">
            Verifique se a estação ESP32 já enviou leituras para a tabela AgroTelemetryData_V5
            no Amazon DynamoDB ou clique em Atualizar.
          </p>
        </div>
      ) : (
        <SensorSummaryGrid
          telemetry={telemetry ?? null}
          isLoading={isLoading}
          capabilities={selectedDevice.settings.capabilities}
          targetSoilMoisture={selectedDevice.settings.targetMoisture}
        />
      )}

      {/* 4. Seção Inferior em Duas Colunas no Desktop: Controle de Válvula + Saúde FreeRTOS */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5">
          <ValveControlCard
            device={selectedDevice}
            onTelemetryRefreshRequested={() => {
              if (refreshTimerRef.current !== null) {
                window.clearTimeout(refreshTimerRef.current);
              }
              // v5.42.0 (WEB-23): a estação mede 2 s depois da válvula; buscar antes traria a leitura antiga.
              refreshTimerRef.current = window.setTimeout(() => {
                refetch();
              }, TELEMETRY_REFRESH_AFTER_VALVE_MS);
            }}
          />
        </div>

        <div className="lg:col-span-7">
          <StationHealthCard
            telemetry={telemetry ?? null}
            timezoneOffset={tzOffset}
          />
        </div>
      </div>
    </div>
  );
}