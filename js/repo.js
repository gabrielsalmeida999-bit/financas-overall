/* ==========================================================================
   repo.js — regras de negócio e acesso aos dados.
   Princípio: preservar dados > executar ação destrutiva.
   ========================================================================== */

import {
  uid, stableId, toInt, splitAmount, sum, pct,
  todayISO, currentMonth, monthOf, dayOf, addMonths, diffMonths, dateInMonth,
  isValidDate, isValidMonth, normalize, nowTs, log, logWarn, logError, byDateAsc, byDateDesc
} from './core.js';

import * as db from './db.js';
import { tx, reqp } from './db.js';

/* ============================== Constantes =============================== */

export const STATUS = { PENDING: 'pending', PAID: 'paid', CANCELLED: 'cancelled' };
export const PAYMENT_METHODS = [
  { value: 'pix', label: 'Pix' },
  { value: 'debit', label: 'Débito' },
  { value: 'cash', label: 'Dinheiro' },
  { value: 'transfer', label: 'Transferência' },
  { value: 'boleto', label: 'Boleto' },
  { value: 'other', label: 'Outro' }
];
export function paymentMethodLabel(v) {
  return (PAYMENT_METHODS.find((p) => p.value === v) || {}).label || 'Outro';
}

export const DEFAULT_CATEGORIES = [
  { name: 'Casa',        icon: '🏠', color: '#FF7300', kind: 'expense' },
  { name: 'Alimentação', icon: '🍽️', color: '#FF9F45', kind: 'expense' },
  { name: 'Transporte',  icon: '🚗', color: '#4A9EFF', kind: 'expense' },
  { name: 'Lazer',       icon: '🎬', color: '#B06BFF', kind: 'expense' },
  { name: 'Compras',     icon: '🛍️', color: '#FF6B9D', kind: 'expense' },
  { name: 'Tecnologia',  icon: '💻', color: '#5AC8FA', kind: 'expense' },
  { name: 'Assinaturas', icon: '🔄', color: '#8E8E93', kind: 'expense' },
  { name: 'Saúde',       icon: '💊', color: '#32D74B', kind: 'expense' },
  { name: 'Educação',    icon: '📚', color: '#FFD426', kind: 'expense' },
  { name: 'Outros',      icon: '📦', color: '#B8B8B8', kind: 'expense' },
  { name: 'Pró-labore',  icon: '💼', color: '#32D74B', kind: 'income' },
  { name: 'Salário',     icon: '💵', color: '#32D74B', kind: 'income' },
  { name: 'Freelance',   icon: '⚡', color: '#FF7300', kind: 'income' },
  { name: 'Comissão',    icon: '📈', color: '#5AC8FA', kind: 'income' },
  { name: 'Outras receitas', icon: '➕', color: '#B8B8B8', kind: 'income' }
];

const DUP_WINDOW_MS = 90 * 1000; // janela de proteção contra toque duplo

/* ============================ Erros tipados ============================== */

export class ValidationError extends Error {
  constructor(message, field) { super(message); this.name = 'ValidationError'; this.field = field; }
}
export class DuplicateError extends Error {
  constructor(existing) {
    super('Já existe um registro idêntico criado há instantes.');
    this.name = 'DuplicateError';
    this.existing = existing;
  }
}

/* ============================= Utilitários =============================== */

const live = (r) => r && !r.deletedAt;
export function isLive(r) { return live(r); }

function baseFields() {
  const ts = nowTs();
  return { createdAt: ts, updatedAt: ts, deletedAt: null };
}

function touch(record) { record.updatedAt = nowTs(); return record; }

function requireText(value, label, max = 80) {
  const v = String(value ?? '').trim();
  if (!v) throw new ValidationError(`Informe ${label}.`);
  return v.slice(0, max);
}
function requireAmount(value, label = 'o valor') {
  const v = toInt(value);
  if (!Number.isInteger(v) || v <= 0) throw new ValidationError(`Informe ${label} (maior que zero).`);
  if (v > 99999999999) throw new ValidationError('Valor acima do limite suportado.');
  return v;
}
function requireDate(value, label = 'a data') {
  const v = String(value || '').slice(0, 10);
  if (!isValidDate(v)) throw new ValidationError(`Informe ${label} corretamente.`);
  return v;
}
function requireMonth(value, label = 'o mês') {
  const v = String(value || '').slice(0, 7);
  if (!isValidMonth(v)) throw new ValidationError(`Informe ${label} corretamente.`);
  return v;
}
function optText(value, max = 240) {
  const v = String(value ?? '').trim();
  return v ? v.slice(0, max) : '';
}

function dedupeKey(...parts) {
  return parts.map((p) => normalize(String(p ?? ''))).join('|');
}

/** Impede que um toque duplo crie dois lançamentos idênticos. */
async function guardDuplicate(storeName, key, force) {
  if (force) return null;
  const all = await db.getAll(storeName);
  const now = nowTs();
  const hit = all.find((r) => live(r) && r.dedupeKey === key && (now - (r.createdAt || 0)) < DUP_WINDOW_MS);
  if (hit) throw new DuplicateError(hit);
  return null;
}

/* ============================== Settings ================================= */

const SETTINGS_DEFAULTS = {
  theme: 'dark',
  onboarded: false,
  backupReminder: true,
  backupReminderDays: 14,
  lastBackupAt: null,
  autoLockMinutes: 5,
  hideValues: false,
  firstRunAt: null
};

let settingsCache = null;

export async function getSettings() {
  if (settingsCache) return settingsCache;
  const rows = await db.getAll('settings');
  const obj = { ...SETTINGS_DEFAULTS };
  for (const r of rows) {
    if (r && r.key && r.key !== 'security') obj[r.key] = r.value;
  }
  settingsCache = obj;
  return obj;
}

export async function setSetting(key, value) {
  await db.put('settings', { key, value, updatedAt: nowTs() });
  if (settingsCache) settingsCache[key] = value;
  return value;
}

export async function setSettings(patch) {
  const names = Object.keys(patch);
  await tx('settings', 'readwrite', async (s) => {
    for (const k of names) await reqp(s.settings.put({ key: k, value: patch[k], updatedAt: nowTs() }));
  });
  if (settingsCache) Object.assign(settingsCache, patch);
  return patch;
}

export function invalidateSettingsCache() { settingsCache = null; }

/** Registro cru de configuração (usado pela segurança: chave "security"). */
export async function getRawSetting(key) {
  const row = await db.get('settings', key);
  return row ? row.value : null;
}
export async function setRawSetting(key, value) {
  return db.put('settings', { key, value, updatedAt: nowTs() });
}
export async function deleteRawSetting(key) {
  return db.del('settings', key);
}

/* ============================== Semente ================================== */

export async function ensureSeed() {
  const cats = await db.getAll('categories');
  if (cats.length === 0) {
    const rows = DEFAULT_CATEGORIES.map((c, i) => ({
      id: stableId('cat', normalize(c.name).replace(/[^a-z0-9]+/g, '-')),
      name: c.name, icon: c.icon, color: c.color, kind: c.kind,
      isDefault: true, order: i, ...baseFields()
    }));
    await db.putMany('categories', rows);
    log('seed.categories', { count: rows.length });
  }
  const s = await getSettings();
  if (!s.firstRunAt) await setSetting('firstRunAt', nowTs());
}

