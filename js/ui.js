/* ==========================================================================
   ui.js — primitivas de interface: DOM, toast, bottom sheet, modal, confirmação.
   Mobile-first, acessível, sem dependências externas.
   ========================================================================== */

import { esc, haptic, money, logError } from './core.js';

/* ------------------------------- DOM ------------------------------------- */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Cria elementos: el('div.card', { onclick }, [filhos]) */
export function el(spec, props = {}, children = []) {
  const [tagPart, ...classes] = String(spec).split('.');
  const [tag, id] = tagPart.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = node.className ? `${node.className} ${v}` : v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }

  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function frag(children) {
  const f = document.createDocumentFragment();
  for (const c of children.flat()) if (c) f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return f;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/* ------------------------------- Toast ----------------------------------- */

const toastRoot = () => $('#toast-root');

export function toast(message, type = 'ok', ms = 2600) {
  const root = toastRoot();
  if (!root) return;
  const icon = type === 'err' ? '!' : type === 'info' ? 'i' : '✓';
  const node = el(`div.toast.${type}`, { role: 'status' }, [
    el('span.tico', { text: icon }),
    el('span', { text: message })
  ]);
  root.append(node);
  haptic(type === 'err' ? 20 : 8);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 260);
  }, ms);
  return node;
}
export const toastOk = (m) => toast(m, 'ok');
export const toastErr = (m) => toast(m, 'err', 3600);
export const toastInfo = (m) => toast(m, 'info');

/* --------------------------- Bloqueio de scroll --------------------------- */

