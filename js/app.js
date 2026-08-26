/* ==========================================================================
   app.js — inicialização, roteamento, bloqueio, tema e tratamento de erros.
   ========================================================================== */

import {
  APP_VERSION, state, setState, subscribe, currentMonth, monthLabel, addMonths,
  todayISO, log, logError, haptic, isValidMonth
} from './core.js';

import { $, el, clear, toast, toastErr, toastOk, on, emit, modal, sheet } from './ui.js';
import * as db from './db.js';
import * as repo from './repo.js';
import * as security from './security.js';
import { exportBackup } from './backup.js';
import { quickAdd } from './forms.js';

import * as dashboard from './views/dashboard.js';
import * as transactions from './views/transactions.js';
import * as cards from './views/cards.js';
import * as reports from './views/reports.js';
import * as more from './views/more.js';
import * as settingsView from './views/settings.js';

/* =============================== Views =================================== */

const VIEWS = {
  dashboard: { title: 'Início', render: dashboard.render, showMonth: true },
  transactions: { title: 'Lançamentos', render: transactions.render, showMonth: true },
  cards: { title: 'Cartões', render: cards.render, showMonth: true },
  reports: { title: 'Relatórios', render: reports.render, showMonth: true },
  more: { title: 'Mais', render: more.render, showMonth: true },
  settings: { title: 'Configurações', render: settingsView.render, showMonth: false }
};

const TABS = [
  { view: 'dashboard', label: 'Início', icon: 'M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z' },
  { view: 'transactions', label: 'Lançamentos', icon: 'M4 6h16M4 12h16M4 18h10' },
  { view: 'cards', label: 'Cartões', icon: 'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18' },
  { view: 'reports', label: 'Relatórios', icon: 'M5 20V10M12 20V4M19 20v-7' },
  { view: 'more', label: 'Mais', icon: 'M4 12h.01M12 12h.01M20 12h.01' }
];

let viewParams = {};
let rendering = false;
let pendingRender = false;

/* ============================== Tema ===================================== */

const THEME_HINT_KEY = 'overall_financas_tema';

