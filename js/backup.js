/* ==========================================================================
   backup.js — exportação, validação rigorosa e restauração segura.
   Nenhuma importação substitui os dados atuais sem validar e confirmar.
   ========================================================================== */

import {
  APP_VERSION, BACKUP_VERSION, RE_DATE, RE_MONTH,
  toInt, isValidDate, isValidMonth, timestampSlug, nowISOStamp, nowTs,
  log, logWarn, logError
} from './core.js';

import * as db from './db.js';
import { DATA_STORES, DB_VERSION } from './db.js';
import { setSetting, invalidateSettingsCache } from './repo.js';

/* ============================== Exportação =============================== */

export async function buildBackup() {
  const data = await db.dumpData();
  const backup = {
    app: 'overall-financas',
    backupVersion: BACKUP_VERSION,
    appVersion: APP_VERSION,
    dbVersion: DB_VERSION,
    createdAt: nowISOStamp(),
    counts: {},
    data: {}
  };
  for (const store of DATA_STORES) {
    const rows = Array.isArray(data[store]) ? data[store] : [];
    backup.data[store] = rows;
    backup.counts[store] = rows.length;
  }
  return backup;
}

export function backupFileName() {
  return `overall-financas_backup_${timestampSlug()}.json`;
}

/** Gera o arquivo e dispara o download. Marca a data do último backup. */
export async function exportBackup({ markAsBackup = true } = {}) {
  const backup = await buildBackup();
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const name = backupFileName();

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);

  if (markAsBackup) await setSetting('lastBackupAt', nowTs());
  log('backup.export', { counts: backup.counts, bytes: json.length });
  return { name, size: json.length, counts: backup.counts };
}

/* ============================== Validação ================================ */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isCents = (v) => Number.isInteger(v) && v >= 0 && v <= 99999999999;
const isNullableStr = (v) => v === null || v === undefined || typeof v === 'string';

/**
 * Descreve como cada store deve ser. Campos não listados são preservados
 * como estão (permite backups de versões futuras com campos extras).
 */
