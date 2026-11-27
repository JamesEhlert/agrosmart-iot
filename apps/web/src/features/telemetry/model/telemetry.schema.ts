/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/model/telemetry.schema.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T00:35:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Desserialização defensiva e geração automática de alertas de integridade
 *            física dos periféricos do ESP32 (SPI MicroSD, I2C RTC, I2C AHT e ADC Solo).
 * CHANGELOG:
 * - v5.25.0: [Auditoria 02 + Roadmap 4.5]
 *            1. Filtra registros inválidos (arrays ou itens sem timestamp válido) para
 *               nunca fabricar leituras falsas com relógio do navegador;
 *            2. `parseFiniteNumber` impede que strings vazias ou `NaN` poluam as séries;
 *            3. Adiciona mensagem explicativa quando `sys.health === 'alert'` isolado;
 *            4. Mapeia campos opcionais `battery_v` e `battery_pct`.
 * =====================================================================================
 */

import {
  StationLocalControls,
  StationProtections,
  TelemetryHistoryResponse,
  TelemetryModel,
} from './telemetry.types';

function parseBoolWithDefault(val: unknown, defaultValue: boolean): boolean {
  if (val === undefined || val === null) return defaultValue;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const clean = val.trim().toLowerCase();
    if (clean === 'true' || clean === '1') return true;
    if (clean === 'false' || clean === '0') return false;
  }
  return defaultValue;
}

