/**
 * ARQUIVO: src/shared/lib/motion.ts — v5.47.0
 * "Reduzir movimento" do sistema (acessibilidade): quem tem enjoo ou distração com
 * animação liga essa opção no celular/computador. Rolagem suave e animações de enfeite
 * respeitam a escolha; indicadores de estado (ex.: girando = carregando) continuam.
 */
export function prefersReducedMotion(mm: ((q: string) => { matches: boolean }) | undefined = typeof window !== 'undefined' ? window.matchMedia?.bind(window) : undefined): boolean {
  try {
    return !!mm && mm('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 'smooth' normalmente; 'auto' (pulo direto) para quem pediu menos movimento. */
export function scrollBehavior(reduced: boolean = prefersReducedMotion()): ScrollBehavior {
  return reduced ? 'auto' : 'smooth';
}
