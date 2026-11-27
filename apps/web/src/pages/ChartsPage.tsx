/**
 * =====================================================================================
 * ARQUIVO: src/pages/ChartsPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T15:30:00-03:00
 * VERSÃO: v5.24.7
 * PROPÓSITO: Tela dedicada exclusivamente aos Gráficos Analíticos Apache ECharts
 *            (rota `/charts`), separada da lista de leituras para maior leveza visual.
 * =====================================================================================
 */

import { LineChart } from 'lucide-react';
import { useSelectedDevice } from '../features/devices/hooks/useSelectedDevice';
import { TelemetryChartCard } from '../features/telemetry/components/TelemetryChartCard';
import { PageHeader } from '../shared/ui';

export function ChartsPage() {
  const { selectedDevice } = useSelectedDevice();

  if (!selectedDevice) return null;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<LineChart className="w-5 h-5" />}
        title="Gráficos analíticos"
        description="Tendência dos 6 sensores; séries reduzidas no servidor (LTTB) para abrir rápido"
        station={{ name: selectedDevice.settings.deviceName, id: selectedDevice.id }}
      />

      <TelemetryChartCard device={selectedDevice} />
    </div>
  );
}