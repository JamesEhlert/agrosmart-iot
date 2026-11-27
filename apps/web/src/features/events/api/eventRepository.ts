/**
 * =====================================================================================
 * ARQUIVO: src/features/events/api/eventRepository.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * RESPONSAVEL PELA ALTERACAO: Revisao de Seguranca (Bloco 3 — Resiliencia a commands/ restrito)
 * DATA DE ATUALIZAÇÃO: 2026-11-21T08:20:00Z (UTC)
 * VERSÃO: v5.37.0
 * PROPÓSITO: Consulta paginada por cursor (`startAfter`) na subcoleção
 *            `devices/{deviceId}/history` e leitura pontual protegida de `commands/{id}`.
 * CHANGELOG:
 * - v5.37.0 (2026-11-24 UTC, WEB-12): intervalo com fim (`until`) e ordem (`asc`/`desc`)
 *   no servidor; contagem do intervalo (`countActivityLogsInRange`); busca direta por
 *   número de operação (`findActivityLogsByOperationId`, campo `command_id`). Índices
 *   automáticos de campo único — nenhum índice composto novo.
 * - v5.36.0 (2026-11-24 UTC): filtro de período no servidor (`since`), contagem e exclusão
 *   de logs pelo titular (regras do Firestore v5.32.0: só o titular exclui; alerta de
 *   segurança com menos de 30 dias é protegido). Exclusão em lotes adaptativos.
 * - v5.29.1: Trata `permission-denied` em `fetchOperationDocument` retornando `null`
 *   para degradação limpa quando uma sessão Demo abre eventos `ota`/`config` restritos.
 * =====================================================================================
 */

import {
  collection,
  DocumentData,
  getCountFromServer,
  getDocs,
  getDoc,
  doc,
  limit,
  orderBy,
  query,
  QueryConstraint,
  QueryDocumentSnapshot,
  startAfter,
  Timestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { firestoreDb } from '../../../shared/config/firebase';
import {
  ActivityLogModel,
  parseActivityLogFromFirestore,
} from '../model/event.types';
import { DeletionSummary, isDeletionProtected, runAdaptiveDeletion } from '../model/logFilters';
import { logWebDiagnostic } from '../../../shared/lib/diagnostics';

export interface ActivityLogsPageResponse {
  logs: ActivityLogModel[];
  lastDoc: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
}

/**
 * Busca um lote paginado de eventos operacionais ordenado do mais recente para o mais antigo.
 */
export async function fetchActivityLogsPage(params: {
  deviceId: string;
  cursorDoc?: QueryDocumentSnapshot<DocumentData> | null;
  pageSize?: number;
  /** v5.36.0: só registros a partir desta data (filtro no servidor). */
  since?: Date | null;
  /** v5.37.0: só registros ANTES desta data (exclusivo). */
  until?: Date | null;
  /** v5.37.0: 'desc' (padrão) = mais recentes primeiro; 'asc' = mais antigos primeiro. */
  order?: 'asc' | 'desc';
}): Promise<ActivityLogsPageResponse> {
  const pageSize = params.pageSize ?? 20;
  const colRef = collection(firestoreDb, 'devices', params.deviceId, 'history');

  const constraints: QueryConstraint[] = [];
  if (params.since) constraints.push(where('timestamp', '>=', Timestamp.fromDate(params.since)));
  if (params.until) constraints.push(where('timestamp', '<', Timestamp.fromDate(params.until)));
  constraints.push(orderBy('timestamp', params.order === 'asc' ? 'asc' : 'desc'));
  if (params.cursorDoc) constraints.push(startAfter(params.cursorDoc));
  constraints.push(limit(pageSize));
  const q = query(colRef, ...constraints);

  const snapshot = await getDocs(q);
  const docs = snapshot.docs;

  const logs = docs.map((docSnap) =>
    parseActivityLogFromFirestore(docSnap.data(), docSnap.id),
  );

  return {
    logs,
    lastDoc: docs.length > 0 ? docs[docs.length - 1] : null,
    hasMore: docs.length === pageSize,
  };
}

/** v5.37.0: quantos registros há no intervalo (1 leitura a cada 1000 registros). */
export async function countActivityLogsInRange(
  deviceId: string,
  range: { from: Date | null; to: Date | null },
): Promise<number> {
  const constraints: QueryConstraint[] = [];
  if (range.from) constraints.push(where('timestamp', '>=', Timestamp.fromDate(range.from)));
  if (range.to) constraints.push(where('timestamp', '<', Timestamp.fromDate(range.to)));
  const snap = await getCountFromServer(
    query(collection(firestoreDb, 'devices', deviceId, 'history'), ...constraints),
  );
  return snap.data().count;
}

/**
 * v5.37.0: registros de uma operação (`command_id` exato) em todo o histórico.
 * Igualdade num campo só: usa o índice automático; no máximo 50 leituras.
 */
export async function findActivityLogsByOperationId(
  deviceId: string,
  operationId: string,
): Promise<ActivityLogModel[]> {
  const snap = await getDocs(
    query(
      collection(firestoreDb, 'devices', deviceId, 'history'),
      where('command_id', '==', operationId.trim()),
      limit(50),
    ),
  );
  return snap.docs.map((d) => parseActivityLogFromFirestore(d.data(), d.id));
}

/**
 * Uma leitura sob demanda ao abrir os detalhes de uma operação.
 * Em sessões Demo, documentos `ota`/`config` são negados pelas Security Rules v5.29.1;
 * nesses casos retorna `null` sem interromper a renderização do modal.
 */
export async function fetchOperationDocument(
  deviceId: string,
  commandId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const snapshot = await getDoc(doc(firestoreDb, 'devices', deviceId, 'commands', commandId));
    return snapshot.exists() ? snapshot.data() : null;
  } catch (err: unknown) {
    const code = String((err as { code?: string })?.code ?? '').toLowerCase();
    if (code === 'permission-denied' || code === 'firestore/permission-denied') {
      return null;
    }
    throw err;
  }
}
// =====================================================================================
// v5.36.0 — Manutenção do histórico (somente titular; a Demo nem vê os botões e as
// regras do Firestore recusam de qualquer forma).
// =====================================================================================

