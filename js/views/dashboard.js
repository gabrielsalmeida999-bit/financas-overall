/* ==========================================================================
   views/dashboard.js — visão do mês selecionado.
   ========================================================================== */

import {
  money, moneyShort, monthLabel, monthLabelShort, addMonths, todayISO,
  formatDateShort, daysSince, pct, currentMonth
} from '../core.js';

import {
  el, section, stat, listItem, emptyState, banner, progressBar,
  statusBadge, badge, toastOk, hexAlpha, emit
} from '../ui.js';

import * as repo from '../repo.js';
import { getSettings } from '../repo.js';
import { exportBackup } from '../backup.js';
import { expenseForm, incomeForm, recurringForm, purchaseForm, quickAdd } from '../forms.js';

export async function render(root, ctx) {
  const month = ctx.month;
  const [data, future, next, breakdown, goals, debts, settings] = await Promise.all([
    repo.getMonthData(month),
    repo.futureCommitted(month, 12),
    repo.upcoming(month === currentMonth() ? todayISO() : `${month}-01`, 5),
    repo.categoryBreakdown(month),
    repo.listGoals(),
    repo.debtsOverview(),
    getSettings()
  ]);

  const t = data.totals;
  root.replaceChildren();

  /* -------- Aviso de backup -------- */
  const days = daysSince(settings.lastBackupAt);
  if (settings.backupReminder && days >= (settings.backupReminderDays || 14)) {
    root.append(banner({
      icon: '⚠️',
      title: settings.lastBackupAt
        ? `Você está há ${days} dias sem realizar um backup.`
        : 'Você ainda não fez nenhum backup.',
      text: 'Seus dados ficam apenas neste dispositivo. Um backup protege você em caso de troca de aparelho.',
      actionLabel: 'Fazer backup agora',
      onAction: async () => {
        try { const r = await exportBackup(); toastOk(`Backup criado (${r.name})`); ctx.refresh(); }
        catch (_) { /* toast tratado no chamador */ }
      }
    }));
    root.append(el('div', { style: { height: '16px' } }));
  }

  /* -------- Hero: disponível -------- */
  const usedPct = t.income > 0 ? Math.min(100, Math.round((t.paid / t.income) * 100)) : 0;
  const hero = el('div.hero', {}, [
    el('div.hero-label', { text: 'Disponível' }),
    el(`div.hero-value${t.available < 0 ? '.neg' : ''}`, { text: money(t.available) }),
    el('div.hero-sub', {
      text: t.income > 0
        ? `${usedPct}% da renda já utilizada · ${money(t.paid)} pago`
        : 'Nenhuma receita lançada neste mês'
    }),
    el(`div.hero-bar${usedPct >= 100 ? '.over' : ''}`, {}, [el('i', { style: { width: `${usedPct}%` } })])
  ]);
  root.append(hero);

  /* -------- Números principais -------- */
  root.append(el('div.grid-2.mt-3', {}, [
    stat('Renda', t.income, 'good'),
    stat('Gastos', t.spent, t.spent > t.income ? 'bad' : ''),
    stat('Saldo projetado', t.projected, t.projected < 0 ? 'bad' : 'good'),
    stat('A pagar no mês', t.pending, t.pending > 0 ? 'accent' : '')
  ]));

  /* -------- Composição dos gastos -------- */
  const compTotal = t.fixed + t.variable + t.card + t.debts;
  const comp = [
    { label: 'Fixas', value: t.fixed, color: '#FF7300', view: 'transactions' },
    { label: 'Variáveis', value: t.variable, color: '#5AC8FA', view: 'transactions' },
    { label: 'Cartão', value: t.card, color: '#B06BFF', view: 'cards' },
    { label: 'Dívidas', value: t.debts, color: '#FF453A', view: 'more' }
  ];

  const compCard = el('div.card');
  if (compTotal === 0) {
    compCard.append(el('div.small.muted.center', { text: 'Nenhum gasto lançado neste mês.' }));
  } else {
    const track = el('div', {
      style: { display: 'flex', height: '10px', borderRadius: '999px', overflow: 'hidden', gap: '2px', marginBottom: '16px' }
    });
    for (const c of comp) {
      if (!c.value) continue;
      track.append(el('i', { style: { width: `${(c.value / compTotal) * 100}%`, background: c.color, display: 'block' } }));
    }
    compCard.append(track);
    for (const c of comp) {
      compCard.append(el('button.summary-line', {
        type: 'button',
        style: { width: '100%', alignItems: 'center' },
        onclick: () => ctx.navigate(c.view)
      }, [
        el('span.k', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
          el('span.dot', { style: { background: c.color } }),
          el('span', { text: c.label })
        ]),
        el('span.v', { text: `${money(c.value)}` })
      ]));
      // "Cartão" mistura assinatura fixa (Netflix etc.) com compra/parcela avulsa.
      // Mostra a divisão pra não parecer que a despesa fixa "sumiu".
      if (c.label === 'Cartão' && t.cardSubscriptions > 0 && t.cardPurchases > 0) {
        compCard.append(el('div.tiny.muted', {
          style: { padding: '0 0 10px 22px', marginTop: '-6px' },
          text: `${money(t.cardSubscriptions)} em assinaturas fixas · ${money(t.cardPurchases)} em compras/parcelas`
        }));
      }
    }

    // Linha informativa à parte: soma de TODAS as despesas fixas (soltas + no
    // cartão), pra quem quer ver o compromisso fixo total. Fica fora da barra
    // proporcional de propósito — somar ela junto faria a barra ultrapassar
    // 100% do total de gastos (o valor do cartão já a inclui).
    const totalFixasComCartao = t.fixed + (t.cardSubscriptions || 0);
    if (t.cardSubscriptions > 0) {
      compCard.append(el('div.divider'));
      compCard.append(el('div.summary-line', {}, [
        el('span.k', { text: 'Total de despesas fixas (fora + no cartão)' }),
        el('span.v', { text: money(totalFixasComCartao) })
      ]));
    }
  }
  root.append(section('Composição dos gastos', compCard));

  /* -------- Compromisso futuro -------- */
  if (future.total > 0) {
    const fCard = el('div.card', {}, [
      el('div.summary-line', {}, [
        el('span.k', { text: `Próximo mês (${monthLabel(addMonths(month, 1))})` }),
        el('span.v', { text: money(future.nextMonth) })
      ]),
      el('div.summary-line', {}, [
        el('span.k', { text: 'Cartão em aberto (12 meses)' }),
        el('span.v', { text: money(future.installments) })
      ]),
      el('div.summary-line', {}, [
        el('span.k', { text: 'Despesas fixas previstas (12 meses)' }),
        el('span.v', { text: money(future.recurring) })
      ]),
      el('div.divider'),
      el('div.summary-line', {}, [
        el('span.k', { style: { fontWeight: '600', color: 'var(--text)' }, text: 'Total comprometido' }),
        el('span.v', { style: { color: 'var(--accent)' }, text: money(future.total) })
      ])
    ]);
    root.append(section('Comprometido no futuro', fCard));
  }

  /* -------- Próximas despesas -------- */
  const upcomingCard = el('div.list');
  if (!next.length) {
    upcomingCard.append(emptyState({
      icon: '✅', title: 'Nada pendente por perto',
      text: 'Você não tem despesas pendentes nos próximos dias.'
    }));
  } else {
    for (const item of next) {
      const overdue = item.date < todayISO();
      const isInstallment = item.type === 'installment';
      const badges = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'flex-end', marginTop: '2px' } }, [
        isInstallment ? badge(`${item.ref.number}/${item.ref.total}`) : null,
        overdue ? statusBadge('pending', true) : null
      ].filter(Boolean));
      upcomingCard.append(listItem({
        icon: isInstallment ? '💳' : '📌',
        // Nome puro (sem "N/T" grudado): nomes compridos cortavam o título
        // antes de mostrar a parcela. Agora ela é um selinho à parte.
        title: isInstallment ? item.ref.name : item.name,
        subtitle: `${formatDateShort(item.date)} · ${isInstallment ? 'Parcela' : 'Despesa'}`,
        amount: item.amount,
        badge: (isInstallment || overdue) ? badges : null,
        onClick: () => openUpcoming(item, ctx)
      }));
    }
  }
  root.append(section('Próximas despesas', upcomingCard));

  /* -------- Categorias -------- */
  if (breakdown.total > 0) {
    const bars = el('div.card.bars');
    for (const row of breakdown.rows.slice(0, 5)) {
      bars.append(el('div.bar-row', {}, [
        el('div.bar-top', {}, [
          el('span', { text: row.icon }),
          el('span.nm', { text: row.name }),
          el('span.vl', { text: money(row.amount) }),
          el('span.pc', { text: `${row.percent}%` })
        ]),
        el('div.pbar', {}, [el('i', { style: { width: `${row.percent}%`, background: row.color } })])
      ]));
    }
    root.append(section('Onde você gastou', bars, {
      label: 'Ver relatórios', onClick: () => ctx.navigate('reports')
    }));
  }

  /* -------- Dívidas -------- */
  if (debts.open.length) {
    const dCard = el('div.list');
    for (const d of debts.open.slice(0, 3)) {
      dCard.append(listItem({
        icon: '🤝',
        title: d.person,
        subtitle: d.reason || `Restante de ${money(d.originalAmount)}`,
        amount: d.remaining,
        meta: `${d.percent}% quitado`,
        onClick: () => ctx.navigate('more', { section: 'debts', id: d.id })
      }));
    }
    root.append(section(`Dívidas — ${money(debts.totalRemaining)} em aberto`, dCard, {
      label: 'Ver todas', onClick: () => ctx.navigate('more', { section: 'debts' })
    }));
  }

  /* -------- Metas -------- */
  if (goals.length) {
    const gCard = el('div.card.bars');
    for (const g of goals.slice(0, 3)) {
      const p = pct(g.currentAmount, g.targetAmount);
      gCard.append(el('div.bar-row', {}, [
        el('div.bar-top', {}, [
          el('span.nm', { text: g.name }),
          el('span.vl', { text: `${money(g.currentAmount)} / ${money(g.targetAmount)}` })
        ]),
        progressBar(p, p >= 100 ? 'good' : '')
      ]));
    }
    root.append(section('Metas', gCard, {
      label: 'Ver todas', onClick: () => ctx.navigate('more', { section: 'goals' })
    }));
  }

  /* -------- Estado vazio geral -------- */
  if (t.income === 0 && t.spent === 0 && !next.length) {
    root.append(section(null, el('div.card', {}, [
      emptyState({
        icon: '📊',
        title: `Nada em ${monthLabel(month)}`,
        text: 'Comece adicionando sua renda do mês ou uma despesa.',
        actionLabel: '+ Adicionar lançamento',
        onAction: () => quickAdd(month)
      })
    ])));
  }
}

async function openUpcoming(item, ctx) {
  if (item.type === 'installment') {
    const purchase = await repo.getPurchase(item.ref.purchaseId);
    if (purchase) { await purchaseForm(purchase); return; }
    return;
  }
  const e = item.ref;
  if (e.kind === 'fixed' && e.recurringId) {
    const model = await repo.listRecurring().then((l) => l.find((r) => r.id === e.recurringId));
    if (model) { await recurringForm(model, e.month); return; }
  }
  await expenseForm(e);
}
