/* ==========================================================================
   core.js — versões, IDs, dinheiro (centavos), datas financeiras, estado, log
   Nada aqui depende de rede.
   ========================================================================== */

export const APP_VERSION = '1.0.0';
export const BACKUP_VERSION = 1;

/* ------------------------------ IDs únicos ------------------------------- */

const HEX = '0123456789abcdef';

/** ID único e ordenável no tempo. Nunca usar nome como identificador. */
export function uid(prefix = 'id') {
  const t = Date.now().toString(36);
  let r = '';
  if (globalThis.crypto && crypto.getRandomValues) {
    const b = new Uint8Array(8);
    crypto.getRandomValues(b);
    for (const x of b) r += HEX[(x >> 4) & 15] + HEX[x & 15];
  } else {
    for (let i = 0; i < 16; i++) r += HEX[Math.floor(Math.random() * 16)];
  }
  return `${prefix}_${t}${r}`;
}

/** ID determinístico: mesma entrada => mesmo ID => impossível duplicar. */
export function stableId(prefix, ...parts) {
  return `${prefix}_${parts.join('~')}`;
}

/* -------------------------- Dinheiro em centavos -------------------------- */
/* Todo valor monetário é INTEIRO em centavos. Nunca float.                   */

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2
});
const NUM2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 2590 -> "R$ 25,90" */
export function money(cents) {
  return BRL.format(toInt(cents) / 100);
}
/** 2590 -> "25,90" */
export function moneyPlain(cents) {
  return NUM2.format(toInt(cents) / 100);
}
/** 123456789 -> "R$ 1,2 mi" (para gráficos/labels curtos) */
export function moneyShort(cents) {
  const v = Math.abs(toInt(cents)) / 100;
  const s = toInt(cents) < 0 ? '-' : '';
  if (v >= 1e6) return `${s}R$ ${(v / 1e6).toFixed(1).replace('.', ',')}mi`;
  if (v >= 1e3) return `${s}R$ ${(v / 1e3).toFixed(1).replace('.', ',')}k`;
  return `${s}R$ ${v.toFixed(0)}`;
}

export function toInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/** Aceita "1.234,56", "1234,56", "1234.56", "R$ 25,90" -> centavos inteiros. */
export function parseMoney(input) {
  if (typeof input === 'number') return toInt(input * 100);
  let s = String(input ?? '').trim().replace(/[R$\s ]/g, '');
  if (!s) return 0;
  const neg = /^-/.test(s);
  s = s.replace(/-/g, '');
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) s = s.replace(/\./g, '').replace(',', '.');
  else if (hasComma) s = s.replace(',', '.');
  else if (hasDot) {
    const parts = s.split('.');
    const last = parts[parts.length - 1];
    if (parts.length > 2 || last.length === 3) s = parts.join('');
  }
  const v = Number(s);
  if (!Number.isFinite(v)) return 0;
  return (neg ? -1 : 1) * Math.round(v * 100);
}

/** Só dígitos -> centavos (usado pela máscara de digitação). */
export function digitsToCents(str) {
  const d = String(str ?? '').replace(/\D/g, '').slice(0, 13);
  return d ? Number(d) : 0;
}

/**
 * Divide um total em N parcelas sem perder 1 centavo.
 * splitAmount(90001, 3) => [30001, 30000, 30000]  (soma == total, sempre)
 */
export function splitAmount(totalCents, parts) {
  const total = toInt(totalCents);
  const n = Math.max(1, Math.floor(parts));
  const base = Math.floor(Math.abs(total) / n);
  let rest = Math.abs(total) - base * n;
  const sign = total < 0 ? -1 : 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const extra = rest > 0 ? 1 : 0;
    if (rest > 0) rest--;
    out.push(sign * (base + extra));
  }
  return out;
}

export function sum(list, pick = (x) => x) {
  let t = 0;
  for (const it of list) t += toInt(pick(it));
  return t;
}