/* ============================= Categorias ================================ */

export async function listCategories(kind) {
  const all = (await db.getAll('categories')).filter(live);
  const filtered = kind ? all.filter((c) => c.kind === kind || c.kind === 'both') : all;
  return filtered.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.name.localeCompare(b.name, 'pt-BR'));
}

export async function categoryMap() {
  const all = await db.getAll('categories');
  const m = new Map();
  for (const c of all) m.set(c.id, c);
  return m;
}

export async function createCategory(data) {
  const name = requireText(data.name, 'o nome da categoria', 40);
  const existing = (await db.getAll('categories')).filter(live);
  if (existing.some((c) => normalize(c.name) === normalize(name) && c.kind === (data.kind || 'expense'))) {
    throw new ValidationError('Já existe uma categoria com esse nome.');
  }
  const rec = {
    id: uid('cat'),
    name,
    icon: optText(data.icon, 4) || '📦',
    color: optText(data.color, 9) || '#B8B8B8',
    kind: data.kind === 'income' ? 'income' : 'expense',
    isDefault: false,
    order: 900 + existing.length,
    ...baseFields()
  };
  await db.add('categories', rec);
  log('category.create');
  return rec;
}

export async function updateCategory(id, data) {
  const rec = await db.get('categories', id);
  if (!rec) throw new ValidationError('Categoria não encontrada.');
  if (data.name !== undefined) rec.name = requireText(data.name, 'o nome da categoria', 40);
  if (data.icon !== undefined) rec.icon = optText(data.icon, 4) || rec.icon;
  if (data.color !== undefined) rec.color = optText(data.color, 9) || rec.color;
  await db.put('categories', touch(rec));
  return rec;
}

/** Quantos lançamentos usam esta categoria (para avisar antes de excluir). */
export async function categoryUsage(id) {
  const [ex, inc, rec, pur] = await Promise.all([
    db.getAllByIndex('expenses', 'byCategory', id),
    db.getAllByIndex('incomes', 'byCategory', id),
    db.getAll('recurringExpenses'),
    db.getAll('creditPurchases')
  ]);
  return ex.filter(live).length + inc.filter(live).length
    + rec.filter((r) => live(r) && r.categoryId === id).length
    + pur.filter((p) => live(p) && p.categoryId === id).length;
}

export async function deleteCategory(id) {
  const rec = await db.get('categories', id);
  if (!rec) return false;
  rec.deletedAt = nowTs();
  await db.put('categories', touch(rec));
  log('category.delete');
  return true;
}

/* ============================== Receitas ================================= */

export async function listIncomes(month) {
  const rows = month
    ? await db.getAllByIndex('incomes', 'byMonth', month)
    : await db.getAll('incomes');
  return rows.filter(live).sort(byDateDesc);
}

export async function createIncome(data, opts = {}) {
  const name = requireText(data.name, 'o nome da receita');
  const amount = requireAmount(data.amount);
  const date = requireDate(data.date);
  const key = dedupeKey('income', name, amount, date);
  await guardDuplicate('incomes', key, opts.force);

  const rec = {
    id: uid('inc'),
    name, amount, date, month: monthOf(date),
    categoryId: data.categoryId || null,
    note: optText(data.note),
    status: STATUS.PAID,
    dedupeKey: key,
    ...baseFields()
  };
  await db.add('incomes', rec);
  log('income.create', { month: rec.month });
  return rec;
}

export async function updateIncome(id, data) {
  const rec = await db.get('incomes', id);
  if (!rec) throw new ValidationError('Receita não encontrada.');
  if (data.name !== undefined) rec.name = requireText(data.name, 'o nome da receita');
  if (data.amount !== undefined) rec.amount = requireAmount(data.amount);
  if (data.date !== undefined) { rec.date = requireDate(data.date); rec.month = monthOf(rec.date); }
  if (data.categoryId !== undefined) rec.categoryId = data.categoryId || null;
  if (data.note !== undefined) rec.note = optText(data.note);
  rec.dedupeKey = dedupeKey('income', rec.name, rec.amount, rec.date);
  await db.put('incomes', touch(rec));
  log('income.update');
  return rec;
}

export async function deleteIncome(id) {
  const rec = await db.get('incomes', id);
  if (!rec) return false;
  rec.deletedAt = nowTs();
  await db.put('incomes', touch(rec));
  log('income.delete');
  return true;
}

/* ============================== Despesas ================================= */
/* kind: 'variable' (à vista) | 'fixed' (ocorrência de recorrência)           */

export async function listExpenses(month) {
  const rows = month
    ? await db.getAllByIndex('expenses', 'byMonth', month)
    : await db.getAll('expenses');
  return rows.filter(live).sort(byDateDesc);
}

export async function createExpense(data, opts = {}) {
  const name = requireText(data.name, 'o nome da despesa');
  const amount = requireAmount(data.amount);
  const date = requireDate(data.date);
  const key = dedupeKey('expense', name, amount, date);
  await guardDuplicate('expenses', key, opts.force);

  const rec = {
    id: uid('exp'),
    name, amount, date, month: monthOf(date),
    categoryId: data.categoryId || null,
    paymentMethod: data.paymentMethod || 'pix',
    kind: data.kind === 'fixed' ? 'fixed' : 'variable',
    status: data.status === STATUS.PENDING ? STATUS.PENDING : STATUS.PAID,
    note: optText(data.note),
    recurringId: data.recurringId || null,
    dedupeKey: key,
    ...baseFields()
  };
  await db.add('expenses', rec);
  log('expense.create', { month: rec.month, kind: rec.kind });
  return rec;
}

export async function updateExpense(id, data) {
  const rec = await db.get('expenses', id);
  if (!rec) throw new ValidationError('Despesa não encontrada.');
  if (data.name !== undefined) rec.name = requireText(data.name, 'o nome da despesa');
  if (data.amount !== undefined) rec.amount = requireAmount(data.amount);
  if (data.date !== undefined) { rec.date = requireDate(data.date); rec.month = monthOf(rec.date); }
  if (data.categoryId !== undefined) rec.categoryId = data.categoryId || null;
  if (data.paymentMethod !== undefined) rec.paymentMethod = data.paymentMethod;
  if (data.status !== undefined) rec.status = data.status;
  if (data.note !== undefined) rec.note = optText(data.note);
  rec.dedupeKey = dedupeKey('expense', rec.name, rec.amount, rec.date);
  await db.put('expenses', touch(rec));
  log('expense.update', { kind: rec.kind });
  return rec;
}

export async function setExpenseStatus(id, status) {
  const rec = await db.get('expenses', id);
  if (!rec) throw new ValidationError('Despesa não encontrada.');
  rec.status = status;
  rec.paidAt = status === STATUS.PAID ? nowTs() : null;
  await db.put('expenses', touch(rec));
  return rec;
}

export async function deleteExpense(id) {
  const rec = await db.get('expenses', id);
  if (!rec) return false;
  rec.deletedAt = nowTs();
  await db.put('expenses', touch(rec));
  log('expense.delete', { kind: rec.kind });
  return true;
}