const SCHEMA = {
  settings: {
    key: 'key',
    check: (r, err) => {
      if (!isStr(r.key)) err('registro de configuração sem chave');
    }
  },
  categories: {
    check: (r, err) => {
      if (!isStr(r.name)) err('categoria sem nome');
      if (r.kind && !['expense', 'income', 'both'].includes(r.kind)) err(`categoria com tipo inválido: ${r.kind}`);
    }
  },
  incomes: {
    check: (r, err) => {
      if (!isStr(r.name)) err('receita sem nome');
      if (!isCents(r.amount)) err(`receita "${r.name}" com valor inválido`);
      if (!isValidDate(r.date)) err(`receita "${r.name}" com data inválida`);
      if (r.month && !isValidMonth(r.month)) err(`receita "${r.name}" com mês inválido`);
    },
    fix: (r) => { if (!r.month) r.month = String(r.date).slice(0, 7); }
  },
  expenses: {
    check: (r, err) => {
      if (!isStr(r.name)) err('despesa sem nome');
      if (!isCents(r.amount)) err(`despesa "${r.name}" com valor inválido`);
      if (!isValidDate(r.date)) err(`despesa "${r.name}" com data inválida`);
      if (r.status && !['pending', 'paid', 'cancelled'].includes(r.status)) err(`despesa "${r.name}" com status inválido`);
      if (!isNullableStr(r.recurringId)) err(`despesa "${r.name}" com vínculo inválido`);
    },
    fix: (r) => {
      if (!r.month) r.month = String(r.date).slice(0, 7);
      if (!r.kind) r.kind = r.recurringId ? 'fixed' : 'variable';
      if (!r.status) r.status = 'paid';
    }
  },
  recurringExpenses: {
    check: (r, err) => {
      if (!isStr(r.name)) err('despesa fixa sem nome');
      if (!isCents(r.amount)) err(`despesa fixa "${r.name}" com valor inválido`);
      if (!isValidMonth(r.startMonth)) err(`despesa fixa "${r.name}" com mês inicial inválido`);
      if (r.endMonth && !isValidMonth(r.endMonth)) err(`despesa fixa "${r.name}" com mês final inválido`);
      const d = Number(r.dueDay);
      if (!Number.isInteger(d) || d < 1 || d > 31) err(`despesa fixa "${r.name}" com dia de vencimento inválido`);
    }
  },
  creditCards: {
    check: (r, err) => {
      if (!isStr(r.name)) err('cartão sem nome');
      if (!isCents(r.limit ?? 0)) err(`cartão "${r.name}" com limite inválido`);
      const c = Number(r.closingDay), v = Number(r.dueDay);
      if (!Number.isInteger(c) || c < 1 || c > 31) err(`cartão "${r.name}" com dia de fechamento inválido`);
      if (!Number.isInteger(v) || v < 1 || v > 31) err(`cartão "${r.name}" com dia de vencimento inválido`);
    }
  },
  creditPurchases: {
    check: (r, err) => {
      if (!isStr(r.name)) err('compra sem descrição');
      if (!isCents(r.totalAmount)) err(`compra "${r.name}" com valor inválido`);
      const n = Number(r.installmentsCount);
      if (!Number.isInteger(n) || n < 1 || n > 240) err(`compra "${r.name}" com número de parcelas inválido`);
      if (!isValidMonth(r.firstMonth)) err(`compra "${r.name}" com mês da 1ª parcela inválido`);
      if (!isStr(r.cardId)) err(`compra "${r.name}" sem cartão`);
    }
  },
  installments: {
    check: (r, err) => {
      if (!isStr(r.purchaseId)) err('parcela sem compra de origem');
      if (!isCents(r.amount)) err('parcela com valor inválido');
      if (!isValidMonth(r.month)) err('parcela com mês inválido');
      const n = Number(r.number), t = Number(r.total);
      if (!Number.isInteger(n) || n < 1) err('parcela com número inválido');
      if (!Number.isInteger(t) || t < 1) err('parcela com total inválido');
      if (n > t) err(`parcela ${n}/${t} é maior que o total de parcelas`);
      if (r.status && !['pending', 'paid', 'cancelled'].includes(r.status)) err('parcela com status inválido');
    },
    fix: (r) => { if (!r.dueDate) r.dueDate = `${r.month}-10`; if (!r.status) r.status = 'pending'; }
  },
  debts: {
    check: (r, err) => {
      if (!isStr(r.person)) err('dívida sem pessoa');
      if (!isCents(r.originalAmount)) err(`dívida de "${r.person}" com valor inválido`);
      if (!isValidDate(r.date)) err(`dívida de "${r.person}" com data inválida`);
    },
    fix: (r) => { if (!r.month) r.month = String(r.date).slice(0, 7); if (!r.status) r.status = 'open'; }
  },
  debtPayments: {
    check: (r, err) => {
      if (!isStr(r.debtId)) err('pagamento sem dívida vinculada');
      if (!isCents(r.amount)) err('pagamento com valor inválido');
      if (!isValidDate(r.date)) err('pagamento com data inválida');
    },
    fix: (r) => { if (!r.month) r.month = String(r.date).slice(0, 7); }
  },
  goals: {
    check: (r, err) => {
      if (!isStr(r.name)) err('meta sem nome');
      if (!isCents(r.targetAmount)) err(`meta "${r.name}" com valor inválido`);
      if (!isCents(r.currentAmount ?? 0)) err(`meta "${r.name}" com valor atual inválido`);
      if (r.deadline && !isValidDate(r.deadline)) err(`meta "${r.name}" com prazo inválido`);
    },
    fix: (r) => { if (r.currentAmount == null) r.currentAmount = 0; }
  }
};

export const STORE_LABELS = {
  settings: 'configurações',
  categories: 'categorias',
  incomes: 'receitas',
  expenses: 'despesas',
  recurringExpenses: 'despesas fixas',
  creditCards: 'cartões',
  creditPurchases: 'compras parceladas',
  installments: 'parcelas',
  debts: 'dívidas',
  debtPayments: 'pagamentos de dívidas',
  goals: 'metas'
};

/**
 * Valida um objeto de backup. Nunca lança: sempre devolve um relatório.
 * { ok, errors[], warnings[], summary{}, data{}, meta{} }
 */
