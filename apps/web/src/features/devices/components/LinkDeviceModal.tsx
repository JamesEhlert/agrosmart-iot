/**
 * =====================================================================================
 * ARQUIVO: src/features/devices/components/LinkDeviceModal.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T05:00:00-03:00
 * VERSÃO: v5.24.3
 * PROPÓSITO: Modal para vincular uma estação ESP32 pelo seu ID Serial à conta do usuário.
 * =====================================================================================
 */

import { Dialog } from '../../../shared/ui';
import React, { useState } from 'react';
import { Cpu, Tag, Loader2, AlertCircle } from 'lucide-react';
import { linkDeviceToCurrentUser } from '../api/deviceRepository';

interface LinkDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLinked: (deviceId: string) => void;
}

export function LinkDeviceModal({ isOpen, onClose, onLinked }: LinkDeviceModalProps) {
  const [serialId, setSerialId] = useState('');
  const [friendlyName, setFriendlyName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = serialId.trim();
    const cleanName = friendlyName.trim();
    if (!cleanId || !cleanName) {
      setErrorMsg('Preencha o ID Serial da placa e um Nome Amigável.');
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await linkDeviceToCurrentUser(cleanId, cleanName);
      onLinked(cleanId);
      setSerialId('');
      setFriendlyName('');
      onClose();
    } catch (err: unknown) {
      setErrorMsg((err as Error)?.message || 'Falha ao vincular estação.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    // v5.45.0: janela padrão do design system
    <Dialog open onClose={onClose} title="Vincular estação ESP32" description="Informe o identificador da placa e um nome para reconhecê-la.">
      <div>
        {errorMsg && (
          <div role="alert" className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-danger">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="link-serial" className="block text-xs font-semibold text-ink-muted mb-1.5">
              ID Serial da Placa (Thing Name)
            </label>
            <div className="relative">
              <Cpu className="w-4 h-4 text-ink-muted absolute left-3.5 top-3.5" />
              <input
                id="link-serial"
                type="text"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={serialId}
                onChange={(e) => setSerialId(e.target.value)}
                placeholder="Ex: ESP32-AgroSmart-Station-V5"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-line text-sm focus:outline-none focus:border-brand focus:ring-2 focus:ring-[#2E7D32]/15"
              />
            </div>
          </div>

          <div>
            <label htmlFor="link-name" className="block text-xs font-semibold text-ink-muted mb-1.5">
              Nome Amigável da Estação
            </label>
            <div className="relative">
              <Tag className="w-4 h-4 text-ink-muted absolute left-3.5 top-3.5" />
              <input
                id="link-name"
                type="text"
                autoComplete="off"
                value={friendlyName}
                onChange={(e) => setFriendlyName(e.target.value)}
                placeholder="Ex: Estação Horta Principal"
                className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-line text-sm focus:outline-none focus:border-brand focus:ring-2 focus:ring-[#2E7D32]/15"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-xl text-sm font-semibold text-ink-muted hover:bg-sunken"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-5 py-2.5 rounded-xl text-sm font-bold bg-brand hover:bg-brand-strong text-white disabled:opacity-50 flex items-center gap-2"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Vincular Agora</span>
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}