export function pct(part, whole) {
  const w = toInt(whole);
  if (w === 0) return 0;
  return Math.round((toInt(part) / w) * 1000) / 10; // 1 casa decimal
}

/* ------------------------------- Datas ----------------------------------- */
/* Datas financeiras são STRINGS "YYYY-MM-DD" e meses "YYYY-MM".              */
/* Nunca usamos Date/UTC para decidir a que mês um lançamento pertence.        */

export const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const RE_MONTH = /^\d{4}-\d{2}$/;

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const MESES_ABR = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
const DIAS = ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'];

/** Data local de hoje como "YYYY-MM-DD" (sem conversão de fuso). */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function currentMonth() { return todayISO().slice(0, 7); }
export function nowTs() { return Date.now(); }
export function nowISOStamp() { return new Date().toISOString(); }

function pad2(n) { return String(n).padStart(2, '0'); }

export function isValidDate(iso) {
  if (!RE_DATE.test(String(iso || ''))) return false;
  const [y, m, d] = iso.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= daysInMonth(y, m);
}
export function isValidMonth(m) {
  if (!RE_MONTH.test(String(m || ''))) return false;
  const mm = Number(String(m).slice(5, 7));
  return mm >= 1 && mm <= 12;
}

export function monthOf(iso) { return String(iso || '').slice(0, 7); }
export function dayOf(iso) { return Number(String(iso || '').slice(8, 10)) || 1; }
export function yearOf(key) { return Number(String(key || '').slice(0, 4)) || 0; }

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** addMonths("2026-12", 2) => "2027-02" */
export function addMonths(monthKey, n) {
  let y = Number(String(monthKey).slice(0, 4));
  let m = Number(String(monthKey).slice(5, 7)) + Math.trunc(n);
  y += Math.floor((m - 1) / 12);
  m = ((m - 1) % 12 + 12) % 12 + 1;
  return `${y}-${pad2(m)}`;
}

/** Diferença em meses: diffMonths("2026-01","2026-04") => 3 */
export function diffMonths(a, b) {
  const ya = Number(String(a).slice(0, 4)), ma = Number(String(a).slice(5, 7));
  const yb = Number(String(b).slice(0, 4)), mb = Number(String(b).slice(5, 7));
  return (yb - ya) * 12 + (mb - ma);
}

/** Data segura dentro do mês: dateInMonth("2026-02", 31) => "2026-02-28" */
export function dateInMonth(monthKey, day) {
  const y = Number(String(monthKey).slice(0, 4));
  const m = Number(String(monthKey).slice(5, 7));
  const d = Math.min(Math.max(1, Math.floor(day) || 1), daysInMonth(y, m));
  return `${monthKey}-${pad2(d)}`;
}

export function addDaysISO(iso, days) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

