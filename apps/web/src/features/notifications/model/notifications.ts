/**
 * =====================================================================================
 * ARQUIVO: src/features/notifications/model/notifications.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-25T06:30:00Z (UTC)
 * VERSÃO: v5.42.0
 * PROPÓSITO: Central de notificações (regras puras, testáveis). Junta o que o site JÁ lê,
 *            sem consulta nova cara: estado da estação (presença), última leitura (sensores,
 *            cartão SD, botão travado, memória de confirmações), firmware disponível,
 *            agendas (sobrepostas, repetidas, sem dias), previsão de chuva e o histórico
 *            das últimas 24 h (regas puladas, falhas, sem confirmação, alertas de segurança).
 *            "Lida" fica neste navegador (localStorage), nada é gravado no servidor.
 * =====================================================================================
 */

import type { DeviceModel } from '../../devices/model/device.types';
import type { TelemetryModel } from '../../telemetry/model/telemetry.types';
import type { ScheduleModel } from '../../schedules/model/schedule.types';
import type { WeatherForecastData } from '../../weather/model/weather.types';
import type { ActivityLogModel } from '../../events/model/event.types';
import { findConflicts } from '../../schedules/model/scheduleInsights';
import { isFailedLog, isSecurityLog, isSkippedWateringLog, isUnconfirmedLog } from '../../events/model/logFilters';

export type NotificationSeverity = 'critical' | 'warning' | 'info' | 'success';

export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  /** 'state' = situação atual (some quando resolve); 'event' = algo que aconteceu. */
  kind: 'state' | 'event';
  title: string;
  body: string;
  at: Date | null;
  link?: { to: string; label: string };
}

export interface NotificationInput {
  device: DeviceModel | null;
  telemetry: TelemetryModel | null | undefined;
  schedules: ScheduleModel[] | null;
  recentLogs: ActivityLogModel[] | null;
  forecast: WeatherForecastData | null | undefined;
  isDemo: boolean;
  nowMs?: number;
}

const DAY_MS = 24 * 3600 * 1000;
const SEVERITY_ORDER: Record<NotificationSeverity, number> = { critical: 0, warning: 1, info: 2, success: 3 };
/** Previsão que vira aviso: chance de chuva ≥ 70% ou ≥ 5 mm no dia. */
export const RAIN_PROB_THRESHOLD = 70;
export const RAIN_MM_THRESHOLD = 5;
const MAX_EVENTS = 15;

