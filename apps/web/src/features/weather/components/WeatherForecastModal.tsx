/**
 * =====================================================================================
 * ARQUIVO: src/features/weather/components/WeatherForecastModal.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T05:15:00-03:00
 * VERSÃO: v5.24.3
 * PROPÓSITO: Modal de Previsão Meteorológica de 7 Dias (paridade com `weather_screen.dart`).
 * =====================================================================================
 */

import { Dialog } from '../../../shared/ui';
import {
  Sun,
  Cloud,
  CloudFog,
  CloudDrizzle,
  CloudRain,
  CloudLightning,
  Droplets,
} from 'lucide-react';
import {
  getWmoWeatherInfo,
  WeatherForecastData,
  WmoWeatherInfo,
} from '../model/weather.types';

interface WeatherForecastModalProps {
  isOpen: boolean;
  forecast: WeatherForecastData | null;
  deviceName: string;
  onClose: () => void;
}

export function renderWmoIcon(kind: WmoWeatherInfo['kind'], className = 'w-6 h-6') {
  switch (kind) {
    case 'sun':
      return <Sun className={`${className} text-amber-400`} />;
    case 'fog':
      return <CloudFog className={`${className} text-slate-400`} />;
    case 'drizzle':
      return <CloudDrizzle className={`${className} text-sky-400`} />;
    case 'rain':
    case 'heavy_rain':
      return <CloudRain className={`${className} text-blue-500`} />;
    case 'storm':
      return <CloudLightning className={`${className} text-amber-500`} />;
    default:
      return <Cloud className={`${className} text-slate-400`} />;
  }
}

function formatDayLabel(dateIso: string, index: number): string {
  if (index === 0) return 'Hoje';
  const [yyyy, mm, dd] = dateIso.split('-').map(Number);
  const dt = new Date(yyyy, (mm || 1) - 1, dd || 1);
  const weekday = dt.toLocaleDateString('pt-BR', { weekday: 'long' });
  const cap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  return `${cap}, ${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}`;
}

export function WeatherForecastModal({
  isOpen,
  forecast,
  deviceName,
  onClose,
}: WeatherForecastModalProps) {
  if (!isOpen || !forecast) return null;

  return (
    // v5.45.0: janela padrão do design system
    <Dialog open onClose={onClose} title="Previsão do tempo · 7 dias" description={`Open-Meteo · ${deviceName}`}>
      <div>
        <div className="space-y-2.5">
          {forecast.daily.map((day, idx) => {
            const info = getWmoWeatherInfo(day.weatherCode);
            const highRainRisk = day.rainProbabilityMax >= 70;
            return (
              <div
                key={day.dateStr}
                className="p-3.5 rounded-xl bg-sunken/60 border border-line flex items-center justify-between gap-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="p-2 rounded-xl bg-surface border border-line">
                    {renderWmoIcon(info.kind, 'w-6 h-6')}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-ink truncate">
                      {formatDayLabel(day.dateStr, idx)}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {info.label} • Volume: {day.precipitationSumMm.toFixed(1)} mm
                    </p>
                  </div>
                </div>

                <div className="text-right shrink-0">
                  <p className="text-sm font-extrabold text-ink">
                    {day.maxTemp}°{' '}
                    <span className="text-ink-muted font-normal">/ {day.minTemp}°</span>
                  </p>
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full mt-0.5 ${
                      highRainRisk
                        ? 'bg-blue-100 text-info'
                        : 'bg-surface text-ink-muted'
                    }`}
                  >
                    <Droplets className="w-3 h-3" />
                    {day.rainProbabilityMax}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-ink-muted mt-4 text-center">
          Nota: O agendador AWS Lambda cancela regas automáticas quando a chance de chuva nas
          próximas 3 horas é ≥ 70%.
        </p>
      </div>
    </Dialog>
  );
}