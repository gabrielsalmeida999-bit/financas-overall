/* ==========================================================================
   db.js — IndexedDB versionado, com migrações e transações.
   Regra de ouro: NENHUMA migração apaga dados. Toda operação crítica é
   transacional — se falhar no meio, o banco volta ao estado anterior.
   ========================================================================== */

import { uid, setLogSink, log, logError } from './core.js';

/* O nome pode ser sobrescrito antes do carregamento dos módulos para permitir
   uma base isolada nos testes (ver testes.html). Em uso normal é sempre o padrão. */
export const DB_NAME = globalThis.__OVERALL_DB_NAME__ || 'overall_financas';
export const DB_VERSION = 3;

/** Stores que contêm dados do usuário (entram no backup). */
export const DATA_STORES = [
  'settings',
  'categories',
  'incomes',
  'expenses',
  'recurringExpenses',
  'creditCards',
  'creditPurchases',
  'installments',
  'debts',
  'debtPayments',
  'goals'
];

/** Stores internas (não entram no backup do usuário). */
export const INTERNAL_STORES = ['snapshots', 'logs'];
export const ALL_STORES = [...DATA_STORES, ...INTERNAL_STORES];

/* ------------------------------ Migrações -------------------------------- */
/*
   v1 — estrutura base de todas as entidades financeiras.
   v2 — adiciona 'snapshots' (cópia interna antes de operações críticas),
        'logs' (diagnóstico) e índices por status.
   Toda migração é idempotente: verifica antes de criar.
*/

function migrate(db, tx, oldVersion) {
  log('db.migrate', { from: oldVersion, to: DB_VERSION });

  const store = (name, opts) =>
    db.objectStoreNames.contains(name)
      ? tx.objectStore(name)
      : db.createObjectStore(name, opts || { keyPath: 'id' });

  const index = (st, name, keyPath, opts) => {
    if (!st.indexNames.contains(name)) st.createIndex(name, keyPath, opts);
  };

  if (oldVersion < 1) {
    store('settings', { keyPath: 'key' });

    const cat = store('categories');
    index(cat, 'byName', 'name');
    index(cat, 'byKind', 'kind');

    const inc = store('incomes');
    index(inc, 'byMonth', 'month');
    index(inc, 'byDate', 'date');
    index(inc, 'byCategory', 'categoryId');

    const exp = store('expenses');
    index(exp, 'byMonth', 'month');
    index(exp, 'byDate', 'date');
    index(exp, 'byCategory', 'categoryId');
    index(exp, 'byRecurring', 'recurringId');

    store('recurringExpenses');

    store('creditCards');

    const pur = store('creditPurchases');
    index(pur, 'byCard', 'cardId');
    index(pur, 'byMonth', 'firstMonth');

    const ins = store('installments');
    index(ins, 'byPurchase', 'purchaseId');
    index(ins, 'byMonth', 'month');
    index(ins, 'byCard', 'cardId');
    // Barreira estrutural contra parcelas duplicadas (mesma compra + mesmo número)
    index(ins, 'byPurchaseNumber', ['purchaseId', 'number'], { unique: true });

    store('debts');

    const pay = store('debtPayments');
    index(pay, 'byDebt', 'debtId');
    index(pay, 'byMonth', 'month');
    index(pay, 'byDate', 'date');

    const goal = store('goals');
    index(goal, 'byDeadline', 'deadline');
  }

  if (oldVersion < 2) {
    const snap = store('snapshots');
    index(snap, 'byCreatedAt', 'createdAt');

    const lg = store('logs');
    index(lg, 'byTs', 'ts');

    index(tx.objectStore('expenses'), 'byStatus', 'status');
    index(tx.objectStore('installments'), 'byStatus', 'status');
    index(tx.objectStore('debts'), 'byStatus', 'status');
  }

  if (oldVersion < 3) {
    // Despesas fixas agora podem estar vinculadas a um cartão (assinaturas
    // cobradas na fatura, ex.: Netflix). Índice para consultar rápido por cartão.
    index(tx.objectStore('expenses'), 'byCardId', 'cardId');
  }
}

/* ------------------------------ Abertura --------------------------------- */

