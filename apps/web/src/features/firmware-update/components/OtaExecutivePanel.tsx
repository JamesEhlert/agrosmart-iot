/**
 * =====================================================================================
 * ARQUIVO: src/features/firmware-update/components/OtaExecutivePanel.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 3 / Parte A — OTA Assinado)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T22:00:00Z (UTC)
 * VERSÃO: v5.32.0
 * PROPÓSITO: Painel Executivo de Atualização Remota de Firmware Over-The-Air (OTA),
 *            exibindo exclusivamente a release publicada no Firestore, com proteção
 *            anti-downgrade, selo de assinatura digital e confirmação prévia obrigatória.
 * CHANGELOG:
 * - v5.33.0 (Fase 3C item 9, 2026-11-23 UTC): status OTA traduzido (`translateOtaStatus`)
 *   e texto da etapa 4 alinhado ao firmware 5.25.x (90 s contínuos; prazo de 10 min).
 * - v5.32.0:
 *   * Remove o campo livre de versão (`ota-manual-semver`), estado e formulário manual.
 *   * Exibe apenas a release publicada, habilitando "Atualizar para vX" somente quando
 *     `currentFw` é conhecido e `compareSemver(availableOta.version, currentFw) > 0`.
 *   * Adiciona diálogo de confirmação com versão atual -> alvo, tamanho, SHA-256 (12
 *     primeiros), selo "Assinado" (quando `availableOta.sigAlg` existir) e aviso de
 *     válvula fechada / até ~10 min sem responder.
 *   * Envia somente `{ targetVersion, sha256 }` (sem `s3_key`), mantém Demo somente
 *     leitura sem botão clicável e traduz erros 409/400 em mensagens amigáveis.
 * - v5.25.0: [Auditorias 04 e 05 - OTA-1 / OTA-2 / OTA-3] Stepper ativo e bloqueio
 *            durante `awaitingReboot`.
 * =====================================================================================
 */

import { useEffect, useState } from 'react';
import {
  Cpu,
  ArrowUpCircle,
  CheckCircle2,
  Loader2,
  AlertTriangle,
  ShieldCheck,
  RotateCcw,
  Lock,
} from 'lucide-react';
import { ApiException } from '../../../shared/api/httpClient';
import { compareSemver } from '../../../shared/lib/formatters';
import { DeviceModel } from '../../devices/model/device.types';
import { computeActiveOtaStep } from '../../devices/model/device.schema';
import {
  generateClientCommandId,
  sendOtaUpdateCommand,
} from '../../irrigation/api/commandApi';
import { translateEventReason, translateOtaStatus } from '../../events/model/event.types';
import { Button, Dialog } from '../../../shared/ui';

interface OtaExecutivePanelProps {
  device: DeviceModel;
  disabled?: boolean;
}

interface OtaFeedbackState {
  type: 'success' | 'error';
  message: string;
}

const OTA_STEPS = [
  {
    step: 1,
    title: '1. Assinatura S3 & Lock ACID',
    desc: 'Lambda valida assinatura ECDSA no S3 e gera Pre-Signed URL HTTPS',
  },
  {
    step: 2,
    title: '2. Download TLS & SHA-256',
    desc: 'ESP32 baixa em blocos de 1 KB e confere integridade e assinatura',
  },
  {
    step: 3,
    title: '3. Graceful Drain & Reboot',
    desc: 'Drena fila da RAM para o MicroSD WAL e alterna partição Flash',
  },
  {
    step: 4,
    title: '4. Self-Test e Auto-Rollback',
    desc: 'Aprova a nova versão após 90 s contínuos conectada à AWS (prazo total de 10 min); se falhar, volta à versão anterior',
  },
] as const;

/**
 * Avalia de forma pura se o botão "Atualizar para vX" pode ser habilitado para a
 * release publicada (exige `currentFw` conhecido e `compareSemver(available, current) > 0`).
 */
export function isPublishedOtaUpgradeEligible(
  currentFw?: string | null,
  availableVersion?: string | null,
): boolean {
  if (!currentFw || !availableVersion) return false;
  return compareSemver(availableVersion, currentFw) > 0;
}

/**
 * Converte erros HTTP 409/400/403 do servidor em texto amigável sem expor detalhes internos.
 */