/** Identificador curto e estável para um texto (para não repetir avisos iguais). */
export function shortHash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function stateNotifications(input: NotificationInput): AppNotification[] {
  const out: AppNotification[] = [];
  const { device, telemetry, schedules, forecast, isDemo } = input;
  if (!device) return out;

  if (!device.isOnline) {
    out.push({
      id: 'state:offline',
      severity: 'critical',
      kind: 'state',
      title: 'Estação offline',
      body: 'A estação parou de dar sinal de vida. Comandos e agendas esperam até ela voltar; a válvula fecha sozinha no prazo.',
      at: null,
      link: { to: '/monitor', label: 'Ver monitor' },
    });
  }

  if (telemetry) {
    for (const alert of telemetry.hardwareAlerts ?? []) {
      out.push({
        id: `state:hw:${shortHash(alert)}`,
        severity: 'warning',
        kind: 'state',
        title: 'Atenção no hardware da estação',
        body: alert,
        at: telemetry.timestamp ?? null,
        link: { to: '/monitor', label: 'Ver saúde da estação' },
      });
    }
    const fault = telemetry.localControls?.btnFault ?? 0;
    if (fault > 0) {
      const which = fault === 3 ? 'Os dois botões' : fault & 2 ? 'O botão de irrigação' : 'O botão do display';
      out.push({
        id: `state:btn:${fault}`,
        severity: 'warning',
        kind: 'state',
        title: 'Botão da estação travado',
        body: `${which} está apertado há mais de 10 s e foi ignorado. Verifique umidade ou fio em curto na caixa.`,
        at: telemetry.timestamp ?? null,
        link: { to: '/settings', label: 'Ver display e botões' },
      });
    }
    if (telemetry.protections?.ackOutboxFault) {
      out.push({
        id: 'state:ackfault',
        severity: 'warning',
        kind: 'state',
        title: 'Memória de confirmações com falha',
        body: 'A estação não consegue guardar confirmações; por segurança ela recusa ligar a válvula até normalizar.',
        at: telemetry.timestamp ?? null,
        link: { to: '/monitor', label: 'Ver saúde da estação' },
      });
    }
  }

  if (!isDemo && device.hasUpdateAvailable && device.availableOta?.version) {
    out.push({
      id: `state:ota:${device.availableOta.version}`,
      severity: 'info',
      kind: 'state',
      title: `Nova versão do firmware: v${device.availableOta.version}`,
      body: `A estação está com v${device.currentFw ?? '?'}. A atualização é assinada e volta sozinha se algo der errado.`,
      at: null,
      link: { to: '/settings', label: 'Atualizar firmware' },
    });
  }
  if (device.otaStatus?.inProgress) {
    out.push({
      id: `state:otaprog:${device.otaStatus.targetVersion ?? ''}`,
      severity: 'info',
      kind: 'state',
      title: 'Atualização de firmware em andamento',
      body: 'Não desligue a estação até a confirmação da nova versão.',
      at: null,
      link: { to: '/settings', label: 'Acompanhar' },
    });
  }

  if (schedules && schedules.length > 0) {
    const active = schedules.filter((s) => s.isEnabled);
    const conflicts = findConflicts(active);
    if (conflicts.size > 0) {
      const names = active.filter((s) => conflicts.has(s.id)).map((s) => s.label || s.time).slice(0, 3);
      out.push({
        id: `state:conflict:${shortHash([...conflicts.keys()].sort().join(','))}`,
        severity: 'warning',
        kind: 'state',
        title: 'Agendas sobrepostas',
        body: `${names.join(', ')}${conflicts.size > 3 ? ' e outras' : ''} se sobrepõem em algum dia. Ajuste os horários para não disputarem a válvula.`,
        at: null,
        link: { to: '/schedules', label: 'Revisar agendas' },
      });
    }
    const seen = new Map<string, string>();
    for (const s of active) {
      const key = `${s.time}|${[...s.days].sort().join(',')}|${s.durationMinutes}`;
      if (seen.has(key)) {
        out.push({
          id: `state:dup:${shortHash(key)}`,
          severity: 'info',
          kind: 'state',
          title: 'Agenda repetida',
          body: `"${s.label || s.time}" é igual a "${seen.get(key)}" (mesmo horário, dias e duração). Uma delas é desnecessária.`,
          at: null,
          link: { to: '/schedules', label: 'Revisar agendas' },
        });
      } else {
        seen.set(key, s.label || s.time);
      }
    }
    for (const s of active) {
      if (!s.days || s.days.length === 0) {
        out.push({
          id: `state:nodays:${s.id}`,
          severity: 'info',
          kind: 'state',
          title: 'Agenda sem dias marcados',
          body: `"${s.label || s.time}" está ativa mas não tem nenhum dia da semana: nunca vai rodar.`,
          at: null,
          link: { to: '/schedules', label: 'Revisar agendas' },
        });
      }
    }
  }

  if (forecast?.daily?.length) {
    const days = forecast.daily.slice(0, 2);
    days.forEach((d, i) => {
      if (d.rainProbabilityMax >= RAIN_PROB_THRESHOLD || d.precipitationSumMm >= RAIN_MM_THRESHOLD) {
        const when = i === 0 ? 'hoje' : 'amanhã';
        const ai = device.settings.enableWeatherControl;
        out.push({
          id: `state:rain:${d.dateStr}`,
          severity: 'info',
          kind: 'state',
          title: `Chuva prevista ${when} (${Math.round(d.rainProbabilityMax)}%, ${d.precipitationSumMm.toFixed(1)} mm)`,
          body: ai
            ? 'A IA climática está ligada: regas agendadas podem ser puladas para economizar água.'
            : 'A IA climática está desligada: considere pausar as agendas ou ligá-la em Configurações.',
          at: null,
          link: { to: ai ? '/schedules' : '/settings', label: ai ? 'Ver agendas' : 'Abrir configurações' },
        });
      }
    });
  }
  return out;
}

