/**
 * =====================================================================================
 * ARQUIVO: src/features/notifications/hooks/useNotifications.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-25T06:30:00Z (UTC)
 * VERSÃO: v5.42.0
 * PROPÓSITO: Dados da central de notificações com custo baixo:
 *            - última leitura: mesmo cache do Monitor (sozinho, repete a cada 5 min);
 *            - histórico: até 25 registros das últimas 24 h, a cada 10 min (≈ 3.600
 *              leituras/dia com o site aberto o dia todo; nível gratuito: 50.000/dia);
 *            - agendas: escuta em tempo real (só lê de novo quando mudam);
 *            - previsão: mesmo cache do banner de clima (10 min).
 * =====================================================================================
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DeviceModel } from '../../devices/model/device.types';
import type { ScheduleModel } from '../../schedules/model/schedule.types';
import { subscribeToDeviceSchedules } from '../../schedules/api/scheduleRepository';
import { fetchActivityLogsPage } from '../../events/api/eventRepository';
import { fetchOpenMeteoForecast } from '../../weather/api/weatherApi';
import { useLatestTelemetry } from '../../telemetry/hooks/useLatestTelemetry';
import {
  AppNotification,
  buildNotifications,
  loadReadState,
  pruneRead,
  ReadState,
  saveReadState,
  unreadCount,
} from '../model/notifications';

const LOGS_REFRESH_MS = 10 * 60 * 1000;
const TELEMETRY_POLL_MS = 5 * 60 * 1000;

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useNotifications(device: DeviceModel | null, isDemo: boolean) {
  const deviceId = device?.id ?? null;
  const { data: telemetry } = useLatestTelemetry(deviceId, { pollMs: TELEMETRY_POLL_MS });

  const { data: recentLogs } = useQuery({
    queryKey: ['notifications', 'logs', deviceId],
    queryFn: async () => {
      if (!deviceId) return [];
      const res = await fetchActivityLogsPage({ deviceId, pageSize: 25, since: new Date(Date.now() - 24 * 3600 * 1000) });
      return res.logs;
    },
    enabled: Boolean(deviceId),
    staleTime: 5 * 60 * 1000,
    refetchInterval: LOGS_REFRESH_MS,
  });

  const lat = device?.settings.latitude ?? 0;
  const lon = device?.settings.longitude ?? 0;
  const hasGps = lat !== 0 || lon !== 0;
  const { data: forecast } = useQuery({
    // Mesma chave do WeatherSummaryBanner: uma consulta serve aos dois.
    queryKey: ['weather', deviceId, lat.toFixed(4), lon.toFixed(4)],
    queryFn: ({ signal }) => fetchOpenMeteoForecast(lat, lon, signal),
    enabled: Boolean(deviceId) && hasGps,
    staleTime: 10 * 60 * 1000,
  });

  const [schedules, setSchedules] = useState<ScheduleModel[] | null>(null);
  useEffect(() => {
    setSchedules(null);
    if (!deviceId) return undefined;
    const unsub = subscribeToDeviceSchedules(deviceId, setSchedules, () => setSchedules(null));
    return () => unsub();
  }, [deviceId]);

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const list: AppNotification[] = useMemo(
    () => buildNotifications({ device, telemetry, schedules, recentLogs: recentLogs ?? null, forecast, isDemo, nowMs }),
    [device, telemetry, schedules, recentLogs, forecast, isDemo, nowMs],
  );

  const [read, setRead] = useState<ReadState>({ ids: [] });
  useEffect(() => {
    setRead(deviceId ? loadReadState(deviceId, storage()) : { ids: [] });
  }, [deviceId]);

  // Esquece marcas de avisos que já sumiram (para avisar de novo se voltarem).
  useEffect(() => {
    // Só depois que todas as fontes responderam (senão apagaria marcas de avisos ainda não carregados).
    const ready = recentLogs !== undefined && schedules !== null && telemetry !== undefined && (!hasGps || forecast !== undefined);
    if (!deviceId || !ready) return;
    const pruned = pruneRead(read, list);
    if (pruned.ids.length !== read.ids.length) {
      setRead(pruned);
      saveReadState(deviceId, pruned, storage());
    }
  }, [deviceId, list, read, recentLogs, schedules, telemetry, forecast, hasGps]);

  const markRead = useCallback(
    (ids: string[]) => {
      if (!deviceId) return;
      setRead((prev) => {
        const next = { ids: [...new Set([...prev.ids, ...ids])] };
        saveReadState(deviceId, next, storage());
        return next;
      });
    },
    [deviceId],
  );

  const readSet = useMemo(() => new Set(read.ids), [read]);
  return {
    list,
    unread: unreadCount(list, read),
    isRead: (id: string) => readSet.has(id),
    markRead,
    markAllRead: () => markRead(list.map((n) => n.id)),
  };
}