export function formatFriendlyOtaError(err: unknown): string {
  if (err instanceof ApiException) {
    const reason = (err.reason ?? '').trim().toLowerCase();
    if (err.statusCode === 403) {
      return 'Atualização OTA é exclusiva do administrador da estação.';
    }
    if (err.statusCode === 409) {
      if (reason === 'ota_downgrade_blocked') {
        return 'Atualização recusada: não é permitido instalar uma versão anterior à atual.';
      }
      if (reason === 'ota_same_version') {
        return 'A estação já está executando esta versão de firmware.';
      }
      if (reason === 'ota_current_version_unknown') {
        return 'Não foi possível confirmar a versão atual da estação. Aguarde a placa ficar online.';
      }
      if (/nenhuma release/i.test(err.message)) {
        return 'Nenhuma release publicada para esta estação.';
      }
      if (/válvula|rega|irrigação/i.test(err.message)) {
        return 'Não é possível iniciar a atualização enquanto há uma irrigação ou reserva ativa.';
      }
      if (/andamento/i.test(err.message)) {
        return 'Já existe uma atualização de firmware em andamento nesta estação.';
      }
      return 'Não foi possível iniciar a atualização: a release ou o estado da estação mudou. Recarregue e tente novamente.';
    }
    if (err.statusCode === 400) {
      if (/assinatura/i.test(err.message)) {
        return 'Release sem assinatura válida. Publique uma nova versão assinada antes de atualizar.';
      }
      return 'Solicitação OTA recusada: verifique se a release publicada está íntegra.';
    }
    return 'Não foi possível iniciar a atualização OTA no momento. Tente novamente em instantes.';
  }
  return 'Falha de comunicação ao solicitar atualização OTA. Verifique sua conexão e tente novamente.';
}

