/**
 * =====================================================================================
 * ARQUIVO: src/app/layouts/AppFooter.tsx
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T20:30:00Z
 * VERSÃO: v5.38.0
 * PROPÓSITO: Rodapé compacto (nome, versões, estado da estação e "Sobre o projeto") e
 *            botão "voltar ao topo".
 * CHANGELOG:
 * - v5.38.0 (F1.1): removida a "doca" fina "Status da Arquitetura" que subia no fim da
 *   página; rodapé numa faixa só; o registro de diagnóstico saiu do rodapé e virou um
 *   botão do titular no cabeçalho (DiagnosticsLauncher). As tecnologias vão para a página
 *   "Sobre o projeto".
 * - v5.37.0 (WEB-13): painel de diagnóstico só para o titular (`?diag=1` na Demo).
 * - v5.33.0 (Fase 4.0-B): painel novo de diagnóstico; versão do web vinda do package.json.
 * =====================================================================================
 */

import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Sprout, ArrowUp, BookOpen, Palette } from 'lucide-react';
import { DeviceModel } from '../../features/devices/model/device.types';
import { APP_VERSION_LABEL } from '../../shared/config/appInfo';
import { scrollBehavior } from '../../shared/lib/motion';

interface AppFooterProps {
  device: DeviceModel | null;
}

export function AppFooter({ device }: AppFooterProps) {
  const currentYear = new Date().getFullYear();
  const [showScrollTop, setShowScrollTop] = useState(false);

  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 900);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const fwLabel = device?.currentFw ? `v${device.currentFw}` : null;

  return (
    <>
      {showScrollTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: scrollBehavior() })}
          title="Voltar ao topo da página"
          aria-label="Voltar ao topo da página"
          // v5.44.0: no celular vira um botão redondo só com ícone, acima da barra de navegação
          // (antes cobria valores e textos); aparece só depois de rolar bastante.
          className="fixed bottom-[88px] lg:bottom-6 right-4 lg:right-5 z-40 inline-flex items-center justify-center gap-1.5 w-11 h-11 lg:w-auto lg:h-auto lg:px-4 lg:py-2.5 rounded-full bg-brand/90 hover:bg-brand-strong text-white text-xs font-extrabold shadow-lg backdrop-blur border border-white/20 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <ArrowUp className="w-4 h-4" aria-hidden="true" />
          <span className="hidden lg:inline">Topo</span>
        </button>
      )}

      <footer className="mt-12 bg-surface border-t border-line text-ink-muted">
        <div className="max-w-7xl w-full mx-auto px-4 lg:px-6 2xl:px-8 py-5 flex flex-col md:flex-row items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="p-1.5 rounded-lg bg-gradient-to-br from-brand to-brand-strong text-white shrink-0">
              <Sprout className="w-4 h-4" />
            </span>
            <span className="font-extrabold text-ink whitespace-nowrap">AgroSmart Precision IoT</span>
            <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-brand-soft/70 text-brand-strong whitespace-nowrap">
              Web {APP_VERSION_LABEL}
            </span>
            {fwLabel && (
              <span className="hidden sm:inline px-2 py-0.5 rounded-full text-[11px] font-bold bg-sunken text-ink whitespace-nowrap">
                Firmware {fwLabel}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            {device && (
              <span
                className="inline-flex items-center gap-1.5 font-semibold text-ink"
                title={device.isOnline ? 'Conectada à nuvem por MQTT com certificado X.509 (mTLS)' : 'Sem conexão com a nuvem'}
              >
                <span className={`w-2 h-2 rounded-full ${device.isOnline ? 'bg-brand' : 'bg-danger'}`} />
                Estação {device.isOnline ? 'online' : 'offline'}
              </span>
            )}
            <NavLink to="/about" className="inline-flex items-center gap-1 font-bold text-brand hover:underline">
              <BookOpen className="w-3.5 h-3.5" />
              Sobre o projeto
            </NavLink>
            {/* v5.44.0: vitrine do design system */}
            <NavLink to="/design" className="inline-flex items-center gap-1 font-bold text-brand hover:underline">
              <Palette className="w-3.5 h-3.5" />
              Design system
            </NavLink>
            <span>
              © {currentYear} <strong className="text-ink">James Rafael Ehlert Reinard</strong>
            </span>
          </div>
        </div>
      </footer>
    </>
  );
}
