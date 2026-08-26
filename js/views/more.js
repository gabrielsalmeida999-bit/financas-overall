/* ==========================================================================
   views/more.js — dívidas, metas, despesas fixas e categorias.
   ========================================================================== */

import {
  money, formatDate, monthLabel, pct, currentMonth, addMonths, dateInMonth
} from '../core.js';

import {
  el, section, listItem, emptyState, sheet, toastOk, confirm, progressBar,
  detailRow, summaryLine, navRow, segmented, emit, badge
} from '../ui.js';

import * as repo from '../repo.js';
import {
  debtForm, debtPaymentForm, goalForm, goalContributeForm,
  recurringForm, categoryForm
} from '../forms.js';

let tab = 'debts'; // debts | goals | recurring | categories

export async function render(root, ctx, params = {}) {
  if (params.section) tab = params.section;
  root.replaceChildren();

  root.append(segmented([
    { value: 'debts', label: 'Dívidas' },
    { value: 'goals', label: 'Metas' },
    { value: 'recurring', label: 'Fixas' },
    { value: 'categories', label: 'Categorias' }
  ], tab, (v) => { tab = v; ctx.refresh(); }));

  const body = el('div.mt-4');
  root.append(body);

  if (tab === 'debts') await renderDebts(body, ctx, params);
  else if (tab === 'goals') await renderGoals(body, ctx);
  else if (tab === 'recurring') await renderRecurring(body, ctx);
  else await renderCategories(body, ctx);

  const nav = el('div.list');
  nav.append(navRow('Configurações', { icon: '⚙️', onClick: () => ctx.navigate('settings') }));
  root.append(section('Aplicativo', nav));
}

/* =============================== Dívidas ================================= */

async function renderDebts(root, ctx, params) {
  const overview = await repo.debtsOverview();

  if (!overview.debts.length) {
    root.append(el('div.card', {}, [
      emptyState({
        icon: '🤝',
        title: 'Nenhuma dívida registrada',
        text: 'Registre valores que você deve para acompanhar quanto já pagou e quanto falta.',
        actionLabel: '+ Registrar dívida',
        onAction: () => debtForm(null)
      })
    ]));
    return;
  }

  root.append(el('div.hero', {}, [
    el('div.hero-label', { text: 'Total em aberto' }),
    el('div.hero-value', { text: money(overview.totalRemaining) }),
    el('div.hero-sub', {
      text: `${money(overview.totalPaid)} já pagos de ${money(overview.totalOriginal)}`
    }),
    el('div.hero-bar', {}, [
      el('i', { style: { width: `${pct(overview.totalPaid, overview.totalOriginal)}%` } })
    ])
  ]));

  const open = overview.debts.filter((d) => d.remaining > 0);
  const settled = overview.debts.filter((d) => d.remaining <= 0);

  if (open.length) {
    const list = el('div.list');
    for (const d of open) {
      list.append(listItem({
        icon: '🤝',
        title: d.person,
        subtitle: `${d.reason || 'Dívida'} · ${d.percent}% quitado`,
        amount: d.remaining,
        meta: `de ${money(d.originalAmount)}`,
        onClick: () => openDebt(d.id, ctx)
      }));
    }
    root.append(section('Em aberto', list));
  }

  if (settled.length) {
    const list = el('div.list');
    for (const d of settled) {
      list.append(listItem({
        icon: '✅',
        title: d.person,
        subtitle: `Quitada · ${money(d.originalAmount)}`,
        amount: money(0),
        onClick: () => openDebt(d.id, ctx)
      }));
    }
    root.append(section('Quitadas', list));
  }

  root.append(el('button.btn.btn-outline.btn-block.mt-4', {
    type: 'button', text: '+ Registrar dívida', onclick: () => debtForm(null)
  }));

  if (params.id) setTimeout(() => openDebt(params.id, ctx), 120);
}