let scrollLocks = 0;
let savedScroll = 0;
function lockScroll() {
  if (scrollLocks++ === 0) {
    savedScroll = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${savedScroll}px`;
    document.body.style.width = '100%';
  }
}
function unlockScroll() {
  if (--scrollLocks <= 0) {
    scrollLocks = 0;
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, savedScroll);
  }
}

/* ---------------------------- Foco / acessibilidade ---------------------- */

function trapFocus(container, previousActive) {
  const selector = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const nodes = [...container.querySelectorAll(selector)].filter((n) => n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', onKey);
  return () => {
    container.removeEventListener('keydown', onKey);
    if (previousActive && previousActive.focus) { try { previousActive.focus(); } catch (_) {} }
  };
}

/* ---------------------------- Bottom Sheet ------------------------------- */

const openSheets = [];

/**
 * sheet({ title, body, footer, onClose, dismissible })
 * body/footer: Node | (api) => Node
 * Retorna api: { close, el, setBusy, setTitle }
 */
export function sheet(options = {}) {
  const {
    title = '', body = null, footer = null,
    onClose = null, dismissible = true, size = 'auto'
  } = options;

  const root = $('#sheet-root');
  const previousActive = document.activeElement;

  const backdrop = el('div.sheet-backdrop', { role: 'presentation' });
  const panel = el('div.sheet', {
    role: 'dialog', 'aria-modal': 'true',
    'aria-label': title || 'Painel'
  });

  const bodyWrap = el('div.sheet-body');
  const footWrap = el('div.sheet-foot');

  const api = {
    el: panel,
    body: bodyWrap,
    close: (result) => closeSheet(result),
    setTitle: (t) => { titleNode.textContent = t; panel.setAttribute('aria-label', t); },
    setBusy: (busy) => {
      [...footWrap.querySelectorAll('button')].forEach((b) => { b.disabled = !!busy; });
    }
  };

  const titleNode = el('div.sheet-title', { text: title });
  const head = el('div.sheet-head', {}, [
    titleNode,
    dismissible ? el('button.sheet-close', {
      type: 'button', 'aria-label': 'Fechar', onclick: () => api.close(null), text: '✕'
    }) : null
  ]);

  panel.append(el('div.sheet-grab'), head, bodyWrap);

  const bodyNode = typeof body === 'function' ? body(api) : body;
  if (bodyNode) bodyWrap.append(bodyNode);

  const footNode = typeof footer === 'function' ? footer(api) : footer;
  if (footNode) { footWrap.append(footNode); panel.append(footWrap); }

  if (size === 'tall') panel.style.height = '86vh';

  root.append(backdrop, panel);
  lockScroll();
  const releaseFocus = trapFocus(panel, previousActive);
  openSheets.push(api);

  let closed = false;
  function closeSheet(result) {
    if (closed) return;
    closed = true;
    panel.classList.add('closing');
    backdrop.style.opacity = '0';
    backdrop.style.transition = 'opacity .2s';
    setTimeout(() => {
      panel.remove(); backdrop.remove();
      unlockScroll(); releaseFocus();
      const i = openSheets.indexOf(api); if (i >= 0) openSheets.splice(i, 1);
      document.removeEventListener('keydown', onEsc);
      if (onClose) { try { onClose(result); } catch (e) { logError('sheet.onClose', e); } }
    }, 220);
  }

  function onEsc(e) { if (e.key === 'Escape' && dismissible) { e.stopPropagation(); api.close(null); } }
  document.addEventListener('keydown', onEsc);
  if (dismissible) backdrop.addEventListener('click', () => api.close(null));

  // Arrastar para baixo para fechar
  if (dismissible) attachDragToClose(panel, () => api.close(null));

  setTimeout(() => {
    const first = panel.querySelector('input:not([type="hidden"]),select,textarea,button:not(.sheet-close)');
    if (first && !('ontouchstart' in window)) first.focus();
  }, 260);

  return api;
}

function attachDragToClose(panel, close) {
  let startY = 0, currentY = 0, dragging = false;
  const grab = panel.querySelector('.sheet-grab');
  const head = panel.querySelector('.sheet-head');
  const targets = [grab, head].filter(Boolean);

  const down = (e) => {
    dragging = true;
    startY = (e.touches ? e.touches[0].clientY : e.clientY);
    currentY = startY;
    panel.style.transition = 'none';
  };
  const move = (e) => {
    if (!dragging) return;
    currentY = (e.touches ? e.touches[0].clientY : e.clientY);
    const dy = Math.max(0, currentY - startY);
    panel.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (!dragging) return;
    dragging = false;
    panel.style.transition = '';
    const dy = currentY - startY;
    panel.style.transform = '';
    if (dy > 110) close();
  };

  targets.forEach((t) => {
    t.addEventListener('touchstart', down, { passive: true });
    t.addEventListener('mousedown', down);
  });
  window.addEventListener('touchmove', move, { passive: true });
  window.addEventListener('mousemove', move);
  window.addEventListener('touchend', up);
  window.addEventListener('mouseup', up);
}

export function closeAllSheets() {
  while (openSheets.length) openSheets[openSheets.length - 1].close(null);
}

/* -------------------------------- Modal ---------------------------------- */

export function modal(options = {}) {
  const { title = '', text = '', content = null, actions = [], dismissible = true, inline = false } = options;
  const root = $('#modal-root');
  const previousActive = document.activeElement;

  return new Promise((resolve) => {
    const backdrop = el('div.modal-backdrop');
    const box = el('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });

    if (title) box.append(el('div.modal-title', { text: title }));
    if (text) box.append(el('div.modal-text', { html: typeof text === 'string' ? esc(text).replace(/\n/g, '<br>') : '' }));
    if (content) box.append(content instanceof Node ? content : el('div', { html: String(content) }));

    const actionsWrap = el(`div.modal-actions${inline ? '.inline' : ''}`);
    for (const a of actions) {
      actionsWrap.append(el(`button.btn.${a.variant || 'btn-ghost'}`, {
        type: 'button',
        text: a.label,
        onclick: () => { done(a.value); }
      }));
    }
    if (actions.length) box.append(actionsWrap);

    backdrop.append(box);
    root.append(backdrop);
    lockScroll();
    const releaseFocus = trapFocus(box, previousActive);

    let finished = false;
    function done(value) {
      if (finished) return;
      finished = true;
      backdrop.remove();
      unlockScroll(); releaseFocus();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape' && dismissible) { e.stopPropagation(); done(null); }
    }
    document.addEventListener('keydown', onKey);
    if (dismissible) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });

    setTimeout(() => {
      const b = box.querySelector('button');
      if (b) b.focus();
    }, 60);
  });
}

/** Confirmação simples. Retorna true/false. */
export async function confirm(options = {}) {
  const {
    title = 'Confirmar', text = '',
    okLabel = 'Confirmar', cancelLabel = 'Cancelar',
    danger = false
  } = options;
  const r = await modal({
    title, text,
    actions: [
      { label: okLabel, value: true, variant: danger ? 'btn-danger-solid' : 'btn-primary' },
      { label: cancelLabel, value: false, variant: 'btn-ghost' }
    ]
  });
  return r === true;
}

/**
 * Escolha entre várias opções (ex.: excluir compra + parcelas / manter parcelas).
 * Retorna o `value` escolhido ou null se cancelado.
 */
export function choose(options = {}) {
  const { title = '', text = '', choices = [], cancelLabel = 'Cancelar' } = options;
  const root = $('#modal-root');
  const previousActive = document.activeElement;

  return new Promise((resolve) => {
    const backdrop = el('div.modal-backdrop');
    const box = el('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title });

    if (title) box.append(el('div.modal-title', { text: title }));
    if (text) box.append(el('div.modal-text', { text }));

    const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' } });
    for (const c of choices) {
      wrap.append(el(`button.opt-btn${c.danger ? '.danger' : ''}`, {
        type: 'button',
        onclick: () => done(c.value)
      }, [
        el('div', { style: { flex: '1' } }, [
          el('div.opt-title', { text: c.label }),
          c.description ? el('div.opt-text', { text: c.description }) : null
        ])
      ]));
    }
    box.append(wrap);
    box.append(el('div.modal-actions', {}, [
      el('button.btn.btn-ghost', { type: 'button', text: cancelLabel, onclick: () => done(null) })
    ]));

    backdrop.append(box);
    root.append(backdrop);
    lockScroll();
    const releaseFocus = trapFocus(box, previousActive);

    let finished = false;
    function done(value) {
      if (finished) return;
      finished = true;
      backdrop.remove();
      unlockScroll(); releaseFocus();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); done(null); } }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) done(null); });
    setTimeout(() => { const b = box.querySelector('button'); if (b) b.focus(); }, 60);
  });
}

/**
 * Confirmação em DUAS etapas para operações críticas.
 * Só retorna true se o usuário confirmar duas vezes.
 */
export async function confirmTwice(options = {}) {
  const {
    title, text, okLabel = 'Continuar',
    secondTitle = 'Tem certeza?', secondText = 'Esta ação não pode ser desfeita.',
    secondOkLabel = 'Sim, tenho certeza',
    typeToConfirm = null
  } = options;

  const first = await confirm({ title, text, okLabel, danger: true });
  if (!first) return false;

  if (typeToConfirm) {
    const input = el('input.input', { type: 'text', placeholder: typeToConfirm, autocapitalize: 'characters', autocomplete: 'off' });
    const wrap = el('div', {}, [
      el('div.modal-text', { text: `Digite ${typeToConfirm} para confirmar.` }),
      input
    ]);
    const ok = await modal({
      title: secondTitle,
      content: wrap,
      actions: [
        { label: secondOkLabel, value: 'ok', variant: 'btn-danger-solid' },
        { label: 'Cancelar', value: null, variant: 'btn-ghost' }
      ]
    });
    if (ok !== 'ok') return false;
    return input.value.trim().toUpperCase() === typeToConfirm.toUpperCase();
  }

  return confirm({ title: secondTitle, text: secondText, okLabel: secondOkLabel, danger: true });
}

/* ---------------------------- Componentes -------------------------------- */

export function emptyState({ icon = '📄', title = 'Nada por aqui', text = '', actionLabel = null, onAction = null }) {
  return el('div.empty', {}, [
    el('div.empty-icon', { text: icon }),
    el('div.empty-title', { text: title }),
    text ? el('div.empty-text', { text }) : null,
    actionLabel ? el('button.btn.btn-primary.mt-2', { type: 'button', text: actionLabel, onclick: onAction }) : null
  ]);
}

export function listItem({ icon, iconColor, title, subtitle, amount, amountClass = '', meta, badge, onClick, chevron = true }) {
  const node = el(onClick ? 'button.list-item' : 'div.list-item', onClick ? { type: 'button', onclick: onClick } : {});
  if (icon !== undefined && icon !== null) {
    node.append(el('div.li-icon', {
      text: icon,
      style: iconColor ? { background: hexAlpha(iconColor, 0.16), color: iconColor } : {}
    }));
  }
  node.append(el('div.li-body', {}, [
    el('div.li-title', { text: title }),
    subtitle ? el('div.li-sub', { text: subtitle }) : null
  ]));
  const right = el('div.li-right');
  if (amount !== undefined && amount !== null) {
    right.append(el(`div.li-amount.${amountClass}`, { text: typeof amount === 'number' ? money(amount) : amount }));
  }
  if (badge) right.append(badge);
  if (meta) right.append(el('div.li-meta', { text: meta }));
  node.append(right);
  if (onClick && chevron) node.append(el('div.li-chev', { text: '›' }));
  return node;
}

export function badge(text, kind = '') {
  return el(`span.badge${kind ? '.' + kind : ''}`, { text });
}

export function statusBadge(status, overdue = false) {
  if (status === 'paid') return badge('Pago', 'paid');
  if (status === 'cancelled') return badge('Cancelado', 'cancelled');
  return badge(overdue ? 'Vencida' : 'Pendente', overdue ? 'late' : 'pending');
}

export function section(title, children, action) {
  return el('section.section', {}, [
    title ? el('div.section-head', {}, [
      el('h2.section-title', { text: title }),
      action ? el('button.section-action', { type: 'button', text: action.label, onclick: action.onClick }) : null
    ]) : null,
    ...(Array.isArray(children) ? children : [children])
  ]);
}

export function stat(label, value, cls = '', dotColor = null) {
  return el('div.stat', {}, [
    el('div.stat-label', {}, [
      dotColor ? el('span.dot', { style: { background: dotColor } }) : null,
      el('span', { text: label })
    ]),
    el(`div.stat-value.${cls}`, { text: typeof value === 'number' ? money(value) : value })
  ]);
}

export function progressBar(percent, cls = '') {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  return el(`div.pbar${cls ? '.' + cls : ''}`, {}, [el('i', { style: { width: `${p}%` } })]);
}

export function summaryLine(k, v, cls = '') {
  return el('div.summary-line', {}, [
    el('span.k', { text: k }),
    el(`span.v.${cls}`, { text: typeof v === 'number' ? money(v) : v })
  ]);
}

export function detailRow(k, v) {
  return el('div.dl-row', {}, [
    el('span.dl-k', { text: k }),
    el('span.dl-v', { text: typeof v === 'number' ? money(v) : (v ?? '—') })
  ]);
}

export function banner({ icon = 'ℹ️', title, text, actionLabel, onAction, kind = '' }) {
  return el(`div.banner${kind ? '.' + kind : ''}`, {}, [
    el('span.bico', { text: icon }),
    el('div.banner-body', {}, [
      el('div.banner-title', { text: title }),
      text ? el('div.banner-text', { text }) : null,
      actionLabel ? el('button.btn.btn-sm.btn-primary.mt-2', { type: 'button', text: actionLabel, onclick: onAction }) : null
    ])
  ]);
}

export function segmented(options, value, onChange) {
  const wrap = el('div.segment', { role: 'tablist' });
  for (const o of options) {
    wrap.append(el('button', {
      type: 'button', role: 'tab',
      'aria-pressed': String(o.value === value),
      text: o.label,
      onclick: () => onChange(o.value)
    }));
  }
  return wrap;
}

export function chips(options, selected, onToggle, { multi = false } = {}) {
  const wrap = el('div.chips');
  for (const o of options) {
    const active = multi ? (selected || []).includes(o.value) : selected === o.value;
    wrap.append(el('button.chip', {
      type: 'button',
      'aria-pressed': String(active),
      text: o.label,
      onclick: () => onToggle(o.value)
    }));
  }
  return wrap;
}

export function switchRow(label, checked, onChange, description) {
  const sw = el('div.switch', { role: 'switch', 'aria-checked': String(!!checked) });
  const row = el('button.switch-row', {
    type: 'button',
    onclick: () => {
      const next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(next));
      onChange(next);
    }
  }, [
    el('div', { style: { flex: '1' } }, [
      el('div', { text: label, style: { fontSize: '15px', fontWeight: '550' } }),
      description ? el('div.tiny.muted', { text: description, style: { marginTop: '2px' } }) : null
    ]),
    sw
  ]);
  row.setSwitch = (v) => sw.setAttribute('aria-checked', String(!!v));
  return row;
}

export function navRow(label, { icon, value, onClick, danger = false, badgeNode = null }) {
  return el('button.switch-row', { type: 'button', onclick: onClick }, [
    icon ? el('div.li-icon', { text: icon }) : null,
    el('div', { style: { flex: '1' } }, [
      el('div', { text: label, style: { fontSize: '15px', fontWeight: '550', color: danger ? 'var(--bad)' : '' } })
    ]),
    badgeNode,
    value ? el('div.small.muted.nowrap', { text: value }) : null,
    el('div.li-chev', { text: '›' })
  ]);
}

/* ------------------------------ Cores ------------------------------------ */

export function hexAlpha(hex, alpha) {
  const h = String(hex || '#B8B8B8').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (isNaN(n)) return `rgba(184,184,184,${alpha})`;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/* ------------------------------- Bus ------------------------------------- */

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}
export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) { try { fn(payload); } catch (e) { logError(`bus.${event}`, e); } }
}

/* --------------------------- Carregamento -------------------------------- */

export function skeleton(lines = 3) {
  const wrap = el('div.card');
  for (let i = 0; i < lines; i++) {
    wrap.append(el('div', {
      style: {
        height: '14px', borderRadius: '7px', background: 'var(--card-2)',
        marginBottom: '10px', width: `${100 - i * 12}%`
      }
    }));
  }
  return wrap;
}

/** Envolve um handler assíncrono impedindo execução dupla (toque duplo). */
export function once(fn) {
  let running = false;
  return async (...args) => {
    if (running) return;
    running = true;
    try { return await fn(...args); }
    finally { running = false; }
  };
}
