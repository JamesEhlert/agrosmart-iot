/**
 * =====================================================================================
 * ARQUIVO: src/pages/SchedulesPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T09:00:00Z (UTC)
 * VERSÃO: v5.36.0
 * PROPÓSITO: Página "Agendamentos" (rotinas semanais em tempo real).
 * CHANGELOG:
 * - v5.36.0: a linha do tempo de auditoria saiu daqui e virou a página própria
 *            "Logs & Auditoria" (`/logs`) na barra lateral.
 * =====================================================================================
 */

import { Link } from 'react-router-dom';
import { CalendarClock, ScrollText } from 'lucide-react';
import { useSelectedDevice } from '../features/devices/hooks/useSelectedDevice';
import { ScheduleList } from '../features/schedules/components/ScheduleList';
import { PageHeader } from '../shared/ui';

export function SchedulesPage() {
  const { selectedDevice } = useSelectedDevice();

  if (!selectedDevice) return null;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<CalendarClock className="w-5 h-5" />}
        title="Agendamentos"
        description="Rotinas semanais conferidas a cada minuto na nuvem"
        station={{ name: selectedDevice.settings.deviceName, id: selectedDevice.id }}
        actions={
          <Link
            to="/logs"
            className="inline-flex items-center gap-2 h-10 px-3.5 rounded-xl border border-line bg-surface text-xs font-bold text-brand hover:bg-sunken"
          >
            <ScrollText className="w-4 h-4" />
            <span>Ver execuções em Logs</span>
          </Link>
        }
      />

      <ScheduleList device={selectedDevice} />
    </div>
  );
}
