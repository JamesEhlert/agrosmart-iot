/**
 * =====================================================================================
 * ARQUIVO: src/features/events/hooks/useLogBrowser.ts
 * PROJETO: AgroSmart Precision System (AgroSmart Precision IoT V5 — Web)
 * AUTOR: James Rafael Ehlert Reinard
 * DATA DE ATUALIZAÇÃO: 2026-11-24T19:30:00Z (UTC)
 * VERSÃO: v5.37.0
 * PROPÓSITO: Motor de navegação dos logs (WEB-12). Três modos:
 *   - server:    sem filtro de categoria/busca → páginas de 50 direto do Firestore
 *                (intervalo e ordem no servidor; "Página X de Y" pela contagem).
 *   - scan:      com categoria ou busca de texto → lê o intervalo em lotes de 250 (até
 *                3.000), guarda em memória e filtra/ordena/pagina aqui. Trocar de
 *                categoria não lê de novo; contagem exata por categoria.
 *   - operation: texto com cara de número de operação → busca exata no servidor em todo
 *                o histórico.
 * Cancelamento por "geração": respostas atrasadas de um filtro antigo são descartadas.
 * =====================================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import {
  countActivityLogsInRange,
  fetchActivityLogsPage,
  findActivityLogsByOperationId,
} from '../api/eventRepository';
import { ActivityLogModel } from '../model/event.types';
import { countByCategory, LogCategoryKey, matchesCategory, matchesSearch } from '../model/logFilters';
import {
  LOG_PAGE_SIZE,
  LogOrder,
  LogRange,
  looksLikeOperationId,
  pageCountOf,
  pageSlice,
  rangeKeyOf,
  SCAN_BATCH,
  SCAN_MAX_DOCS,
  sortLogs,
} from '../model/logQuery';
import { logWebDiagnostic } from '../../../shared/lib/diagnostics';

export type BrowseMode = 'server' | 'scan' | 'operation';

type Cursor = QueryDocumentSnapshot<DocumentData> | null;

interface ServerPage {
  logs: ActivityLogModel[];
  lastDoc: Cursor;
  hasMore: boolean;
}

interface ScanState {
  key: string;
  docs: ActivityLogModel[];
  cursor: Cursor;
  done: boolean;
  capped: boolean;
  running: boolean;
}

export interface LogBrowserParams {
  deviceId: string;
  range: LogRange;
  order: LogOrder;
  category: LogCategoryKey;
  search: string;
}

function errorText(err: unknown): string {
  const code = String((err as { code?: string })?.code ?? '');
  if (code.includes('permission-denied')) return 'Sem permissão para ler o histórico desta estação.';
  if (code.includes('unavailable')) return 'Sem conexão com o banco de dados. Tente de novo em instantes.';
  return 'Não foi possível carregar os registros. Tente “Atualizar”.';
}

export function useLogBrowser({ deviceId, range, order, category, search }: LogBrowserParams) {
  const trimmed = search.trim();
  const operationId = looksLikeOperationId(trimmed) ? trimmed : null;
  const mode: BrowseMode = operationId ? 'operation' : category !== 'all' || trimmed !== '' ? 'scan' : 'server';

  const [reloadStamp, setReloadStamp] = useState(0);
  const rangeKey = rangeKeyOf(range);
  const serverKey = `${deviceId}|${rangeKey}|${order}|${reloadStamp}`;
  const scanKey = `${deviceId}|${rangeKey}|${reloadStamp}`;
  const countKey = scanKey;

  const [pageIndex, setPageIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [serverLoading, setServerLoading] = useState(false);

  // ---------- Contagem do intervalo ----------
  const [countState, setCountState] = useState<{ key: string; total: number | null }>({ key: '', total: null });
  const total = countState.key === countKey ? countState.total : null;
  useEffect(() => {
    let alive = true;
    countActivityLogsInRange(deviceId, range)
      .then((n) => alive && setCountState({ key: countKey, total: n }))
      .catch(() => alive && setCountState({ key: countKey, total: null }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countKey]);

  // ---------- Modo server: páginas guardadas por chave ----------
  const [pagesState, setPagesState] = useState<{ key: string; list: ServerPage[] }>({ key: '', list: [] });
  const pages = useMemo(() => (pagesState.key === serverKey ? pagesState.list : []), [pagesState, serverKey]);
  const pagesRef = useRef(pagesState);
  pagesRef.current = pagesState;
  const serverKeyRef = useRef(serverKey);
  serverKeyRef.current = serverKey;
  const inflightRef = useRef<string>('');

  const fetchServerPage = useCallback(
    async (i: number) => {
      const key = serverKey;
      const tag = `${key}#${i}`;
      if (inflightRef.current === tag) return;
      const known = pagesRef.current.key === key ? pagesRef.current.list : [];
      if (i > 0 && !known[i - 1]) return;
      inflightRef.current = tag;
      setServerLoading(true);
      setError(null);
      try {
        const res = await fetchActivityLogsPage({
          deviceId,
          cursorDoc: i > 0 ? known[i - 1].lastDoc : null,
          pageSize: LOG_PAGE_SIZE,
          since: range.from,
          until: range.to,
          order,
        });
        if (serverKeyRef.current !== key) return;
        setPagesState((prev) => {
          const list = prev.key === key ? [...prev.list] : [];
          list[i] = { logs: res.logs, lastDoc: res.lastDoc, hasMore: res.hasMore };
          return { key, list };
        });
      } catch (err: unknown) {
        if (serverKeyRef.current === key) setError(errorText(err));
      } finally {
        if (inflightRef.current === tag) inflightRef.current = '';
        if (serverKeyRef.current === key) setServerLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverKey],
  );

  useEffect(() => {
    if (mode === 'server' && !pages[pageIndex] && !error) void fetchServerPage(pageIndex);
  }, [mode, pages, pageIndex, error, fetchServerPage]);

  // ---------- Modo scan: varredura do intervalo em lotes, pausável e retomável ----------
  const [scanState, setScanState] = useState<ScanState | null>(null);
  const scan = scanState && scanState.key === scanKey ? scanState : null;
  const scanRef = useRef<ScanState | null>(null);
  scanRef.current = scanState;
  const scanGenRef = useRef(0);

  useEffect(() => {
    if (mode !== 'scan') return undefined;
    const prev = scanRef.current && scanRef.current.key === scanKey ? scanRef.current : null;
    if (prev && (prev.done || prev.capped)) return undefined;
    const gen = ++scanGenRef.current;
    const started = performance.now();
    let docs = prev ? prev.docs : [];
    let cursor: Cursor = prev ? prev.cursor : null;
    setError(null);
    setScanState({ key: scanKey, docs, cursor, done: false, capped: false, running: true });
    (async () => {
      try {
        for (;;) {
          const res = await fetchActivityLogsPage({
            deviceId,
            cursorDoc: cursor,
            pageSize: SCAN_BATCH,
            since: range.from,
            until: range.to,
            order: 'desc',
          });
          if (gen !== scanGenRef.current) return;
          docs = [...docs, ...res.logs];
          cursor = res.lastDoc;
          const done = !res.hasMore;
          const capped = !done && docs.length >= SCAN_MAX_DOCS;
          setScanState({ key: scanKey, docs, cursor, done, capped, running: !(done || capped) });
          if (done || capped) {
            logWebDiagnostic('INFO', 'logs.scan.done', {
              device_id: deviceId,
              scanned: docs.length,
              capped,
              elapsed_ms: Math.round(performance.now() - started),
            });
            return;
          }
        }
      } catch (err: unknown) {
        if (gen !== scanGenRef.current) return;
        setError(errorText(err));
        setScanState((s) => (s && s.key === scanKey ? { ...s, running: false } : s));
      }
    })();
    return () => {
      // Pausa (ex.: voltou para "Todos"); a próxima entrada retoma do cursor.
      scanGenRef.current += 1;
      setScanState((s) => (s && s.key === scanKey && s.running ? { ...s, running: false } : s));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, scanKey]);

  // ---------- Modo operation ----------
  const [opState, setOpState] = useState<{ key: string; logs: ActivityLogModel[] | null }>({ key: '', logs: null });
  const opKey = `${deviceId}|${operationId ?? ''}|${reloadStamp}`;
  const opLogs = opState.key === opKey ? opState.logs : null;
  useEffect(() => {
    if (!operationId) return undefined;
    let alive = true;
    setError(null);
    findActivityLogsByOperationId(deviceId, operationId)
      .then((logs) => alive && setOpState({ key: opKey, logs }))
      .catch((err) => {
        if (!alive) return;
        setError(errorText(err));
        setOpState({ key: opKey, logs: [] });
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opKey]);

  // ---------- Volta para a página 1 quando o filtro muda ----------
  useEffect(() => {
    setPageIndex(0);
    setError(null);
  }, [serverKey, category, trimmed]);

  // ---------- Resultado derivado ----------
  const scanDocs = scan?.docs ?? [];
  const searchedScan = useMemo(
    () => (mode === 'scan' && trimmed ? scanDocs.filter((l) => matchesSearch(l, trimmed)) : scanDocs),
    [mode, scanDocs, trimmed],
  );
  const scanMatches = useMemo(() => {
    if (mode !== 'scan') return [];
    return sortLogs(searchedScan.filter((l) => matchesCategory(l, category)), order);
  }, [mode, searchedScan, category, order]);

  /** Contagem por categoria: exata quando o período já foi varrido (parcial durante a varredura). */
  const categoryCounts = useMemo(() => (scan ? countByCategory(searchedScan) : null), [scan, searchedScan]);

  let items: ActivityLogModel[] = [];
  let pageCount: number | null = null;
  let hasNext = false;
  let matchCount: number | null = null;

  if (mode === 'server') {
    const page = pages[pageIndex];
    items = page?.logs ?? [];
    pageCount = total === null ? null : pageCountOf(total);
    hasNext = total !== null ? (pageIndex + 1) * LOG_PAGE_SIZE < total : Boolean(page?.hasMore);
  } else if (mode === 'scan') {
    matchCount = scanMatches.length;
    pageCount = pageCountOf(scanMatches.length);
    // A varredura lê do mais recente para o mais antigo: com "mais antigos primeiro" o
    // resultado parcial ainda não é o começo da lista → espera terminar (sem "pulo").
    items = order === 'asc' && scan?.running ? [] : pageSlice(scanMatches, pageIndex);
    hasNext = (pageIndex + 1) * LOG_PAGE_SIZE < scanMatches.length;
  } else {
    const all = sortLogs(opLogs ?? [], order);
    matchCount = all.length;
    pageCount = pageCountOf(all.length);
    items = pageSlice(all, pageIndex);
    hasNext = (pageIndex + 1) * LOG_PAGE_SIZE < all.length;
  }

  // Depois de exclusões, a página atual pode deixar de existir.
  useEffect(() => {
    if (mode !== 'server' && pageCount !== null && pageIndex > pageCount - 1) setPageIndex(pageCount - 1);
  }, [mode, pageCount, pageIndex]);

  const loading =
    mode === 'server'
      ? serverLoading || (!pages[pageIndex] && !error)
      : mode === 'scan'
        ? Boolean(!scan || scan.running)
        : opLogs === null && !error;

  // ---------- Ações ----------
  const goToPage = useCallback((i: number) => {
    setError(null);
    setPageIndex(Math.max(0, i));
  }, []);

  const refresh = useCallback(() => {
    setError(null);
    setReloadStamp((s) => s + 1);
  }, []);

  /** Tira da tela o que foi excluído, sem ler de novo o período. */
  const removeLocally = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      const gone = new Set(ids);
      setScanState((s) => (s ? { ...s, docs: s.docs.filter((l) => !gone.has(l.id)) } : s));
      setOpState((s) => (s.logs ? { ...s, logs: s.logs.filter((l) => !gone.has(l.id)) } : s));
      setCountState((s) => (s.total === null ? s : { ...s, total: Math.max(0, s.total - ids.length) }));
      // Modo server: mantém as páginas anteriores e recarrega a atual pelo mesmo cursor.
      setPagesState((s) => ({ key: s.key, list: s.list.slice(0, pageIndex) }));
    },
    [pageIndex],
  );

  return {
    mode,
    operationId,
    items,
    pageIndex,
    pageCount,
    hasPrev: pageIndex > 0,
    hasNext,
    total,
    matchCount,
    categoryCounts,
    scanned: scan?.docs.length ?? 0,
    scanDone: Boolean(scan?.done),
    scanCapped: Boolean(scan?.capped),
    scanRunning: Boolean(scan?.running),
    loading,
    error,
    goToPage,
    refresh,
    removeLocally,
  };
}