export function validateBackup(raw) {
  const errors = [];
  const warnings = [];
  const err = (m) => { if (errors.length < 40) errors.push(m); };
  const warn = (m) => { if (warnings.length < 40) warnings.push(m); };

  if (!isObj(raw)) {
    return fail(['O arquivo não contém um backup válido.']);
  }

  // Aceita tanto { data: {...} } quanto o formato plano { expenses: [...] }
  const data = isObj(raw.data) ? raw.data : raw;

  const version = Number(raw.backupVersion);
  if (!Number.isInteger(version) || version < 1) {
    return fail(['O arquivo não possui uma versão de backup reconhecida.']);
  }
  if (version > BACKUP_VERSION) {
    return fail([
      `Este backup foi criado por uma versão mais nova do aplicativo (formato ${version}). ` +
      `Atualize o aplicativo antes de restaurar.`
    ]);
  }
  if (raw.app && raw.app !== 'overall-financas') {
    warn('O backup indica ter sido gerado por outro aplicativo.');
  }
  if (raw.createdAt && isNaN(new Date(raw.createdAt).getTime())) {
    warn('A data de criação do backup não pôde ser lida.');
  }

  // Estrutura: cada store precisa ser array (ausente => vazio, com aviso)
  const clean = {};
  let hasAnyStore = false;
  for (const store of DATA_STORES) {
    const rows = data[store];
    if (rows === undefined || rows === null) { clean[store] = []; continue; }
    if (!Array.isArray(rows)) { err(`A seção "${STORE_LABELS[store]}" está corrompida (não é uma lista).`); clean[store] = []; continue; }
    hasAnyStore = true;
    clean[store] = rows;
  }
  if (!hasAnyStore) return fail(['O backup não contém nenhum dado restaurável.']);

  // Registros: tipos, IDs e unicidade
  const ids = {};
  for (const store of DATA_STORES) {
    const spec = SCHEMA[store] || {};
    const keyField = spec.key || 'id';
    const seen = new Set();
    const kept = [];

    for (let i = 0; i < clean[store].length; i++) {
      const row = clean[store][i];
      if (!isObj(row)) { err(`Registro inválido em ${STORE_LABELS[store]} (posição ${i + 1}).`); continue; }
      if (!isStr(row[keyField])) { err(`Registro sem identificador em ${STORE_LABELS[store]} (posição ${i + 1}).`); continue; }
      if (seen.has(row[keyField])) { err(`Identificador repetido em ${STORE_LABELS[store]}: ${row[keyField]}.`); continue; }
      seen.add(row[keyField]);

      const copy = { ...row };
      if (spec.fix) { try { spec.fix(copy); } catch (_) {} }
      if (spec.check) {
        const before = errors.length;
        spec.check(copy, err);
        if (errors.length > before) continue;
      }
      if (store !== 'settings') {
        if (copy.createdAt == null) copy.createdAt = Date.now();
        if (copy.updatedAt == null) copy.updatedAt = copy.createdAt;
        if (copy.deletedAt === undefined) copy.deletedAt = null;
      }
      kept.push(copy);
    }
    clean[store] = kept;
    ids[store] = seen;
  }

  // Relacionamentos
  const cardIds = ids.creditCards || new Set();
  const purchaseIds = ids.creditPurchases || new Set();
  const debtIds = ids.debts || new Set();
  const recurringIds = ids.recurringExpenses || new Set();
  const categoryIds = ids.categories || new Set();

  for (const p of clean.creditPurchases) {
    if (!cardIds.has(p.cardId)) err(`A compra "${p.name}" aponta para um cartão que não existe no backup.`);
  }
  const instSeen = new Set();
  for (const i of clean.installments) {
    if (!purchaseIds.has(i.purchaseId)) {
      err('Existe uma parcela vinculada a uma compra que não existe no backup.');
      continue;
    }
    const k = `${i.purchaseId}#${i.number}`;
    if (instSeen.has(k)) err(`Parcela duplicada detectada (${i.number}/${i.total}) na mesma compra.`);
    instSeen.add(k);
  }
  // Soma das parcelas x total da compra
  const byPurchase = new Map();
  for (const i of clean.installments) {
    if (!byPurchase.has(i.purchaseId)) byPurchase.set(i.purchaseId, []);
    byPurchase.get(i.purchaseId).push(i);
  }
  for (const p of clean.creditPurchases) {
    const list = (byPurchase.get(p.id) || []).filter((i) => !i.deletedAt && i.status !== 'cancelled');
    if (!list.length) continue;
    const total = list.reduce((a, b) => a + toInt(b.amount), 0);
    if (list.length === p.installmentsCount && total !== toInt(p.totalAmount)) {
      warn(`A soma das parcelas de "${p.name}" difere do total da compra.`);
    }
  }
  for (const p of clean.debtPayments) {
    if (!debtIds.has(p.debtId)) err('Existe um pagamento vinculado a uma dívida que não existe no backup.');
  }
  for (const e of clean.expenses) {
    if (e.recurringId && !recurringIds.has(e.recurringId)) {
      warn('Uma despesa fixa perdeu o vínculo com o modelo de recorrência.');
      e.recurringId = null; e.kind = 'variable';
    }
    if (e.categoryId && !categoryIds.has(e.categoryId)) { warn('Uma despesa aponta para categoria inexistente.'); e.categoryId = null; }
  }
  for (const r of clean.incomes) {
    if (r.categoryId && !categoryIds.has(r.categoryId)) { warn('Uma receita aponta para categoria inexistente.'); r.categoryId = null; }
  }

  if (errors.length) return fail(errors, warnings);

  const summary = {};
  for (const store of DATA_STORES) summary[store] = clean[store].length;
  const total = Object.entries(summary)
    .filter(([k]) => k !== 'settings')
    .reduce((a, [, v]) => a + v, 0);

  return {
    ok: true,
    errors: [],
    warnings,
    summary,
    total,
    data: clean,
    meta: {
      createdAt: raw.createdAt || null,
      appVersion: raw.appVersion || 'desconhecida',
      backupVersion: version,
      dbVersion: raw.dbVersion || null
    }
  };

  function fail(errs, warns = []) {
    logWarn('backup.invalid', { errors: errs.slice(0, 3) });
    return { ok: false, errors: errs, warnings: warns, summary: {}, total: 0, data: null, meta: {} };
  }
}

