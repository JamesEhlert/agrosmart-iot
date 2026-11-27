/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/components/SensorSummaryGrid.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T05:15:00-03:00
 * VERSÃO: v5.24.3
 * PROPÓSITO: Grid responsivo dos 6 sensores ambientais e de solo (paridade visual e
 *            semântica com `sensor_cards.dart` do aplicativo Flutter).
 * =====================================================================================
 */

import React from 'react';
import {
  Thermometer,
  Droplets,
  Sprout,
  Sun,
  Sparkles,
  CloudRain,
  Cloud,
  AlertTriangle,
} from 'lucide-react';
import { TelemetryModel } from '../model/telemetry.types';
import { SensorCapability } from '../../devices/model/device.types';
import { AgroColors } from '../../../shared/theme/agroColors';

interface SensorSummaryGridProps {
  telemetry: TelemetryModel | null;
  isLoading: boolean;
  capabilities: SensorCapability[];
  targetSoilMoisture: number;
}

interface SensorCardItemProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  subLabel?: string;
  accentColor: string;
  progressPct: number | null;
  isError?: boolean;
}

function SensorCardItem({
  icon,
  label,
  value,
  subLabel,
  accentColor,
  progressPct,
  isError = false,
}: SensorCardItemProps) {
  const clampedPct =
    progressPct !== null ? Math.max(0, Math.min(100, progressPct)) : null;

  return (
    <div
      className={`bg-white rounded-2xl border p-3 sm:p-4 shadow-sm transition hover:shadow-md flex flex-col justify-between min-w-0 ${
        isError ? 'border-red-300 bg-red-50/20' : 'border-line'
      }`}
    >
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <span className="text-xs font-bold sm:uppercase sm:tracking-wider text-ink-muted block truncate">
            {label}
          </span>
          <span
            className={`text-xl sm:text-2xl font-extrabold mt-1 block tabular-nums ${
              isError ? 'text-danger' : 'text-ink'
            }`}
          >
            {value}
          </span>
        </div>
        <div
          className="p-2 sm:p-3 rounded-xl sm:rounded-2xl shrink-0"
          style={{
            backgroundColor: `${accentColor}1F`,
            color: accentColor,
          }}
        >
          {icon}
        </div>
      </div>

      <div className="mt-3 sm:mt-4">
        {clampedPct !== null ? (
          <div className="w-full h-2 rounded-full bg-sunken overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${clampedPct}%`,
                backgroundColor: accentColor,
              }}
            />
          </div>
        ) : (
          <div className="h-2 rounded-full bg-red-100" />
        )}

        {subLabel && (
          <p className="text-xs font-medium text-ink-muted mt-2 truncate">
            {subLabel}
          </p>
        )}
      </div>
    </div>
  );
}