/* ========================= Despesas recorrentes ========================== */
/*
   O modelo (recurringExpenses) descreve a regra.
   Cada mês materializa UMA ocorrência com ID determinístico:
     occ_<recurringId>~<YYYY-MM>
   Isso torna a duplicação estruturalmente impossível, e uma ocorrência
   excluída (soft delete) nunca é recriada.
*/

export function occurrenceId(recurringId, month) {
  return stableId('occ', recurringId, month);
}

export async function listRecurring(includeInactive = true) {
  const rows = (await db.getAll('recurringExpenses')).filter(live);
  const out = includeInactive ? rows : rows.filter((r) => r.active !== false);
  return out.sort((a, b) => (a.dueDay || 1) - (b.dueDay || 1) || a.name.localeCompare(b.name, 'pt-BR'));
}

export function recurringActiveIn(rec, month) {
  if (!live(rec) || rec.active === false) return false;
  if (rec.startMonth && month < rec.startMonth) return false;
  if (rec.endMonth && month > rec.endMonth) return false;
  return true;
}

export async function createRecurring(data, opts = {}) {
  const name = requireText(data.name, 'o nome da despesa fixa');
  const amount = requireAmount(data.amount);
  const startMonth = requireMonth(data.startMonth || currentMonth(), 'o mês inicial');
  const dueDay = Math.min(Math.max(1, Math.floor(Number(data.dueDay) || 1)), 31);
  const key = dedupeKey('recurring', name, amount, startMonth);
  await guardDuplicate('recurringExpenses', key, opts.force);

  const rec = {
    id: uid('rec'),
    name, amount, dueDay, startMonth,
    endMonth: data.endMonth || null,
    categoryId: data.categoryId || null,
    note: optText(data.note),
    active: true,
    dedupeKey: key,
    ...baseFields()
  };
  await db.add('recurringExpenses', rec);
  await materializeMonth(startMonth);
  log('recurring.create');
  return rec;
}

/**
 * Edição de despesa fixa.
 * scope: 'occurrence' -> altera somente o mês selecionado
 *        'future'     -> altera o modelo e regenera ocorrências futuras
 *                        NÃO PAGAS (as pagas ficam intactas)
 */
export async function updateRecurring(id, data, scope, month) {
  const rec = await db.get('recurringExpenses', id);
  if (!rec) throw new ValidationError('Despesa fixa não encontrada.');

  if (scope === 'occurrence') {
    const occId = occurrenceId(id, month);
    const occ = await db.get('expenses', occId);
    if (!occ) throw new ValidationError('Ocorrência não encontrada neste mês.');
    if (data.name !== undefined) occ.name = requireText(data.name, 'o nome da despesa');
    if (data.amount !== undefined) occ.amount = requireAmount(data.amount);
    if (data.dueDay !== undefined) occ.date = dateInMonth(month, data.dueDay);
    if (data.categoryId !== undefined) occ.categoryId = data.categoryId || null;
    if (data.note !== undefined) occ.note = optText(data.note);
    occ.overridden = true; // não será sobrescrita por edições futuras do modelo
    await db.put('expenses', touch(occ));
    log('recurring.update.occurrence');
    return { model: rec, occurrence: occ };
  }

  if (data.name !== undefined) rec.name = requireText(data.name, 'o nome da despesa fixa');
  if (data.amount !== undefined) rec.amount = requireAmount(data.amount);
  if (data.dueDay !== undefined) rec.dueDay = Math.min(Math.max(1, Math.floor(Number(data.dueDay) || 1)), 31);
  if (data.categoryId !== undefined) rec.categoryId = data.categoryId || null;
  if (data.note !== undefined) rec.note = optText(data.note);
  if (data.endMonth !== undefined) rec.endMonth = data.endMonth || null;
  await db.put('recurringExpenses', touch(rec));

  // Regenera apenas ocorrências do mês em diante que ainda não foram pagas
  const from = month || currentMonth();
  const occs = (await db.getAllByIndex('expenses', 'byRecurring', id))
    .filter((o) => live(o) && o.month >= from && o.status !== STATUS.PAID && !o.overridden);
  if (occs.length) {
    await tx('expenses', 'readwrite', async (s) => {
      for (const o of occs) {
        o.name = rec.name;
        o.amount = rec.amount;
        o.date = dateInMonth(o.month, rec.dueDay);
        o.categoryId = rec.categoryId;
        o.updatedAt = nowTs();
        await reqp(s.expenses.put(o));
      }
    });
  }
  log('recurring.update.future', { affected: occs.length });
  return { model: rec, affected: occs.length };
}

/** Encerra a recorrência: histórico passado permanece, futuro não é gerado. */
export async function endRecurring(id, month) {
  const rec = await db.get('recurringExpenses', id);
  if (!rec) throw new ValidationError('Despesa fixa não encontrada.');
  const endAt = addMonths(month || currentMonth(), -1);
  rec.endMonth = endAt;
  rec.active = false;
  await db.put('recurringExpenses', touch(rec));

  // Remove (soft) apenas as ocorrências futuras ainda não pagas
  const future = (await db.getAllByIndex('expenses', 'byRecurring', id))
    .filter((o) => live(o) && o.month > endAt && o.status !== STATUS.PAID);
  if (future.length) {
    await tx('expenses', 'readwrite', async (s) => {
      for (const o of future) { o.deletedAt = nowTs(); o.updatedAt = nowTs(); await reqp(s.expenses.put(o)); }
    });
  }
  log('recurring.end', { removedFuture: future.length });
  return { endMonth: endAt, removedFuture: future.length };
}

/** Exclui apenas a ocorrência do mês selecionado. */
export async function deleteRecurringOccurrence(id, month) {
  const occ = await db.get('expenses', occurrenceId(id, month));
  if (!occ) return false;
  occ.deletedAt = nowTs();
  await db.put('expenses', touch(occ));
  log('recurring.delete.occurrence');
  return true;
}

/** Exclui o modelo e TODAS as ocorrências (exige confirmação dupla na UI). */
export async function deleteRecurringAll(id) {
  const rec = await db.get('recurringExpenses', id);
  if (!rec) return false;
  const occs = (await db.getAllByIndex('expenses', 'byRecurring', id)).filter(live);
  await tx(['recurringExpenses', 'expenses'], 'readwrite', async (s) => {
    rec.deletedAt = nowTs(); rec.updatedAt = nowTs(); rec.active = false;
    await reqp(s.recurringExpenses.put(rec));
    for (const o of occs) { o.deletedAt = nowTs(); o.updatedAt = nowTs(); await reqp(s.expenses.put(o)); }
  });
  logWarn('recurring.delete.all', { occurrences: occs.length });
  return occs.length;
}

export async function recurringStats(id) {
  const occs = (await db.getAllByIndex('expenses', 'byRecurring', id)).filter(live);
  return {
    total: occs.length,
    paid: occs.filter((o) => o.status === STATUS.PAID).length,
    months: occs.map((o) => o.month).sort()
  };
}

/**
 * Garante que as ocorrências das despesas fixas existem para o mês.
 * Idempotente: rodar N vezes gera exatamente o mesmo resultado.
 */