export function formatDate(iso) {
  if (!RE_DATE.test(String(iso || ''))) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
export function formatDateShort(iso) {
  if (!RE_DATE.test(String(iso || ''))) return '—';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}
export function formatDateLong(iso) {
  if (!RE_DATE.test(String(iso || ''))) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} de ${MESES[m - 1].toLowerCase()} de ${y}`;
}
export function weekdayOf(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
export function monthLabel(monthKey) {
  const y = String(monthKey).slice(0, 4);
  const m = Number(String(monthKey).slice(5, 7));
  return `${MESES[m - 1]} ${y}`;
}
export function monthLabelShort(monthKey) {
  const m = Number(String(monthKey).slice(5, 7));
  return MESES_ABR[m - 1] || '—';
}
export function monthName(monthKey) {
  const m = Number(String(monthKey).slice(5, 7));
  return MESES[m - 1] || '—';
}

/** "há 18 dias", "hoje", "ontem" — a partir de um timestamp técnico. */
export function relativeFrom(ts) {
  if (!ts) return 'nunca';
  const days = Math.floor((Date.now() - Number(ts)) / 86400000);
  if (days <= 0) return 'hoje';
  if (days === 1) return 'ontem';
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  if (months === 1) return 'há 1 mês';
  if (months < 12) return `há ${months} meses`;
  const years = Math.floor(months / 12);
  return years === 1 ? 'há 1 ano' : `há ${years} anos`;
}
export function daysSince(ts) {
  if (!ts) return Infinity;
  return Math.floor((Date.now() - Number(ts)) / 86400000);
}

export function timestampSlug() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

export function formatStamp(isoStamp) {
  const d = new Date(isoStamp);
  if (isNaN(d.getTime())) return '—';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} — ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ------------------------------- Texto ----------------------------------- */

export function normalize(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
export function initials(s) {
  const t = String(s ?? '').trim();
  return t ? t[0].toUpperCase() : '?';
}
/** Escapa texto do usuário antes de inserir em HTML. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ------------------------------- Estado ---------------------------------- */

export const state = {
  view: 'dashboard',
  month: currentMonth(),
  ready: false,
  locked: false
};

const subs = new Set();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
export function setState(patch) {
  const changed = {};
  let any = false;
  for (const k of Object.keys(patch)) {
    if (state[k] !== patch[k]) { state[k] = patch[k]; changed[k] = true; any = true; }
  }
  if (any) subs.forEach((f) => { try { f(state, changed); } catch (e) { logError('state.sub', e); } });
}

/* ------------------------------- Log ------------------------------------- */
/* Diagnóstico técnico. NUNCA guardamos PIN, senhas, nomes de lançamentos     */
/* nem valores financeiros completos.                                         */

const LOG_MAX = 200;
const logBuffer = [];
let logSink = null; // definido por db.js quando o banco abre

export function setLogSink(fn) { logSink = fn; }

const SENSITIVE = /(pin|senha|password|token|hash|salt|valor|amount|cents)/i;

function sanitize(detail) {
  if (detail == null) return undefined;
  if (typeof detail === 'string') return detail.slice(0, 240);
  if (typeof detail === 'number' || typeof detail === 'boolean') return detail;
  if (Array.isArray(detail)) return detail.slice(0, 12).map(sanitize);
  if (typeof detail === 'object') {
    const out = {};
    for (const k of Object.keys(detail).slice(0, 14)) {
      if (SENSITIVE.test(k)) { out[k] = '[omitido]'; continue; }
      const v = detail[k];
      out[k] = (typeof v === 'object' && v !== null) ? '[obj]' : sanitize(v);
    }
    return out;
  }
  return String(detail).slice(0, 240);
}

function push(level, event, detail) {
  const entry = { id: uid('log'), ts: Date.now(), level, event: String(event).slice(0, 60), detail: sanitize(detail) };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  if (logSink) { try { logSink(entry); } catch (_) {} }
  return entry;
}

export function log(event, detail) { return push('info', event, detail); }
export function logWarn(event, detail) { return push('warn', event, detail); }
export function logError(event, err) {
  const detail = err instanceof Error
    ? { name: err.name, message: String(err.message).slice(0, 200) }
    : sanitize(err);
  if (typeof console !== 'undefined') console.error(`[${event}]`, err);
  return push('error', event, detail);
}
export function getLogBuffer() { return logBuffer.slice().reverse(); }

/* ------------------------------ Utilitários ------------------------------ */

export function debounce(fn, ms = 220) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    const k = typeof key === 'function' ? key(item) : item[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

export function byDateDesc(a, b) {
  if (a.date === b.date) return (b.createdAt || 0) - (a.createdAt || 0);
  return a.date < b.date ? 1 : -1;
}
export function byDateAsc(a, b) {
  if (a.date === b.date) return (a.createdAt || 0) - (b.createdAt || 0);
  return a.date < b.date ? -1 : 1;
}

export function clone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

export function haptic(ms = 8) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {}
}
