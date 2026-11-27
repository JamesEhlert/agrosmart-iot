/**
 * =====================================================================================
 * ARQUIVO: src/pages/LogsPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * DATA DE CRIAÇÃO: 2026-11-24 (UTC) — Web v5.36.0
 * PROPÓSITO: Página própria "Logs & Auditoria" (antes era uma sub-aba de Agendamentos):
 *            linha do tempo de comandos, confirmações (ACK), agendas, proteções, OTA e
 *            alertas de segurança. Exclusão só para o titular.
 * =====================================================================================
 */

import { ScrollText, ShieldCheck } from 'lucide-react';
import { useAuth } from '../features/auth/hooks/useAuth';
import { useSelectedDevice } from '../features/devices/hooks/useSelectedDevice';
import { EventsTimeline } from '../features/events/components/EventsTimeline';
import { InfoTip } from '../shared/ui/InfoTip';
import { PageHeader } from '../shared/ui';

export function LogsPage() {
  const { isDemoUser } = useAuth();
  const { selectedDevice } = useSelectedDevice();

  if (!selectedDevice) return null;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ScrollText className="w-5 h-5" />}
        title="Logs & auditoria"
        description={<>Comandos, confirmações da estação (ACK <InfoTip k="ack" />), agendas, proteções e alertas</>}
        station={{ name: selectedDevice.settings.deviceName, id: selectedDevice.id }}
        actions={
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold ${
              isDemoUser ? 'bg-amber-50 text-warning border border-amber-200' : 'bg-surface border border-line text-ink-muted'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            {isDemoUser ? 'Somente leitura (convidado)' : 'Alertas de segurança protegidos por 30 dias'}
          </span>
        }
      />

      <EventsTimeline device={selectedDevice} canManage={!isDemoUser} />
    </div>
  );
}
