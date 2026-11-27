/**
 * =====================================================================================
 * ARQUIVO: src/features/auth/hooks/useAuth.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-02T05:00:00-03:00
 * VERSÃO: v5.24.3
 * PROPÓSITO: Hook para acesso rápido ao usuário autenticado no Firebase Auth.
 * =====================================================================================
 */

import { useContext } from 'react';
import { AuthContext, AuthContextValue } from '../../../app/providers/AppProviders';

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}