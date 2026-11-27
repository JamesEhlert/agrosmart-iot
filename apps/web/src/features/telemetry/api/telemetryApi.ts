/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/api/telemetryApi.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-05T03:00:00-03:00
 * VERSÃO: v5.25.2-diag
 * PROPÓSITO: Cliente REST para consulta de séries temporais no Amazon DynamoDB via
 *            endpoint `GET /telemetry` com log de auditoria das amostras recebidas.
 * =====================================================================================
 */

import { awsAuthenticatedFetch } from '../../../shared/api/httpClient';
import { EnvConfig } from '../../../shared/config/env';
import { logWebDiagnostic } from '../../../shared/lib/diagnostics';
import { parseTelemetryHistoryResponse } from '../model/telemetry.schema';
import { TelemetryHistoryResponse, TelemetryModel } from '../model/telemetry.types';

export async function fetchLatestTelemetry(
  deviceId: string,
  signal?: AbortSignal,
): Promise<TelemetryModel | null> {
  const params = new URLSearchParams({
    device_id: deviceId,
    limit: '1',
  });
  const url = `${EnvConfig.aws.telemetryEndpoint}?${params.toString()}`;
  const raw = await awsAuthenticatedFetch<Record<string, unknown>>(url, {
    method: 'GET',
    signal,
  });

  const rawItems = Array.isArray(raw.data) ? (raw.data as Record<string, unknown>[]) : [];
  const firstRaw = rawItems.length > 0 ? rawItems[0] : null;
  const parsed = parseTelemetryHistoryResponse(raw);
  const latest = parsed.items.length > 0 ? parsed.items[0] : null;

  if (latest && firstRaw) {
    const rawSensors = (firstRaw.sensors as Record<string, unknown> | undefined) ?? {};
    const rawSys = (firstRaw.sys as Record<string, unknown> | undefined) ?? {};
    logWebDiagnostic('INFO', 'telemetry.latest.received', {
      device_id: deviceId,
      telemetry_id: firstRaw.telemetry_id ?? null,
      telemetry_seq: firstRaw.telemetry_seq ?? null,
      device_ts: firstRaw.timestamp ?? null,
      soil_moisture_pct: latest.soilMoisture,
      soil_raw_adc: rawSensors.soil_raw ?? latest.soilRaw,
      soil_fault: latest.soilFault,
      rain_detected: latest.rainDetected,
      rain_raw_adc: rawSensors.rain_raw ?? latest.rainRaw,
      air_temp_c: latest.airTemp,
      air_humidity_pct: latest.airHumidity,
      light_level_pct: latest.lightLevel,
      uv_index: latest.uvIndex,
      fw: latest.fw,
      boot_id: rawSys.boot_id ?? null,
      pending_bytes: latest.pendingBytes,
      // Não existe `valveState` no TelemetryModel: usa apenas campos brutos,
      // caso estejam presentes na amostra, sem inventar valor de estado.
      valve_state: firstRaw.valve_state ?? rawSys.valve_state ?? null,
    });
  }

  return latest;
}

export interface FetchTelemetryHistoryParams {
  deviceId: string;
  limit?: number;
  nextToken?: string | null;
  startDate?: Date;
  endDate?: Date;
  downsample?: number;
  signal?: AbortSignal;
}

export async function fetchTelemetryHistory(
  params: FetchTelemetryHistoryParams,
): Promise<TelemetryHistoryResponse> {
  const query = new URLSearchParams({
    device_id: params.deviceId,
    limit: String(params.limit ?? 50),
  });

  if (params.nextToken) {
    query.set('next_token', params.nextToken);
  }
  if (params.startDate && params.endDate) {
    query.set('start_time', String(Math.floor(params.startDate.getTime() / 1000)));
    query.set('end_time', String(Math.floor(params.endDate.getTime() / 1000)));
  }
  if (params.downsample && params.downsample > 0) {
    query.set('downsample', String(params.downsample));
  }

  const url = `${EnvConfig.aws.telemetryEndpoint}?${query.toString()}`;
  const raw = await awsAuthenticatedFetch<Record<string, unknown>>(url, {
    method: 'GET',
    signal: params.signal,
  });

  const parsed = parseTelemetryHistoryResponse(raw);
  logWebDiagnostic('DEBUG', 'telemetry.history.received', {
    device_id: params.deviceId,
    returned_count: parsed.items.length,
    raw_scanned_count: parsed.rawScannedCount,
    downsampled: parsed.downsampled,
    partial_window: parsed.partialWindow,
    has_next_token: Boolean(parsed.nextToken),
  });

  return parsed;
}