let dbPromise = null;
let dbInstance = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }

    req.onupgradeneeded = (ev) => {
      try { migrate(req.result, req.transaction, ev.oldVersion); }
      catch (e) { logError('db.migrate.fail', e); throw e; }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbInstance = null; dbPromise = null; };
      dbInstance = db;
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Falha ao abrir o banco de dados.'));
    req.onblocked = () => reject(new Error(
      'O aplicativo está aberto em outra aba com uma versão diferente. Feche as outras abas e tente novamente.'
    ));
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

export function closeDB() {
  if (dbInstance) { try { dbInstance.close(); } catch (_) {} }
  dbInstance = null;
  dbPromise = null;
}

/* --------------------------- Helpers de request --------------------------- */

function reqp(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Executa uma transação. `fn(stores, tx)` recebe um mapa nome->objectStore.
 * A promessa só resolve quando a transação COMPLETA (oncomplete).
 * Qualquer erro dentro de fn aborta a transação inteira: nada fica pela metade.
 */
export async function tx(storeNames, mode, fn) {
  const db = await openDB();
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(names, mode); }
    catch (e) { reject(e); return; }

    const stores = {};
    for (const n of names) stores[n] = t.objectStore(n);

    let result;
    let failed = null;

    t.oncomplete = () => { if (failed) reject(failed); else resolve(result); };
    t.onerror = () => reject(failed || t.error || new Error('Erro na transação.'));
    t.onabort = () => reject(failed || t.error || new Error('Transação cancelada.'));

    Promise.resolve()
      .then(() => fn(stores, t))
      .then((r) => { result = r; })
      .catch((err) => {
        failed = err;
        try { t.abort(); } catch (_) {}
      });
  });
}

/* ------------------------- Operações de conveniência ---------------------- */

export async function getAll(storeName, query, count) {
  return tx(storeName, 'readonly', (s) => reqp(s[storeName].getAll(query, count)));
}

export async function getAllByIndex(storeName, indexName, query, count) {
  return tx(storeName, 'readonly', (s) => reqp(s[storeName].index(indexName).getAll(query, count)));
}

export async function get(storeName, key) {
  return tx(storeName, 'readonly', (s) => reqp(s[storeName].get(key)));
}

export async function getMany(storeName, keys) {
  return tx(storeName, 'readonly', async (s) => {
    const out = [];
    for (const k of keys) out.push(await reqp(s[storeName].get(k)));
    return out.filter(Boolean);
  });
}

export async function put(storeName, value) {
  return tx(storeName, 'readwrite', async (s) => { await reqp(s[storeName].put(value)); return value; });
}

export async function putMany(storeName, values) {
  return tx(storeName, 'readwrite', async (s) => {
    for (const v of values) await reqp(s[storeName].put(v));
    return values.length;
  });
}

export async function add(storeName, value) {
  return tx(storeName, 'readwrite', async (s) => { await reqp(s[storeName].add(value)); return value; });
}

export async function del(storeName, key) {
  return tx(storeName, 'readwrite', (s) => reqp(s[storeName].delete(key)));
}

export async function count(storeName, query) {
  return tx(storeName, 'readonly', (s) => reqp(s[storeName].count(query)));
}

export async function countAll() {
  const db = await openDB();
  const names = DATA_STORES.filter((n) => db.objectStoreNames.contains(n));
  return tx(names, 'readonly', async (s) => {
    const out = {};
    for (const n of names) out[n] = await reqp(s[n].count());
    return out;
  });
}

/** Dump completo dos dados do usuário (usado por backup e snapshot). */
export async function dumpData() {
  const db = await openDB();
  const names = DATA_STORES.filter((n) => db.objectStoreNames.contains(n));
  return tx(names, 'readonly', async (s) => {
    const out = {};
    for (const n of names) out[n] = await reqp(s[n].getAll());
    return out;
  });
}

/**
 * Substitui TODOS os dados do usuário numa única transação.
 * Se qualquer registro falhar, a transação aborta e os dados atuais permanecem
 * exatamente como estavam. Não existe estado intermediário visível.
 */
