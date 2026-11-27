/**
 * =====================================================================================
 * ARQUIVO: src/features/station-settings/components/LocalControlsCard.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T23:50:00Z (UTC)
 * VERSÃO: v5.41.0
 * PROPÓSITO: "Display e botões da estação" (firmware 5.27.0 + SendCommand v5.38.0):
 *            liga/apaga a tela agora, define o padrão (sempre ligada ou acende pelo botão)
 *            e a duração da irrigação pelo botão físico. Cada ajuste é um `action: "config"`
 *            com número único e só é anunciado depois do ACK da estação. O estado mostrado
 *            vem da última telemetria (`sys.disp*`, `sys.btn_*`). Convidado: só leitura.
 * =====================================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Hand,
  Loader2,
  Monitor,
  MonitorOff,
  Power,
  Save,
  ToggleRight,
} from 'lucide-react';
import { DeviceModel } from '../../devices/model/device.types';
import {
  DisplayModeCommand,
  generateClientCommandId,
  sendLocalControlsConfigCommand,
  waitForCommandAck,
} from '../../irrigation/api/commandApi';
import { useLatestTelemetry } from '../../telemetry/hooks/useLatestTelemetry';
import { describeDisplayState, readingAgeS } from '../../telemetry/model/localControls';
import { InfoTip } from '../../../shared/ui/InfoTip';

interface LocalControlsCardProps {
  device: DeviceModel;
  disabled?: boolean;
}

type ActionKey = 'on5' | 'on30' | 'off' | 'default_on' | 'default_off' | 'btn';

interface Feedback {
  type: 'success' | 'warning' | 'error';
  message: string;
}

/** Primeira versão do firmware com display e botões controláveis. */
export const LOCAL_CONTROLS_MIN_FW = '5.27.0';

/** Mensagem amigável para recusas da estação ou do servidor. */
export function friendlyLocalConfigError(reasonOrError: string | null | undefined): string {
  const r = (reasonOrError ?? '').toLowerCase();
  if (r.includes('nvs')) return 'a estação não conseguiu gravar o ajuste na memória. Tente de novo.';
  if (r.includes('out_of_range') || r.includes('invalid')) return 'valor fora da faixa aceita pela estação.';
  if (r.includes('ota')) return 'a estação está atualizando o firmware. Tente depois.';
  return reasonOrError ? `motivo: ${reasonOrError}` : 'sem detalhe.';
}

const BUTTON_MINUTES = Array.from({ length: 15 }, (_, i) => i + 1);