export async function openDebt(debtId, ctx) {
  const s = await repo.debtSummary(debtId);
  if (!s.debt) return;
  const d = s.debt;

  const body = el('div');
  body.append(el('div.card', { style: { background: 'var(--card-2)', border: 'none' } }, [
    summaryLine('Valor original', d.originalAmount),
    summaryLine('Total pago', s.paid),
    el('div.summary-line', {}, [
      el('span.k', { text: 'Restante' }),
      el('span.v', { style: { color: s.remaining > 0 ? 'var(--accent)' : 'var(--good)' }, text: money(s.remaining) })
    ]),
    el('div.mt-3', {}, [progressBar(s.percent, s.percent >= 100 ? 'good' : '')]),
    el('div.tiny.muted.center.mt-2', { text: `${s.percent}% quitado` })
  ]));

  body.append(el('div.dl.mt-3', {}, [
    detailRow('Pessoa', d.person),
    d.reason ? detailRow('Motivo', d.reason) : null,
    detailRow('Data', formatDate(d.date)),
    d.note ? detailRow('Observação', d.note) : null
  ].filter(Boolean)));

  if (s.payments.length) {
    const list = el('div.list.mt-3');
    for (const p of s.payments) {
      list.append(listItem({
        icon: '💸',
        title: money(p.amount),
        subtitle: formatDate(p.date) + (p.note ? ` · ${p.note}` : ''),
        chevron: false,
        onClick: async () => {
          const ok = await confirm({
            title: 'Excluir pagamento',
            text: 'O valor voltará a constar como devido.',
            okLabel: 'Excluir', danger: true
          });
          if (!ok) return;
          await repo.deleteDebtPayment(p.id);
          toastOk('Pagamento excluído');
          emit('data:changed');
          sh.close(true);
        }
      }));
    }
    body.append(el('div.section-title.mt-4', { text: 'Pagamentos' }), list);
  }

  const actions = el('div.mt-4', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, [
    s.remaining > 0 ? el('button.btn.btn-primary.btn-block', {
      type: 'button', text: '+ Registrar pagamento',
      onclick: () => { sh.close(null); setTimeout(() => debtPaymentForm(d), 240); }
    }) : null,
    el('button.btn.btn-ghost.btn-block', {
      type: 'button', text: 'Editar dívida',
      onclick: () => { sh.close(null); setTimeout(() => debtForm(d), 240); }
    })
  ].filter(Boolean));
  body.append(actions);

  const sh = sheet({ title: d.person, body, size: 'tall' });
  return sh;
}

/* ================================ Metas ================================== */

async function renderGoals(root, ctx) {
  const goals = await repo.listGoals();

  if (!goals.length) {
    root.append(el('div.card', {}, [
      emptyState({
        icon: '🎯',
        title: 'Nenhuma meta criada',
        text: 'Defina um objetivo e acompanhe o quanto já guardou.',
        actionLabel: '+ Criar meta',
        onAction: () => goalForm(null)
      })
    ]));
    return;
  }

  for (const g of goals) {
    const p = pct(g.currentAmount, g.targetAmount);
    const done = p >= 100;
    root.append(el('div.card.mt-3', {}, [
      el('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } }, [
        el('div', { style: { flex: '1' } }, [
          el('div', { text: g.name, style: { fontSize: '16px', fontWeight: '650' } }),
          el('div.tiny.muted', {
            text: g.deadline ? `Prazo: ${formatDate(g.deadline)}` : 'Sem prazo definido'
          })
        ]),
        done ? badge('Concluída', 'paid') : null
      ].filter(Boolean)),

      el('div.mt-3', {}, [
        el('div', { style: { display: 'flex', justifyContent: 'space-between', marginBottom: '6px' } }, [
          el('span', { style: { fontWeight: '650', fontSize: '17px' }, text: money(g.currentAmount) }),
          el('span.small.muted', { text: `de ${money(g.targetAmount)}` })
        ]),
        progressBar(p, done ? 'good' : ''),
        el('div.tiny.muted.mt-2', {
          text: done ? 'Meta alcançada 🎉' : `${p}% · faltam ${money(Math.max(0, g.targetAmount - g.currentAmount))}`
        })
      ]),

      el('div.row.gap.mt-4', {}, [
        el('button.btn.btn-sm.btn-primary', {
          type: 'button', text: 'Guardar', style: { flex: '1' },
          onclick: () => goalContributeForm(g)
        }),
        el('button.btn.btn-sm.btn-ghost', {
          type: 'button', text: 'Editar', style: { flex: '1' },
          onclick: () => goalForm(g)
        })
      ])
    ]));
  }

  root.append(el('button.btn.btn-outline.btn-block.mt-4', {
    type: 'button', text: '+ Criar meta', onclick: () => goalForm(null)
  }));
}

