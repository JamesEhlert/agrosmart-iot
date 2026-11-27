/**
 * =====================================================================================
 * ARQUIVO: src/features/devices/hooks/useSelectedDevice.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T05:00:00-03:00
 * VERSÃO: v5.24.3
 * PROPÓSITO: Hook para acessar a estação IoT ativa e alternar entre estações vinculadas.
 * =====================================================================================
 */

import { useContext } from 'react';
import { DeviceContext, DeviceContextValue } from '../../../app/providers/AppProviders';

export function useSelectedDevice(): DeviceContextValue {
  return useContext(DeviceContext);
}