/* ============================== Leitura ================================== */

export function readBackupFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) { reject(new Error('Nenhum arquivo selecionado.')); return; }
    if (file.size > 80 * 1024 * 1024) { reject(new Error('O arquivo é grande demais para ser um backup válido.')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        resolve(parsed);
      } catch (_) {
        reject(new Error('Não foi possível ler este arquivo. Ele não é um JSON válido.'));
      }
    };
    reader.onerror = () => reject(new Error('Falha ao ler o arquivo.'));
    reader.readAsText(file);
  });
}

/* ============================= Restauração =============================== */

/**
 * Restaura um backup JÁ VALIDADO.
 * 1) cria snapshot interno dos dados atuais;
 * 2) substitui tudo numa única transação (falhou = nada mudou);
 * 3) revalida a estrutura do banco.
 */
export async function restoreBackup(validation) {
  if (!validation || !validation.ok || !validation.data) {
    throw new Error('Não foi possível restaurar este backup porque o arquivo está inválido ou incompatível.');
  }
  const snapshotId = await db.createSnapshot('antes-da-restauracao');
  try {
    const written = await db.replaceAllData(validation.data);
    invalidateSettingsCache();
    const schema = await db.validateSchema();
    if (!schema.ok) throw new Error('A estrutura do banco ficou inconsistente após a restauração.');
    log('backup.restore', { written, snapshotId });
    return { written, snapshotId };
  } catch (e) {
    logError('backup.restore.fail', e);
    if (snapshotId) {
      try {
        const snap = await db.getSnapshot(snapshotId);
        if (snap && snap.payload) {
          await db.replaceAllData(snap.payload);
          invalidateSettingsCache();
          logWarn('backup.restore.rolledback');
        }
      } catch (e2) { logError('backup.rollback.fail', e2); }
    }
    throw new Error('A restauração falhou e os dados anteriores foram mantidos. Nenhuma informação foi perdida.');
  }
}

/* ============================ Apagar tudo ================================ */

export async function wipeAllData() {
  await db.createSnapshot('antes-de-apagar-tudo');
  await db.clearAllData();
  invalidateSettingsCache();
  logWarn('data.wipe');
  return true;
}
