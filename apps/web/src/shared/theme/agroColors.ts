/**
 * =====================================================================================
 * ARQUIVO: src/shared/theme/agroColors.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T05:00:00-03:00
 * VERSÃO: v5.24.3
 * PROPÓSITO: Centraliza os tokens semânticos de cores do Design System AgroSmart V5,
 *            mantendo 100% de paridade visual com o arquivo `app_colors.dart` do Flutter.
 * CHANGELOG:
 * - v5.24.3: Mapeamento completo das cores de marca, estados e dos 6 sensores físicos.
 * =====================================================================================
 */

export const AgroColors = {
  // 1. Identidade de Marca
  primary: '#2E7D32',
  primaryDark: '#1B5E20',
  primaryLight: '#C8E6C9',
  accent: '#00E676',

  // 2. Fundos e Superfícies
  background: '#F4F6F8',
  surface: '#FFFFFF',
  surfaceVariant: '#EEF2F5',
  borderLight: '#E0E6ED',

  // 3. Feedback Semântico Operacional
  success: '#2E7D32',
  error: '#D32F2F',
  errorAccent: '#FF5252',
  warning: '#F57C00',
  info: '#1976D2',

  // 4. Tipografia
  textPrimary: '#1C252C',
  textSecondary: '#606F7B',
  textLight: '#FFFFFF',

  // 5. Cores Exclusivas dos 6 Sensores da Estação ESP32
  sensorTemp: '#FB8C00',
  sensorHumidity: '#1E88E5',
  sensorSoil: '#6D4C41',
  sensorUv: '#8E24AA',
  sensorLight: '#FBC02D',
  sensorRain: '#546E7A',
} as const;