function eventNotifications(logs: ActivityLogModel[], nowMs: number): AppNotification[] {
  const out: AppNotification[] = [];
  for (const log of logs) {
    const ts = log.timestamp?.getTime();
    if (typeof ts !== 'number' || nowMs - ts > DAY_MS) continue;
    const base = { kind: 'event' as const, at: log.timestamp, body: log.message, link: { to: '/logs', label: 'Ver nos logs' } };
    if (isSecurityLog(log)) {
      out.push({ ...base, id: `log:${log.id}`, severity: 'critical', title: 'Alerta de segurança' });
    } else if ((log.reason ?? '').toLowerCase() === 'button_stuck') {
      out.push({ ...base, id: `log:${log.id}`, severity: 'warning', title: 'Botão da estação travado' });
    } else if (isFailedLog(log)) {
      out.push({ ...base, id: `log:${log.id}`, severity: 'warning', title: 'Falha na estação' });
    } else if (isUnconfirmedLog(log)) {
      out.push({ ...base, id: `log:${log.id}`, severity: 'warning', title: 'Comando sem confirmação' });
    } else if (isSkippedWateringLog(log)) {
      out.push({ ...base, id: `log:${log.id}`, severity: 'info', title: 'Rega pulada' });
    } else if ((log.reason ?? '').toLowerCase() === 'ota_updated' || log.type === 'ota_verification') {
      out.push({ ...base, id: `log:${log.id}`, severity: 'success', title: 'Firmware atualizado' });
    }
    if (out.length >= MAX_EVENTS) break;
  }
  return out;
}

export function buildNotifications(input: NotificationInput): AppNotification[] {
  const nowMs = input.nowMs ?? Date.now();
  const state = stateNotifications(input).sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const events = eventNotifications(input.recentLogs ?? [], nowMs).sort(
    (a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0),
  );
  return [...state, ...events];
}

// ---------- "lida" (por navegador e por estação) ----------
export interface ReadState {
  ids: string[];
}

export const READ_CAP = 300;

export function storageKey(deviceId: string): string {
  return `agrosmart.notif.read.${deviceId}`;
}

export function loadReadState(deviceId: string, storage: Pick<Storage, 'getItem'> | null): ReadState {
  try {
    const raw = storage?.getItem(storageKey(deviceId));
    const parsed = raw ? JSON.parse(raw) : null;
    const ids = Array.isArray(parsed?.ids) ? parsed.ids.filter((x: unknown) => typeof x === 'string') : [];
    return { ids: ids.slice(-READ_CAP) };
  } catch {
    return { ids: [] };
  }
}

export function saveReadState(deviceId: string, state: ReadState, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(storageKey(deviceId), JSON.stringify({ ids: state.ids.slice(-READ_CAP) }));
  } catch {
    /* sem armazenamento: vale só nesta aba */
  }
}

/**
 * Mantém só as marcas de "lida" que ainda existem: quando um problema some e volta depois
 * (ex.: estação offline de novo), ele aparece outra vez como não lido.
 */
export function pruneRead(state: ReadState, current: AppNotification[]): ReadState {
  const live = new Set(current.map((n) => n.id));
  return { ids: state.ids.filter((id) => live.has(id)) };
}

export function unreadCount(list: AppNotification[], state: ReadState): number {
  const read = new Set(state.ids);
  return list.filter((n) => !read.has(n.id) && n.severity !== 'success').length;
}
