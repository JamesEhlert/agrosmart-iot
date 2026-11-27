/**
 * =====================================================================================
 * ARQUIVO: src/test/agrosmart_unit.test.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1C — Testes Web v5.31.0)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T19:03:00Z (UTC)
 * VERSÃO: v5.31.0
 * PROPÓSITO: Suíte Completa de 51 Testes Unitários e de Integração Simulada
 *            (WEB-UT-01 a WEB-UT-51) cobrindo os 5 Módulos originais + Fase 1A
 *            (WEB-UT-37 a WEB-UT-39) + Fase 1B (WEB-UT-40 a WEB-UT-46) + Fase 1C
 *            (WEB-UT-47 a WEB-UT-51: classifyOperatorProbe, demoClaimEndpoint,
 *            claimDemoPassAndLogin sem Authorization, rótulo Brasília e anti-PII).
 * CHANGELOG:
 * - v5.31.0: Acrescenta o Módulo 8 (WEB-UT-47 a WEB-UT-51) preservando todos os 46
 *            testes anteriores sem alterações destrutivas.
 * =====================================================================================
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firestoreMocks = vi.hoisted(() => ({
  doc: vi.fn(),
  getDoc: vi.fn(),
  deleteDoc: vi.fn(),
  runTransaction: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  signInWithCustomToken: vi.fn(),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: (...args: unknown[]) => firestoreMocks.doc(...args),
    getDoc: (...args: unknown[]) => firestoreMocks.getDoc(...args),
    deleteDoc: (...args: unknown[]) => firestoreMocks.deleteDoc(...args),
    runTransaction: (...args: unknown[]) => firestoreMocks.runTransaction(...args),
  };
});

vi.mock('firebase/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/auth')>();
  return {
    ...actual,
    signInWithCustomToken: (...args: unknown[]) => authMocks.signInWithCustomToken(...args),
  };
});

import {
  ApiException,
  awsAuthenticatedFetch,
  ConflictException,
  ForbiddenException,
  TooManyRequestsException,
  UnauthorizedException,
} from '../shared/api/httpClient';
import { EnvConfig } from '../shared/config/env';
import { firebaseAuth } from '../shared/config/firebase';
import {
  classifyRssiQuality,
  classifyTelemetryFreshness,
  compareSemver,
  escapeCsvCell,
  formatFreeHeap,
  formatPendingBytes,
  formatResetReason,
  formatUptime,
  formatWithDeviceTimezone,
  parseDateTimeLocalInputValue,
  toDateTimeLocalInputValue,
} from '../shared/lib/formatters';
import { clearWebDiagnostics, logWebDiagnostic } from '../shared/lib/diagnostics';
import {
  claimDemoPassAndLogin,
  classifyOperatorProbe,
  translateFirebaseAuthError,
} from '../features/auth/api/authService';
import {
  computeActiveOtaStep,
  deviceSettingsFormSchema,
  parseDeviceFromFirestore,
  parseFirestoreDate,
} from '../features/devices/model/device.schema';
import { MAX_DEMO_FAILED_ATTEMPTS } from '../features/devices/model/device.types';
import { formatDemoLockUntilBrasilia } from '../features/station-settings/components/DemoAccessManagerCard';
import {
  parseTelemetryHistoryResponse,
  parseTelemetryItem,
} from '../features/telemetry/model/telemetry.schema';
import { generateClientCommandId } from '../features/irrigation/api/commandApi';
import {
  classifyValveCommandError,
  resolveManualValveMinutes,
} from '../features/irrigation/hooks/useValveControl';
import { translateValveRejectionReason } from '../features/irrigation/model/command.types';
import {
  createDeviceSchedule,
  deleteDeviceSchedule,
} from '../features/schedules/api/scheduleRepository';
import {
  parseScheduleFromFirestore,
  scheduleFormSchema,
  toFirestoreSchedulePayload,
  validateScheduleDurationForCaller,
} from '../features/schedules/model/schedule.schema';
import {
  buildDemoScheduleSlotIds,
  formatScheduleDaysSummary,
} from '../features/schedules/model/schedule.types';
import {
  formatLogMessageDuration,
  parseActivityLogFromFirestore,
  translateEventReason,
  translateEventResult,
  translateEventSource,
} from '../features/events/model/event.types';
import { getWmoWeatherInfo } from '../features/weather/model/weather.types';
import { fetchOpenMeteoForecast } from '../features/weather/api/weatherApi';

afterEach(() => {
  vi.restoreAllMocks();
});

// =====================================================================================
// MÓDULO 1: FUNDAÇÃO, FORMATADORES E CLIENTE HTTP AUTENTICADO (WEB-UT-01 A WEB-UT-14)
// =====================================================================================
describe('Módulo 1 — Fundação, Formatadores e Rede HTTP (Auditoria 01)', () => {
  it('WEB-UT-01: formatUptime deve formatar segundos, minutos, horas e dias ou rejeitar inválidos', () => {
    expect(formatUptime(0)).toBe('0m 0s');
    expect(formatUptime(45)).toBe('0m 45s');
    expect(formatUptime(125)).toBe('2m 5s');
    expect(formatUptime(3665)).toBe('1h 1m');
    expect(formatUptime(90060)).toBe('1d 1h 1m');
    expect(formatUptime(-10)).toBe('--');
    expect(formatUptime(null)).toBe('--');
    expect(formatUptime(Number.NaN)).toBe('--');
    expect(formatUptime(Number.POSITIVE_INFINITY)).toBe('--');
  });

  it('WEB-UT-02: formatPendingBytes deve distinguir zero real de ausência (null/NaN)', () => {
    expect(formatPendingBytes(0)).toBe('0 B (Sincronizado)');
    expect(formatPendingBytes(512)).toBe('512 B na fila');
    expect(formatPendingBytes(2048)).toBe('2.0 KB na fila');
    expect(formatPendingBytes(null)).toBe('Sem leitura');
    expect(formatPendingBytes(undefined)).toBe('Sem leitura');
    expect(formatPendingBytes(-5)).toBe('Sem leitura');
    expect(formatPendingBytes(Number.NaN)).toBe('Sem leitura');
  });

  it('WEB-UT-03: formatFreeHeap deve exibir KB e bytes formatados ou "--" quando ausente', () => {
    expect(formatFreeHeap(65536)).toContain('64.0 KB');
    expect(formatFreeHeap(0)).toBe('--');
    expect(formatFreeHeap(-1024)).toBe('--');
    expect(formatFreeHeap(null)).toBe('--');
    expect(formatFreeHeap(Number.NaN)).toBe('--');
  });

  it('WEB-UT-04: formatResetReason deve traduzir todos os códigos ESP-IDF sem presumir OTA em sw_reset', () => {
    expect(formatResetReason('poweron')).toBe('Energia (Power-On)');
    expect(formatResetReason('sw_reset')).toBe('Reinício por Software');
    expect(formatResetReason('task_wdt')).toBe('Watchdog Timer (Auto-Recovery)');
    expect(formatResetReason('int_wdt')).toBe('Watchdog Timer (Auto-Recovery)');
    expect(formatResetReason('brownout')).toBe('Queda de Tensão (Brownout)');
    expect(formatResetReason('panic')).toBe('Exceção Crítica (Panic)');
    expect(formatResetReason('ext_reset')).toBe('Pino Reset Externo (EN)');
    expect(formatResetReason('deepsleep')).toBe('Retorno de Deep Sleep');
    expect(formatResetReason('sdio')).toBe('Reinício via SDIO');
    expect(formatResetReason('unknown')).toBe('Motivo não identificado');
    expect(formatResetReason(null)).toBe('Não informado');
  });

  it('WEB-UT-05: classifyRssiQuality deve classificar todas as faixas de dBm e rejeitar >= 0', () => {
    expect(classifyRssiQuality(-55)).toEqual({ label: 'Excelente', tone: 'success' });
    expect(classifyRssiQuality(-65)).toEqual({ label: 'Muito Bom', tone: 'success' });
    expect(classifyRssiQuality(-72)).toEqual({ label: 'Regular', tone: 'warning' });
    expect(classifyRssiQuality(-80)).toEqual({ label: 'Fraco', tone: 'warning' });
    expect(classifyRssiQuality(-92)).toEqual({ label: 'Crítico', tone: 'error' });
    expect(classifyRssiQuality(0)).toEqual({ label: 'Sem leitura', tone: 'neutral' });
    expect(classifyRssiQuality(15)).toEqual({ label: 'Sem leitura', tone: 'neutral' });
    expect(classifyRssiQuality(-135)).toEqual({ label: 'Sem leitura', tone: 'neutral' });
    expect(classifyRssiQuality(null)).toEqual({ label: 'Sem leitura', tone: 'neutral' });
    expect(classifyRssiQuality(Number.NaN)).toEqual({ label: 'Sem leitura', tone: 'neutral' });
  });

  it('WEB-UT-06: formatWithDeviceTimezone deve aplicar o fuso da estação e tratar datas inválidas', () => {
    const utcDate = new Date('2026-11-03T01:30:45.000Z');
    expect(formatWithDeviceTimezone(utcDate, -3, true)).toBe('02/11/2026 • 22:30:45');
    expect(formatWithDeviceTimezone(utcDate, -3, false)).toBe('02/11 22:30');
    expect(formatWithDeviceTimezone(null, -3)).toBe('Horário não informado');
    expect(formatWithDeviceTimezone(new Date('invalid'), -3)).toBe('Horário não informado');
  });

  it('WEB-UT-07: conversores de datetime-local devem preservar o instante exato no fuso da estação', () => {
    const originalUtc = new Date('2026-11-02T15:00:00.000Z');
    const inputText = toDateTimeLocalInputValue(originalUtc, -3);
    expect(inputText).toBe('2026-11-02T12:00');

    const roundTripDate = parseDateTimeLocalInputValue(inputText, -3);
    expect(roundTripDate?.toISOString()).toBe('2026-11-02T15:00:00.000Z');
    expect(parseDateTimeLocalInputValue('texto-invalido', -3)).toBeNull();
  });

  it('WEB-UT-08: compareSemver deve comparar versões numericamente e ignorar strings malformadas', () => {
    expect(compareSemver('5.22.4', '5.22.3')).toBe(1);
    expect(compareSemver('v5.23.0', '5.22.9')).toBe(1);
    expect(compareSemver('5.22.2', '5.22.3')).toBe(-1);
    expect(compareSemver('v5.22.3', '5.22.3')).toBe(0);
    expect(compareSemver('abc', '5.22.3')).toBe(0);
    expect(compareSemver(null, '5.22.3')).toBe(0);
  });

  it('WEB-UT-09: classifyTelemetryFreshness deve adaptar limites para 30s (bancada) e 30 min (campo)', () => {
    const nowMs = 1_762_000_000_000;
    const sample20sAgo = new Date(nowMs - 20 * 1000);
    const sample110sAgo = new Date(nowMs - 110 * 1000);
    const sample12mAgo = new Date(nowMs - 12 * 60 * 1000);

    expect(classifyTelemetryFreshness(sample20sAgo, 30_000, nowMs).status).toBe('fresh');
    expect(classifyTelemetryFreshness(sample110sAgo, 30_000, nowMs).status).toBe('delayed');
    expect(classifyTelemetryFreshness(sample12mAgo, 30_000, nowMs).status).toBe('stale');
    expect(classifyTelemetryFreshness(sample12mAgo, 1_800_000, nowMs).status).toBe('fresh');
    expect(classifyTelemetryFreshness(null, 30_000, nowMs).status).toBe('unknown');
  });

  it('WEB-UT-10: escapeCsvCell deve neutralizar CSV Formula Injection (OWASP) e escapar vírgulas/aspas', () => {
    expect(escapeCsvCell('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
    expect(escapeCsvCell('+cmd|\'/C calc\'!A0')).toBe("'+cmd|'/C calc'!A0");
    expect(escapeCsvCell('@IMPORTXML()')).toBe("'@IMPORTXML()");
    expect(escapeCsvCell('-27.5954')).toBe('-27.5954');
    expect(escapeCsvCell('v5.22.3, "app1"')).toBe('"v5.22.3, ""app1"""');
    expect(escapeCsvCell(true)).toBe('SIM');
    expect(escapeCsvCell(false)).toBe('NAO');
    expect(escapeCsvCell(null)).toBe('');
  });

  it('WEB-UT-11: awsAuthenticatedFetch deve bloquear envio de Bearer Token para URLs externas', async () => {
    await expect(
      awsAuthenticatedFetch('https://site-malicioso.com/roubar-token'),
    ).rejects.toThrow(ApiException);
  });

  it('WEB-UT-12: awsAuthenticatedFetch deve renovar o token em HTTP 401 e lançar UnauthorizedException se o UID mudar', async () => {
    const getIdTokenMock = vi
      .fn()
      .mockResolvedValueOnce('jwt-token-antigo')
      .mockResolvedValueOnce('jwt-token-renovado');

    Object.defineProperty(firebaseAuth, 'currentUser', {
      get: () => ({ uid: 'user-james-1', getIdToken: getIdTokenMock }),
      configurable: true,
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"message":"Expired"}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{"ok":true,"count":5}', { status: 200 }));

    const result = await awsAuthenticatedFetch<{ ok: boolean; count: number }>(
      `${EnvConfig.aws.telemetryEndpoint}?device_id=ESP32-TEST`,
    );

    expect(result).toEqual({ ok: true, count: 5 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(getIdTokenMock).toHaveBeenNthCalledWith(1, false);
    expect(getIdTokenMock).toHaveBeenNthCalledWith(2, true);

    Object.defineProperty(firebaseAuth, 'currentUser', {
      get: () => null,
      configurable: true,
    });
    await expect(
      awsAuthenticatedFetch(EnvConfig.aws.telemetryEndpoint),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('WEB-UT-13: awsAuthenticatedFetch deve lançar exceções tipadas para 403, 409 e JSON inválido (502)', async () => {
    Object.defineProperty(firebaseAuth, 'currentUser', {
      get: () => ({ uid: 'user-james-1', getIdToken: () => Promise.resolve('token-ok') }),
      configurable: true,
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"message":"Acesso negado"}', { status: 403 }),
    );
    await expect(awsAuthenticatedFetch(EnvConfig.aws.telemetryEndpoint)).rejects.toThrow(
      ForbiddenException,
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"message":"Válvula ocupada"}', { status: 409 }),
    );
    await expect(awsAuthenticatedFetch(EnvConfig.aws.commandEndpoint)).rejects.toThrow(
      ConflictException,
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<html>Erro Gateway</html>', { status: 200 }),
    );
    await expect(awsAuthenticatedFetch(EnvConfig.aws.telemetryEndpoint)).rejects.toThrow(
      /JSON malformado/,
    );
  });

  it('WEB-UT-14: awsAuthenticatedFetch deve manter o timeout ativo durante a leitura de response.text()', async () => {
    Object.defineProperty(firebaseAuth, 'currentUser', {
      get: () => ({ uid: 'user-james-1', getIdToken: () => Promise.resolve('token-ok') }),
      configurable: true,
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      const signal = init?.signal;
      return Promise.resolve({
        status: 200,
        ok: true,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      } as unknown as Response);
    });

    await expect(
      awsAuthenticatedFetch(EnvConfig.aws.telemetryEndpoint, { timeoutMs: 25 }),
    ).rejects.toThrow(/Tempo limite/);
  });
});

// =====================================================================================
// MÓDULO 2: DISPOSITIVOS, TELEMETRIA E AUTENTICAÇÃO (WEB-UT-15 A WEB-UT-22)
// =====================================================================================
describe('Módulo 2 — Dispositivos, Telemetria V2 e Auth (Auditoria 02)', () => {
  it('WEB-UT-15: deviceSettingsFormSchema deve exigir margem ADC >= 100 e limites físicos válidos', () => {
    const valid = deviceSettingsFormSchema.safeParse({
      deviceName: 'Estação Horta',
      targetMoisture: 60,
      manualDuration: 10,
      timezoneOffset: -3,
      latitude: -27.5954,
      longitude: -48.548,
      enableWeatherControl: true,
      telemetryIntervalMs: 30000,
      soilRawDry: 3000,
      soilRawWet: 1200,
    });
    expect(valid.success).toBe(true);

    const invalidMargin = deviceSettingsFormSchema.safeParse({
      deviceName: 'Estação Horta',
      targetMoisture: 60,
      manualDuration: 10,
      timezoneOffset: -3,
      latitude: -27.5954,
      longitude: -48.548,
      enableWeatherControl: true,
      telemetryIntervalMs: 30000,
      soilRawDry: 1550,
      soilRawWet: 1500,
    });
    expect(invalidMargin.success).toBe(false);
  });

  it('WEB-UT-16: parseFirestoreDate deve converter Timestamp, Date, ISO String e Epoch (s/ms)', () => {
    const sampleIso = '2026-11-03T12:00:00.000Z';
    const epochSeconds2026 = 1793707200;
    const epochMillis2026 = 1793707200000;

    expect(parseFirestoreDate(new Date(sampleIso))?.toISOString()).toBe(sampleIso);
    expect(parseFirestoreDate({ toDate: () => new Date(sampleIso) })?.toISOString()).toBe(
      sampleIso,
    );
    expect(parseFirestoreDate(sampleIso)?.toISOString()).toBe(sampleIso);
    expect(parseFirestoreDate(epochSeconds2026)?.toISOString()).toBe(sampleIso);
    expect(parseFirestoreDate(epochMillis2026)?.toISOString()).toBe(sampleIso);
    expect(parseFirestoreDate('')).toBeNull();
    expect(parseFirestoreDate(null)).toBeNull();
  });

  it('WEB-UT-17: parseDeviceFromFirestore deve impedir falso downgrade OTA e tratar strings booleanas', () => {
    const deviceOlderS3 = parseDeviceFromFirestore(
      {
        online: 'false',
        settings: {
          device_name: 'Estação Pomar',
          enable_weather_control: 'false',
          manual_valve_duration: 25,
        },
        connection: { fw: '5.22.4', part: 'app1' },
        available_ota: { version: '5.22.3' },
      },
      'ESP32-POMAR',
    );

    expect(deviceOlderS3.isOnline).toBe(false);
    expect(deviceOlderS3.settings.enableWeatherControl).toBe(false);
    expect(deviceOlderS3.settings.manualDuration).toBe(15);
    expect(deviceOlderS3.hasUpdateAvailable).toBe(false);
  });

  it('WEB-UT-18: parseTelemetryHistoryResponse deve descartar pacotes vazios ou sem timestamp', () => {
    const parsed = parseTelemetryHistoryResponse({
      data: [
        {},
        [],
        { timestamp: 0, sensors: { air_temp: 25 } },
        {
          timestamp: 1793707200,
          sensors: { air_temp: 26.4, soil_moisture: 58 },
          sys: { fw: 'v5.22.3', part: 'app1', pending_bytes: 0 },
        },
      ],
      count: 4,
    });

    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].airTemp).toBe(26.4);
    expect(parsed.items[0].fw).toBe('5.22.3');
  });

  it('WEB-UT-19: parseTelemetryItem deve calcular rainPct derivado do ADC quando rain_pct não vier', () => {
    const dryItem = parseTelemetryItem({
      timestamp: 1793707200,
      sensors: { rain_raw: 4095 },
    });
    expect(dryItem.rainPct).toBe(0);
    expect(dryItem.rainDetected).toBe(false);

    const wetItem = parseTelemetryItem({
      timestamp: 1793707260,
      sensors: { rain_raw: 1500 },
    });
    expect(wetItem.rainPct).toBe(100);
    expect(wetItem.rainDetected).toBe(true);
  });

  it('WEB-UT-20: parseTelemetryItem deve gerar todos os alertas físicos de periféricos e bateria futura', () => {
    const faultItem = parseTelemetryItem({
      timestamp: 1793707300,
      sensors: {
        soil_moisture: 0,
        soil_fault: true,
      },
      sys: {
        sd_ok: false,
        rtc_ok: false,
        aht_ok: false,
        corrupt_lines: 3,
        battery_v: 3.92,
        battery_pct: 78,
      },
    });

    expect(faultItem.hasHardwareFault).toBe(true);
    expect(faultItem.hardwareAlerts).toHaveLength(5);
    expect(faultItem.batteryVoltage).toBe(3.92);
    expect(faultItem.batteryPct).toBe(78);
  });

  it('WEB-UT-21: parseTelemetryItem deve adicionar explicação quando sys.health === "alert" isolado', () => {
    const generalAlertItem = parseTelemetryItem({
      timestamp: 1793707400,
      sys: {
        sd_ok: true,
        rtc_ok: true,
        aht_ok: true,
        health: 'alert',
      },
    });

    expect(generalAlertItem.hasHardwareFault).toBe(true);
    expect(generalAlertItem.hardwareAlerts).toHaveLength(1);
    expect(generalAlertItem.hardwareAlerts[0]).toContain('alerta geral');
  });

  it('WEB-UT-22: translateFirebaseAuthError deve traduzir códigos de autenticação para português', () => {
    expect(translateFirebaseAuthError({ code: 'auth/invalid-credential' })).toContain(
      'E-mail ou senha incorretos',
    );
    expect(translateFirebaseAuthError({ code: 'auth/admin-restricted-operation' })).toContain('AGRO-XXXX-XXXX');
    expect(translateFirebaseAuthError({ code: 'auth/too-many-requests' })).toContain(
      'Muitas tentativas',
    );
    expect(translateFirebaseAuthError({ code: 'auth/popup-closed-by-user' })).toContain(
      'fechada antes de concluir',
    );
  });
});

// =====================================================================================
// MÓDULO 3: IRRIGAÇÃO, AGENDAMENTOS E AUDITORIA DE EVENTOS (WEB-UT-23 A WEB-UT-30)
// =====================================================================================
describe('Módulo 3 — Irrigação, Agendas e Auditoria (Auditoria 03)', () => {
  it('WEB-UT-23: generateClientCommandId deve respeitar o limite char[48] do firmware C++ no ESP32', () => {
    const appId = generateClientCommandId('app');
    const cfgId = generateClientCommandId('cfg');
    const otaId = generateClientCommandId('ota');

    expect(appId).toMatch(/^app-\d+-\d{6}$/);
    expect(cfgId).toMatch(/^cfg-\d+-\d{6}$/);
    expect(otaId).toMatch(/^ota-\d+-\d{6}$/);
    expect(appId.length).toBeLessThan(48);
  });

  it('WEB-UT-24: translateValveRejectionReason deve traduzir travas físicas e preservar códigos novos', () => {
    expect(translateValveRejectionReason('rain_interlock')).toContain('chuva');
    expect(translateValveRejectionReason('valve_already_open')).toContain('já se encontra aberta');
    expect(translateValveRejectionReason('ota_valve_busy')).toContain('segurança mútua');
    expect(translateValveRejectionReason('publish_failed')).toContain('broker MQTT');
    expect(translateValveRejectionReason('custom_hw_lock')).toContain('custom_hw_lock');
  });

  it('WEB-UT-25: scheduleFormSchema e toFirestoreSchedulePayload devem garantir as 5 chaves de firestore.rules', () => {
    expect(() =>
      scheduleFormSchema.parse({
        label: 'Rega Matinal',
        time: '24:00',
        days: [1, 3, 5],
        durationMinutes: 5,
        isEnabled: true,
      }),
    ).toThrow();

    const payload = toFirestoreSchedulePayload({
      label: '  Irrigação Noturna  ',
      time: '21:30',
      days: [5, 1, 3, 1],
      durationMinutes: 12,
      isEnabled: true,
    });

    expect(Object.keys(payload).sort()).toEqual([
      'days',
      'duration_minutes',
      'enabled',
      'label',
      'time',
    ]);
    expect(payload.label).toBe('Irrigação Noturna');
    expect(payload.days).toEqual([1, 3, 5]);
  });

  it('WEB-UT-26: parseScheduleFromFirestore deve tratar booleano "false" e duração corrompida', () => {
    const parsedSchedule = parseScheduleFromFirestore(
      {
        label: 'Rotina Horta',
        time: '06:30',
        days: [5, 1, 1, 3],
        duration_minutes: 'invalid',
        enabled: 'false',
      },
      'sched-01',
    );

    expect(parsedSchedule.days).toEqual([1, 3, 5]);
    expect(parsedSchedule.durationMinutes).toBe(5);
    expect(parsedSchedule.isEnabled).toBe(false);
  });

  it('WEB-UT-27: formatScheduleDaysSummary deve sintetizar dias úteis, fim de semana e todos os dias', () => {
    expect(formatScheduleDaysSummary([1, 2, 3, 4, 5, 6, 7])).toBe('Todos os dias');
    expect(formatScheduleDaysSummary([1, 2, 3, 4, 5])).toBe('Segunda a Sexta (Dias úteis)');
    expect(formatScheduleDaysSummary([6, 7])).toBe('Fim de semana (Sáb, Dom)');
    expect(formatScheduleDaysSummary([1, 3, 5])).toBe('Seg, Qua, Sex');
  });

  it('WEB-UT-28: formatLogMessageDuration deve converter segundos em minutos legíveis', () => {
    expect(formatLogMessageDuration('Válvula acionada por 45 s.')).toBe(
      'Válvula acionada por 45 s.',
    );
    expect(formatLogMessageDuration('Válvula acionada por 180 s.')).toBe(
      'Válvula acionada por 3 min.',
    );
    expect(formatLogMessageDuration('Válvula acionada por 150 s.')).toBe(
      'Válvula acionada por 2 min e 30 s.',
    );
  });

  it('WEB-UT-29: parseActivityLogFromFirestore deve classificar comandos de agenda (sched-) e alertas', () => {
    const schedLog = parseActivityLogFromFirestore(
      {
        type: 'command',
        source: 'command',
        command_id: 'sched-1793707200-1',
        result: 'success',
        message: 'Disparo de rotina',
      },
      'log-sched',
    );
    expect(schedLog.isFromSchedule).toBe(true);
    expect(schedLog.isManualCommand).toBe(false);
    expect(translateEventSource(schedLog)).toBe('Automação por Agendamento');

    const alertLog = parseActivityLogFromFirestore(
      {
        type: 'info',
        source: 'system',
        reason: 'invalid_calibration',
        result: 'failed',
      },
      'log-alert',
    );
    expect(alertLog.isSecurityOrAlert).toBe(true);
  });

  it('WEB-UT-30: translateEventResult e translateEventReason devem separar pré-reboot OTA de pós-boot', () => {
    const rebootingLog = parseActivityLogFromFirestore(
      {
        type: 'command',
        source: 'system',
        result: 'success',
        reason: 'ota_rebooting',
      },
      'log-1',
    );
    const verifiedLog = parseActivityLogFromFirestore(
      {
        type: 'ota_verification',
        source: 'system',
        result: 'success',
        reason: 'ota_updated',
      },
      'log-2',
    );

    expect(translateEventResult(rebootingLog)).toBe(
      'Binário Gravado (Reiniciando para Self-Test)',
    );
    expect(translateEventResult(verifiedLog)).toBe(
      'Firmware Atualizado e Validado no Boot',
    );
    expect(translateEventReason('rain_interlock')).toContain('sensor físico detectou chuva');
    expect(translateEventReason(null)).toBe('Motivo específico não informado');
  });
});

// =====================================================================================
// MÓDULOS 4 E 5: CLIMA OPEN-METEO E MÁQUINA DE ESTADOS OTA (WEB-UT-31 A WEB-UT-36)
// =====================================================================================
describe('Módulos 4 e 5 — Clima Open-Meteo e Motor OTA (Auditorias 04 e 05)', () => {
  it('WEB-UT-31: getWmoWeatherInfo deve mapear todos os códigos meteorológicos WMO', () => {
    expect(getWmoWeatherInfo(0)).toEqual({ label: 'Céu Limpo', kind: 'sun' });
    expect(getWmoWeatherInfo(2)).toEqual({ label: 'Nublado', kind: 'cloud' });
    expect(getWmoWeatherInfo(45)).toEqual({ label: 'Nevoeiro', kind: 'fog' });
    expect(getWmoWeatherInfo(53)).toEqual({ label: 'Garoa', kind: 'drizzle' });
    expect(getWmoWeatherInfo(63)).toEqual({ label: 'Chuva', kind: 'rain' });
    expect(getWmoWeatherInfo(81)).toEqual({ label: 'Chuva Forte', kind: 'heavy_rain' });
    expect(getWmoWeatherInfo(95)).toEqual({ label: 'Tempestade', kind: 'storm' });
  });

  it('WEB-UT-32: fetchOpenMeteoForecast deve retornar null para coordenadas (0, 0) sem chamar a rede', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await fetchOpenMeteoForecast(0, 0);
    expect(res).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('WEB-UT-33: fetchOpenMeteoForecast deve rejeitar resposta vazia sem fabricar 0°C (Auditoria 04 CL-1)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ daily: { time: ['2026-11-03'] } }), { status: 200 }),
    );

    await expect(fetchOpenMeteoForecast(-27.5954, -48.548)).rejects.toThrow(
      /incompleta/,
    );
  });

  it('WEB-UT-34: fetchOpenMeteoForecast deve processar previsão válida de 7 dias da Open-Meteo', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          current: { temperature_2m: 24.6, weather_code: 1 },
          daily: {
            time: ['2026-11-03', '2026-11-04'],
            weather_code: [1, 61],
            temperature_2m_max: [27.2, 22.8],
            temperature_2m_min: [18.4, 16.1],
            precipitation_sum: [0.0, 14.5],
            precipitation_probability_max: [15, 85],
          },
        }),
        { status: 200 },
      ),
    );

    const forecast = await fetchOpenMeteoForecast(-27.5954, -48.548);
    expect(forecast).not.toBeNull();
    expect(forecast?.currentTemp).toBe(25);
    expect(forecast?.todayMaxTemp).toBe(27);
    expect(forecast?.todayMinTemp).toBe(18);
    expect(forecast?.todayRainProb).toBe(15);
    expect(forecast?.daily).toHaveLength(2);
    expect(forecast?.daily[1].rainProbabilityMax).toBe(85);
  });

  it('WEB-UT-35: computeActiveOtaStep deve priorizar novo OTA pendente sobre reason antigo (OTA-1)', () => {
    const stepPending = computeActiveOtaStep({
      otaStatus: {
        inProgress: true,
        awaitingReboot: false,
        status: 'pending',
        reason: 'ota_updated',
        targetVersion: '5.22.4',
        previousVersion: '5.22.3',
        verifiedFw: '5.22.3',
        error: null,
        lastCommandId: 'ota-new-1',
        updatedAt: new Date(),
      },
    });
    expect(stepPending).toEqual({ currentStep: 1, stateTone: 'active' });

    const stepDownloading = computeActiveOtaStep({
      otaStatus: {
        inProgress: true,
        awaitingReboot: false,
        status: 'started',
        reason: null,
        targetVersion: '5.22.4',
        previousVersion: '5.22.3',
        verifiedFw: null,
        error: null,
        lastCommandId: 'ota-new-1',
        updatedAt: new Date(),
      },
    });
    expect(stepDownloading).toEqual({ currentStep: 2, stateTone: 'active' });

    const stepRebooting = computeActiveOtaStep({
      otaStatus: {
        inProgress: false,
        awaitingReboot: true,
        status: 'rebooting',
        reason: 'ota_rebooting',
        targetVersion: '5.22.4',
        previousVersion: '5.22.3',
        verifiedFw: null,
        error: null,
        lastCommandId: 'ota-new-1',
        updatedAt: new Date(),
      },
    });
    expect(stepRebooting).toEqual({ currentStep: 3, stateTone: 'active' });
  });

  it('WEB-UT-36: computeActiveOtaStep deve classificar falhas por etapa (S3 vs Hash vs Rollback)', () => {
    const baseOta = {
      inProgress: false,
      awaitingReboot: false,
      targetVersion: '5.22.4',
      previousVersion: '5.22.3',
      verifiedFw: null,
      error: null,
      lastCommandId: 'ota-err-1',
      updatedAt: new Date(),
    };

    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'publish_failed', reason: null },
      }),
    ).toEqual({ currentStep: 1, stateTone: 'error' });

    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'failed', reason: 'ota_hash_mismatch' },
      }),
    ).toEqual({ currentStep: 2, stateTone: 'error' });

    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'rolled_back', reason: 'ota_rollback' },
      }),
    ).toEqual({ currentStep: 4, stateTone: 'error' });

    expect(
      computeActiveOtaStep({
        otaStatus: { ...baseOta, status: 'done', reason: 'ota_same_version' },
      }),
    ).toEqual({ currentStep: 0, stateTone: 'idle' });
  });
});

// =====================================================================================
// MÓDULO 6: SEGURANÇA ZERO-TRUST FASE 1 (WEB-UT-37 A WEB-UT-39)
// =====================================================================================
describe('Módulo 6 — Blindagem Zero-Trust Demo e Privacidade (Fase 1)', () => {
  it('WEB-UT-37: parseDeviceFromFirestore deve desserializar demo_summary e projeção sanitizada demo_view', () => {
    const ownerView = parseDeviceFromFirestore(
      {
        online: true,
        settings: { device_name: 'Estação Demo', latitude: -30.0347, longitude: -51.2178 },
        demo_summary: {
          active: true,
          token_hint: 'AGRO-****-X4P2',
          token_hash_prefix: 'abcdef0123456789',
          expires_epoch: 1800000000,
          pass_claimed: true,
          failed_attempts: 2,
          locked_brute_force: false,
        },
      },
      'ESP32-AgroSmart-Station-V5',
    );

    expect(ownerView.demoSummary.active).toBe(true);
    expect(ownerView.demoSummary.tokenHint).toBe('AGRO-****-X4P2');
    expect(ownerView.demoSummary.tokenHashPrefix).toBe('abcdef0123456789');
    expect(ownerView.demoSummary.passClaimed).toBe(true);
    expect(ownerView.demoSummary.failedAttempts).toBe(2);

    const demoView = parseDeviceFromFirestore(
      {
        online: true,
        connection: { state: 'online', fw: '5.23.0', part: 'app0' },
        settings: {
          device_name: 'Estação Demo',
          latitude: -30.85,
          longitude: -51.81,
          demo_expires_epoch: 1800000000,
          demo_pass_claimed: true,
        },
      },
      'ESP32-AgroSmart-Station-V5',
    );

    expect(demoView.id).toBe('ESP32-AgroSmart-Station-V5');
    expect(demoView.lastIp).toBeNull();
    expect(demoView.settings.demoTokenHash).toBeNull();
    expect(demoView.settings.demoSessionId).toBeNull();
    expect(demoView.settings.latitude).toBe(-30.85);
    expect(demoView.settings.demoPassClaimed).toBe(true);
  });

  it('WEB-UT-38: schedules devem vincular demo_session_id para sessão Demo e omiti-lo para o titular', () => {
    const demoPayload = toFirestoreSchedulePayload({
      label: 'Teste Recrutador',
      time: '14:30',
      days: [2, 4],
      durationMinutes: 3,
      isEnabled: true,
      createdByDemo: true,
      demoSessionId: 'dsid-aabbccddeeff001122334455',
    });

    expect(demoPayload).toEqual({
      label: 'Teste Recrutador',
      time: '14:30',
      days: [2, 4],
      duration_minutes: 3,
      enabled: true,
      created_by_demo: true,
      demo_session_id: 'dsid-aabbccddeeff001122334455',
    });

    const parsed = parseScheduleFromFirestore(demoPayload, 'sched-demo-1');
    expect(parsed.createdByDemo).toBe(true);
    expect(parsed.demoSessionId).toBe('dsid-aabbccddeeff001122334455');
  });

  it('WEB-UT-39: diagnostics deve mascarar códigos AGRO, JWTs, tokens, IP e GPS nos logs', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    clearWebDiagnostics();

    logWebDiagnostic('INFO', 'security.test', {
      plain_code: 'AGRO-7K9M-X4P2',
      custom_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.signature123456',
      latitude: -30.0347,
      ip: '192.168.1.50',
      free_text: 'Convite AGRO-7K9M-X4P2 e JWT eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.signature123456',
    });

    const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1];
    const loggedFields = lastCall[1] as Record<string, unknown>;
    expect(loggedFields.plain_code).toBe('***REDACTED***');
    expect(loggedFields.custom_token).toBe('***REDACTED***');
    expect(loggedFields.latitude).toBe('***REDACTED***');
    expect(loggedFields.ip).toBe('***REDACTED***');
    expect(String(loggedFields.free_text)).not.toContain('7K9M-X4P2');
    expect(String(loggedFields.free_text)).not.toContain('eyJhbGci');
  });
});

// =====================================================================================
// MÓDULO 7: FASE 1B — VAGAS DEMO, LIMITES 5 MIN, 429/403 E LOCKOUT TEMPORAL (WEB-UT-40 A 46)
// =====================================================================================
interface FakeDocRef {
  path: string;
  id: string;
}

interface FakeTx {
  get: (ref: FakeDocRef) => Promise<{ exists: () => boolean; data: () => Record<string, unknown> | undefined }>;
  set: (ref: FakeDocRef, payload: Record<string, unknown>) => void;
}

describe('Módulo 7 — Limites de Agendas Demo, 429/403 e Lockout Temporal (Fase 1B)', () => {
  const DEMO_SID = 'dsid-11223344556677889900aabb';
  const DEVICE_ID = 'ESP32-AgroSmart-Station-V5';

  function setMockCurrentUser(opts: {
    uid: string;
    email: string;
    isDemo: boolean;
    demoSid?: string;
  }): void {
    Object.defineProperty(firebaseAuth, 'currentUser', {
      get: () => ({
        uid: opts.uid,
        email: opts.email,
        getIdToken: () => Promise.resolve('mock-jwt-token'),
        getIdTokenResult: () =>
          Promise.resolve({
            claims: opts.isDemo
              ? { is_demo: true, demo_sid: opts.demoSid ?? DEMO_SID, demo_device_id: DEVICE_ID }
              : {},
          }),
      }),
      configurable: true,
    });
  }

  beforeEach(() => {
    firestoreMocks.doc.mockReset();
    firestoreMocks.getDoc.mockReset();
    firestoreMocks.deleteDoc.mockReset();
    firestoreMocks.runTransaction.mockReset();

    firestoreMocks.doc.mockImplementation((_db: unknown, ...segments: string[]): FakeDocRef => ({
      path: segments.join('/'),
      id: segments[segments.length - 1] ?? '',
    }));
  });

  it('WEB-UT-40: Demo deve criar agendamento na primeira vaga livre (demo-<sid>-0..4) lendo antes de gravar', async () => {
    setMockCurrentUser({
      uid: 'demo-uid-1',
      email: 'demo@agrosmart.com',
      isDemo: true,
      demoSid: DEMO_SID,
    });

    const slotIds = buildDemoScheduleSlotIds(DEMO_SID);
    expect(slotIds).toEqual([
      `demo-${DEMO_SID}-0`,
      `demo-${DEMO_SID}-1`,
      `demo-${DEMO_SID}-2`,
      `demo-${DEMO_SID}-3`,
      `demo-${DEMO_SID}-4`,
    ]);

    const occupied = new Set<string>([
      `devices/${DEVICE_ID}/schedules/${slotIds[0]}`,
      `devices/${DEVICE_ID}/schedules/${slotIds[1]}`,
    ]);
    const writtenDocs = new Map<string, Record<string, unknown>>();
    let wroteDuringTx = false;
    let readAfterWrite = false;

    firestoreMocks.runTransaction.mockImplementation(
      async (_db: unknown, updateFn: (tx: FakeTx) => Promise<string>) => {
        const tx: FakeTx = {
          get: async (ref: FakeDocRef) => {
            if (wroteDuringTx) readAfterWrite = true;
            const exists = occupied.has(ref.path);
            return {
              exists: () => exists,
              data: () => (exists ? { label: 'Ocupada' } : undefined),
            };
          },
          set: (ref: FakeDocRef, payload: Record<string, unknown>) => {
            wroteDuringTx = true;
            writtenDocs.set(ref.path, payload);
          },
        };
        return updateFn(tx);
      },
    );

    const createdId = await createDeviceSchedule(DEVICE_ID, {
      label: 'Rega Teste Vaga 2',
      time: '09:15',
      days: [1, 3, 5],
      durationMinutes: 5,
      isEnabled: true,
    });

    expect(readAfterWrite).toBe(false);
    expect(createdId).toBe(slotIds[2]);
    expect(writtenDocs.size).toBe(1);
    expect(writtenDocs.get(`devices/${DEVICE_ID}/schedules/${slotIds[2]}`)).toEqual({
      label: 'Rega Teste Vaga 2',
      time: '09:15',
      days: [1, 3, 5],
      duration_minutes: 5,
      enabled: true,
      created_by_demo: true,
      demo_session_id: DEMO_SID,
    });
  });

  it('WEB-UT-41: Demo com todas as 5 vagas ocupadas deve bloquear criação sem chamar tx.set', async () => {
    setMockCurrentUser({
      uid: 'demo-uid-1',
      email: 'demo@agrosmart.com',
      isDemo: true,
      demoSid: DEMO_SID,
    });

    const txSetSpy = vi.fn();
    firestoreMocks.runTransaction.mockImplementation(
      async (_db: unknown, updateFn: (tx: FakeTx) => Promise<string>) => {
        const tx: FakeTx = {
          get: async () => ({
            exists: () => true,
            data: () => ({ label: 'Vaga ocupada' }),
          }),
          set: txSetSpy,
        };
        return updateFn(tx);
      },
    );

    await expect(
      createDeviceSchedule(DEVICE_ID, {
        label: 'Sexta Agenda Demo',
        time: '11:00',
        days: [2],
        durationMinutes: 3,
        isEnabled: true,
      }),
    ).rejects.toThrow(/limite de 5 agendamentos por sessão atingido/i);

    expect(txSetSpy).not.toHaveBeenCalled();
  });

  it('WEB-UT-42: duração 6 min deve ser rejeitada na Demo e aceita no titular', async () => {
    expect(() => validateScheduleDurationForCaller(6, true)).toThrow(/5 minutos/i);
    expect(validateScheduleDurationForCaller(5, true)).toBe(5);
    expect(validateScheduleDurationForCaller(6, false)).toBe(6);
    expect(validateScheduleDurationForCaller(15, false)).toBe(15);

    expect(resolveManualValveMinutes(6, 5, true)).toBe(5);
    expect(resolveManualValveMinutes(6, 5, false)).toBe(6);

    setMockCurrentUser({
      uid: 'demo-uid-1',
      email: 'demo@agrosmart.com',
      isDemo: true,
      demoSid: DEMO_SID,
    });

    await expect(
      createDeviceSchedule(DEVICE_ID, {
        label: 'Agenda Acima do Limite',
        time: '10:00',
        days: [1],
        durationMinutes: 6,
        isEnabled: true,
      }),
    ).rejects.toThrow(/5 minutos/i);

    expect(firestoreMocks.runTransaction).not.toHaveBeenCalled();
  });

  it('WEB-UT-43: awsAuthenticatedFetch deve lançar TooManyRequestsException com retryAfterSec do corpo, header ou 60s', async () => {
    setMockCurrentUser({
      uid: 'demo-uid-1',
      email: 'demo@agrosmart.com',
      isDemo: true,
      demoSid: DEMO_SID,
    });

    // 1) retry_after_sec vindo do corpo JSON (prioritário)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: 'Modo Usuário Teste: aguarde 42s antes de iniciar outra irrigação.',
          reason: 'demo_cooldown',
          retry_after_sec: 42,
        }),
        { status: 429, headers: { 'Retry-After': '99' } },
      ),
    );

    try {
      await awsAuthenticatedFetch(EnvConfig.aws.commandEndpoint, { method: 'POST', body: {} });
      expect.unreachable('Era esperada TooManyRequestsException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(TooManyRequestsException);
      const tmr = err as TooManyRequestsException;
      expect(tmr.statusCode).toBe(429);
      expect(tmr.retryAfterSec).toBe(42);
      expect(tmr.reason).toBe('demo_cooldown');
    }

    // 2) Fallback para cabeçalho Retry-After quando o corpo não traz retry_after_sec
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Aguarde' }), {
        status: 429,
        headers: { 'Retry-After': '35' },
      }),
    );

    try {
      await awsAuthenticatedFetch(EnvConfig.aws.commandEndpoint, { method: 'POST', body: {} });
      expect.unreachable('Era esperada TooManyRequestsException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(TooManyRequestsException);
      expect((err as TooManyRequestsException).retryAfterSec).toBe(35);
    }

    // 3) Fallback padrão de 60s quando nenhum dos dois existe
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'Limite atingido' }), { status: 429 }),
    );

    try {
      await awsAuthenticatedFetch(EnvConfig.aws.commandEndpoint, { method: 'POST', body: {} });
      expect.unreachable('Era esperada TooManyRequestsException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(TooManyRequestsException);
      expect((err as TooManyRequestsException).retryAfterSec).toBe(60);
    }
  });

  it('WEB-UT-44: 403 e 429 não devem marcar incerteza, mas timeout, rede e 5xx devem marcar', () => {
    const err403Quota = new ForbiddenException(
      'Modo Usuário Teste: a cota máxima de irrigação desta sessão (30 min) foi atingida.',
      undefined,
      'demo_quota_exhausted',
    );
    const out403 = classifyValveCommandError(err403Quota, false, false);
    expect(out403.shouldMarkUncertain).toBe(false);
    expect(out403.feedback.type).toBe('warning');
    expect(out403.feedback.message).toMatch(/cota/i);

    const err429 = new TooManyRequestsException(
      'Modo Usuário Teste: aguarde 42s antes de iniciar outra irrigação.',
      42,
      undefined,
      'demo_cooldown',
    );
    const out429 = classifyValveCommandError(err429, false, false);
    expect(out429.shouldMarkUncertain).toBe(false);
    expect(out429.feedback.type).toBe('warning');
    expect(out429.cooldownSec).toBe(42);

    // Se já havia incerteza prévia, 403/429 preservam a incerteza anterior
    expect(classifyValveCommandError(err429, true, false).shouldMarkUncertain).toBe(true);

    // Timeout, erro 5xx e erro de rede marcam incerteza física
    expect(classifyValveCommandError(new Error('TIMEOUT_ACK'), false, true).shouldMarkUncertain).toBe(true);
    expect(classifyValveCommandError(new ApiException(408, 'Timeout'), false, false).shouldMarkUncertain).toBe(true);
    expect(classifyValveCommandError(new ApiException(503, 'Indisponível'), false, false).shouldMarkUncertain).toBe(true);
    expect(classifyValveCommandError(new TypeError('Failed to fetch'), false, false).shouldMarkUncertain).toBe(true);
  });

  it('WEB-UT-45: lockedBruteForce deve seguir locked_until_epoch mesmo com locked_brute_force legado true', () => {
    expect(MAX_DEMO_FAILED_ATTEMPTS).toBe(30);
    const nowSec = Math.floor(Date.now() / 1000);

    // Bloqueio futuro -> true
    const lockedDev = parseDeviceFromFirestore(
      {
        demo_summary: {
          active: true,
          failed_attempts: 0,
          locked_brute_force: false,
          locked_until_epoch: nowSec + 300,
        },
      },
      DEVICE_ID,
    );
    expect(lockedDev.demoSummary.lockedUntilEpoch).toBe(nowSec + 300);
    expect(lockedDev.demoSummary.lockedBruteForce).toBe(true);

    // Bloqueio expirado -> false MESMO com locked_brute_force: true legado presente
    const expiredLockDev = parseDeviceFromFirestore(
      {
        demo_summary: {
          active: true,
          failed_attempts: 30,
          locked_brute_force: true,
          locked_until_epoch: nowSec - 60,
        },
      },
      DEVICE_ID,
    );
    expect(expiredLockDev.demoSummary.lockedUntilEpoch).toBe(nowSec - 60);
    expect(expiredLockDev.demoSummary.lockedBruteForce).toBe(false);
  });

  it('WEB-UT-46: Demo pode excluir apenas agendamentos da própria sessão atual', async () => {
    setMockCurrentUser({
      uid: 'demo-uid-1',
      email: 'demo@agrosmart.com',
      isDemo: true,
      demoSid: DEMO_SID,
    });

    const docsByPath: Record<string, Record<string, unknown>> = {
      [`devices/${DEVICE_ID}/schedules/demo-${DEMO_SID}-0`]: {
        label: 'Minha Agenda Demo',
        created_by_demo: true,
        demo_session_id: DEMO_SID,
      },
      [`devices/${DEVICE_ID}/schedules/owner-fixed-1`]: {
        label: 'Agenda Fixa do Titular',
        created_by_demo: false,
      },
      [`devices/${DEVICE_ID}/schedules/demo-outra-sessao-0`]: {
        label: 'Agenda de Sessão Anterior',
        created_by_demo: true,
        demo_session_id: 'dsid-999999999999999999999999',
      },
    };

    firestoreMocks.getDoc.mockImplementation(async (ref: FakeDocRef) => {
      const data = docsByPath[ref.path];
      return {
        exists: () => Boolean(data),
        data: () => data,
      };
    });
    firestoreMocks.deleteDoc.mockResolvedValue(undefined);

    // 1) Agenda da própria sessão -> exclusão permitida
    await deleteDeviceSchedule(DEVICE_ID, `demo-${DEMO_SID}-0`);
    expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);

    // 2) Agenda do titular -> bloqueada sem chamar deleteDoc
    await expect(deleteDeviceSchedule(DEVICE_ID, 'owner-fixed-1')).rejects.toThrow(
      /apenas agendamentos criados nesta sessão atual podem ser excluídos/i,
    );
    expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);

    // 3) Agenda de outra sessão Demo -> bloqueada sem chamar deleteDoc
    await expect(deleteDeviceSchedule(DEVICE_ID, 'demo-outra-sessao-0')).rejects.toThrow(
      /apenas agendamentos criados nesta sessão atual podem ser excluídos/i,
    );
    expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================================
// MÓDULO 8: FASE 1C — PORTA /demo/claim, PROBE SERVER-SIDE E ANTI-PII (WEB-UT-47 A 51)
// =====================================================================================
describe('Módulo 8 — Porta /demo/claim, Sondagem Server-Side e Anti-PII (Fase 1C)', () => {
  beforeEach(() => {
    authMocks.signInWithCustomToken.mockReset();
  });

  it('WEB-UT-47: classifyOperatorProbe deve cobrir toda a matriz de decisão na ordem especificada', () => {
    const probes: Array<'ok' | 'permission-denied' | 'error'> = [
      'ok',
      'permission-denied',
      'error',
    ];

    // 1) Token Demo -> sempre 'denied'
    for (const hasGoogleProvider of [true, false]) {
      for (const probe of probes) {
        expect(
          classifyOperatorProbe({ isDemoClaim: true, hasGoogleProvider, probe }),
        ).toBe('denied');
      }
    }

    // 2) Sem provedor Google -> sempre 'denied'
    for (const probe of probes) {
      expect(
        classifyOperatorProbe({ isDemoClaim: false, hasGoogleProvider: false, probe }),
      ).toBe('denied');
    }

    // 3) Não-Demo com Google -> decidido pelo resultado da sondagem
    expect(
      classifyOperatorProbe({ isDemoClaim: false, hasGoogleProvider: true, probe: 'ok' }),
    ).toBe('operator');
    expect(
      classifyOperatorProbe({
        isDemoClaim: false,
        hasGoogleProvider: true,
        probe: 'permission-denied',
      }),
    ).toBe('denied');
    expect(
      classifyOperatorProbe({ isDemoClaim: false, hasGoogleProvider: true, probe: 'error' }),
    ).toBe('unavailable');
  });

  it('WEB-UT-48: EnvConfig.aws.demoClaimEndpoint deve apontar para /demo/claim na base configurada', () => {
    expect(EnvConfig.aws.demoClaimEndpoint).toBe(`${EnvConfig.aws.apiBaseUrl}/demo/claim`);
    expect(EnvConfig.aws.demoClaimEndpoint.endsWith('/demo/claim')).toBe(true);
  });

  it('WEB-UT-49: claimDemoPassAndLogin deve chamar /demo/claim sem cabeçalho Authorization', async () => {
    const getIdTokenSpy = vi.fn().mockResolvedValue('fresh-id-token');
    const mockUser = { uid: 'demo-uid-1', getIdToken: getIdTokenSpy };
    authMocks.signInWithCustomToken.mockResolvedValueOnce({ user: mockUser });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          custom_token: 'custom-jwt-assinado',
          demo_session_id: 'dsid-00112233445566778899aabb',
          expires_epoch: 1800003600,
          device_id: 'ESP32-AgroSmart-Station-V5',
        }),
        { status: 200 },
      ),
    );

    const user = await claimDemoPassAndLogin('agro-7k9m-x4p2', 'ESP32-AgroSmart-Station-V5');

    expect(user).toBe(mockUser);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe(EnvConfig.aws.demoClaimEndpoint);
    expect(calledInit?.method).toBe('POST');

    const headersObj = (calledInit?.headers ?? {}) as Record<string, string>;
    const headerKeysLower = Object.keys(headersObj).map((k) => k.toLowerCase());
    expect(headerKeysLower).toContain('content-type');
    expect(headerKeysLower).not.toContain('authorization');

    const sentBody = JSON.parse(String(calledInit?.body ?? '{}')) as Record<string, unknown>;
    expect(sentBody).toEqual({
      device_id: 'ESP32-AgroSmart-Station-V5',
      action: 'claim_demo_pass',
      demo_pass_token: 'AGRO-7K9M-X4P2',
    });

    expect(authMocks.signInWithCustomToken).toHaveBeenCalledWith(
      firebaseAuth,
      'custom-jwt-assinado',
    );
    expect(getIdTokenSpy).toHaveBeenCalledWith(true);
  });

  it('WEB-UT-50: formatDemoLockUntilBrasilia deve exibir "Bloqueado até HH:MM:SS (Brasília)" sem 0/30', () => {
    // 2026-11-22T15:30:45Z -> 12:30:45 no horário de Brasília (UTC-3)
    const epochAfternoon = Math.floor(Date.UTC(2026, 10, 22, 15, 30, 45) / 1000);
    const labelAfternoon = formatDemoLockUntilBrasilia(epochAfternoon);
    expect(labelAfternoon).toBe('Bloqueado até 12:30:45 (Brasília)');
    expect(labelAfternoon).not.toContain('0/30');

    // 2026-11-22T01:05:09Z -> 22:05:09 (vira o dia corretamente para UTC-3)
    const epochNight = Math.floor(Date.UTC(2026, 10, 22, 1, 5, 9) / 1000);
    expect(formatDemoLockUntilBrasilia(epochNight)).toBe(
      'Bloqueado até 22:05:09 (Brasília)',
    );
  });

  it('WEB-UT-51: varredura anti-PII não deve encontrar e-mails pessoais nem de domínio reservado em /src/', () => {
    const rawSources = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    });

    const sourceEntries = Object.entries(rawSources).filter(
      ([filePath]) => !filePath.includes('/src/test/'),
    );
    expect(sourceEntries.length).toBeGreaterThan(10);

    const forbiddenPattern = new RegExp(
      [
        ['[A-Za-z0-9._%+-]+', '@', 'gmail', '\\.com'].join(''),
        ['[A-Za-z0-9._%+-]+', '@', 'agrosmart', '\\.com'].join(''),
      ].join('|'),
      'i',
    );

    const offenders: string[] = [];
    for (const [filePath, rawCode] of sourceEntries) {
      if (forbiddenPattern.test(rawCode)) {
        offenders.push(filePath);
      }
    }

    expect(offenders).toEqual([]);
  });
});