const historyCol = (deviceId: string) => collection(firestoreDb, 'devices', deviceId, 'history');

async function commitDeletion(deviceId: string, ids: string[]): Promise<void> {
  const batch = writeBatch(firestoreDb);
  for (const id of ids) batch.delete(doc(firestoreDb, 'devices', deviceId, 'history', id));
  await batch.commit();
}

/** Exclui os logs escolhidos. Alertas de segurança recentes são mantidos (espelho da regra). */
export async function deleteActivityLogs(
  deviceId: string,
  logs: ActivityLogModel[],
  onProgress?: (done: number, total: number) => void,
): Promise<DeletionSummary & { deletedIds: string[] }> {
  const now = Date.now();
  const allowed = logs.filter((l) => !isDeletionProtected(l, now)).map((l) => l.id);
  const protectedKept = logs.length - allowed.length;
  const { deleted, denied } = await runAdaptiveDeletion(allowed, (chunk) => commitDeletion(deviceId, chunk), {
    onProgress,
  });
  const summary = { requested: logs.length, deleted: deleted.length, protectedKept, denied: denied.length };
  logWebDiagnostic(denied.length > 0 ? 'WARN' : 'INFO', 'logs.delete.selected', { device_id: deviceId, ...summary });
  return { ...summary, deletedIds: deleted };
}

/** Quantos registros existem antes da data de corte (1 leitura a cada 1000 registros). */
export async function countActivityLogsOlderThan(deviceId: string, cutoff: Date): Promise<number> {
  const snap = await getCountFromServer(
    query(historyCol(deviceId), where('timestamp', '<', Timestamp.fromDate(cutoff))),
  );
  return snap.data().count;
}

/**
 * Exclui, em páginas de 200, todos os registros anteriores à data de corte.
 * Alertas de segurança recentes nunca entram (o corte mínimo da tela é 7 dias, mas a
 * proteção é conferida item a item, como no servidor).
 */
export async function deleteActivityLogsOlderThan(
  deviceId: string,
  cutoff: Date,
  onProgress?: (done: number) => void,
  signal?: AbortSignal,
): Promise<DeletionSummary> {
  const now = Date.now();
  let cursor: QueryDocumentSnapshot<DocumentData> | null = null;
  const summary: DeletionSummary = { requested: 0, deleted: 0, protectedKept: 0, denied: 0 };
  for (let page = 0; page < 500; page += 1) {
    if (signal?.aborted) break;
    const constraints: QueryConstraint[] = [
      where('timestamp', '<', Timestamp.fromDate(cutoff)),
      orderBy('timestamp', 'asc'),
    ];
    if (cursor) constraints.push(startAfter(cursor));
    constraints.push(limit(200));
    const snap = await getDocs(query(historyCol(deviceId), ...constraints));
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1];
    const logs = snap.docs.map((d) => parseActivityLogFromFirestore(d.data(), d.id));
    const allowed = logs.filter((l) => !isDeletionProtected(l, now)).map((l) => l.id);
    summary.requested += logs.length;
    summary.protectedKept += logs.length - allowed.length;
    const res = await runAdaptiveDeletion(allowed, (chunk) => commitDeletion(deviceId, chunk), { signal });
    summary.deleted += res.deleted.length;
    summary.denied += res.denied.length;
    onProgress?.(summary.deleted);
    if (snap.docs.length < 200) break;
  }
  logWebDiagnostic(summary.denied > 0 ? 'WARN' : 'INFO', 'logs.delete.older_than', {
    device_id: deviceId,
    cutoff_utc: cutoff.toISOString(),
    ...summary,
  });
  return summary;
}