function applyTheme(theme) {
  const root = document.documentElement;
  let resolved = theme;
  if (theme === 'system' || !theme) {
    resolved = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  if (root.getAttribute('data-theme') !== resolved) root.setAttribute('data-theme', resolved);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#F5F5F5' : '#000000');
  // Dica leve para aplicar o tema antes da primeira pintura na próxima abertura.
  try { localStorage.setItem(THEME_HINT_KEY, theme || 'dark'); } catch (_) {}
}

/* ============================ Renderização =============================== */

const ctx = {
  get month() { return state.month; },
  refresh: () => renderView(),
  navigate: (view, params) => navigate(view, params),
  setMonth: (m) => setMonth(m)
};

async function renderView() {
  if (rendering) { pendingRender = true; return; }
  rendering = true;

  const container = $('#view');
  const def = VIEWS[state.view] || VIEWS.dashboard;

  const topbar = $('#topbar');
  const monthRow = $('.topbar-row');
  const titleNode = $('#view-title');
  if (monthRow) monthRow.style.display = def.showMonth ? '' : 'none';
  if (titleNode) {
    titleNode.textContent = def.title;
    titleNode.style.display = def.showMonth ? 'none' : 'block';
    titleNode.style.textAlign = 'center';
    titleNode.style.fontSize = '17px';
    titleNode.style.fontWeight = '650';
  }
  $('#month-label').textContent = monthLabel(state.month);

  const fab = $('#fab');
  if (fab) fab.style.display = state.view === 'settings' ? 'none' : '';

  paintTabs();

  try {
    const params = viewParams;
    viewParams = {};
    await def.render(container, ctx, params);
    container.scrollTop = 0;
  } catch (err) {
    logError(`view.${state.view}`, err);
    container.replaceChildren(el('div.card', {}, [
      el('div.empty', {}, [
        el('div.empty-icon', { text: '⚠️' }),
        el('div.empty-title', { text: 'Ocorreu um problema ao carregar esta informação.' }),
        el('div.empty-text', { text: 'Seus dados continuam salvos. Nada foi apagado.' }),
        el('button.btn.btn-primary.mt-2', { type: 'button', text: 'Tentar novamente', onclick: () => renderView() })
      ])
    ]));
  } finally {
    rendering = false;
    if (pendingRender) { pendingRender = false; renderView(); }
  }
}

function paintTabs() {
  const bar = $('#tabbar');
  if (bar.childElementCount === TABS.length) {
    [...bar.children].forEach((b) => {
      const active = b.dataset.view === state.view
        || (state.view === 'settings' && b.dataset.view === 'more');
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    return;
  }
  clear(bar);
  for (const t of TABS) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', t.icon);
    svg.append(path);

    bar.append(el('button.tab', {
      type: 'button',
      dataset: { view: t.view },
      'aria-current': state.view === t.view ? 'page' : null,
      onclick: () => { haptic(6); navigate(t.view); }
    }, [svg, el('span', { text: t.label })]));
  }
}

function navigate(view, params = {}) {
  if (!VIEWS[view]) view = 'dashboard';
  viewParams = params || {};
  if (state.view === view) { renderView(); return; }
  setState({ view });
}

function setMonth(month) {
  if (!isValidMonth(month)) return;
  setState({ month });
}

/* ============================ Navegação de mês =========================== */

function bindMonthNav() {
  $('#month-prev').addEventListener('click', () => { haptic(5); setMonth(addMonths(state.month, -1)); });
  $('#month-next').addEventListener('click', () => { haptic(5); setMonth(addMonths(state.month, 1)); });
  $('#month-current').addEventListener('click', openMonthPicker);
}

function openMonthPicker() {
  const body = el('div');
  const now = currentMonth();
  const years = new Set();
  for (let i = -24; i <= 24; i++) years.add(addMonths(state.month, i).slice(0, 4));

  const yearList = [...years].sort();
  let selectedYear = state.month.slice(0, 4);

  const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '10px', marginTop: '16px' } });

  const paintGrid = () => {
    grid.replaceChildren();
    for (let m = 1; m <= 12; m++) {
      const key = `${selectedYear}-${String(m).padStart(2, '0')}`;
      const isCur = key === state.month;
      const isNow = key === now;
      grid.append(el('button.chip', {
        type: 'button',
        'aria-pressed': String(isCur),
        style: { justifyContent: 'center', display: 'flex', border: isNow && !isCur ? '1px solid var(--accent)' : '' },
        text: monthLabel(key).split(' ')[0].slice(0, 3),
        onclick: () => { setMonth(key); s.close(true); }
      }));
    }
  };

  const yearRow = el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px' } }, [
    el('button.mnav-btn', {
      type: 'button', text: '‹', 'aria-label': 'Ano anterior',
      onclick: () => { selectedYear = String(Number(selectedYear) - 1); yearLabel.textContent = selectedYear; paintGrid(); }
    }),
    el('div', { text: selectedYear, style: { fontWeight: '650', fontSize: '17px', minWidth: '60px', textAlign: 'center' } }),
    el('button.mnav-btn', {
      type: 'button', text: '›', 'aria-label': 'Próximo ano',
      onclick: () => { selectedYear = String(Number(selectedYear) + 1); yearLabel.textContent = selectedYear; paintGrid(); }
    })
  ]);
  const yearLabel = yearRow.children[1];

  paintGrid();
  body.append(yearRow, grid);
  body.append(el('button.btn.btn-ghost.btn-block.mt-4', {
    type: 'button', text: 'Ir para o mês atual',
    onclick: () => { setMonth(now); s.close(true); }
  }));

  const s = sheet({ title: 'Selecionar mês', body });
}

/* =============================== Bloqueio ================================ */

let pinBuffer = '';
let expectedLength = 4;

function buildKeypad() {
  const pad = $('#keypad');
  clear(pad);
  for (let i = 1; i <= 9; i++) {
    pad.append(el('button.key', { type: 'button', text: String(i), onclick: () => pushDigit(String(i)) }));
  }
  pad.append(el('button.key.fn', { type: 'button', text: '', 'aria-hidden': 'true', tabindex: '-1' }));
  pad.append(el('button.key', { type: 'button', text: '0', onclick: () => pushDigit('0') }));
  pad.append(el('button.key.fn', { type: 'button', text: '⌫', 'aria-label': 'Apagar', onclick: popDigit }));
}

