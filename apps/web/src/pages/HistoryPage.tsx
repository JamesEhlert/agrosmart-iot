/**
 * =====================================================================================
 * ARQUIVO: src/pages/HistoryPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T14:45:00-03:00
 * VERSÃO: v5.24.5
 * PROPÓSITO: Página de Histórico Analítico com alternância entre Gráficos Apache ECharts
 *            (Canvas com Downsampling Server-Side) e Lista Paginada HMAC-SHA256.
 * =====================================================================================
 */

import { useState } from 'react';
import { LineChart, List } from 'lucide-react';
import { useSelectedDevice } from '../features/devices/hooks/useSelectedDevice';
import { TelemetryChartCard } from '../features/telemetry/components/TelemetryChartCard';
import { TelemetryReadingsTable } from '../features/telemetry/components/TelemetryReadingsTable';

export function HistoryPage() {
  const { selectedDevice } = useSelectedDevice();
  const [activeTab, setActiveTab] = useState<'charts' | 'table'>('charts');

  if (!selectedDevice) return null;

  return (
    <div className="space-y-5">
      <div className="bg-surface rounded-2xl border border-line p-4 shadow-sm flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-ink">
            Histórico & Telemetria Analítica
          </h1>
          <p className="text-xs text-ink-muted">
            Estação ativa: <span className="font-semibold">{selectedDevice.settings.deviceName}</span> ({selectedDevice.id})
          </p>
        </div>

        <div className="flex rounded-xl bg-sunken p-1">
          <button
            type="button"
            onClick={() => setActiveTab('charts')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === 'charts'
                ? 'bg-surface text-brand shadow-xs'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <LineChart className="w-4 h-4" />
            <span>Gráficos Analíticos</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('table')}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition ${
              activeTab === 'table'
                ? 'bg-surface text-brand shadow-xs'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <List className="w-4 h-4" />
            <span>Lista de Leituras</span>
          </button>
        </div>
      </div>

      {activeTab === 'charts' ? (
        <TelemetryChartCard device={selectedDevice} />
      ) : (
        <TelemetryReadingsTable device={selectedDevice} />
      )}
    </div>
  );
}