/**
 * =====================================================================================
 * ARQUIVO: src/pages/SettingsPage.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T21:20:00-03:00
 * VERSÃO: v5.25.1
 * PROPÓSITO: Página de Configurações Operacionais, Clima/GPS, Calibração Remota NVS,
 *            Painel Executivo OTA, Gerador de Passe Demo (para o dono) e proteção RBAC.
 * =====================================================================================
 */

import { useState } from 'react';
import { Unlink, Lock, ShieldAlert, AlertCircle, Settings } from 'lucide-react';
import { PageHeader } from '../shared/ui';
import { useAuth } from '../features/auth/hooks/useAuth';
import { useSelectedDevice } from '../features/devices/hooks/useSelectedDevice';
import { unlinkDeviceFromCurrentUser } from '../features/devices/api/deviceRepository';
import { OperationalSettingsCard } from '../features/station-settings/components/OperationalSettingsCard';
import { WeatherGpsCard } from '../features/station-settings/components/WeatherGpsCard';
import { NvsCalibrationCard } from '../features/station-settings/components/NvsCalibrationCard';
import { LocalControlsCard } from '../features/station-settings/components/LocalControlsCard';
import { DemoAccessManagerCard } from '../features/station-settings/components/DemoAccessManagerCard';
import { OtaExecutivePanel } from '../features/firmware-update/components/OtaExecutivePanel';
import { useConfirm } from '../shared/ui/Feedback.providers';

export function SettingsPage() {
  const { isDemoUser } = useAuth();
  const { selectedDevice } = useSelectedDevice();
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const confirm = useConfirm();

  if (!selectedDevice) return null;

  const handleUnlink = async () => {
    if (isDemoUser) return;
    setUnlinkError(null);
    // v5.46.0: confirmação no padrão do site (antes: window.confirm do navegador)
    const confirmed = await confirm({
      title: 'Desvincular esta estação?',
      message: `"${selectedDevice.settings.deviceName}" (${selectedDevice.id}) sai da sua lista ativa. O histórico na nuvem é preservado e você pode vinculá-la de novo depois.`,
      confirmLabel: 'Desvincular',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await unlinkDeviceFromCurrentUser(selectedDevice.id);
    } catch (err: unknown) {
      setUnlinkError(
        (err as Error)?.message || 'Não foi possível desvincular a estação no momento.',
      );
    }
  };

  return (
    <div className="space-y-6">
      {/* v5.46.0: cabeçalho padrão de página */}
      <PageHeader
        icon={<Settings className="w-5 h-5" />}
        title="Configurações & OTA"
        description={isDemoUser ? 'Somente leitura para convidados' : 'Passe de convidado, firmware, parâmetros, display e botões da estação'}
        station={{ name: selectedDevice.settings.deviceName, id: selectedDevice.id }}
      />
      {/* Se for o proprietário (James), exibe no topo o Gerador de Passe Temporário para Recrutador */}
      {!isDemoUser && <DemoAccessManagerCard device={selectedDevice} />}

      {/* Banner de Proteção RBAC quando logado como Usuário de Teste / Recrutador */}
      {isDemoUser && (
        <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-5 shadow-sm flex items-start gap-3.5">
          <div className="p-2.5 rounded-xl bg-amber-100 text-warning shrink-0">
            <Lock className="w-6 h-6" />
          </div>
          <div>
            <span className="text-xs font-extrabold uppercase tracking-wider text-warning">
              Modo Usuário Teste (Sessão Temporária Autorizada)
            </span>
            <h2 className="text-sm font-extrabold text-ink mt-0.5">
              Configurações Críticas de Hardware em Modo Somente Leitura
            </h2>
            <p className="text-xs text-ink-muted mt-1 leading-relaxed">
              Para proteger a estação física instalada em campo, sessões de demonstração podem
              acionar a válvula na aba <strong>Monitoramento</strong>, testar o{' '}
              <strong>Simulador Gêmeo Digital</strong> e criar/editar rotinas na aba{' '}
              <strong>Agenda</strong>, mas não podem gravar na memória Flash (OTA / NVS) nem
              desvincular a estação.
            </p>
          </div>
        </div>
      )}

      <div className={isDemoUser ? 'opacity-80 space-y-6' : 'space-y-6'}>
        {/* 1. Painel Executivo de Atualização Remota OTA */}
        <OtaExecutivePanel device={selectedDevice} disabled={isDemoUser} />

        {/* 2. Parâmetros Operacionais */}
        <OperationalSettingsCard device={selectedDevice} disabled={isDemoUser} />

        {/* 3. Inteligência Climática Open-Meteo 3h & Coordenadas GPS */}
        <WeatherGpsCard device={selectedDevice} disabled={isDemoUser} />

        {/* 4. Calibração Remota da Memória Flash NVS */}
        <NvsCalibrationCard device={selectedDevice} disabled={isDemoUser} />

        {/* v5.41.0: display e botões físicos da estação (firmware 5.27.0) */}
        <LocalControlsCard device={selectedDevice} disabled={isDemoUser} />
      </div>

      {/* 5. Zona de Gerenciamento de Vínculo Multi-Tenant */}
      <div className="bg-surface rounded-2xl border border-red-200 p-5 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-extrabold text-danger flex items-center gap-2">
              <ShieldAlert className="w-4 h-4" />
              <span>Remover Estação da Minha Lista Ativa</span>
            </h3>
            <p className="text-xs text-ink-muted mt-0.5">
              {isDemoUser
                ? 'Operação bloqueada para usuários de demonstração.'
                : `Oculta ${selectedDevice.id} da sua lista ativa. Você poderá adicioná-la novamente usando o ID Serial.`}
            </p>
          </div>

          <button
            type="button"
            disabled={isDemoUser}
            onClick={handleUnlink}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-red-300 text-danger hover:bg-red-50 text-xs font-extrabold transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isDemoUser ? <Lock className="w-4 h-4" /> : <Unlink className="w-4 h-4" />}
            <span>{isDemoUser ? 'Bloqueado (Modo Teste)' : 'Desvincular Estação'}</span>
          </button>
        </div>

        {unlinkError && (
          <div className="p-3 rounded-xl bg-red-50 border border-red-200 flex items-center gap-2 text-xs font-semibold text-danger">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{unlinkError}</span>
          </div>
        )}
      </div>
    </div>
  );
}