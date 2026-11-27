/**
 * =====================================================================================
 * ARQUIVO: src/features/weather/components/WeatherSummaryBanner.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T01:05:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Banner executivo de clima atual com gradiente verde institucional
 *            (`#2E7D32` -> `#1B5E20`) e abertura do modal de 7 dias.
 * CHANGELOG:
 * - v5.25.0: [Auditoria 04 - CL-1/CL-2]
 *            1. Exibe estado explícito de falha com botão de nova tentativa quando a
 *               Open-Meteo estiver indisponível;
 *            2. Rotula "Chuva máx. hoje" e informa se o bloqueio automático de 3h está
 *               ativo ou desativado nas configurações da estação.
 * =====================================================================================
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Droplets, ChevronRight, MapPin, AlertCircle, RefreshCw } from 'lucide-react';
import { DeviceModel } from '../../devices/model/device.types';
import { fetchOpenMeteoForecast } from '../api/weatherApi';
import { getWmoWeatherInfo } from '../model/weather.types';
import { renderWmoIcon, WeatherForecastModal } from './WeatherForecastModal';

interface WeatherSummaryBannerProps {
  device: DeviceModel;
}

export function WeatherSummaryBanner({ device }: WeatherSummaryBannerProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const { latitude, longitude, deviceName, enableWeatherControl } = device.settings;
  const hasGps = latitude !== 0 || longitude !== 0;

  const {
    data: forecast,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['weather', device.id, latitude.toFixed(4), longitude.toFixed(4)],
    queryFn: ({ signal }) => fetchOpenMeteoForecast(latitude, longitude, signal),
    enabled: hasGps,
    staleTime: 10 * 60 * 1000,
  });

  if (!hasGps) {
    return (
      <div className="bg-surface rounded-2xl border border-line p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-sunken text-ink-muted">
            <MapPin className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">
              Clima Hiperlocal Sem Coordenadas GPS
            </p>
            <p className="text-xs text-ink-muted">
              Configure a Latitude e Longitude na aba Config para habilitar a previsão de 7 dias.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isLoading && !forecast) {
    return (
      <div className="h-28 rounded-2xl bg-gradient-to-r from-brand to-brand-strong animate-pulse p-5" />
    );
  }

  if (isError && !forecast) {
    return (
      <div className="bg-surface rounded-2xl border border-amber-200 p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 text-xs font-semibold text-warning">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>
            Previsão meteorológica Open-Meteo temporariamente indisponível para estas coordenadas.
          </span>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-amber-300 bg-amber-50 hover:bg-amber-100 text-xs font-bold text-ink transition"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Tentar Novamente</span>
        </button>
      </div>
    );
  }

  if (!forecast) return null;

  const info = getWmoWeatherInfo(forecast.currentWeatherCode);

  return (
    <>
      <div
        onClick={() => setIsModalOpen(true)}
        role="button"
        tabIndex={0}
        aria-label="Abrir previsão meteorológica de 7 dias"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setIsModalOpen(true);
          }
        }}
        className="rounded-2xl bg-gradient-to-br from-brand to-brand-strong text-white p-4 sm:p-5 shadow-md hover:shadow-lg transition cursor-pointer flex items-center justify-between gap-3 sm:gap-4"
      >
        <div className="flex items-center gap-3 sm:gap-5 min-w-0">
          <div className="flex flex-col items-center justify-center w-14 sm:w-16 text-center shrink-0">
            {renderWmoIcon(info.kind, 'w-9 h-9')}
            <span className="text-xs font-semibold mt-1 text-white/95 truncate max-w-full">
              {info.label}
            </span>
          </div>

          <div className="text-4xl sm:text-5xl font-extrabold tracking-tight">
            {forecast.currentTemp}°
          </div>

          <div className="space-y-1.5">
            <p className="text-xs sm:text-sm font-bold text-white">
              Máx {forecast.todayMaxTemp}° • Mín {forecast.todayMinTemp}°
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-black/20 text-xs font-semibold">
                <Droplets className="w-3.5 h-3.5 text-sky-300" />
                <span>Chuva máx. hoje: {forecast.todayRainProb}%</span>
              </div>
              <span className="text-xs font-medium text-emerald-100/90">
                • {enableWeatherControl ? 'Bloqueio 3h Ativo' : 'Bloqueio 3h Desativado'}
              </span>
            </div>
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-1 text-xs font-bold text-white/85">
          <span>Previsão 7 dias</span>
          <ChevronRight className="w-4 h-4" />
        </div>
        <ChevronRight className="sm:hidden w-5 h-5 text-white/85 shrink-0" aria-hidden="true" />
      </div>

      <WeatherForecastModal
        isOpen={isModalOpen}
        forecast={forecast}
        deviceName={deviceName}
        onClose={() => setIsModalOpen(false)}
      />
    </>
  );
}