export function OtaExecutivePanel({
  device,
  disabled = false,
}: OtaExecutivePanelProps) {
  const [isTriggering, setIsTriggering] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [feedback, setFeedback] = useState<OtaFeedbackState | null>(null);

  useEffect(() => {
    setFeedback(null);
    setIsConfirmOpen(false);
  }, [device.id, device.availableOta.version, device.currentFw]);

  useEffect(() => {
    if (!isConfirmOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTriggering) {
        setIsConfirmOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isConfirmOpen, isTriggering]);

  const { currentStep, stateTone } = computeActiveOtaStep(device);
  const isOtaBusy =
    device.otaStatus.inProgress ||
    device.otaStatus.awaitingReboot ||
    isTriggering;

  const availableVer = device.availableOta.version;
  const upgradeEligible = isPublishedOtaUpgradeEligible(device.currentFw, availableVer);
  const isSignedRelease = Boolean(device.availableOta.sigAlg);

  const canStartOta =
    !disabled &&
    device.isOnline &&
    !device.state.valveOpen &&
    !isOtaBusy &&
    upgradeEligible;

  const formattedFileSize = device.availableOta.fileSize
    ? `${(device.availableOta.fileSize / 1024).toFixed(1)} KB`
    : 'Não informado';
  const shortSha256 = device.availableOta.sha256
    ? device.availableOta.sha256.slice(0, 12)
    : '--';

  const handleConfirmOta = async () => {
    if (!canStartOta || !availableVer) return;
    setFeedback(null);
    setIsTriggering(true);
    try {
      const cmdId = generateClientCommandId('ota');
      const res = await sendOtaUpdateCommand({
        deviceId: device.id,
        targetVersion: availableVer,
        sha256: device.availableOta.sha256,
        commandId: cmdId,
      });
      setIsConfirmOpen(false);
      setFeedback({
        type: 'success',
        message: `Solicitação OTA v${res.version || availableVer} registrada (${res.commandId})! Acompanhe as 4 etapas em tempo real.`,
      });
    } catch (err: unknown) {
      setIsConfirmOpen(false);
      setFeedback({
        type: 'error',
        message: formatFriendlyOtaError(err),
      });
    } finally {
      setIsTriggering(false);
    }
  };

  return (
    <div className="bg-surface rounded-2xl border border-line p-6 shadow-sm space-y-6">
      {/* Cabeçalho do Painel OTA */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-brand to-brand-strong text-white">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-extrabold text-ink">
              Painel Executivo de Atualização Remota (Dual-Bank OTA S3 + ECDSA)
            </h2>
            <p className="text-xs text-ink-muted">
              Firmware reportado pela estação:{' '}
              <strong className="text-brand-strong">
                {device.currentFw ? `v${device.currentFw}` : 'Não informado'} (
                {device.currentPartition ?? 'partição não informada'})
              </strong>
            </p>
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-sunken text-ink">
          <ShieldCheck className="w-4 h-4 text-brand" />
          Arquitetura Dual-Bank (app0 ⇄ app1)
        </span>
      </div>

      {/* 1. Release Publicada no Amazon S3 (única origem aceita — sem versão livre) */}
      {availableVer ? (
        <div
          className={`p-5 rounded-2xl shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4 ${
            upgradeEligible
              ? 'bg-gradient-to-r from-brand-strong to-brand text-white'
              : 'bg-sunken/70 border border-line text-ink'
          }`}
        >
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-extrabold ${
                  upgradeEligible
                    ? 'bg-[#00E676] text-[#1B5E20]'
                    : 'bg-surface border border-line text-ink-muted'
                }`}
              >
                <ArrowUpCircle className="w-3.5 h-3.5" />
                {upgradeEligible
                  ? 'NOVA RELEASE PUBLICADA NO AMAZON S3'
                  : 'RELEASE PUBLICADA NO AMAZON S3'}
              </span>

              {isSignedRelease && (
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-extrabold ${
                    upgradeEligible
                      ? 'bg-white/15 text-white border border-white/25'
                      : 'bg-emerald-100 text-brand-strong'
                  }`}
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  Assinado
                </span>
              )}
            </div>

            <h3 className="text-lg font-extrabold">
              Firmware v{availableVer}
              {upgradeEligible ? ' Disponível para Instalação' : ''}
            </h3>

            {device.availableOta.releaseNotes && (
              <p
                className={`text-xs ${
                  upgradeEligible ? 'text-emerald-100' : 'text-ink-muted'
                }`}
              >
                {device.availableOta.releaseNotes}
              </p>
            )}

            <p
              className={`text-xs font-mono ${
                upgradeEligible ? 'text-emerald-200/90' : 'text-ink-muted'
              }`}
            >
              Instalado: {device.currentFw ? `v${device.currentFw}` : 'desconhecido'} → Alvo: v
              {availableVer} • Tamanho: {formattedFileSize} • SHA-256: {shortSha256}
            </p>

            {!upgradeEligible && (
              <p className="text-xs font-semibold text-ink-muted">
                {!device.currentFw
                  ? 'Versão atual da estação desconhecida. Aguarde a placa reportar o firmware para habilitar a atualização.'
                  : 'A estação já está nesta versão ou em uma versão mais recente (downgrade bloqueado).'}
              </p>
            )}
          </div>

          {disabled ? (
            <span className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-black/15 text-xs font-bold shrink-0">
              <Lock className="w-4 h-4" />
              Somente leitura (Modo Teste)
            </span>
          ) : (
            <button
              type="button"
              disabled={!canStartOta}
              onClick={() => {
                setFeedback(null);
                setIsConfirmOpen(true);
              }}
              className={`px-5 py-3 rounded-xl font-extrabold text-xs shadow-sm transition shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
                upgradeEligible
                  ? 'bg-[#00E676] hover:bg-[#00C853] text-[#1B5E20]'
                  : 'bg-brand text-white'
              }`}
            >
              {device.otaStatus.awaitingReboot
                ? 'Aguardando reinício pós-OTA…'
                : !upgradeEligible && device.currentFw
                  ? `✓ v${device.currentFw} instalada` // v5.44.0: deixa claro que já está atualizada
                  : `Atualizar para v${availableVer}`}
            </button>
          )}
        </div>
      ) : (
        <div className="p-4 rounded-xl bg-sunken/60 border border-line text-xs text-ink-muted">
          Nenhuma release de firmware publicada para esta estação no momento.
        </div>
      )}

      {/* 2. Stepper Visual das 4 Etapas do Motor OTA */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {OTA_STEPS.map((item) => {
          const isCompleted =
            (stateTone === 'success' && item.step <= 4) ||
            ((stateTone === 'active' || stateTone === 'error') &&
              item.step < currentStep);
          const isCurrent = stateTone === 'active' && item.step === currentStep;
          const isErrorStep = stateTone === 'error' && item.step === currentStep;

          return (
            <div
              key={item.step}
              className={`p-4 rounded-xl border transition ${
                isErrorStep
                  ? 'bg-red-50 border-red-300'
                  : isCurrent
                    ? 'bg-amber-50/80 border-[#F57C00] shadow-sm'
                    : isCompleted
                      ? 'bg-emerald-50/70 border-emerald-300'
                      : 'bg-sunken/50 border-line'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-extrabold text-ink">
                  {item.title}
                </span>
                {isErrorStep ? (
                  <RotateCcw className="w-4 h-4 text-danger" />
                ) : isCurrent ? (
                  <Loader2 className="w-4 h-4 text-warning animate-spin" />
                ) : isCompleted ? (
                  <CheckCircle2 className="w-4 h-4 text-brand" />
                ) : (
                  <span className="w-5 h-5 rounded-full bg-surface border border-line text-[11px] font-bold flex items-center justify-center text-ink-muted">
                    {item.step}
                  </span>
                )}
              </div>
              <p className="text-xs text-ink-muted leading-relaxed">{item.desc}</p>
            </div>
          );
        })}
      </div>

      {/* Status Detalhado do Último Ciclo OTA */}
      {device.otaStatus.status && (
        <div
          className={`p-4 rounded-xl border text-xs flex flex-wrap items-center justify-between gap-2 ${
            stateTone === 'error'
              ? 'bg-red-50 border-red-200 text-danger'
              : stateTone === 'active'
                ? 'bg-amber-50 border-amber-200 text-warning'
                : stateTone === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-brand'
                  : 'bg-sunken/60 border-line text-ink-muted'
          }`}
        >
          <div className="font-bold">
            Status OTA ({translateOtaStatus(device.otaStatus.status)}):{' '}
            <span className="font-normal text-ink">
              {device.otaStatus.reason
                ? translateEventReason(device.otaStatus.reason)
                : stateTone === 'active'
                  ? 'Operação OTA em processamento...'
                  : 'Aguardando próximo evento OTA'}
            </span>
          </div>
          {device.otaStatus.targetVersion && (
            <span className="font-mono font-bold">
              Alvo: v{device.otaStatus.targetVersion}
              {device.otaStatus.verifiedFw
                ? ` • Verificado: v${device.otaStatus.verifiedFw}`
                : ''}
            </span>
          )}
        </div>
      )}

      {device.state.valveOpen && (
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-center gap-2 text-xs font-semibold text-warning">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            Safety Interlock: Não é permitido iniciar atualização OTA enquanto a válvula estiver
            aberta irrigando.
          </span>
        </div>
      )}

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className={`p-3.5 rounded-xl border flex items-center gap-2.5 text-xs font-semibold ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-brand'
              : 'bg-red-50 border-red-200 text-danger'
          }`}
        >
          {feedback.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 shrink-0" />
          )}
          <span>{feedback.message}</span>
        </div>
      )}

      {/* Diálogo de Confirmação Antes de Enviar OTA */}
      {/* v5.46.0: confirmação no Dialog padrão; enquanto envia, não fecha */}
      <Dialog
        open={isConfirmOpen && !disabled && !!availableVer}
        onClose={() => setIsConfirmOpen(false)}
        dismissible={!isTriggering}
        size="sm"
        eyebrow="Atualização remota (OTA)"
        title="Confirmar atualização do firmware"
        footer={<>
          <Button variant="ghost" disabled={isTriggering} onClick={() => setIsConfirmOpen(false)}>Cancelar</Button>
          <Button variant="primary" disabled={!canStartOta} loading={isTriggering} onClick={handleConfirmOta}>Confirmar e atualizar</Button>
        </>}
      >
            <div className="space-y-2.5 text-xs text-ink">
              <div className="p-3.5 rounded-xl bg-sunken/70 border border-line space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-muted font-semibold">Versão:</span>
                  <span className="font-mono font-extrabold text-brand-strong">
                    v{device.currentFw} → v{availableVer}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-muted font-semibold">Tamanho:</span>
                  <span className="font-mono font-bold">{formattedFileSize}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-muted font-semibold">SHA-256:</span>
                  <span className="font-mono font-bold">{shortSha256}</span>
                </div>
                {isSignedRelease && (
                  <div className="flex items-center justify-between gap-2 pt-1 border-t border-line">
                    <span className="text-ink-muted font-semibold">Integridade:</span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-brand-strong font-extrabold text-xs">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Assinado
                    </span>
                  </div>
                )}
              </div>

              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2.5 text-[#92400E] leading-relaxed">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-warning" />
                <span>
                  Atenção: a válvula precisa estar fechada; a estação fica até ~10 min sem
                  responder durante a atualização.
                </span>
              </div>
            </div>

      </Dialog>
    </div>
  );
}
