/**
 * =====================================================================================
 * ARQUIVO: src/features/weather/api/weatherApi.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T01:05:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Consulta a previsão hiperlocal atual e de 7 dias na API Open-Meteo.
 * CHANGELOG:
 * - v5.25.0: [Auditoria 04 - CL-1] Valida a presença e finitude dos campos `current` e
 *            `daily` antes de converter, impedindo que respostas vazias ou parciais
 *            fabriquem `0°C` e `WMO 0 (Céu Limpo)`.
 * =====================================================================================
 */

import { DailyForecastItem, WeatherForecastData } from '../model/weather.types';

function parseFiniteMetric(val: unknown): number | null {
  if (val === undefined || val === null || typeof val === 'boolean') return null;
  if (typeof val === 'string' && !val.trim()) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

export async function fetchOpenMeteoForecast(
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<WeatherForecastData | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  if (latitude === 0 && longitude === 0) {
    return null;
  }

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${latitude}&longitude=${longitude}` +
    `&current=temperature_2m,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max` +
    `&timezone=auto`;

  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Open-Meteo retornou HTTP ${response.status}`);
  }

  const root = (await response.json()) as Record<string, unknown>;
  const current = (root.current as Record<string, unknown> | undefined) ?? {};
  const daily = (root.daily as Record<string, unknown> | undefined) ?? {};

  const currentTempRaw = parseFiniteMetric(current.temperature_2m);
  const currentCodeRaw = parseFiniteMetric(current.weather_code);

  const times = Array.isArray(daily.time) ? (daily.time as unknown[]) : [];
  const codes = Array.isArray(daily.weather_code) ? (daily.weather_code as unknown[]) : [];
  const maxTemps = Array.isArray(daily.temperature_2m_max)
    ? (daily.temperature_2m_max as unknown[])
    : [];
  const minTemps = Array.isArray(daily.temperature_2m_min)
    ? (daily.temperature_2m_min as unknown[])
    : [];
  const precipSums = Array.isArray(daily.precipitation_sum)
    ? (daily.precipitation_sum as unknown[])
    : [];
  const rainProbs = Array.isArray(daily.precipitation_probability_max)
    ? (daily.precipitation_probability_max as unknown[])
    : [];

  if (currentTempRaw === null || currentCodeRaw === null || times.length === 0) {
    throw new Error('Resposta meteorológica incompleta recebida da Open-Meteo.');
  }

  const dailyItems: DailyForecastItem[] = [];
  for (let idx = 0; idx < times.length; idx++) {
    const rawDate = times[idx];
    if (typeof rawDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate.trim())) {
      continue;
    }
    const codeVal = parseFiniteMetric(codes[idx]);
    const maxVal = parseFiniteMetric(maxTemps[idx]);
    const minVal = parseFiniteMetric(minTemps[idx]);
    const precipVal = parseFiniteMetric(precipSums[idx]);
    const probVal = parseFiniteMetric(rainProbs[idx]);

    if (maxVal === null || minVal === null) {
      continue;
    }

    dailyItems.push({
      dateStr: rawDate.trim(),
      weatherCode: codeVal !== null ? Math.trunc(codeVal) : currentCodeRaw,
      maxTemp: Math.round(maxVal),
      minTemp: Math.round(minVal),
      precipitationSumMm: precipVal !== null ? Math.max(0, precipVal) : 0,
      rainProbabilityMax:
        probVal !== null ? Math.max(0, Math.min(100, Math.round(probVal))) : 0,
    });
  }

  if (dailyItems.length === 0) {
    throw new Error('Séries diárias de previsão ausentes na resposta da Open-Meteo.');
  }

  return {
    currentTemp: Math.round(currentTempRaw),
    currentWeatherCode: Math.trunc(currentCodeRaw),
    todayMaxTemp: dailyItems[0].maxTemp,
    todayMinTemp: dailyItems[0].minTemp,
    todayRainProb: dailyItems[0].rainProbabilityMax,
    daily: dailyItems,
  };
}