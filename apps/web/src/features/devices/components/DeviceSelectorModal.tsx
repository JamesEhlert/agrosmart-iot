/**
 * =====================================================================================
 * ARQUIVO: src/features/devices/components/DeviceSelectorModal.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-03T01:05:00-03:00
 * VERSÃO: v5.25.0
 * PROPÓSITO: Modal seletor de estações IoT (`DevicePickerSheet` do Flutter adaptado para Web).
 * CHANGELOG:
 * - v5.25.0: [Auditoria 05] Oculta o botão de vincular nova estação quando `canLinkDevice`
 *            for `false` (`isDemoUser`) e adiciona suporte à tecla `Escape`.
 * =====================================================================================
 */

import { Dialog } from '../../../shared/ui';
import { Router, PlusCircle, Check } from 'lucide-react';

interface DeviceSelectorModalProps {
  isOpen: boolean;
  userDevices: string[];
  selectedDeviceId: string | null;
  canLinkDevice?: boolean;
  onSelectDevice: (deviceId: string) => void;
  onOpenLinkModal: () => void;
  onClose: () => void;
}

export function DeviceSelectorModal({
  isOpen,
  userDevices,
  selectedDeviceId,
  canLinkDevice = true,
  onSelectDevice,
  onOpenLinkModal,
  onClose,
}: DeviceSelectorModalProps) {

  if (!isOpen) return null;

  return (
    // v5.45.0: janela padrão do design system
    <Dialog open onClose={onClose} size="sm" title="Minhas estações" description={`${userDevices.length} estação(ões) vinculada(s) à sua conta`}>
      <div>
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {userDevices.map((devId) => {
            const isSelected = devId === selectedDeviceId;
            return (
              <button
                key={devId}
                type="button"
                onClick={() => {
                  onSelectDevice(devId);
                  onClose();
                }}
                className={`w-full flex items-center justify-between p-3.5 rounded-xl border text-left transition ${
                  isSelected
                    ? 'bg-brand-soft/35 border-brand text-ink'
                    : 'bg-surface border-line hover:bg-sunken/60 text-ink'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`p-2 rounded-full ${
                      isSelected
                        ? 'bg-brand text-white'
                        : 'bg-sunken text-ink-muted'
                    }`}
                  >
                    <Router className="w-4 h-4" />
                  </div>
                  <span className="text-sm font-semibold truncate">{devId}</span>
                </div>
                {isSelected && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-brand text-white shrink-0">
                    <Check className="w-3.5 h-3.5" />
                    Ativa
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {canLinkDevice && (
          <div className="border-t border-line mt-5 pt-4">
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenLinkModal();
              }}
              className="w-full py-2.5 px-4 rounded-xl border-2 border-brand text-brand hover:bg-brand-soft/25 font-bold text-sm flex items-center justify-center gap-2 transition"
            >
              <PlusCircle className="w-4 h-4" />
              <span>Vincular Nova Estação ESP32</span>
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}