function paintDots() {
  const dots = $('#pin-dots');
  clear(dots);
  const n = Math.max(expectedLength, pinBuffer.length);
  for (let i = 0; i < n; i++) {
    dots.append(el(`div.pin-dot${i < pinBuffer.length ? '.on' : ''}`));
  }
}

function pushDigit(d) {
  if (pinBuffer.length >= 8) return;
  pinBuffer += d;
  haptic(5);
  paintDots();
  $('#pin-error').textContent = '';
  if (pinBuffer.length >= expectedLength) setTimeout(tryUnlock, 120);
}

function popDigit() {
  pinBuffer = pinBuffer.slice(0, -1);
  paintDots();
}

async function tryUnlock() {
  const attempt = pinBuffer;
  try {
    const ok = await security.verifyPin(attempt);
    if (ok) {
      pinBuffer = '';
      hideLock();
      return;
    }
    pinBuffer = '';
    paintDots();
    const dots = $('#pin-dots');
    dots.classList.add('shake');
    setTimeout(() => dots.classList.remove('shake'), 400);
    const info = await security.attemptsInfo();
    $('#pin-error').textContent = info.lockoutSeconds > 0
      ? `Muitas tentativas. Aguarde ${info.lockoutSeconds}s.`
      : 'PIN incorreto. Tente novamente.';
    haptic(30);
  } catch (e) {
    pinBuffer = '';
    paintDots();
    $('#pin-error').textContent = e.message || 'Não foi possível verificar o PIN.';
  }
}

async function showLock() {
  expectedLength = await security.getPinLength();
  pinBuffer = '';
  buildKeypad();
  paintDots();
  $('#pin-error').textContent = '';
  $('#lock').hidden = false;
  $('#app').setAttribute('aria-hidden', 'true');

  const bioBtn = $('#bio-btn');
  const canBio = await security.biometricEnabled();
  bioBtn.hidden = !canBio;
  if (canBio) {
    bioBtn.onclick = async () => {
      const ok = await security.unlockWithBiometric();
      if (ok) hideLock();
      else $('#pin-error').textContent = 'Não foi possível confirmar a biometria. Use o PIN.';
    };
    setTimeout(() => security.unlockWithBiometric().then((ok) => { if (ok) hideLock(); }), 400);
  }
}

function hideLock() {
  $('#lock').hidden = true;
  $('#app').removeAttribute('aria-hidden');
  renderView();
}

/* ============================== Onboarding =============================== */

async function maybeOnboard() {
  const s = await repo.getSettings();
  if (s.onboarded) return;

  await modal({
    title: 'Bem-vindo ao Overall Finanças',
    content: el('div', {}, [
      el('div.modal-text', {
        text: 'Seus dados ficam armazenados neste dispositivo e o aplicativo funciona offline.'
      }),
      el('div.modal-text.mt-3', {
        text: 'Para evitar perda de informações ao trocar de aparelho ou apagar os dados do navegador, recomendamos fazer backups regularmente em Configurações → Dados e Segurança.'
      })
    ]),
    actions: [{ label: 'Começar', value: true, variant: 'btn-primary' }],
    dismissible: false
  });

  await repo.setSetting('onboarded', true);
  await db.requestPersistence();
}

/* =========================== Service Worker ============================== */

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;

  // O boot é assíncrono: o evento "load" pode já ter ocorrido.
  if (document.readyState === 'complete') doRegister();
  else window.addEventListener('load', doRegister, { once: true });

  async function doRegister() {
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
      log('sw.registered');

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', async () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            const ok = await modal({
              title: 'Atualização disponível',
              text: 'Uma nova versão do aplicativo foi baixada. Seus dados serão mantidos.',
              actions: [
                { label: 'Atualizar agora', value: true, variant: 'btn-primary' },
                { label: 'Depois', value: false, variant: 'btn-ghost' }
              ]
            });
            if (ok) { sw.postMessage({ type: 'SKIP_WAITING' }); }
          }
        });
      });

      // Na primeira instalação o SW assume o controle (clients.claim) e isso
      // dispara "controllerchange". Recarregar aí seria um susto sem motivo:
      // só recarregamos quando havia um SW anterior, ou seja, numa atualização real.
      const hadController = !!navigator.serviceWorker.controller;
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || refreshing) return;
        refreshing = true;
        location.reload();
      });
    } catch (e) {
      log('sw.register.fail', { message: String(e && e.message).slice(0, 80) });
    }
  }
}