export async function materializeMonth(month) {
  if (!isValidMonth(month)) return 0;
  const recs = (await db.getAll('recurringExpenses')).filter((r) => recurringActiveIn(r, month));
  if (!recs.length) return 0;

  return tx('expenses', 'readwrite', async (s) => {
    let created = 0;
    for (const r of recs) {
      const id = occurrenceId(r.id, month);
      const existing = await reqp(s.expenses.get(id));
      if (existing) continue; // já existe (mesmo se excluída: não recriamos)
      const date = dateInMonth(month, r.dueDay);
      await reqp(s.expenses.put({
        id,
        name: r.name,
        amount: toInt(r.amount),
        date,
        month,
        categoryId: r.categoryId || null,
        paymentMethod: 'other',
        kind: 'fixed',
        status: STATUS.PENDING,
        note: r.note || '',
        recurringId: r.id,
        overridden: false,
        dedupeKey: dedupeKey('occ', r.id, month),
        createdAt: nowTs(), updatedAt: nowTs(), deletedAt: null
      }));
      created++;
    }
    if (created) log('recurring.materialize', { month, created });
    return created;
  });
}

/* ========================= Cartões de crédito ============================ */

export async function listCards() {
  return (await db.getAll('creditCards')).filter(live)
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
export async function getCard(id) { return db.get('creditCards', id); }

export async function createCard(data) {
  const name = requireText(data.name, 'o nome do cartão', 40);
  const closingDay = clampDay(data.closingDay, 1);
  const dueDay = clampDay(data.dueDay, 10);
  const rec = {
    id: uid('card'),
    name,
    institution: optText(data.institution, 40),
    limit: toInt(data.limit) || 0,
    closingDay, dueDay,
    color: optText(data.color, 9) || '#FF7300',
    ...baseFields()
  };
  await db.add('creditCards', rec);
  log('card.create');
  return rec;
}

function clampDay(v, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(1, n), 31);
}

export async function updateCard(id, data) {
  const rec = await db.get('creditCards', id);
  if (!rec) throw new ValidationError('Cartão não encontrado.');
  if (data.name !== undefined) rec.name = requireText(data.name, 'o nome do cartão', 40);
  if (data.institution !== undefined) rec.institution = optText(data.institution, 40);
  if (data.limit !== undefined) rec.limit = toInt(data.limit) || 0;
  if (data.closingDay !== undefined) rec.closingDay = clampDay(data.closingDay, rec.closingDay);
  if (data.dueDay !== undefined) rec.dueDay = clampDay(data.dueDay, rec.dueDay);
  if (data.color !== undefined) rec.color = optText(data.color, 9) || rec.color;
  await db.put('creditCards', touch(rec));
  log('card.update');
  return rec;
}

export async function cardUsage(cardId) {
  const purchases = (await db.getAllByIndex('creditPurchases', 'byCard', cardId)).filter(live);
  const insts = (await db.getAllByIndex('installments', 'byCard', cardId))
    .filter((i) => live(i) && i.status !== STATUS.CANCELLED);
  const open = insts.filter((i) => i.status === STATUS.PENDING);
  return {
    purchases: purchases.length,
    installments: insts.length,
    openInstallments: open.length,
    committed: sum(open, (i) => i.amount)
  };
}

export async function deleteCard(cardId, mode) {
  const card = await db.get('creditCards', cardId);
  if (!card) return false;
  const purchases = (await db.getAllByIndex('creditPurchases', 'byCard', cardId)).filter(live);
  const insts = (await db.getAllByIndex('installments', 'byCard', cardId)).filter(live);

  await tx(['creditCards', 'creditPurchases', 'installments'], 'readwrite', async (s) => {
    card.deletedAt = nowTs(); card.updatedAt = nowTs();
    await reqp(s.creditCards.put(card));
    if (mode === 'with-purchases') {
      for (const p of purchases) { p.deletedAt = nowTs(); p.updatedAt = nowTs(); await reqp(s.creditPurchases.put(p)); }
      for (const i of insts) {
        if (i.status === STATUS.PAID) continue; // preserva histórico já pago
        i.deletedAt = nowTs(); i.updatedAt = nowTs(); await reqp(s.installments.put(i));
      }
    }
  });
  logWarn('card.delete', { mode, purchases: purchases.length });
  return true;
}

/**
 * Mês da fatura em que a compra cai, considerando fechamento e vencimento.
 * Retorna o mês em que a fatura é PAGA (é assim que o usuário pensa).
 */
export function suggestFirstMonth(card, purchaseDate) {
  const m = monthOf(purchaseDate);
  const day = dayOf(purchaseDate);
  if (!card) return m;
  const closes = day <= card.closingDay ? m : addMonths(m, 1);
  return card.dueDay > card.closingDay ? closes : addMonths(closes, 1);
}

/* ======================== Compras parceladas ============================= */
/*
   Cada parcela tem ID determinístico  inst_<purchaseId>~<n>  e o banco possui
   índice único [purchaseId, number]. Duplicar parcela é impossível por
   construção. A soma das parcelas SEMPRE bate com o total da compra.
*/

export function installmentId(purchaseId, number) {
  return stableId('inst', purchaseId, number);
}

function buildInstallments(purchase, card, fromNumber = 1, amountToSpread = null) {
  const total = purchase.installmentsCount;
  const start = Math.max(1, fromNumber);
  const slots = total - start + 1;
  if (slots <= 0) return [];
  const amount = amountToSpread === null ? purchase.totalAmount : amountToSpread;
  const parts = splitAmount(amount, slots);
  const out = [];
  for (let i = 0; i < slots; i++) {
    const number = start + i;
    const month = addMonths(purchase.firstMonth, number - 1);
    out.push({
      id: installmentId(purchase.id, number),
      purchaseId: purchase.id,
      cardId: purchase.cardId,
      name: purchase.name,
      number,
      total,
      amount: parts[i],
      month,
      dueDate: dateInMonth(month, card ? card.dueDay : 10),
      categoryId: purchase.categoryId || null,
      status: STATUS.PENDING,
      paidAt: null,
      createdAt: nowTs(), updatedAt: nowTs(), deletedAt: null
    });
  }
  return out;
}

export async function listPurchases(cardId) {
  const rows = cardId
    ? await db.getAllByIndex('creditPurchases', 'byCard', cardId)
    : await db.getAll('creditPurchases');
  return rows.filter(live).sort((a, b) => (b.purchaseDate || '').localeCompare(a.purchaseDate || ''));
}

export async function getPurchase(id) { return db.get('creditPurchases', id); }

export async function listInstallmentsOf(purchaseId) {
  return (await db.getAllByIndex('installments', 'byPurchase', purchaseId))
    .filter(live).sort((a, b) => a.number - b.number);
}

export async function listInstallments(month) {
  const rows = month
    ? await db.getAllByIndex('installments', 'byMonth', month)
    : await db.getAll('installments');
  return rows.filter(live).sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || ''));
}