function parseOptionalInt(val: unknown): number | null {
  if (val === undefined || val === null || typeof val === 'boolean') return null;
  if (typeof val === 'string' && !val.trim()) return null;
  const n = Number(val);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function parseOptionalFloat(val: unknown): number | null {
  if (val === undefined || val === null || typeof val === 'boolean') return null;
  if (typeof val === 'string' && !val.trim()) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseFiniteNumber(val: unknown, fallback = 0): number {
  const parsed = parseOptionalFloat(val);
  return parsed !== null ? parsed : fallback;
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Converte um item JSON vindo do DynamoDB em um objeto `TelemetryModel` validado.
 */
export function parseTelemetryItem(raw: Record<string, unknown>): TelemetryModel {
  const sensors = isPlainRecord(raw.sensors) ? raw.sensors : {};
  const sys = isPlainRecord(raw.sys) ? raw.sys : {};

  const rainRaw = parseOptionalInt(sensors.rain_raw) ?? 4095;
  const computedRainPct = Math.max(
    0,
    Math.min(100, Math.trunc(((4095 - rainRaw) * 100) / (4095 - 1500))),
  );
  const explicitRainPct = parseOptionalFloat(sensors.rain_pct);
  const rainPct =
    explicitRainPct !== null
      ? Math.max(0, Math.min(100, Math.round(explicitRainPct)))
      : computedRainPct;

  const rainDetected =
    sensors.rain_detected !== undefined && sensors.rain_detected !== null
      ? parseBoolWithDefault(sensors.rain_detected, false)
      : rainPct > 50;

  const soilFault =
    parseBoolWithDefault(sensors.soil_fault, false) ||
    parseBoolWithDefault(sys.soil_fault, false);

  const sdOk = parseBoolWithDefault(sys.sd_ok, true);
  const rtcOk = parseBoolWithDefault(sys.rtc_ok, true);
  const ahtOk = parseBoolWithDefault(sys.aht_ok, true);
  const sdErrors = parseOptionalInt(sys.sd_err) ?? 0;
  const corruptLines = parseOptionalInt(sys.corrupt_lines) ?? 0;
  const rainInterlocks = parseOptionalInt(sys.rain_interlocks) ?? 0;
  const healthStatus = typeof sys.health === 'string' ? sys.health : null;

  const hardwareAlerts: string[] = [];
  if (!sdOk) {
    hardwareAlerts.push('Cartão MicroSD indisponível ou com falha de comunicação SPI.');
  }
  if (!rtcOk) {
    hardwareAlerts.push('Módulo RTC DS3231 (Relógio I2C) não detectado.');
  }
  if (!ahtOk) {
    hardwareAlerts.push('Sensor de Temp./Umidade do Ar (AHT I2C) com falha de leitura.');
  }
  if (soilFault) {
    hardwareAlerts.push(
      'Sensor de Solo com leitura elétrica inválida (verifique cabo ou conexão no GPIO 34).',
    );
  }
  if (corruptLines > 0) {
    hardwareAlerts.push(
      `${corruptLines} registro(s) corrompido(s) no SD foram isolados e descartados.`,
    );
  }

  const hasHardwareFault =
    !sdOk || !rtcOk || !ahtOk || soilFault || healthStatus === 'alert';

  if (hasHardwareFault && hardwareAlerts.length === 0) {
    hardwareAlerts.push(
      'A estação reportou estado de alerta geral no autodiagnóstico embarcado.',
    );
  }

  const rawTs = parseOptionalFloat(raw.timestamp) ?? 0;
  const timestamp =
    rawTs > 0
      ? new Date(rawTs > 100_000_000_000 ? rawTs : rawTs * 1000)
      : new Date(0);

  return {
    airTemp: parseFiniteNumber(sensors.air_temp, 0),
    airHumidity: Math.max(0, Math.min(100, parseFiniteNumber(sensors.air_humidity, 0))),
    soilMoisture: Math.max(0, Math.min(100, parseFiniteNumber(sensors.soil_moisture, 0))),
    soilRaw: parseOptionalInt(sensors.soil_raw),
    uvIndex: Math.max(0, parseFiniteNumber(sensors.uv_index, 0)),
    lightLevel: Math.max(0, Math.min(100, parseFiniteNumber(sensors.light_level, 0))),
    rainRaw,
    rainPct,
    rainDetected,
    timestamp,
    fw: typeof sys.fw === 'string' && sys.fw.trim() ? sys.fw.trim().replace(/^[vV]/, '') : null,
    part: typeof sys.part === 'string' && sys.part.trim() ? sys.part.trim() : null,
    rssi: parseOptionalInt(sys.rssi),
    uptimeSeconds: parseOptionalInt(sys.uptime_s),
    freeHeap: parseOptionalInt(sys.heap),
    bootCount: parseOptionalInt(sys.boot_count),
    bootId: typeof sys.boot_id === 'string' ? sys.boot_id : null,
    resetReason: typeof sys.reset_reason === 'string' ? sys.reset_reason : null,
    tsSource: typeof sys.ts_source === 'string' ? sys.ts_source : null,
    pendingBytes: parseOptionalInt(sys.pending_bytes),
    wifiDisconnects: parseOptionalInt(sys.wifi_disc),
    mqttReconnects: parseOptionalInt(sys.mqtt_reconn),
    teleIntMs: parseOptionalInt(sys.tele_int_ms),
    soilDry: parseOptionalInt(sys.soil_dry),
    soilWet: parseOptionalInt(sys.soil_wet),
    batteryVoltage: parseOptionalFloat(sys.battery_v ?? sensors.battery_v),
    batteryPct: parseOptionalInt(sys.battery_pct ?? sensors.battery_pct),
    healthStatus,
    sdOk,
    rtcOk,
    ahtOk,
    soilFault,
    sdErrors,
    corruptLines,
    rainInterlocks,
    hasHardwareFault,
    hardwareAlerts,
    protections: parseStationProtections(sys),
    localControls: parseStationLocalControls(sys),
  };
}

/** v5.41.0: display e botões (firmware 5.27.0+); versões antigas devolvem null. */
export function parseStationLocalControls(sys: Record<string, unknown>): StationLocalControls | null {
  if (sys.disp === undefined || sys.disp === null) return null;
  const left = parseOptionalInt(sys.disp_left_s);
  const btn = parseOptionalInt(sys.btn_min);
  const fault = parseOptionalInt(sys.btn_fault);
  return {
    displayOn: parseBoolWithDefault(sys.disp, false),
    displayDefaultOn: parseBoolWithDefault(sys.disp_def, true),
    displayLeftS: left !== null && left > 0 ? left : 0,
    btnIrrigMin: btn !== null && btn >= 1 && btn <= 15 ? btn : null,
    btnFault: fault !== null && fault > 0 ? fault & 3 : 0,
  };
}

/** AGRO_E1: lê as proteções do firmware 5.26.0+; versões antigas devolvem null. */
export function parseStationProtections(sys: Record<string, unknown>): StationProtections | null {
  const hasAny = ['flood_rejects', 'ack_outbox_used', 'ack_write_fail', 'ack_abandoned'].some(
    (k) => sys[k] !== undefined && sys[k] !== null,
  );
  if (!hasAny) return null;
  return {
    ackOutboxUsed: parseOptionalInt(sys.ack_outbox_used),
    ackOutboxPending: parseOptionalInt(sys.ack_outbox_pending),
    ackOutboxFault: parseBoolWithDefault(sys.ack_outbox_fault, false),
    floodRejects: parseOptionalInt(sys.flood_rejects) ?? 0,
    cmdRejected: parseOptionalInt(sys.cmd_rejected) ?? 0,
    ackWriteFail: parseOptionalInt(sys.ack_write_fail) ?? 0,
    ackAbandoned: parseOptionalInt(sys.ack_abandoned) ?? 0,
    ackRepaired: parseOptionalInt(sys.ack_repaired) ?? 0,
    nvsFree: parseOptionalInt(sys.nvs_free),
  };
}

/**
 * Desserializa a resposta completa da Lambda `AgroSmart_V5_GetTelemetry`,
 * descartando entradas malformadas ou sem timestamp válido.
 */
export function parseTelemetryHistoryResponse(
  root: Record<string, unknown>,
): TelemetryHistoryResponse {
  const rawList = Array.isArray(root?.data) ? root.data : [];
  const items = rawList
    .filter((item): item is Record<string, unknown> => {
      if (!isPlainRecord(item)) return false;
      const ts = parseOptionalFloat(item.timestamp);
      return ts !== null && ts > 0;
    })
    .map(parseTelemetryItem);

  return {
    items,
    count: parseOptionalInt(root?.count) ?? items.length,
    rawScannedCount: parseOptionalInt(root?.raw_scanned_count) ?? items.length,
    downsampled: Boolean(root?.downsampled),
    truncatedBy1Mb: Boolean(root?.truncated_by_1mb),
    partialWindow: Boolean(root?.partial_window),
    coveredStartTs: parseOptionalInt(root?.covered_start_ts),
    coveredEndTs: parseOptionalInt(root?.covered_end_ts),
    nextToken:
      typeof root?.next_token === 'string' && root.next_token.trim()
        ? root.next_token.trim()
        : null,
  };
}