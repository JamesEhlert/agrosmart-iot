/**
 * v5.44.0 / v5.45.0: junta classes condicionais (clsx). Sem tailwind-merge (pesava ~10 KB
 * no carregamento inicial): os componentes não dependem de "a última classe vence" —
 * quem precisa de outro espaçamento usa as props (ex.: Card padded={false}).
 */
import { clsx, type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