export function SensorSummaryGrid({
  telemetry,
  isLoading,
  capabilities,
  targetSoilMoisture,
}: SensorSummaryGridProps) {
  if (isLoading && !telemetry) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, idx) => (
          <div
            key={idx}
            className="bg-surface rounded-2xl border border-line p-4 h-32 animate-pulse flex flex-col justify-between"
          >
            <div className="flex justify-between">
              <div className="space-y-2">
                <div className="w-20 h-3 bg-slate-200 rounded" />
                <div className="w-16 h-6 bg-slate-200 rounded" />
              </div>
              <div className="w-11 h-11 rounded-2xl bg-slate-200" />
            </div>
            <div className="w-full h-2 bg-slate-200 rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  if (!telemetry) return null;

  const cards: SensorCardItemProps[] = [];

  if (capabilities.includes('air')) {
    cards.push({
      icon: <Thermometer className="w-6 h-6" />,
      label: 'Temp. do Ar',
      value: telemetry.ahtOk ? `${telemetry.airTemp.toFixed(1)}°C` : 'ERRO I2C',
      subLabel: telemetry.ahtOk
        ? 'Sensor digital AHT10/20'
        : 'Falha de leitura no barramento I2C',
      accentColor: telemetry.ahtOk ? AgroColors.sensorTemp : AgroColors.error,
      progressPct: telemetry.ahtOk ? (telemetry.airTemp / 50) * 100 : null,
      isError: !telemetry.ahtOk,
    });

    cards.push({
      icon: <Droplets className="w-6 h-6" />,
      label: 'Umid. do Ar',
      value: telemetry.ahtOk ? `${telemetry.airHumidity.toFixed(0)}%` : 'ERRO I2C',
      subLabel: telemetry.ahtOk
        ? 'Umidade relativa ambiente'
        : 'Verifique conexão do sensor AHT',
      accentColor: telemetry.ahtOk ? AgroColors.sensorHumidity : AgroColors.error,
      progressPct: telemetry.ahtOk ? telemetry.airHumidity : null,
      isError: !telemetry.ahtOk,
    });
  }

  if (capabilities.includes('soil')) {
    const belowTarget = telemetry.soilMoisture < targetSoilMoisture;
    cards.push({
      icon: telemetry.soilFault ? (
        <AlertTriangle className="w-6 h-6" />
      ) : (
        <Sprout className="w-6 h-6" />
      ),
      label: telemetry.soilFault ? 'Falha no Solo' : 'Umid. do Solo',
      value: telemetry.soilFault ? 'CABO/ADC' : `${telemetry.soilMoisture.toFixed(0)}%`,
      subLabel: telemetry.soilFault
        ? 'Leitura ADC fora da faixa (100..4080)'
        : `Meta: ${targetSoilMoisture.toFixed(0)}% (${belowTarget ? 'Abaixo da meta' : 'Solo úmido'})`,
      accentColor: telemetry.soilFault ? AgroColors.error : AgroColors.sensorSoil,
      progressPct: telemetry.soilFault ? null : telemetry.soilMoisture,
      isError: telemetry.soilFault,
    });
  }

  if (capabilities.includes('light')) {
    cards.push({
      icon: <Sun className="w-6 h-6" />,
      label: 'Luminosidade',
      value: `${telemetry.lightLevel.toFixed(0)}%`,
      subLabel: 'Incidência solar (LDR GPIO 33)',
      accentColor: '#D97706',
      progressPct: telemetry.lightLevel,
    });
  }

  if (capabilities.includes('uv')) {
    cards.push({
      icon: <Sparkles className="w-6 h-6" />,
      label: 'Índice UV',
      value: telemetry.uvIndex.toFixed(1),
      subLabel:
        telemetry.uvIndex >= 8
          ? 'Radiação Muito Alta'
          : telemetry.uvIndex >= 3
            ? 'Radiação Moderada'
            : 'Radiação Baixa',
      accentColor: AgroColors.sensorUv,
      progressPct: (telemetry.uvIndex / 11) * 100,
    });
  }

  if (capabilities.includes('rain')) {
    cards.push({
      icon: telemetry.rainDetected ? (
        <CloudRain className="w-6 h-6" />
      ) : (
        <Cloud className="w-6 h-6" />
      ),
      label: telemetry.rainDetected ? 'Chovendo Agora!' : 'Chuva (Seco)',
      value: `${telemetry.rainPct}%`,
      subLabel: telemetry.rainDetected
        ? 'Edge Rain Interlock ativo na placa'
        : `ADC Chuva: ${telemetry.rainRaw} / 4095`,
      accentColor: telemetry.rainDetected ? AgroColors.info : AgroColors.sensorRain,
      progressPct: telemetry.rainPct,
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3 px-1">
        <h2 className="text-sm font-bold uppercase tracking-wider text-ink-muted">
          <span className="sm:hidden">Sensores agora</span>
          <span className="hidden sm:inline">Ambiente & Solo (Tempo Real)</span>
        </h2>
        <span className="text-xs font-semibold text-brand">
          {cards.length}<span className="hidden sm:inline"> sensores monitorados</span><span className="sm:hidden"> sensores</span>
        </span>
      </div>
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-2.5 sm:gap-4" data-testid="sensor-grid">
        {cards.map((card, index) => (
          <SensorCardItem key={index} {...card} />
        ))}
      </div>
    </div>
  );
}