export async function replaceAllData(data) {
  const db = await openDB();
  const names = DATA_STORES.filter((n) => db.objectStoreNames.contains(n));
  return tx(names, 'readwrite', async (s) => {
    let written = 0;
    for (const n of names) {
      await reqp(s[n].clear());
      const rows = Array.isArray(data[n]) ? data[n] : [];
      for (const row of rows) { await reqp(s[n].put(row)); written++; }
    }
    return written;
  });
}

/** Apaga todos os dados do usuário (mantém a estrutura do banco). */
export async function clearAllData() {
  const db = await openDB();
  const names = DATA_STORES.filter((n) => db.objectStoreNames.contains(n));
  return tx(names, 'readwrite', async (s) => {
    for (const n of names) await reqp(s[n].clear());
    return true;
  });
}

/* ------------------------------- Snapshots -------------------------------- */
/* Cópia interna do estado anterior antes de operações críticas.               */
/* NÃO substitui o backup exportado pelo usuário — é uma rede de segurança.     */

const SNAPSHOT_KEEP = 5;

export async function createSnapshot(reason) {
  try {
    const payload = await dumpData();
    const record = {
      id: uid('snap'),
      createdAt: Date.now(),
      reason: String(reason || 'manual').slice(0, 60),
      counts: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v.length])),
      payload
    };
    await tx('snapshots', 'readwrite', async (s) => {
      await reqp(s.snapshots.put(record));
      const all = await reqp(s.snapshots.getAll());
      all.sort((a, b) => b.createdAt - a.createdAt);
      for (const old of all.slice(SNAPSHOT_KEEP)) await reqp(s.snapshots.delete(old.id));
    });
    log('snapshot.created', { reason: record.reason, counts: record.counts });
    return record.id;
  } catch (e) {
    logError('snapshot.fail', e);
    return null;
  }
}

export async function listSnapshots() {
  const all = await getAll('snapshots');
  return all.sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, createdAt, reason, counts }) => ({ id, createdAt, reason, counts }));
}

export async function getSnapshot(id) { return get('snapshots', id); }

export async function restoreSnapshot(id) {
  const snap = await get('snapshots', id);
  if (!snap || !snap.payload) throw new Error('Cópia de segurança interna não encontrada.');
  await createSnapshot('antes-de-restaurar-snapshot');
  return replaceAllData(snap.payload);
}

/* --------------------------------- Logs ----------------------------------- */

let logQueue = [];
let logTimer = null;

setLogSink((entry) => {
  logQueue.push(entry);
  if (logTimer) return;
  logTimer = setTimeout(async () => {
    const batch = logQueue; logQueue = []; logTimer = null;
    if (!dbInstance) return; // banco ainda não abriu: fica só em memória
    try {
      await tx('logs', 'readwrite', async (s) => {
        for (const e of batch) await reqp(s.logs.put(e));
        const all = await reqp(s.logs.getAllKeys());
        if (all.length > 400) {
          const sorted = all.slice().sort();
          for (const k of sorted.slice(0, all.length - 400)) await reqp(s.logs.delete(k));
        }
      });
    } catch (_) { /* log nunca pode quebrar o app */ }
  }, 1500);
});

export async function readLogs(limit = 120) {
  try {
    const all = await getAll('logs');
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
  } catch (_) { return []; }
}

export async function clearLogs() {
  return tx('logs', 'readwrite', (s) => reqp(s.logs.clear()));
}

/* ----------------------------- Diagnóstico -------------------------------- */

export async function estimateStorage() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage: usage || 0, quota: quota || 0 };
    }
  } catch (_) {}
  return null;
}

/** Pede ao navegador para não descartar os dados sob pressão de espaço. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    }
  } catch (_) {}
  return false;
}

export async function isPersisted() {
  try {
    if (navigator.storage && navigator.storage.persisted) return await navigator.storage.persisted();
  } catch (_) {}
  return false;
}

/** Verifica se o banco tem a estrutura esperada (pós-migração / pós-restauração). */
export async function validateSchema() {
  const db = await openDB();
  const missing = ALL_STORES.filter((n) => !db.objectStoreNames.contains(n));
  const ok = missing.length === 0 && db.version === DB_VERSION;
  if (!ok) logError('db.schema.invalid', { missing, version: db.version });
  return { ok, missing, version: db.version };
}

export { reqp };
