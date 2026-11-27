/**
 * =====================================================================================
 * ARQUIVO: src/pages/ReadingsHistoryPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T15:30:00-03:00
 * VERSÃO: v5.24.7
 * PROPÓSITO: Tela dedicada exclusivamente ao Histórico de Leituras Brutas do DynamoDB
 *            (rota `/readings`), exibindo cards espaçados com cores alternadas e CSV.
 * =====================================================================================
 */

import { List } from 'lucide-react';
import { useSelectedDevice } from '../features/devices/hooks/useSelectedDevice';
import { TelemetryReadingsTable } from '../features/telemetry/components/TelemetryReadingsTable';
import { PageHeader } from '../shared/ui';

export function ReadingsHistoryPage() {
  const { selectedDevice } = useSelectedDevice();

  if (!selectedDevice) return null;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<List className="w-5 h-5" />}
        title="Histórico de leituras"
        description="Todas as medições enviadas pela estação, por período, com exportação em CSV"
        station={{ name: selectedDevice.settings.deviceName, id: selectedDevice.id }}
      />

      <TelemetryReadingsTable device={selectedDevice} />
    </div>
  );
}