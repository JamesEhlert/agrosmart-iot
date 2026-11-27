/**
 * ARQUIVO: src/shared/lib/relativeTime.ts — v5.40.0
 * "há 25 s", "há 3 min", "há 2 h", "há 4 dias" (para idades de leituras e eventos).
 */
export function formatAge(date: Date | null | undefined, nowMs: number = Date.now()): string {
  if (!date || Number.isNaN(date.getTime())) return 'sem dados';
  const s = Math.max(0, Math.round((nowMs - date.getTime()) / 1000));
  if (s < 60) return `há ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} dias`;
}