/* ============================ Erros globais ============================== */

function showFatal(message) {
  const box = $('#fatal');
  $('#fatal-msg').textContent = message
    || 'Não foi possível iniciar o aplicativo. Tente novamente ou use uma janela normal (não anônima/privada).';
  box.hidden = false;
  $('#boot').hidden = true;
  $('#fatal-retry').onclick = () => location.reload();
  $('#fatal-backup').onclick = async () => {
    try { await exportBackup({ markAsBackup: false }); }
    catch (_) { alert('Não foi possível gerar o backup neste momento.'); }
  };
}

function bindGlobalErrors() {
  window.addEventListener('error', (e) => {
    logError('window.error', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    logError('promise.rejection', e.reason);
    if (state.ready) toastErr('Ocorreu um problema. Tente novamente.');
  });
}

/* ============================== Atalhos ================================== */

async function handleShortcut() {
  const params = new URLSearchParams(location.search);
  const acao = params.get('acao');
  if (!acao) return;
  history.replaceState(null, '', location.pathname);
  await new Promise((r) => setTimeout(r, 400));
  const { expenseForm, incomeForm } = await import('./forms.js');
  if (acao === 'despesa') expenseForm(null, { date: todayISO() });
  else if (acao === 'receita') incomeForm(null, { date: todayISO() });
  else if (acao === 'backup') navigate('settings');
}

/* ================================ Boot =================================== */

async function boot() {
  bindGlobalErrors();

  try {
    // O tema já foi aplicado pelo script inline no <head>; aqui apenas confirmamos
    // com a preferência salva no banco.
    await db.openDB();
    const schema = await db.validateSchema();
    if (!schema.ok) log('db.schema.partial', schema);

    await repo.ensureSeed();

    const settings = await repo.getSettings();
    applyTheme(settings.theme || 'dark');

    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', async () => {
        const s = await repo.getSettings();
        if ((s.theme || 'dark') === 'system') applyTheme('system');
      });
    }

    bindMonthNav();
    paintTabs();

    $('#fab').addEventListener('click', () => { haptic(8); quickAdd(state.month); });

    on('data:changed', () => { if (state.ready) renderView(); });
    on('theme:changed', (t) => applyTheme(t));

    security.onLock(() => { showLock(); });
    security.watchActivity();
    const mustLock = await security.initLockState();

    setState({ ready: true });
    $('#boot').hidden = true;
    $('#app').hidden = false;

    if (mustLock) await showLock();
    else await renderView();

    await maybeOnboard();
    registerSW();
    handleShortcut();

    log('app.boot', { version: APP_VERSION, month: state.month });
  } catch (err) {
    logError('app.boot.fail', err);
    showFatal(describeBootError(err));
  }
}

/** Traduz erros técnicos comuns de boot (IndexedDB bloqueado, etc.) em algo acionável. */
function describeBootError(err) {
  const name = err && err.name;
  if (name === 'SecurityError' || name === 'InvalidStateError') {
    return 'O navegador bloqueou o armazenamento local (comum em modo anônimo/privado ou com bloqueio de cookies de terceiros muito restritivo). Abra numa janela normal ou permita dados de site para este endereço.';
  }
  if (name === 'QuotaExceededError') {
    return 'Não há espaço de armazenamento disponível neste navegador. Libere espaço e tente novamente.';
  }
  if (!('indexedDB' in window)) {
    return 'Este navegador não possui suporte a armazenamento local (IndexedDB). Use um navegador atualizado (Chrome, Edge, Firefox ou Safari).';
  }
  if (err && err.message) return err.message;
  return `Não foi possível iniciar o aplicativo${name ? ` (${name})` : ''}. Tente novamente numa janela normal (não anônima/privada).`;
}

/* Re-renderiza quando o estado global muda. */
let lastView = state.view;
let lastMonth = state.month;
subscribe((s) => {
  if (!s.ready) return;
  if (s.view !== lastView || s.month !== lastMonth) {
    lastView = s.view;
    lastMonth = s.month;
    renderView();
  }
});

/* Se a data do aparelho mudar de mês enquanto o app está aberto,
   não mexemos nos lançamentos: apenas o mês padrão de novas aberturas muda. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.ready) renderView();
});

boot();