export function LocalControlsCard({ device, disabled = false }: LocalControlsCardProps) {
  const queryClient = useQueryClient();
  const { data: telemetry, isLoading } = useLatestTelemetry(device.id);
  const lc = telemetry?.localControls ?? null;

  const [busy, setBusy] = useState<ActionKey | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [btnMin, setBtnMin] = useState<number>(lc?.btnIrrigMin ?? 5);
  const [btnDirty, setBtnDirty] = useState(false);

  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const refreshTimerRef = useRef<number | null>(null);

  // Troca de estação: cancela o que estiver pendente e limpa a tela.
  useEffect(() => {
    genRef.current += 1;
    abortRef.current?.abort();
    setBusy(null);
    setFeedback(null);
    setBtnDirty(false);
    return () => {
      abortRef.current?.abort();
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    };
  }, [device.id]);

  // Valor confirmado pela estação chega pela telemetria (sem sobrescrever o que o usuário está editando).
  useEffect(() => {
    if (!btnDirty && lc?.btnIrrigMin) setBtnMin(lc.btnIrrigMin);
  }, [lc?.btnIrrigMin, btnDirty]);

  const supported = lc !== null;
  const fwLabel = telemetry?.fw ? `v${telemetry.fw}` : 'versão desconhecida';
  const blocked = disabled || !device.isOnline || !supported || busy !== null;

  const send = async (
    key: ActionKey,
    params: { displayMode?: DisplayModeCommand; displayMinutes?: number; btnIrrigMin?: number },
    successText: string,
  ) => {
    if (blocked) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const myGen = ++genRef.current;
    const deviceId = device.id;
    const cmdId = generateClientCommandId('cfg');
    setBusy(key);
    setFeedback(null);
    try {
      const res = await sendLocalControlsConfigCommand({ deviceId, commandId: cmdId, signal: controller.signal, ...params });
      if (myGen !== genRef.current) return;
      const ack = await waitForCommandAck({
        deviceId,
        commandId: res.commandId,
        targetStatuses: ['done', 'failed', 'error', 'publish_failed'],
        expectedAction: 'config',
        timeoutMs: 15_000,
        signal: controller.signal,
      });
      if (myGen !== genRef.current) return;
      if (ack.status === 'done' && ack.result !== 'failed') {
        setFeedback({ type: 'success', message: `${successText} A estação confirmou (ACK).` });
        if (key === 'btn') setBtnDirty(false);
        // A estação envia uma leitura logo após o ajuste: atualiza o estado mostrado.
        if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ['telemetry', 'latest'] });
        }, 1500);
      } else {
        setFeedback({ type: 'error', message: `A estação recusou o ajuste: ${friendlyLocalConfigError(ack.error || ack.reason)}` });
      }
    } catch (err: unknown) {
      if ((err as Error)?.name === 'AbortError' || myGen !== genRef.current) return;
      const msg = (err as Error)?.message || '';
      if (msg === 'TIMEOUT_ACK') {
        setFeedback({
          type: 'warning',
          message: 'Pedido enviado, mas a estação não confirmou em 15 s. Veja o resultado em Logs & Auditoria.',
        });
      } else {
        setFeedback({ type: 'error', message: msg || 'Não foi possível enviar o ajuste.' });
      }
    } finally {
      if (myGen === genRef.current) setBusy(null);
    }
  };

  const spin = (key: ActionKey) => (busy === key ? <Loader2 className="w-4 h-4 animate-spin" /> : null);

  const quickBtn =
    'inline-flex items-center justify-center gap-2 px-2 sm:px-4 py-2.5 rounded-xl border text-xs font-extrabold whitespace-nowrap transition disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="bg-surface rounded-2xl border border-line p-6 shadow-sm" data-testid="local-controls-card">
      <div className="flex items-center gap-3 border-b border-line pb-4 mb-5">
        <div className="p-2.5 rounded-xl bg-info-tint text-info">
          <Monitor className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-extrabold text-ink flex items-center gap-1.5">
            Display e botões da estação
            <InfoTip k="botaoFisico" />
          </h2>
          <p className="text-xs text-ink-muted">
            Ligue ou apague a tela da placa e ajuste o botão físico de irrigação. Cada ajuste só aparece como feito depois da
            confirmação da estação.
          </p>
        </div>
      </div>

      {!supported && !isLoading && (
        <div className="mb-5 p-3.5 rounded-xl border border-info-soft bg-info-tint/60 text-xs text-info-strong font-semibold flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            Disponível a partir do firmware {LOCAL_CONTROLS_MIN_FW}. A estação está com {fwLabel}: atualize em “Atualização de
            firmware (OTA)” acima.
          </span>
        </div>
      )}

      {lc && lc.btnFault > 0 && (
        <div role="alert" className="mb-5 p-3.5 rounded-xl border border-amber-200 bg-amber-50 text-xs text-warning font-semibold flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            {lc.btnFault & 2 ? 'Botão de irrigação travado' : 'Botão do display travado'}
            {lc.btnFault === 3 ? ' e botão do display travado' : ''}: a estação está ignorando o botão até ele ser solto. Verifique
            umidade ou fio em curto na caixa. <InfoTip k="botaoTravado" align="left" />
          </span>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Tela agora */}
        <section className="space-y-3" aria-labelledby="lc-now">
          <div className="flex items-center justify-between gap-2">
            <h3 id="lc-now" className="text-xs font-extrabold uppercase tracking-wide text-ink-muted flex items-center gap-1">
              Tela agora <InfoTip k="displayEstacao" align="left" />
            </h3>
            {lc && (
              <span
                data-testid="display-state"
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-extrabold ${
                  lc.displayOn ? 'bg-emerald-100 text-brand-strong' : 'bg-slate-200 text-ink-soft'
                }`}
              >
                {lc.displayOn ? <Monitor className="w-3.5 h-3.5" /> : <MonitorOff className="w-3.5 h-3.5" />}
                {describeDisplayState(lc, readingAgeS(telemetry?.timestamp))}
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              disabled={blocked}
              onClick={() => send('on5', { displayMode: 'on', displayMinutes: 5 }, 'Display ligado por 5 min.')}
              className={`${quickBtn} border-brand bg-brand-tint text-brand-strong hover:bg-brand-soft`}
            >
              {spin('on5') ?? <Power className="w-4 h-4 hidden sm:block" />} Ligar 5 min
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={() => send('on30', { displayMode: 'on', displayMinutes: 30 }, 'Display ligado por 30 min.')}
              className={`${quickBtn} border-brand bg-brand-tint text-brand-strong hover:bg-brand-soft`}
            >
              {spin('on30') ?? <Power className="w-4 h-4 hidden sm:block" />} Ligar 30 min
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={() => send('off', { displayMode: 'off' }, 'Display apagado.')}
              className={`${quickBtn} border-[#CFD8DC] bg-subtle text-ink-soft hover:bg-sunken`}
            >
              {spin('off') ?? <MonitorOff className="w-4 h-4 hidden sm:block" />} Apagar
            </button>
          </div>
          <p className="text-xs text-ink-muted leading-relaxed">
            “Ligar por X min” vale até o tempo acabar ou até a estação reiniciar; depois ela volta ao padrão abaixo.
          </p>
        </section>

        {/* Padrão */}
        <section className="space-y-3" aria-labelledby="lc-default">
          <h3 id="lc-default" className="text-xs font-extrabold uppercase tracking-wide text-ink-muted">
            Padrão da tela (fica gravado na placa)
          </h3>
          <div className="grid sm:grid-cols-2 gap-2" role="radiogroup" aria-labelledby="lc-default">
            {([
              { key: 'default_on' as const, on: true, title: 'Sempre ligada', text: 'Bom na bancada, para acompanhar tudo.' },
              { key: 'default_off' as const, on: false, title: 'Apagada', text: 'Acende 5 min ao tocar no botão. Ideal no campo.' },
            ]).map((opt) => {
              const active = lc ? lc.displayDefaultOn === opt.on : false;
              return (
                <button
                  key={opt.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={blocked || active}
                  onClick={() =>
                    send(opt.key, { displayMode: opt.key }, opt.on ? 'Padrão: tela sempre ligada.' : 'Padrão: tela apagada (acende pelo botão).')
                  }
                  className={`p-3 rounded-xl border text-left transition disabled:cursor-not-allowed ${
                    active
                      ? 'bg-brand-soft/45 border-brand text-brand-strong'
                      : 'bg-sunken/60 border-line text-ink-soft hover:border-[#90A4AE] disabled:opacity-50'
                  }`}
                >
                  <span className="flex items-center gap-1.5 text-xs font-extrabold">
                    {spin(opt.key) ?? <ToggleRight className={`w-4 h-4 ${active ? '' : 'opacity-40'}`} />}
                    {opt.title}
                    {active && <span className="ml-auto text-[11px] font-bold uppercase">atual</span>}
                  </span>
                  <span className="block text-xs text-ink-muted mt-1 leading-snug">{opt.text}</span>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {/* Botão de irrigação */}
      <section className="mt-5 pt-5 border-t border-line grid gap-4 lg:grid-cols-2" aria-labelledby="lc-btn">
        <div className="space-y-2">
          <h3 id="lc-btn" className="text-xs font-extrabold uppercase tracking-wide text-ink-muted">
            Botão de irrigação
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="lc-btn-min" className="text-xs font-bold text-ink">
              Ao segurar o botão, irrigar por
            </label>
            <select
              id="lc-btn-min"
              value={btnMin}
              disabled={disabled || !supported || busy !== null}
              onChange={(e) => {
                setBtnMin(Number(e.target.value));
                setBtnDirty(true);
              }}
              className="px-3 py-2 rounded-lg border border-line bg-surface text-sm font-bold text-ink disabled:bg-slate-100"
            >
              {BUTTON_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={blocked || !btnDirty || btnMin === lc?.btnIrrigMin}
              onClick={() => send('btn', { btnIrrigMin: btnMin }, `Botão de irrigação ajustado para ${btnMin} min.`)}
              className={`${quickBtn} border-[#1565C0] bg-info-strong text-white hover:bg-[#0D47A1]`}
            >
              {spin('btn') ?? <Save className="w-4 h-4" />} Salvar
            </button>
          </div>
          <p className="text-xs text-ink-muted leading-relaxed">
            Valem as mesmas proteções do botão do site: tempo máximo, chuva, anti-rajada e modo seguro.
          </p>
        </div>

        <div className="rounded-xl bg-subtle border border-line p-3.5">
          <p className="flex items-center gap-1.5 text-xs font-extrabold text-ink">
            <Hand className="w-4 h-4 text-brand" /> Como usar os botões da caixa
          </p>
          <ul className="mt-2 space-y-1.5 text-xs text-ink-soft leading-relaxed">
            <li>
              <strong>Display:</strong> um toque acende por 5 min; outro toque apaga.
            </li>
            <li>
              <strong>Irrigação:</strong> segure 1 segundo para ligar; um toque desliga.
            </li>
            <li className="flex items-center gap-1">
              Cada aperto aparece em Logs &amp; Auditoria, na categoria “Botões da estação”. <InfoTip k="eventoLocal" align="right" />
            </li>
          </ul>
        </div>
      </section>

      {feedback && (
        <div
          role="status"
          aria-live="polite"
          className={`mt-5 p-3.5 rounded-xl border flex items-center gap-2.5 text-xs font-semibold ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-brand'
              : feedback.type === 'warning'
                ? 'bg-amber-50 border-amber-200 text-warning'
                : 'bg-red-50 border-red-200 text-danger'
          }`}
        >
          {feedback.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
          <span>{feedback.message}</span>
        </div>
      )}

      {!device.isOnline && supported && (
        <p className="mt-4 text-xs font-semibold text-warning">Estação offline: os ajustes ficam disponíveis quando ela voltar.</p>
      )}
      {disabled && (
        <p className="mt-4 text-xs font-semibold text-ink-muted">Modo demonstração: só o titular altera o display e os botões.</p>
      )}
    </div>
  );
}
