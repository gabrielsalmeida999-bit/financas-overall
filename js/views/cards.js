/* ==========================================================================
   views/cards.js — cartões, faturas e compras parceladas.
   ========================================================================== */

import {
  money, monthLabel, monthLabelShort, addMonths, formatDate, pct, sum, toInt
} from '../core.js';

import {
  el, section, listItem, emptyState, statusBadge, badge, sheet, toastOk,
  confirm, progressBar, detailRow, summaryLine, emit
} from '../ui.js';

import * as repo from '../repo.js';
import { STATUS } from '../repo.js';
import { cardForm, purchaseForm } from '../forms.js';

export async function render(root, ctx) {
  const month = ctx.month;
  root.replaceChildren();

  const cards = await repo.listCards();

  if (!cards.length) {
    root.append(el('div.card', {}, [
      emptyState({
        icon: '💳',
        title: 'Nenhum cartão cadastrado',
        text: 'Cadastre um cartão para acompanhar faturas e compras parceladas.',
        actionLabel: '+ Adicionar cartão',
        onAction: () => cardForm(null)
      })
    ]));
    return;
  }

  let totalInvoice = 0;
  let totalLimit = 0;
  let totalCommitted = 0;

  const cardNodes = [];
  for (const card of cards) {
    const [invoice, usage] = await Promise.all([
      repo.cardInvoice(card.id, month),
      repo.cardUsage(card.id)
    ]);
    totalInvoice += invoice.total;
    totalLimit += toInt(card.limit);
    totalCommitted += usage.committed;

    const available = Math.max(0, toInt(card.limit) - usage.committed);
    const usedPct = card.limit ? pct(usage.committed, card.limit) : 0;

    cardNodes.push(el('div.card-visual.mt-3', {}, [
      el('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px' } }, [
        el('div', { style: { flex: '1' } }, [
          el('div', { text: card.name, style: { fontSize: '17px', fontWeight: '650', letterSpacing: '-.3px' } }),
          el('div.tiny.muted', { text: `${card.institution || 'Cartão de crédito'} · fecha dia ${card.closingDay} · vence dia ${card.dueDay}` })
        ]),
        el('button.btn.btn-sm.btn-ghost', { type: 'button', text: 'Editar', onclick: () => cardForm(card) })
      ]),

      el('div.mt-4', {}, [
        el('div.summary-line', {}, [
          el('span.k', { text: `Fatura de ${monthLabel(month)}` }),
          el('span.v', { style: { fontSize: '17px' }, text: money(invoice.total) })
        ]),
        invoice.pending !== invoice.total ? el('div.summary-line', {}, [
          el('span.k', { text: 'Em aberto' }),
          el('span.v', { style: { color: 'var(--accent)' }, text: money(invoice.pending) })
        ]) : null
      ].filter(Boolean)),

      card.limit ? el('div.mt-3', {}, [
        progressBar(usedPct, usedPct >= 90 ? 'bad' : ''),
        el('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '6px' } }, [
          el('span.tiny.muted', { text: `Comprometido ${money(usage.committed)}` }),
          el('span.tiny.muted', { text: `Disponível ${money(available)}` })
        ])
      ]) : null,

      el('div.row.gap.mt-4', {}, [
        el('button.btn.btn-sm.btn-primary', {
          type: 'button', text: '+ Compra', style: { flex: '1' },
          onclick: () => purchaseForm(null, { cardId: card.id })
        }),
        el('button.btn.btn-sm.btn-ghost', {
          type: 'button', text: 'Ver fatura', style: { flex: '1' },
          onclick: () => openInvoice(card, month, ctx)
        })
      ])
    ].filter(Boolean)));
  }

  if (cards.length > 1) {
    root.append(el('div.hero', {}, [
      el('div.hero-label', { text: `Total das faturas — ${monthLabel(month)}` }),
      el('div.hero-value', { text: money(totalInvoice) }),
      totalLimit ? el('div.hero-sub', {
        text: `${money(totalCommitted)} comprometidos de ${money(totalLimit)} em limite`
      }) : null
    ].filter(Boolean)));
  }

  for (const n of cardNodes) root.append(n);

  root.append(el('button.btn.btn-outline.btn-block.mt-4', {
    type: 'button', text: '+ Adicionar cartão', onclick: () => cardForm(null)
  }));

  /* ---- Compras ativas ---- */
  const purchases = await repo.listPurchases();
  const active = [];
  for (const p of purchases) {
    const s = await repo.purchaseSummary(p.id);
    if (s.pendingCount > 0) active.push({ purchase: p, summary: s });
  }

  if (active.length) {
    const list = el('div.list');
    for (const { purchase, summary } of active.slice(0, 20)) {
      const card = cards.find((c) => c.id === purchase.cardId);
      list.append(listItem({
        icon: '🧾',
        title: purchase.name,
        subtitle: `${card ? card.name : 'Cartão'} · ${summary.paidCount}/${purchase.installmentsCount} pagas`,
        amount: summary.pendingTotal,
        meta: 'restante',
        onClick: () => openPurchase(purchase, ctx)
      }));
    }
    root.append(section('Parcelamentos em aberto', list));
  }
}