export async function createPurchase(data, opts = {}) {
  const name = requireText(data.name, 'a descrição da compra');
  const totalAmount = requireAmount(data.totalAmount, 'o valor total');
  const cardId = data.cardId;
  if (!cardId) throw new ValidationError('Selecione o cartão.');
  const card = await db.get('creditCards', cardId);
  if (!card || !live(card)) throw new ValidationError('Cartão não encontrado.');
  const n = Math.floor(Number(data.installmentsCount) || 1);
  if (!Number.isInteger(n) || n < 1 || n > 72) {
    throw new ValidationError('Número de parcelas deve estar entre 1 e 72.');
  }
  const purchaseDate = requireDate(data.purchaseDate || todayISO(), 'a data da compra');
  const firstMonth = requireMonth(data.firstMonth || suggestFirstMonth(card, purchaseDate), 'o mês da 1ª parcela');

  const key = dedupeKey('purchase', name, totalAmount, purchaseDate, cardId, n);
  await guardDuplicate('creditPurchases', key, opts.force);

  const purchase = {
    id: uid('pur'),
    cardId, name,
    totalAmount,
    installmentsCount: n,
    firstMonth,
    purchaseDate,
    categoryId: data.categoryId || null,
    note: optText(data.note),
    dedupeKey: key,
    ...baseFields()
  };
  const installments = buildInstallments(purchase, card);

  await tx(['creditPurchases', 'installments'], 'readwrite', async (s) => {
    await reqp(s.creditPurchases.add(purchase));
    for (const inst of installments) await reqp(s.installments.add(inst));
  });

  log('purchase.create', { installments: installments.length });
  return { purchase, installments };
}

/**
 * Edição de compra parcelada.
 * Parcelas PAGAS nunca são alteradas nem apagadas silenciosamente.
 * Só as parcelas pendentes são recalculadas, e a soma continua fechando
 * com o valor total informado.
 */
export async function updatePurchase(id, data) {
  const purchase = await db.get('creditPurchases', id);
  if (!purchase || !live(purchase)) throw new ValidationError('Compra não encontrada.');
  const card = await db.get('creditCards', purchase.cardId);
  const current = await listInstallmentsOf(id);
  const paid = current.filter((i) => i.status === STATUS.PAID);
  const paidTotal = sum(paid, (i) => i.amount);
  const highestPaid = paid.reduce((m, i) => Math.max(m, i.number), 0);

  const next = { ...purchase };
  if (data.name !== undefined) next.name = requireText(data.name, 'a descrição da compra');
  if (data.totalAmount !== undefined) next.totalAmount = requireAmount(data.totalAmount, 'o valor total');
  if (data.categoryId !== undefined) next.categoryId = data.categoryId || null;
  if (data.note !== undefined) next.note = optText(data.note);
  if (data.firstMonth !== undefined) next.firstMonth = requireMonth(data.firstMonth, 'o mês da 1ª parcela');
  if (data.installmentsCount !== undefined) {
    const n = Math.floor(Number(data.installmentsCount) || 1);
    if (!Number.isInteger(n) || n < 1 || n > 72) throw new ValidationError('Número de parcelas deve estar entre 1 e 72.');
    if (n < highestPaid) {
      throw new ValidationError(
        `Esta compra já possui a parcela ${highestPaid} paga. O número de parcelas não pode ser menor que ${highestPaid}.`
      );
    }
    next.installmentsCount = n;
  }
  if (next.totalAmount < paidTotal) {
    throw new ValidationError('O valor total não pode ser menor do que a soma das parcelas já pagas.');
  }

  const remaining = next.totalAmount - paidTotal;
  const rebuilt = buildInstallments(next, card, highestPaid + 1, remaining);
  const rebuiltIds = new Set(rebuilt.map((i) => i.id));
  const toRemove = current.filter((i) => i.status !== STATUS.PAID && !rebuiltIds.has(i.id));

  await tx(['creditPurchases', 'installments'], 'readwrite', async (s) => {
    next.updatedAt = nowTs();
    await reqp(s.creditPurchases.put(next));
    // parcelas excedentes: removidas de fato (nunca foram pagas, não são histórico)
    for (const i of toRemove) await reqp(s.installments.delete(i.id));
    for (const inst of rebuilt) {
      const prev = current.find((c) => c.id === inst.id);
      if (prev && prev.status === STATUS.PAID) continue; // nunca toca no que foi pago
      if (prev) { inst.createdAt = prev.createdAt; inst.status = prev.status; inst.paidAt = prev.paidAt; }
      await reqp(s.installments.put(inst));
    }
  });

  log('purchase.update', { preservedPaid: paid.length, rebuilt: rebuilt.length, removed: toRemove.length });
  return { purchase: next, preservedPaid: paid.length };
}

export async function purchaseSummary(id) {
  const insts = await listInstallmentsOf(id);
  const paid = insts.filter((i) => i.status === STATUS.PAID);
  const pending = insts.filter((i) => i.status === STATUS.PENDING);
  return {
    installments: insts,
    paidCount: paid.length,
    pendingCount: pending.length,
    paidTotal: sum(paid, (i) => i.amount),
    pendingTotal: sum(pending, (i) => i.amount),
    total: sum(insts, (i) => i.amount)
  };
}

/**
 * Exclusão de compra parcelada.
 * mode: 'with-future' -> exclui a compra e as parcelas ainda não pagas
 *       'keep'        -> exclui a compra e mantém todas as parcelas
 * Parcelas pagas NUNCA são removidas.
 */
export async function deletePurchase(id, mode) {
  const purchase = await db.get('creditPurchases', id);
  if (!purchase) return false;
  const insts = await listInstallmentsOf(id);
  const pending = insts.filter((i) => i.status !== STATUS.PAID);

  await tx(['creditPurchases', 'installments'], 'readwrite', async (s) => {
    purchase.deletedAt = nowTs(); purchase.updatedAt = nowTs();
    await reqp(s.creditPurchases.put(purchase));
    if (mode === 'with-future') {
      for (const i of pending) {
        i.deletedAt = nowTs(); i.updatedAt = nowTs();
        await reqp(s.installments.put(i));
      }
    }
  });
  logWarn('purchase.delete', { mode, removedInstallments: mode === 'with-future' ? pending.length : 0 });
  return true;
}

export async function setInstallmentStatus(installmentId_, status) {
  const inst = await db.get('installments', installmentId_);
  if (!inst) throw new ValidationError('Parcela não encontrada.');
  inst.status = status;
  inst.paidAt = status === STATUS.PAID ? nowTs() : null;
  await db.put('installments', touch(inst));
  log('installment.status', { status });
  return inst;
}

/** Marca todas as parcelas pendentes de um cartão no mês como pagas. */
export async function payCardInvoice(cardId, month) {
  const insts = (await db.getAllByIndex('installments', 'byMonth', month))
    .filter((i) => live(i) && i.cardId === cardId && i.status === STATUS.PENDING);
  if (!insts.length) return 0;
  await tx('installments', 'readwrite', async (s) => {
    for (const i of insts) {
      i.status = STATUS.PAID; i.paidAt = nowTs(); i.updatedAt = nowTs();
      await reqp(s.installments.put(i));
    }
  });
  log('card.invoice.paid', { month, count: insts.length });
  return insts.length;
}

export async function cardInvoice(cardId, month) {
  const insts = (await db.getAllByIndex('installments', 'byMonth', month))
    .filter((i) => live(i) && i.cardId === cardId && i.status !== STATUS.CANCELLED);
  return {
    items: insts.sort((a, b) => (a.dueDate || '').localeCompare(b.dueDate || '')),
    total: sum(insts, (i) => i.amount),
    pending: sum(insts.filter((i) => i.status === STATUS.PENDING), (i) => i.amount),
    paid: sum(insts.filter((i) => i.status === STATUS.PAID), (i) => i.amount)
  };
}

