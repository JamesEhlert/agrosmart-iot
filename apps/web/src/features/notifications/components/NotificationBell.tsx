/**
 * =====================================================================================
 * ARQUIVO: src/features/notifications/components/NotificationBell.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-25T06:30:00Z (UTC)
 * VERSÃO: v5.42.0
 * PROPÓSITO: Sino do cabeçalho com contador e painel de notificações ("Agora" = situação
 *            atual; "Últimas 24 horas" = o que aconteceu). Clicar num aviso marca como lido
 *            e leva à tela certa. Acessível: Esc fecha, foco visível, contador lido pelo
 *            leitor de tela. No celular o painel ocupa a largura da tela.
 * =====================================================================================
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertOctagon, AlertTriangle, Bell, BellRing, CheckCheck, CheckCircle2, Info, PartyPopper, X } from 'lucide-react';
import type { DeviceModel } from '../../devices/model/device.types';
import { useNotifications } from '../hooks/useNotifications';
import type { AppNotification, NotificationSeverity } from '../model/notifications';
import { formatAge } from '../../../shared/lib/relativeTime';

const SEVERITY_STYLE: Record<NotificationSeverity, { icon: typeof Info; box: string; dot: string }> = {
  critical: { icon: AlertOctagon, box: 'bg-red-50 text-danger', dot: 'bg-danger' },
  warning: { icon: AlertTriangle, box: 'bg-amber-50 text-warning', dot: 'bg-[#F57C00]' },
  info: { icon: Info, box: 'bg-info-tint text-info', dot: 'bg-info' },
  success: { icon: CheckCircle2, box: 'bg-brand-tint text-brand', dot: 'bg-brand' },
};

interface Props {
  device: DeviceModel | null;
  isDemo: boolean;
}

export function NotificationBell({ device, isDemo }: Props) {
  const { list, unread, isRead, markRead, markAllRead } = useNotifications(device, isDemo);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hasCritical = list.some((n) => n.severity === 'critical' && !isRead(n.id));
  const state = list.filter((n) => n.kind === 'state');
  const events = list.filter((n) => n.kind === 'event');
  const BellIcon = unread > 0 ? BellRing : Bell;

  const go = (n: AppNotification) => {
    markRead([n.id]);
    setOpen(false);
    if (n.link) navigate(n.link.to);
  };

  const renderItem = (n: AppNotification) => {
    const st = SEVERITY_STYLE[n.severity];
    const Icon = st.icon;
    const read = isRead(n.id);
    return (
      <li key={n.id}>
        <button
          type="button"
          onClick={() => go(n)}
          className={`w-full text-left flex gap-3 px-3 py-2.5 rounded-xl transition hover:bg-[#EEF2F5] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2E7D32] ${
            read ? 'opacity-70' : ''
          }`}
        >
          <span className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center ${st.box}`}>
            <Icon className="w-4 h-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-start gap-1.5">
              <span className="text-[13px] font-extrabold text-ink leading-snug flex-1">{n.title}</span>
              {!read && <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${st.dot}`} aria-label="não lida" />}
            </span>
            <span className="block text-xs text-ink-soft leading-snug mt-0.5 line-clamp-3">{n.body}</span>
            <span className="flex items-center justify-between gap-2 mt-1">
              <span className="text-[11px] font-semibold text-ink-muted">{n.at ? formatAge(n.at) : 'agora'}</span>
              {n.link && <span className="text-xs font-bold text-brand">{n.link.label} →</span>}
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notificações: ${unread} não lida(s)` : 'Notificações: nenhuma nova'}
        title="Notificações"
        data-testid="notification-bell"
        className="relative inline-flex items-center justify-center w-10 h-10 tap-target rounded-xl bg-white/10 hover:bg-white/20 border border-white/20 text-white transition"
      >
        <BellIcon className="w-[18px] h-[18px]" />
        {unread > 0 && (
          <span
            data-testid="notification-count"
            className={`absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full text-xs font-extrabold flex items-center justify-center ring-2 ring-[#1B5E20] ${
              hasCritical ? 'bg-danger text-white' : 'bg-[#00E676] text-[#0B3D0F]'
            }`}
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notificações"
          className="fixed sm:absolute left-2 right-2 sm:left-auto sm:right-0 top-[64px] sm:top-auto sm:mt-2 sm:w-[380px] max-h-[75vh] flex flex-col rounded-2xl border border-line bg-surface text-ink shadow-2xl z-50 overflow-hidden anim-pop origin-top-right"
        >
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-line">
            <div>
              <p className="text-sm font-extrabold">Notificações</p>
              <p className="text-xs text-ink-muted">{unread > 0 ? `${unread} não lida(s)` : 'Tudo em dia'}</p>
            </div>
            <div className="flex items-center gap-1">
              {unread > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-brand hover:bg-brand-tint"
                >
                  <CheckCheck className="w-3.5 h-3.5" /> Marcar todas
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Fechar notificações"
                className="p-1.5 rounded-lg text-ink-muted hover:bg-sunken"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="overflow-y-auto p-2" data-testid="notification-panel">
            {list.length === 0 ? (
              <div className="flex flex-col items-center text-center px-6 py-10">
                <span className="w-12 h-12 rounded-2xl bg-brand-tint text-brand flex items-center justify-center">
                  <PartyPopper className="w-6 h-6" />
                </span>
                <p className="mt-3 text-sm font-extrabold">Tudo certo por aqui</p>
                <p className="text-xs text-ink-muted mt-1">
                  Avisos de sensores, agendas, chuva, firmware e falhas aparecem neste painel.
                </p>
              </div>
            ) : (
              <>
                {state.length > 0 && (
                  <>
                    <p className="px-3 pt-1.5 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-ink-muted">Agora</p>
                    <ul>{state.map(renderItem)}</ul>
                  </>
                )}
                {events.length > 0 && (
                  <>
                    <p className="px-3 pt-3 pb-1 text-[11px] font-extrabold uppercase tracking-wider text-ink-muted">
                      Últimas 24 horas
                    </p>
                    <ul>{events.map(renderItem)}</ul>
                  </>
                )}
              </>
            )}
          </div>
          <p className="px-4 py-2 border-t border-line text-[11px] text-ink-muted">
            Atualiza sozinho a cada poucos minutos. "Lida" fica salvo só neste navegador.
          </p>
        </div>
      )}
    </div>
  );
}