/* ============================== Fatura =================================== */

async function openInvoice(card, month, ctx) {
  const build = async (m) => {
    const invoice = await repo.cardInvoice(card.id, m);
    const body = el('div');

    body.append(el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' } }, [
      el('button.mnav-btn', { type: 'button', text: '‹', 'aria-label': 'Mês anterior', onclick: () => reload(addMonths(m, -1)) }),
      el('div', { text: monthLabel(m), style: { fontWeight: '600', minWidth: '150px', textAlign: 'center' } }),
      el('button.mnav-btn', { type: 'button', text: '›', 'aria-label': 'Próximo mês', onclick: () => reload(addMonths(m, 1)) })
    ]));

    body.append(el('div.card.mt-3', {}, [
      summaryLine('Total da fatura', invoice.total),
      summaryLine('Já pago', invoice.paid),
      summaryLine('Em aberto', invoice.pending),
      el('div.divider'),
      summaryLine('Vencimento', formatDate(`${m}-${String(card.dueDay).padStart(2, '0')}`))
    ]));

    if (!invoice.items.length) {
      body.append(el('div.card.mt-3', {}, [
        emptyState({ icon: '🧾', title: 'Fatura vazia', text: `Nenhuma parcela lançada em ${monthLabel(m)}.` })
      ]));
    } else {
      const list = el('div.list.mt-3');
      for (const item of invoice.items) {
        // Selinho de parcela (2/5) fica separado do nome pra nunca ser cortado
        // quando a descrição da compra é comprida.
        const badges = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'flex-end', marginTop: '2px' } }, [
          item.kind !== 'fixed' ? badge(`${item.ref.number}/${item.ref.total}`) : null,
          statusBadge(item.status)
        ].filter(Boolean));
        list.append(listItem({
          icon: item.status === STATUS.PAID ? '✓' : (item.kind === 'fixed' ? '📌' : '💳'),
          title: item.name,
          subtitle: `vence ${formatDate(item.dueDate)}`,
          amount: item.amount,
          badge: badges,
          onClick: async () => {
            const next = item.status === STATUS.PAID ? STATUS.PENDING : STATUS.PAID;
            if (item.kind === 'fixed') await repo.setExpenseStatus(item.id, next);
            else await repo.setInstallmentStatus(item.id, next);
            toastOk(next === STATUS.PAID ? 'Marcada como paga' : 'Marcada como pendente');
            emit('data:changed');
            reload(m);
          },
          chevron: false
        }));
      }
      body.append(list);

      if (invoice.pending > 0) {
        body.append(el('button.btn.btn-primary.btn-block.mt-4', {
          type: 'button',
          text: `Pagar fatura (${money(invoice.pending)})`,
          onclick: async () => {
            const ok = await confirm({
              title: 'Pagar fatura',
              text: `Todas as parcelas em aberto de ${monthLabel(m)} serão marcadas como pagas.`,
              okLabel: 'Confirmar pagamento'
            });
            if (!ok) return;
            const n = await repo.payCardInvoice(card.id, m);
            toastOk(`${n} parcela(s) marcadas como pagas`);
            emit('data:changed');
            reload(m);
          }
        }));
      }
    }

    /* Próximas faturas */
    const next = [];
    for (let i = 1; i <= 6; i++) {
      const fm = addMonths(m, i);
      const inv = await repo.cardInvoice(card.id, fm);
      if (inv.total > 0) next.push({ month: fm, total: inv.total });
    }
    if (next.length) {
      const nCard = el('div.card.mt-3');
      nCard.append(el('div.section-title', { text: 'Próximas faturas' }));
      for (const n of next) nCard.append(summaryLine(monthLabel(n.month), n.total));
      body.append(nCard);
    }

    return body;
  };

  let current = month;
  const s = sheet({ title: card.name, body: await build(current), size: 'tall' });

  async function reload(m) {
    current = m;
    const fresh = await build(m);
    s.body.replaceChildren(fresh);
  }
  return s;
}