/* =============================== Dívidas ================================= */

export async function listDebts() {
  return (await db.getAll('debts')).filter(live)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
export async function getDebt(id) { return db.get('debts', id); }

export async function createDebt(data, opts = {}) {
  const person = requireText(data.person, 'a pessoa/instituição', 60);
  const originalAmount = requireAmount(data.originalAmount, 'o valor da dívida');
  const date = requireDate(data.date || todayISO());
  const key = dedupeKey('debt', person, originalAmount, date);
  await guardDuplicate('debts', key, opts.force);

  const rec = {
    id: uid('debt'),
    person,
    reason: optText(data.reason, 120),
    originalAmount,
    date, month: monthOf(date),
    note: optText(data.note),
    status: 'open',
    dedupeKey: key,
    ...baseFields()
  };
  await db.add('debts', rec);
  log('debt.create');
  return rec;
}

export async function updateDebt(id, data) {
  const rec = await db.get('debts', id);
  if (!rec) throw new ValidationError('Dívida não encontrada.');
  const paidTotal = await debtPaidTotal(id);
  if (data.person !== undefined) rec.person = requireText(data.person, 'a pessoa/instituição', 60);
  if (data.reason !== undefined) rec.reason = optText(data.reason, 120);
  if (data.originalAmount !== undefined) {
    const v = requireAmount(data.originalAmount, 'o valor da dívida');
    if (v < paidTotal) throw new ValidationError('O valor da dívida não pode ser menor do que o total já pago.');
    rec.originalAmount = v;
  }
  if (data.date !== undefined) { rec.date = requireDate(data.date); rec.month = monthOf(rec.date); }
  if (data.note !== undefined) rec.note = optText(data.note);
  rec.status = paidTotal >= rec.originalAmount ? 'paid' : 'open';
  await db.put('debts', touch(rec));
  log('debt.update');
  return rec;
}

export async function deleteDebt(id, mode) {
  const rec = await db.get('debts', id);
  if (!rec) return false;
  const payments = (await db.getAllByIndex('debtPayments', 'byDebt', id)).filter(live);
  await tx(['debts', 'debtPayments'], 'readwrite', async (s) => {
    rec.deletedAt = nowTs(); rec.updatedAt = nowTs();
    await reqp(s.debts.put(rec));
    if (mode === 'with-payments') {
      for (const p of payments) { p.deletedAt = nowTs(); p.updatedAt = nowTs(); await reqp(s.debtPayments.put(p)); }
    }
  });
  logWarn('debt.delete', { mode, payments: payments.length });
  return true;
}

export async function listDebtPayments(debtId) {
  return (await db.getAllByIndex('debtPayments', 'byDebt', debtId)).filter(live).sort(byDateDesc);
}

async function debtPaidTotal(debtId) {
  return sum(await listDebtPayments(debtId), (p) => p.amount);
}

export async function createDebtPayment(debtId, data, opts = {}) {
  const debt = await db.get('debts', debtId);
  if (!debt || !live(debt)) throw new ValidationError('Dívida não encontrada.');
  const amount = requireAmount(data.amount, 'o valor do pagamento');
  const date = requireDate(data.date || todayISO());
  const key = dedupeKey('payment', debtId, amount, date);
  await guardDuplicate('debtPayments', key, opts.force);

  const rec = {
    id: uid('pay'),
    debtId, amount, date, month: monthOf(date),
    note: optText(data.note),
    dedupeKey: key,
    ...baseFields()
  };

  const paidBefore = await debtPaidTotal(debtId);
  const paidAfter = paidBefore + amount;

  await tx(['debtPayments', 'debts'], 'readwrite', async (s) => {
    await reqp(s.debtPayments.add(rec));
    debt.status = paidAfter >= debt.originalAmount ? 'paid' : 'open';
    debt.updatedAt = nowTs();
    await reqp(s.debts.put(debt));
  });
  log('debt.payment.create');
  return { payment: rec, debt, quitada: debt.status === 'paid' };
}

export async function deleteDebtPayment(id) {
  const rec = await db.get('debtPayments', id);
  if (!rec) return false;
  const debt = await db.get('debts', rec.debtId);
  rec.deletedAt = nowTs(); rec.updatedAt = nowTs();
  await tx(['debtPayments', 'debts'], 'readwrite', async (s) => {
    await reqp(s.debtPayments.put(rec));
    if (debt) {
      const all = await reqp(s.debtPayments.index('byDebt').getAll(rec.debtId));
      const total = sum(all.filter(live), (p) => p.amount);
      debt.status = total >= debt.originalAmount ? 'paid' : 'open';
      debt.updatedAt = nowTs();
      await reqp(s.debts.put(debt));
    }
  });
  log('debt.payment.delete');
  return true;
}

export async function debtSummary(debtId) {
  const debt = await db.get('debts', debtId);
  const payments = await listDebtPayments(debtId);
  const paid = sum(payments, (p) => p.amount);
  const original = toInt(debt ? debt.originalAmount : 0);
  return {
    debt, payments,
    paid,
    remaining: Math.max(0, original - paid),
    percent: pct(paid, original),
    settled: paid >= original && original > 0
  };
}

export async function debtsOverview() {
  const debts = await listDebts();
  const all = (await db.getAll('debtPayments')).filter(live);
  const byDebt = new Map();
  for (const p of all) byDebt.set(p.debtId, (byDebt.get(p.debtId) || 0) + toInt(p.amount));
  const rows = debts.map((d) => {
    const paid = byDebt.get(d.id) || 0;
    return { ...d, paid, remaining: Math.max(0, d.originalAmount - paid), percent: pct(paid, d.originalAmount) };
  });
  return {
    debts: rows,
    totalOriginal: sum(rows, (d) => d.originalAmount),
    totalPaid: sum(rows, (d) => d.paid),
    totalRemaining: sum(rows, (d) => d.remaining),
    open: rows.filter((d) => d.remaining > 0)
  };
}

/* ================================ Metas ================================== */

export async function listGoals() {
  return (await db.getAll('goals')).filter(live)
    .sort((a, b) => (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31'));
}

export async function createGoal(data) {
  const name = requireText(data.name, 'o nome da meta', 60);
  const targetAmount = requireAmount(data.targetAmount, 'o valor desejado');
  const rec = {
    id: uid('goal'),
    name, targetAmount,
    currentAmount: Math.max(0, toInt(data.currentAmount) || 0),
    deadline: data.deadline && isValidDate(data.deadline) ? data.deadline : null,
    note: optText(data.note),
    ...baseFields()
  };
  await db.add('goals', rec);
  log('goal.create');
  return rec;
}

export async function updateGoal(id, data) {
  const rec = await db.get('goals', id);
  if (!rec) throw new ValidationError('Meta não encontrada.');
  if (data.name !== undefined) rec.name = requireText(data.name, 'o nome da meta', 60);
  if (data.targetAmount !== undefined) rec.targetAmount = requireAmount(data.targetAmount, 'o valor desejado');
  if (data.currentAmount !== undefined) rec.currentAmount = Math.max(0, toInt(data.currentAmount));
  if (data.deadline !== undefined) rec.deadline = data.deadline && isValidDate(data.deadline) ? data.deadline : null;
  if (data.note !== undefined) rec.note = optText(data.note);
  await db.put('goals', touch(rec));
  log('goal.update');
  return rec;
}

export async function addToGoal(id, amountCents) {
  const rec = await db.get('goals', id);
  if (!rec) throw new ValidationError('Meta não encontrada.');
  const delta = toInt(amountCents);
  rec.currentAmount = Math.max(0, toInt(rec.currentAmount) + delta);
  await db.put('goals', touch(rec));
  log('goal.contribute');
  return rec;
}

export async function deleteGoal(id) {
  const rec = await db.get('goals', id);
  if (!rec) return false;
  rec.deletedAt = nowTs();
  await db.put('goals', touch(rec));
  log('goal.delete');
  return true;
}

/* ========================= Cálculos do mês =============================== */

const notCancelled = (r) => r.status !== STATUS.CANCELLED;

/**
 * Retorna tudo que o mês precisa, já materializado e calculado.
 * Todos os valores em centavos.
 */
export async function getMonthData(month) {
  await materializeMonth(month);

  const [incomes, expenses, installments, payments, cards, cats] = await Promise.all([
    listIncomes(month),
    listExpenses(month),
    listInstallments(month),
    (async () => (await db.getAllByIndex('debtPayments', 'byMonth', month)).filter(live))(),
    listCards(),
    categoryMap()
  ]);

  const validIncomes = incomes.filter(notCancelled);
  const fixed = expenses.filter((e) => e.kind === 'fixed' && notCancelled(e));
  const variable = expenses.filter((e) => e.kind !== 'fixed' && notCancelled(e));
  const validInst = installments.filter(notCancelled);

  const income = sum(validIncomes, (r) => r.amount);
  const fixedTotal = sum(fixed, (r) => r.amount);
  const variableTotal = sum(variable, (r) => r.amount);
  const cardTotal = sum(validInst, (r) => r.amount);
  const debtTotal = sum(payments, (r) => r.amount);

  const spent = fixedTotal + variableTotal + cardTotal + debtTotal;

  const paidExpenses = sum(expenses.filter((e) => e.status === STATUS.PAID), (r) => r.amount);
  const paidInst = sum(validInst.filter((i) => i.status === STATUS.PAID), (r) => r.amount);
  const alreadyPaid = paidExpenses + paidInst + debtTotal;

  const pendingExpenses = sum(expenses.filter((e) => e.status === STATUS.PENDING), (r) => r.amount);
  const pendingInst = sum(validInst.filter((i) => i.status === STATUS.PENDING), (r) => r.amount);
  const pending = pendingExpenses + pendingInst;

  return {
    month,
    incomes: validIncomes,
    expenses, fixed, variable,
    installments: validInst,
    debtPayments: payments,
    cards, categories: cats,
    totals: {
      income,
      spent,
      fixed: fixedTotal,
      variable: variableTotal,
      card: cardTotal,
      debts: debtTotal,
      paid: alreadyPaid,
      pending,
      available: income - alreadyPaid,   // já saiu do bolso
      projected: income - spent          // se tudo do mês for pago
    }
  };
}

/** Compromissos dos próximos meses: parcelas existentes + fixas previstas. */
export async function futureCommitted(fromMonth, monthsAhead = 12) {
  const startNext = addMonths(fromMonth, 1);
  const endMonth = addMonths(fromMonth, monthsAhead);

  const insts = (await db.getAll('installments'))
    .filter((i) => live(i) && notCancelled(i) && i.month >= startNext && i.month <= endMonth);

  const recs = (await db.getAll('recurringExpenses')).filter(live);
  let recurringTotal = 0;
  const byMonth = new Map();

  for (let k = 1; k <= monthsAhead; k++) {
    const m = addMonths(fromMonth, k);
    let t = 0;
    for (const r of recs) if (recurringActiveIn(r, m)) t += toInt(r.amount);
    recurringTotal += t;
    byMonth.set(m, t);
  }
  for (const i of insts) byMonth.set(i.month, (byMonth.get(i.month) || 0) + toInt(i.amount));

  const instTotal = sum(insts, (i) => i.amount);
  return {
    total: instTotal + recurringTotal,
    installments: instTotal,
    recurring: recurringTotal,
    byMonth: [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    nextMonth: byMonth.get(startNext) || 0
  };
}

/** Próximos vencimentos pendentes (despesas fixas + parcelas). */
export async function upcoming(fromDate, limit = 6) {
  const from = fromDate || todayISO();
  const horizon = addMonths(monthOf(from), 2);

  const exps = (await db.getAll('expenses')).filter(
    (e) => live(e) && e.status === STATUS.PENDING && e.date >= from && monthOf(e.date) <= horizon
  ).map((e) => ({ type: 'expense', id: e.id, name: e.name, amount: e.amount, date: e.date, ref: e }));

  const insts = (await db.getAll('installments')).filter(
    (i) => live(i) && i.status === STATUS.PENDING && (i.dueDate || '') >= from && monthOf(i.dueDate || '') <= horizon
  ).map((i) => ({
    type: 'installment', id: i.id,
    name: `${i.name} ${i.number}/${i.total}`,
    amount: i.amount, date: i.dueDate, ref: i
  }));

  return [...exps, ...insts].sort((a, b) => a.date.localeCompare(b.date)).slice(0, limit);
}

/** Gastos por categoria no mês (fixas + variáveis + parcelas do cartão). */
export async function categoryBreakdown(month) {
  const [expenses, installments, cats] = await Promise.all([
    listExpenses(month),
    listInstallments(month),
    categoryMap()
  ]);
  const map = new Map();
  const bump = (catId, amount) => {
    const key = catId || '__none__';
    map.set(key, (map.get(key) || 0) + toInt(amount));
  };
  for (const e of expenses) if (notCancelled(e)) bump(e.categoryId, e.amount);
  for (const i of installments) if (notCancelled(i)) bump(i.categoryId, i.amount);

  const rows = [...map.entries()].map(([id, amount]) => {
    const c = cats.get(id);
    return {
      id, amount,
      name: c ? c.name : 'Sem categoria',
      icon: c ? c.icon : '—',
      color: c ? c.color : '#B8B8B8'
    };
  }).sort((a, b) => b.amount - a.amount);

  const total = sum(rows, (r) => r.amount);
  return { rows: rows.map((r) => ({ ...r, percent: pct(r.amount, total) })), total };
}

/** Série histórica de N meses até `endMonth`. */
export async function monthlySeries(endMonth, months = 12) {
  const start = addMonths(endMonth, -(months - 1));
  const [allExp, allInc, allInst, allPay] = await Promise.all([
    db.getAll('expenses'), db.getAll('incomes'), db.getAll('installments'), db.getAll('debtPayments')
  ]);
  const inRange = (m) => m >= start && m <= endMonth;

  const acc = new Map();
  for (let k = 0; k < months; k++) {
    const m = addMonths(start, k);
    acc.set(m, { month: m, income: 0, expense: 0, fixed: 0, variable: 0, card: 0, debts: 0 });
  }
  const bump = (m, field, v) => { const row = acc.get(m); if (row) row[field] += toInt(v); };

  for (const e of allExp) {
    if (!live(e) || !notCancelled(e) || !inRange(e.month)) continue;
    bump(e.month, 'expense', e.amount);
    bump(e.month, e.kind === 'fixed' ? 'fixed' : 'variable', e.amount);
  }
  for (const i of allInst) {
    if (!live(i) || !notCancelled(i) || !inRange(i.month)) continue;
    bump(i.month, 'expense', i.amount); bump(i.month, 'card', i.amount);
  }
  for (const p of allPay) {
    if (!live(p) || !inRange(p.month)) continue;
    bump(p.month, 'expense', p.amount); bump(p.month, 'debts', p.amount);
  }
  for (const r of allInc) {
    if (!live(r) || !notCancelled(r) || !inRange(r.month)) continue;
    bump(r.month, 'income', r.amount);
  }
  return [...acc.values()];
}

export async function reportStats(endMonth, months = 12) {
  const series = await monthlySeries(endMonth, months);
  const withData = series.filter((s) => s.expense > 0 || s.income > 0);
  const expenses = series.map((s) => s.expense);
  const active = series.filter((s) => s.expense > 0);
  const avg = active.length ? Math.round(sum(active, (s) => s.expense) / active.length) : 0;
  const max = active.length ? active.reduce((a, b) => (b.expense > a.expense ? b : a)) : null;
  const min = active.length ? active.reduce((a, b) => (b.expense < a.expense ? b : a)) : null;
  const current = series[series.length - 1];
  const previous = series[series.length - 2];
  return {
    series, avg, max, min, current, previous,
    totalExpense: sum(expenses),
    totalIncome: sum(series, (s) => s.income),
    monthsWithData: withData.length,
    variation: previous && previous.expense > 0
      ? Math.round(((current.expense - previous.expense) / previous.expense) * 1000) / 10
      : null
  };
}

/* ============================ Busca / filtros ============================ */

/**
 * Busca unificada. Todos os filtros são opcionais.
 * types: ['expense','income','installment','debtPayment']
 */
export async function search(filters = {}) {
  const {
    text = '', month = null, from = null, to = null,
    categoryIds = null, types = null, methods = null,
    cardIds = null, statuses = null, minAmount = null, maxAmount = null
  } = filters;

  const q = normalize(text.trim());
  const wantType = (t) => !types || types.length === 0 || types.includes(t);
  const inRange = (date) => {
    if (month && monthOf(date) !== month) return false;
    if (from && date < from) return false;
    if (to && date > to) return false;
    return true;
  };
  const matchAmount = (v) => {
    if (minAmount != null && v < minAmount) return false;
    if (maxAmount != null && v > maxAmount) return false;
    return true;
  };
  const matchCat = (id) => !categoryIds || categoryIds.length === 0 || categoryIds.includes(id);
  const matchStatus = (s) => !statuses || statuses.length === 0 || statuses.includes(s);

  const out = [];

  if (wantType('expense')) {
    const rows = month ? await listExpenses(month) : (await db.getAll('expenses')).filter(live);
    for (const e of rows) {
      if (!inRange(e.date) || !matchAmount(e.amount) || !matchCat(e.categoryId) || !matchStatus(e.status)) continue;
      if (methods && methods.length && !methods.includes(e.paymentMethod)) continue;
      if (q && !normalize(e.name).includes(q) && !normalize(e.note).includes(q)) continue;
      out.push({ type: 'expense', id: e.id, name: e.name, amount: e.amount, date: e.date, categoryId: e.categoryId, status: e.status, ref: e });
    }
  }
  if (wantType('income')) {
    const rows = month ? await listIncomes(month) : (await db.getAll('incomes')).filter(live);
    for (const r of rows) {
      if (!inRange(r.date) || !matchAmount(r.amount) || !matchCat(r.categoryId)) continue;
      if (methods && methods.length) continue;
      if (q && !normalize(r.name).includes(q) && !normalize(r.note).includes(q)) continue;
      out.push({ type: 'income', id: r.id, name: r.name, amount: r.amount, date: r.date, categoryId: r.categoryId, status: r.status, ref: r });
    }
  }
  if (wantType('installment')) {
    const rows = month ? await listInstallments(month) : (await db.getAll('installments')).filter(live);
    for (const i of rows) {
      const date = i.dueDate || dateInMonth(i.month, 10);
      if (!inRange(date) || !matchAmount(i.amount) || !matchCat(i.categoryId) || !matchStatus(i.status)) continue;
      if (cardIds && cardIds.length && !cardIds.includes(i.cardId)) continue;
      if (methods && methods.length && !methods.includes('credit')) continue;
      if (q && !normalize(i.name).includes(q)) continue;
      out.push({
        type: 'installment', id: i.id,
        name: `${i.name} ${i.number}/${i.total}`,
        amount: i.amount, date, categoryId: i.categoryId, status: i.status, ref: i
      });
    }
  }
  if (wantType('debtPayment')) {
    const rows = (await db.getAll('debtPayments')).filter(live);
    const debts = await categoryMapOfDebts();
    for (const p of rows) {
      if (!inRange(p.date) || !matchAmount(p.amount)) continue;
      if (categoryIds && categoryIds.length) continue;
      const label = `Pagamento — ${debts.get(p.debtId) || 'dívida'}`;
      if (q && !normalize(label).includes(q) && !normalize(p.note).includes(q)) continue;
      out.push({ type: 'debtPayment', id: p.id, name: label, amount: p.amount, date: p.date, categoryId: null, status: STATUS.PAID, ref: p });
    }
  }

  return out.sort((a, b) => b.date.localeCompare(a.date) || (b.ref.createdAt || 0) - (a.ref.createdAt || 0));
}

async function categoryMapOfDebts() {
  const debts = await db.getAll('debts');
  const m = new Map();
  for (const d of debts) m.set(d.id, d.person);
  return m;
}

/* ============================== Lixeira ================================== */

const TRASHABLE = ['expenses', 'incomes', 'creditPurchases', 'debts', 'debtPayments', 'goals', 'creditCards', 'recurringExpenses', 'categories'];

export async function listTrash(limit = 120) {
  const out = [];
  for (const store of TRASHABLE) {
    const rows = (await db.getAll(store)).filter((r) => r && r.deletedAt);
    for (const r of rows) {
      out.push({
        store, id: r.id,
        label: r.name || r.person || 'Registro',
        amount: r.amount ?? r.originalAmount ?? r.totalAmount ?? r.targetAmount ?? null,
        deletedAt: r.deletedAt
      });
    }
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt).slice(0, limit);
}

export async function restoreFromTrash(store, id) {
  const rec = await db.get(store, id);
  if (!rec) return false;
  rec.deletedAt = null;
  await db.put(store, touch(rec));
  log('trash.restore', { store });
  return true;
}

export async function purgeTrash() {
  let removed = 0;
  for (const store of TRASHABLE) {
    const rows = (await db.getAll(store)).filter((r) => r && r.deletedAt);
    if (!rows.length) continue;
    await tx(store, 'readwrite', async (s) => {
      for (const r of rows) { await reqp(s[store].delete(r.id)); removed++; }
    });
  }
  logWarn('trash.purge', { removed });
  return removed;
}

/* ============================== Contagens =============================== */

export async function totalRecords() {
  const counts = await db.countAll();
  const total = Object.entries(counts)
    .filter(([k]) => k !== 'settings')
    .reduce((a, [, v]) => a + v, 0);
  return { counts, total };
}
