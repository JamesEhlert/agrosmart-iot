/**
 * =====================================================================================
 * ARQUIVO: src/shared/config/appInfo.ts
 * PROJETO: AgroSmart Precision IoT V5 — Web
 * DATA: 2026-11-23 (UTC) — Fase 4.0-B
 * PROPOSITO: Fonte UNICA da versao do web app (vem do package.json no build) e do
 *            instante do build. Substitui as versoes digitadas a mao (rodape e logs).
 * =====================================================================================
 */

const injectedVersion = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
const injectedBuild = typeof __APP_BUILD_UTC__ === 'string' ? __APP_BUILD_UTC__ : '';

/** Versao do web app sem o "v" (ex.: "5.33.0"). */
export const APP_VERSION: string = injectedVersion || '0.0.0-dev';

/** Rotulo exibido e gravado nos logs (ex.: "v5.33.0"). */
export const APP_VERSION_LABEL = `v${APP_VERSION}`;

/** Instante UTC do build (ISO-8601) ou "dev". */
export const APP_BUILD_UTC: string = injectedBuild || 'dev';