/* ============================== Compra =================================== */

export async function openPurchase(purchase, ctx) {
  const [summary, card] = await Promise.all([
    repo.purchaseSummary(purchase.id),
    repo.getCard(purchase.cardId)
  ]);

  const body = el('div');
  body.append(el('div.dl', {}, [
    detailRow('Valor total', purchase.totalAmount),
    detailRow('Parcelas', `${purchase.installmentsCount}x de ${money(Math.round(purchase.totalAmount / purchase.installmentsCount))}`),
    detailRow('Cartão', card ? card.name : '—'),
    detailRow('Data da compra', formatDate(purchase.purchaseDate)),
    detailRow('1ª parcela', monthLabel(purchase.firstMonth)),
    purchase.note ? detailRow('Observação', purchase.note) : null
  ].filter(Boolean)));

  body.append(el('div.card.mt-3', { style: { background: 'var(--card-2)', border: 'none' } }, [
    summaryLine('Já pago', summary.paidTotal),
    summaryLine('Em aberto', summary.pendingTotal),
    el('div.mt-2', {}, [progressBar(pct(summary.paidTotal, summary.total), 'good')])
  ]));

  const list = el('div.list.mt-3');
  for (const inst of summary.installments) {
    list.append(listItem({
      icon: inst.status === STATUS.PAID ? '✓' : '•',
      title: `${inst.number}/${inst.total} — ${monthLabel(inst.month)}`,
      subtitle: `Vence ${formatDate(inst.dueDate)}`,
      amount: inst.amount,
      badge: statusBadge(inst.status),
      chevron: false,
      onClick: async () => {
        const next = inst.status === STATUS.PAID ? STATUS.PENDING : STATUS.PAID;
        await repo.setInstallmentStatus(inst.id, next);
        toastOk(next === STATUS.PAID ? 'Parcela paga' : 'Parcela reaberta');
        emit('data:changed');
        s.close(true);
      }
    }));
  }
  body.append(list);

  body.append(el('button.btn.btn-primary.btn-block.mt-4', {
    type: 'button', text: 'Editar compra',
    onclick: () => s.close('edit')
  }));

  // Abre a edição só quando esta tela realmente terminou de fechar (via onClose),
  // em vez de torcer pra um tempo fixo ser suficiente — evita a corrida entre
  // a animação de fechamento e a abertura da próxima tela.
  const s = sheet({
    title: purchase.name, body, size: 'tall',
    onClose: (result) => { if (result === 'edit') purchaseForm(purchase); }
  });
  return s;
}
