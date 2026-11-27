/**
 * ARQUIVO: src/shared/ui/OfflineBanner.tsx — v5.47.0
 * Faixa "Sem internet" (o navegador avisa quando a conexão cai e volta). Sem ela, a tela
 * ficava carregando sem explicação. Comandos à estação nunca ficam guardados para depois:
 * sem internet, o envio falha na hora e a tela mostra o erro (segurança da válvula).
 */
import { useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';

function subscribe(cb: () => void): () => void {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

/** true = o navegador diz que está conectado (sem a API, assume conectado). Exportado para teste. */
export function readOnline(nav: { onLine?: boolean } | undefined = typeof navigator !== 'undefined' ? navigator : undefined): boolean {
  return nav?.onLine !== false;
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, () => readOnline(), () => true);
}

export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div role="status" data-testid="offline-banner"
      className="sticky top-14 lg:top-20 z-[19] bg-amber-50 border-b border-amber-300 text-warning-strong px-4 lg:px-8 py-2 text-xs sm:text-sm font-semibold flex items-center gap-2">
      <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>Sem internet neste aparelho. Os dados na tela podem estar desatualizados e os comandos à estação ficam indisponíveis até a conexão voltar.</span>
    </div>
  );
}