/* =========================== Despesas fixas ============================== */

async function renderRecurring(root, ctx) {
  const list = await repo.listRecurring();
  const cards = await repo.listCards();
  const cardName = (id) => (cards.find((c) => c.id === id) || {}).name;
  const month = ctx.month;

  if (!list.length) {
    root.append(el('div.card', {}, [
      emptyState({
        icon: '📌',
        title: 'Nenhuma despesa fixa',
        text: 'Cadastre contas que se repetem todo mês: internet, aluguel, assinaturas.',
        actionLabel: '+ Nova despesa fixa',
        onAction: () => recurringForm(null, month)
      })
    ]));
    return;
  }

  const active = list.filter((r) => repo.recurringActiveIn(r, month));
  const inactive = list.filter((r) => !repo.recurringActiveIn(r, month));
  const total = active.reduce((a, r) => a + r.amount, 0);

  root.append(el('div.card', {}, [
    summaryLine(`Ativas em ${monthLabel(month)}`, `${active.length}`),
    summaryLine('Total mensal', total)
  ]));

  if (active.length) {
    const l = el('div.list.mt-3');
    for (const r of active) {
      l.append(listItem({
        icon: r.cardId ? '💳' : '📌',
        title: r.name,
        subtitle: `Vence dia ${r.dueDay}${r.cardId ? ` · ${cardName(r.cardId) || 'cartão'}` : ''}${r.endMonth ? ` · até ${monthLabel(r.endMonth)}` : ''}`,
        amount: r.amount,
        onClick: () => recurringForm(r, month)
      }));
    }
    root.append(section('Ativas', l));
  }

  if (inactive.length) {
    const l = el('div.list');
    for (const r of inactive) {
      l.append(listItem({
        icon: '⏸',
        title: r.name,
        subtitle: r.endMonth ? `Encerrada em ${monthLabel(r.endMonth)}` : `Começa em ${monthLabel(r.startMonth)}`,
        amount: r.amount,
        onClick: () => recurringForm(r, month)
      }));
    }
    root.append(section('Inativas neste mês', l));
  }

  root.append(el('button.btn.btn-outline.btn-block.mt-4', {
    type: 'button', text: '+ Nova despesa fixa', onclick: () => recurringForm(null, month)
  }));
}

/* ============================== Categorias =============================== */

async function renderCategories(root, ctx) {
  const [expense, income] = await Promise.all([
    repo.listCategories('expense'),
    repo.listCategories('income')
  ]);

  const build = (list, kind, title) => {
    const l = el('div.list');
    for (const c of list) {
      l.append(listItem({
        icon: c.icon,
        iconColor: c.color,
        title: c.name,
        subtitle: c.isDefault ? 'Padrão' : 'Personalizada',
        onClick: () => categoryForm(c, kind)
      }));
    }
    return section(title, l, {
      label: '+ Nova',
      onClick: () => categoryForm(null, kind)
    });
  };

  root.append(build(expense, 'expense', 'Categorias de despesa'));
  root.append(build(income, 'income', 'Categorias de receita'));
}
