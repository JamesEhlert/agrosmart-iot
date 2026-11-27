/**
 * =====================================================================================
 * ARQUIVO: src/features/schedules/api/scheduleRepository.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Fase 1C — Decisao Demo So Por Claim)
 * DATA DE ATUALIZAÇÃO: 2026-11-22T18:50:00Z (UTC)
 * VERSÃO: v5.31.0 (Decisao Demo Exclusiva por Claim is_demo + 5 Vagas Transacionais)
 * PROPÓSITO: Repositório CRUD em tempo real para a subcoleção `devices/{deviceId}/schedules`
 *            no Cloud Firestore, compatível com `firestore.rules` v5.30.0+:
 *            - Titular: criação via `addDoc` (limite 100), duração até 15 min e CRUD total;
 *            - Demo: criação via `runTransaction` nas vagas `demo-<sid>-0..4`, duração
 *              até 5 min e edição/pausa/exclusão restritas às agendas da sessão atual.
 * CHANGELOG:
 * - v5.38.0 (SCH-01): limite do titular 100 → 20 agendas (`OWNER_MAX_SCHEDULES`), contando só
 *   as agendas do titular (as de sessões Demo têm 5 vagas próprias nas regras). Reforço no
 *   servidor planejado na Scheduler_Logic (backlog SCH-01).
 * - v5.31.0:
 *   * Remove import de `isAuthorizedOperatorEmail` e o fallback baseado em e-mail em
 *     `resolveCallerDemoContext()`. O caminho Demo é decidido exclusivamente pela claim
 *     `is_demo === true`; quem não possui a claim segue o caminho do titular (protegido
 *     pelas Security Rules do servidor).
 * - v5.30.0:
 *   * `createDeviceSchedule` da Demo usa `runTransaction` nas 5 vagas `demo-<sid>-0..4`,
 *     valida duração <= 5 min e libera exclusão apenas para agendas da própria sessão.
 * =====================================================================================
 */

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getDoc,
  onSnapshot,
  runTransaction,
  Unsubscribe,
  updateDoc,
} from 'firebase/firestore';
import { firebaseAuth, firestoreDb } from '../../../shared/config/firebase';
import {
  parseScheduleFromFirestore,
  toFirestoreSchedulePayload,
  validateScheduleDurationForCaller,
} from '../model/schedule.schema';
import {
  buildDemoScheduleSlotIds,
  DEMO_MAX_SCHEDULES_PER_SESSION,
  OWNER_MAX_SCHEDULES,
  ScheduleFormInput,
  ScheduleModel,
} from '../model/schedule.types';

/** Limite de agendamentos do titular por estação (v5.38.0: 20). */
export const MAX_SCHEDULES_PER_DEVICE = OWNER_MAX_SCHEDULES;

/**
 * Resolve o contexto de sessão Demo exclusivamente a partir da claim assinada
 * `is_demo === true` no ID token Firebase. Sem essa claim, segue o caminho do titular
 * (as Security Rules do Firestore garantem a autorização no servidor).
 */
async function resolveCallerDemoContext(): Promise<{
  isDemo: boolean;
  demoSid: string | null;
}> {
  const currentUser = firebaseAuth.currentUser;
  if (!currentUser) {
    throw new Error('Usuário não autenticado.');
  }
  try {
    const tokenRes = await currentUser.getIdTokenResult();
    const claims = tokenRes.claims ?? {};
    if (claims.is_demo === true) {
      const sid = typeof claims.demo_sid === 'string' ? claims.demo_sid.trim() : '';
      return { isDemo: true, demoSid: sid || null };
    }
  } catch {
    // Sem claim confirmada: segue caminho do titular; regras do Firestore decidem no servidor
  }
  return { isDemo: false, demoSid: null };
}

function isOwnedByCurrentDemoSession(
  data: Record<string, unknown> | null | undefined,
  demoSid: string | null,
): boolean {
  return Boolean(
    demoSid &&
      data?.created_by_demo === true &&
      typeof data?.demo_session_id === 'string' &&
      data.demo_session_id === demoSid,
  );
}

/**
 * Escuta em tempo real a lista de agendamentos da estação, ordenando por horário (`HH:mm`).
 */
