/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/model/telemetry.types.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T00:35:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Contratos TypeScript do pacote de Telemetria (Schema V2) gerado pelo
 *            ESP32 (v5.22.3) e retornado pela Lambda `AgroSmart_V5_GetTelemetry`.
 * CHANGELOG:
 * - v5.25.0: [Roadmap 4.5] Adicionados campos opcionais `batteryVoltage` e `batteryPct`
 *            para suportar futura bateria de backup com divisor de tensão no ESP32 sem
 *            quebrar o contrato atual.
 * - v5.24.3: Paridade total com `telemetry_model.dart` + campos NVS.
 * =====================================================================================
 */

export interface TelemetryModel {
  // 1. Grandezas dos 6 Sensores Ambientais e de Solo (Bloco 'sensors')
  airTemp: number;
  airHumidity: number;
  soilMoisture: number;
  soilRaw: number | null;
  uvIndex: number;
  lightLevel: number;
  rainRaw: number;
  rainPct: number;
  rainDetected: boolean;
  timestamp: Date;

  // 2. Métricas de Observabilidade e Saúde FreeRTOS (Bloco 'sys' - Schema V2)
  fw: string | null;
  part: string | null;
  rssi: number | null;
  uptimeSeconds: number | null;
  freeHeap: number | null;
  bootCount: number | null;
  bootId: string | null;
  resetReason: string | null;
  tsSource: string | null;
  pendingBytes: number | null;
  wifiDisconnects: number | null;
  mqttReconnects: number | null;

  // Parâmetros de calibração NVS reportados pela placa (FW v5.22.3+)
  teleIntMs: number | null;
  soilDry: number | null;
  soilWet: number | null;

  // Campos opcionais preparados para futura Bateria de Backup (Roadmap Seção 4.5)
  batteryVoltage: number | null;
  batteryPct: number | null;

  // 3. Flags de Integridade de Hardware e Detecção de Falhas Físicas
  healthStatus: string | null;
  sdOk: boolean;
  rtcOk: boolean;
  ahtOk: boolean;
  soilFault: boolean;
  sdErrors: number;
  corruptLines: number;
  rainInterlocks: number;

  // 4. Diagnósticos Derivados para a Interface (UI)
  hasHardwareFault: boolean;
  hardwareAlerts: string[];
  /** AGRO_E1: proteções do firmware 5.26.0+ (null quando a versão não envia). */
  protections: StationProtections | null;
  /** v5.41.0: display e botões do firmware 5.27.0+ (null quando a versão não envia). */
  localControls: StationLocalControls | null;
}

/** v5.41.0: estado do display e dos botões físicos (`sys.disp*`, `sys.btn_*`, firmware 5.27.0+). */
export interface StationLocalControls {
  /** Display aceso agora. */
  displayOn: boolean;
  /** Padrão gravado na placa: true = sempre ligado; false = apagado (acende pelo botão). */
  displayDefaultOn: boolean;
  /** Segundos até apagar (0 = sem prazo). */
  displayLeftS: number;
  /** Duração da irrigação pelo botão físico (minutos). */
  btnIrrigMin: number | null;
  /** Bits de botão travado: 1 = display, 2 = irrigação. */
  btnFault: number;
}

/** Envelope completo retornado pelo endpoint `GET /telemetry` da AWS. */
/** AGRO_E1: contadores de proteção publicados em `sys` pelo firmware 5.26.0+. */
export interface StationProtections {
  ackOutboxUsed: number | null;
  ackOutboxPending: number | null;
  ackOutboxFault: boolean;
  floodRejects: number;
  cmdRejected: number;
  ackWriteFail: number;
  ackAbandoned: number;
  ackRepaired: number;
  nvsFree: number | null;
}

export interface TelemetryHistoryResponse {
  items: TelemetryModel[];
  count: number;
  rawScannedCount: number;
  downsampled: boolean;
  truncatedBy1Mb: boolean;
  partialWindow: boolean;
  coveredStartTs: number | null;
  coveredEndTs: number | null;
  nextToken: string | null;
}