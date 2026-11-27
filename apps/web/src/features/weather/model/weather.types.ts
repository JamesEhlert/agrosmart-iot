/**
 * =====================================================================================
 * ARQUIVO: src/features/weather/model/weather.types.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T05:15:00-03:00
 * VERSÃO: v5.24.3
 * PROPÓSITO: Tipos e tradutor WMO para integração com a API meteorológica Open-Meteo.
 * =====================================================================================
 */

export interface DailyForecastItem {
  dateStr: string;
  weatherCode: number;
  maxTemp: number;
  minTemp: number;
  precipitationSumMm: number;
  rainProbabilityMax: number;
}

export interface WeatherForecastData {
  currentTemp: number;
  currentWeatherCode: number;
  todayMaxTemp: number;
  todayMinTemp: number;
  todayRainProb: number;
  daily: DailyForecastItem[];
}

export interface WmoWeatherInfo {
  label: string;
  kind: 'sun' | 'cloud' | 'fog' | 'drizzle' | 'rain' | 'heavy_rain' | 'storm';
}

/**
 * Traduz o código WMO da Open-Meteo exatamente como em `weather_summary_card.dart`.
 */
export function getWmoWeatherInfo(code: number): WmoWeatherInfo {
  switch (code) {
    case 0:
      return { label: 'Céu Limpo', kind: 'sun' };
    case 1:
    case 2:
    case 3:
      return { label: 'Nublado', kind: 'cloud' };
    case 45:
    case 48:
      return { label: 'Nevoeiro', kind: 'fog' };
    case 51:
    case 53:
    case 55:
      return { label: 'Garoa', kind: 'drizzle' };
    case 61:
    case 63:
    case 65:
      return { label: 'Chuva', kind: 'rain' };
    case 80:
    case 81:
    case 82:
      return { label: 'Chuva Forte', kind: 'heavy_rain' };
    case 95:
    case 96:
    case 99:
      return { label: 'Tempestade', kind: 'storm' };
    default:
      return { label: 'Instável', kind: 'cloud' };
  }
}