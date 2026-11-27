/**
 * =====================================================================================
 * ARQUIVO: src/features/telemetry/hooks/useLatestTelemetry.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T05:15:00-03:00
 * VERSÃO: v5.24.3
 * PROPÓSITO: Hook TanStack Query para buscar e atualizar automaticamente a telemetria
 *            mais recente da estação ativa a cada 30 segundos, com proteção contra
 *            condições de corrida na troca de estação (`AbortSignal`).
 * =====================================================================================
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/hooks/useAuth';
import { fetchLatestTelemetry } from '../api/telemetryApi';

const DEFAULT_POLLING_INTERVAL_MS = 30_000;

/**
 * v5.42.0: `pollMs` opcional. Vários componentes compartilham o mesmo cache; a consulta
 * repete no MENOR intervalo entre os que estão na tela (ex.: Monitor 30 s; só o sino, 5 min).
 */
export function useLatestTelemetry(deviceId: string | null, options?: { pollMs?: number }) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['telemetry', 'latest', user?.uid ?? 'anon', deviceId ?? 'none'],
    queryFn: ({ signal }) => {
      if (!deviceId) return Promise.resolve(null);
      return fetchLatestTelemetry(deviceId, signal);
    },
    enabled: Boolean(user && deviceId),
    refetchInterval: options?.pollMs ?? DEFAULT_POLLING_INTERVAL_MS,
    staleTime: 15_000,
  });
}