export function subscribeToDeviceSchedules(
  deviceId: string,
  onData: (schedules: ScheduleModel[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const colRef = collection(firestoreDb, 'devices', deviceId, 'schedules');

  return onSnapshot(
    colRef,
    (snapshot) => {
      const list = snapshot.docs
        .map((docSnap) => parseScheduleFromFirestore(docSnap.data(), docSnap.id))
        .sort((a, b) => a.time.localeCompare(b.time));
      onData(list);
    },
    (err) => {
      if (onError) onError(err);
    },
  );
}

/**
 * Cria um novo agendamento no Firestore:
 * - Titular: valida limite de 100 rotinas e grava com `addDoc`;
 * - Demo: valida duração <= 5 min e usa `runTransaction` para ocupar a primeira vaga
 *   livre entre `demo-<sid>-0..4` (compatível com `firestore.rules` v5.30.0+).
 */
export async function createDeviceSchedule(
  deviceId: string,
  input: ScheduleFormInput,
): Promise<string> {
  const { isDemo, demoSid } = await resolveCallerDemoContext();

  validateScheduleDurationForCaller(input.durationMinutes, isDemo);

  if (isDemo) {
    if (!demoSid) {
      throw new Error(
        'Sessão de Usuário Teste sem identificador válido. Refaça o login com um código ativo.',
      );
    }

    const payload = toFirestoreSchedulePayload({
      ...input,
      createdByDemo: true,
      demoSessionId: demoSid,
    });

    const slotIds = buildDemoScheduleSlotIds(demoSid);
    const slotRefs = slotIds.map((slotId) =>
      doc(firestoreDb, 'devices', deviceId, 'schedules', slotId),
    );

    return runTransaction(firestoreDb, async (tx) => {
      // Lê todas as 5 vagas estritamente ANTES de qualquer escrita na transação
      const snapshots = await Promise.all(slotRefs.map((ref) => tx.get(ref)));
      const freeIndex = snapshots.findIndex((snap) => !snap.exists());

      if (freeIndex === -1) {
        throw new Error(
          `Modo Usuário Teste: limite de ${DEMO_MAX_SCHEDULES_PER_SESSION} agendamentos por sessão atingido. Exclua um dos seus agendamentos para criar outro.`,
        );
      }

      tx.set(slotRefs[freeIndex], payload);
      return slotIds[freeIndex];
    });
  }

  const colRef = collection(firestoreDb, 'devices', deviceId, 'schedules');

  // Conta só as agendas do titular (poucos documentos: no máximo ~25 leituras).
  const existing = await getDocs(colRef);
  const ownerCount = existing.docs.filter((d) => d.data()?.created_by_demo !== true).length;
  if (ownerCount >= MAX_SCHEDULES_PER_DEVICE) {
    throw new Error(
      `Limite de ${MAX_SCHEDULES_PER_DEVICE} agendamentos atingido nesta estação. Exclua ou reaproveite uma rotina para criar outra.`,
    );
  }

  const payload = toFirestoreSchedulePayload({
    ...input,
    createdByDemo: input.createdByDemo,
    demoSessionId: input.demoSessionId,
  });
  const docRef = await addDoc(colRef, payload);
  return docRef.id;
}

/**
 * Atualiza um agendamento existente respeitando as chaves da regra `firestore.rules` (v5.30.0+).
 * No Modo Usuário Teste, permite editar apenas rotinas criadas pela própria sessão atual
 * e com duração máxima de 5 minutos.
 */
export async function updateDeviceSchedule(
  deviceId: string,
  scheduleId: string,
  input: ScheduleFormInput,
): Promise<void> {
  if (!scheduleId.trim()) {
    throw new Error('Identificador do agendamento inválido.');
  }
  const docRef = doc(firestoreDb, 'devices', deviceId, 'schedules', scheduleId);
  const { isDemo, demoSid } = await resolveCallerDemoContext();

  validateScheduleDurationForCaller(input.durationMinutes, isDemo);

  if (isDemo) {
    if (!demoSid) {
      throw new Error('Sessão de Usuário Teste inválida para edição.');
    }
    const snap = await getDoc(docRef);
    const data = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    if (!isOwnedByCurrentDemoSession(data, demoSid)) {
      throw new Error(
        'Modo Usuário Teste: Apenas agendamentos criados nesta sessão atual podem ser editados. Crie um novo agendamento para testar!',
      );
    }

    const payload = toFirestoreSchedulePayload({
      ...input,
      createdByDemo: true,
      demoSessionId: demoSid,
    });
    await updateDoc(docRef, payload);
    return;
  }

  const payload = toFirestoreSchedulePayload({
    ...input,
    createdByDemo: false,
    demoSessionId: null,
  });
  await updateDoc(docRef, {
    ...payload,
    created_by_demo: false,
    demo_session_id: '',
  });
}

/**
 * Alterna rapidamente o status Ativo/Pausado (`enabled`) de um agendamento.
 * No Modo Usuário Teste, permite alternar apenas agendamentos da própria sessão atual.
 */
export async function toggleDeviceScheduleEnabled(
  deviceId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<void> {
  const docRef = doc(firestoreDb, 'devices', deviceId, 'schedules', scheduleId);
  const { isDemo, demoSid } = await resolveCallerDemoContext();

  if (isDemo) {
    const snap = await getDoc(docRef);
    const data = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    if (!isOwnedByCurrentDemoSession(data, demoSid)) {
      throw new Error(
        'Modo Usuário Teste: Apenas agendamentos criados nesta sessão atual podem ser ativados ou pausados.',
      );
    }
    await updateDoc(docRef, { enabled: Boolean(enabled) });
    return;
  }

  await updateDoc(docRef, { enabled: Boolean(enabled) });
}

/**
 * Remove permanentemente um agendamento da subcoleção `schedules`:
 * - Titular: pode excluir qualquer agendamento da estação;
 * - Demo: pode excluir apenas agendamentos criados pela própria sessão ativa (Rules v5.30.0+).
 */
export async function deleteDeviceSchedule(
  deviceId: string,
  scheduleId: string,
): Promise<void> {
  if (!scheduleId.trim()) {
    throw new Error('Identificador do agendamento inválido.');
  }
  const docRef = doc(firestoreDb, 'devices', deviceId, 'schedules', scheduleId);
  const { isDemo, demoSid } = await resolveCallerDemoContext();

  if (isDemo) {
    if (!demoSid) {
      throw new Error('Sessão de Usuário Teste inválida para exclusão.');
    }
    const snap = await getDoc(docRef);
    const data = snap.exists() ? (snap.data() as Record<string, unknown>) : null;
    if (!isOwnedByCurrentDemoSession(data, demoSid)) {
      throw new Error(
        'Modo Usuário Teste: Apenas agendamentos criados nesta sessão atual podem ser excluídos.',
      );
    }
    await deleteDoc(docRef);
    return;
  }

  await deleteDoc(docRef);
}
