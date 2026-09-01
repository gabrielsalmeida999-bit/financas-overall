/* ==========================================================================
   views/transactions.js — lançamentos do mês, busca e filtros.
   ========================================================================== */

import {
  money, formatDate, weekdayOf, todayISO, monthLabel, debounce, groupBy, sum
} from '../core.js';

import {
  el, section, listItem, emptyState, statusBadge, badge, sheet, toastOk,
  confirm, segmented, chips, detailRow, emit, once, summaryLine
} from '../ui.js';

import * as repo from '../repo.js';
import { STATUS } from '../repo.js';
import {
  expenseForm, incomeForm, recurringForm, purchaseForm, debtPaymentForm, quickAdd
} from '../forms.js';

/** Filtros preservados enquanto o app está aberto. */
const filters = {
  tab: 'all',           // all | expenses | incomes
  text: '',
  categoryIds: [],
  methods: [],
  statuses: [],
  cardIds: [],
  minAmount: null,
  maxAmount: null
};

export function resetFilters() {
  filters.text = ''; filters.categoryIds = []; filters.methods = [];
  filters.statuses = []; filters.cardIds = []; filters.minAmount = null; filters.maxAmount = null;
}

function activeFilterCount() {
  return filters.categoryIds.length + filters.methods.length + filters.statuses.length
    + filters.cardIds.length + (filters.minAmount != null ? 1 : 0) + (filters.maxAmount != null ? 1 : 0);
}

export async function render(root, ctx) {
  const month = ctx.month;
  root.replaceChildren();

  /* ---- Barra superior: busca + filtros ---- */
  const searchInput = el('input.input', {
    type: 'search', placeholder: 'Pesquisar por nome…',
    value: filters.text, 'aria-label': 'Pesquisar lançamentos', enterkeyhint: 'search'
  });
  const onSearch = debounce(() => { filters.text = searchInput.value; paint(); }, 220);
  searchInput.addEventListener('input', onSearch);

  const filterBtn = el('button.btn.btn-ghost', {
    type: 'button',
    'aria-label': 'Filtros',
    onclick: () => openFilters(ctx, paint)
  }, [el('span', { text: '⚙︎' }), el('span', { text: 'Filtros' })]);

  const countBadge = el('span.badge.pending', { text: String(activeFilterCount()) });
  if (activeFilterCount()) filterBtn.append(countBadge);

  root.append(el('div', { style: { display: 'flex', gap: '12px' } }, [
    el('div', { style: { flex: '1' } }, [searchInput]),
    filterBtn
  ]));

  root.append(el('div.mt-3', {}, [
    segmented([
      { value: 'all', label: 'Tudo' },
      { value: 'expenses', label: 'Despesas' },
      { value: 'incomes', label: 'Receitas' }
    ], filters.tab, (v) => { filters.tab = v; paint(); })
  ]));

  const listWrap = el('div.mt-3');
  root.append(listWrap);

  await paint();

  async function paint() {
    listWrap.replaceChildren(el('div.small.muted.center.mt-4', { text: 'Carregando…' }));

    const types = filters.tab === 'expenses'
      ? ['expense', 'installment', 'debtPayment']
      : filters.tab === 'incomes' ? ['income']
      : ['expense', 'installment', 'debtPayment', 'income'];

    const rows = await repo.search({
      month, text: filters.text, types,
      categoryIds: filters.categoryIds.length ? filters.categoryIds : null,
      methods: filters.methods.length ? filters.methods : null,
      statuses: filters.statuses.length ? filters.statuses : null,
      cardIds: filters.cardIds.length ? filters.cardIds : null,
      minAmount: filters.minAmount, maxAmount: filters.maxAmount
    });

    const cats = await repo.categoryMap();
    const cardsList = await repo.listCards();
    const cardMap = new Map(cardsList.map((c) => [c.id, c]));
    listWrap.replaceChildren();

    if (!rows.length) {
      listWrap.append(el('div.card', {}, [
        emptyState({
          icon: filters.text || activeFilterCount() ? '🔍' : '📄',
          title: filters.text || activeFilterCount()
            ? 'Nenhum resultado'
            : `Nenhum lançamento em ${monthLabel(month)}`,
          text: filters.text || activeFilterCount()
            ? 'Tente ajustar a pesquisa ou os filtros.'
            : 'Você ainda não adicionou nenhum lançamento neste mês.',
          actionLabel: filters.text || activeFilterCount() ? 'Limpar filtros' : '+ Adicionar lançamento',
          onAction: () => {
            if (filters.text || activeFilterCount()) { resetFilters(); searchInput.value = ''; ctx.refresh(); }
            else quickAdd(month);
          }
        })
      ]));
      return;
    }

    /* Totais do que está sendo mostrado */
    const income = sum(rows.filter((r) => r.type === 'income'), (r) => r.amount);
    const outflow = sum(rows.filter((r) => r.type !== 'income'), (r) => r.amount);
    listWrap.append(el('div.card', {}, [
      el('div.summary-line', {}, [
        el('span.k', { text: `${rows.length} lançamento(s)` }),
        el('span.v', { text: '' })
      ]),
      income ? el('div.summary-line', {}, [
        el('span.k', { text: 'Entradas' }),
        el('span.v', { style: { color: 'var(--good)' }, text: money(income) })
      ]) : null,
      outflow ? el('div.summary-line', {}, [
        el('span.k', { text: 'Saídas' }),
        el('span.v', { text: money(outflow) })
      ]) : null
    ].filter(Boolean)));

    /* Tudo que é do cartão (parcelas de compras + despesas fixas vinculadas)
       fica agrupado por cartão, com botão para pagar a fatura inteira de uma vez. */
    const cardGroups = new Map();
    const otherRows = [];
    for (const item of rows) {
      const cardId = item.ref && item.ref.cardId;
      if (cardId && cardMap.has(cardId)) {
        if (!cardGroups.has(cardId)) cardGroups.set(cardId, []);
        cardGroups.get(cardId).push(item);
      } else {
        otherRows.push(item);
      }
    }

    if (cardGroups.size) {
      listWrap.append(el('div.section-title.mt-4', { text: 'Cartões de crédito' }));
    }

    for (const [cardId, items] of cardGroups) {
      const card = cardMap.get(cardId);
      const sorted = [...items].sort((a, b) => a.date.localeCompare(b.date));
      const pendingItems = sorted.filter((i) => i.status === STATUS.PENDING);
      const pendingTotal = sum(pendingItems, (i) => i.amount);
      const paidTotal = sum(sorted.filter((i) => i.status === STATUS.PAID), (i) => i.amount);

      const list = el('div.list.mt-3');
      for (const item of sorted) {
        const cat = item.categoryId ? cats.get(item.categoryId) : null;
        // Nome puro da compra (sem "N/T" grudado): nomes compridos cortam o
        // título com reticências, e a parcela sumia junto. Agora ela vira um
        // selinho à parte, num espaço que nunca é cortado.
        const isInstallment = item.type === 'installment';
        const title = isInstallment ? item.ref.name : item.name;
        list.append(listItem({
          icon: iconFor(item, cat),
          iconColor: cat ? cat.color : null,
          title,
          subtitle: subtitleFor(item, cat),
          amount: item.amount,
          amountClass: 'out',
          badge: installmentBadges(item),
          onClick: () => openDetail(item, ctx, month)
        }));
      }

      listWrap.append(el('div.card.mt-3', {}, [
        el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [
          el('span', { text: '💳', style: { fontSize: '17px' } }),
          el('span', { text: card.name, style: { fontWeight: '650', fontSize: '15px', flex: '1' } }),
          el('span', { text: money(pendingTotal + paidTotal), style: { fontWeight: '650', fontSize: '15px' } })
        ]),
        paidTotal ? summaryLine('Já pago', paidTotal) : null,
        pendingTotal ? summaryLine('Em aberto', pendingTotal) : null,
        list,
        pendingTotal > 0 ? el('button.btn.btn-primary.btn-block.mt-3', {
          type: 'button',
          text: `Pagar fatura (${money(pendingTotal)})`,
          onclick: once(async () => {
            const ok = await confirm({
              title: 'Pagar fatura',
              text: `Todas as ${pendingItems.length} despesa(s) em aberto de "${card.name}" neste mês serão marcadas como pagas.`,
              okLabel: 'Confirmar pagamento'
            });
            if (!ok) return;
            const n = await repo.payCardInvoice(cardId, month);
            toastOk(`${n} despesa(s) marcadas como pagas`);
            emit('data:changed');
            paint();
          })
        }) : null
      ].filter(Boolean)));
    }

    if (cardGroups.size && otherRows.length) {
      listWrap.append(el('div.section-title.mt-4', { text: 'Outros lançamentos' }));
    }

    const byDay = groupBy(otherRows, (r) => r.date);
    for (const [date, items] of [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      listWrap.append(el('div.day-head', {
        text: `${formatDate(date)} · ${weekdayOf(date).replace('-feira', '')}`
      }));
      const list = el('div.list');
      for (const item of items) {
        const cat = item.categoryId ? cats.get(item.categoryId) : null;
        list.append(listItem({
          icon: iconFor(item, cat),
          iconColor: cat ? cat.color : null,
          title: item.name,
          subtitle: subtitleFor(item, cat),
          amount: item.amount,
          amountClass: item.type === 'income' ? 'in' : 'out',
          badge: item.status === STATUS.PENDING
            ? statusBadge('pending', item.date < todayISO())
            : null,
          onClick: () => openDetail(item, ctx, month)
        }));
      }
      listWrap.append(list);
    }
  }
}

function iconFor(item, cat) {
  if (item.type === 'income') return cat ? cat.icon : '💵';
  if (item.type === 'installment') return '💳';
  if (item.type === 'debtPayment') return '🤝';
  if (item.ref && item.ref.kind === 'fixed') return cat ? cat.icon : '📌';
  return cat ? cat.icon : '📦';
}

function subtitleFor(item, cat) {
  const parts = [];
  if (item.type === 'income') parts.push('Receita');
  else if (item.type === 'installment') parts.push('Cartão de crédito');
  else if (item.type === 'debtPayment') parts.push('Pagamento de dívida');
  else parts.push(item.ref.kind === 'fixed' ? 'Despesa fixa' : repo.paymentMethodLabel(item.ref.paymentMethod));
  if (cat) parts.push(cat.name);
  return parts.join(' · ');
}

/**
 * Selinhos do lado direito de um item do grupo de cartão: número da parcela
 * (sempre visível, mesmo com nome comprido) + situação, quando pendente.
 */
function installmentBadges(item) {
  const parts = [];
  if (item.type === 'installment') {
    parts.push(badge(`${item.ref.number}/${item.ref.total}`));
  }
  if (item.status === STATUS.PENDING) {
    parts.push(statusBadge('pending', item.date < todayISO()));
  }
  if (!parts.length) return null;
  return el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'flex-end', marginTop: '2px' } }, parts);
}

/* ============================== Detalhe ================================== */

export async function openDetail(item, ctx, month) {
  const cats = await repo.categoryMap();
  const cat = item.categoryId ? cats.get(item.categoryId) : null;
  const ref = item.ref;

  const rows = el('div.dl');
  rows.append(detailRow('Valor', item.amount));
  rows.append(detailRow('Data', formatDate(item.date)));
  if (cat) rows.append(detailRow('Categoria', `${cat.icon} ${cat.name}`));

  if (item.type === 'expense') {
    rows.append(detailRow('Tipo', ref.kind === 'fixed' ? 'Despesa fixa' : 'Despesa variável'));
    if (ref.kind !== 'fixed') rows.append(detailRow('Pagamento', repo.paymentMethodLabel(ref.paymentMethod)));
    rows.append(detailRow('Situação', ref.status === STATUS.PAID ? 'Paga' : 'Pendente'));
  }
  if (item.type === 'installment') {
    const card = await repo.getCard(ref.cardId);
    rows.append(detailRow('Cartão', card ? card.name : '—'));
    rows.append(detailRow('Parcela', `${ref.number} de ${ref.total}`));
    rows.append(detailRow('Situação', ref.status === STATUS.PAID ? 'Paga' : 'Pendente'));
  }
  if (item.type === 'debtPayment') {
    const debt = await repo.getDebt(ref.debtId);
    rows.append(detailRow('Dívida', debt ? debt.person : '—'));
  }
  if (ref.note) rows.append(detailRow('Observação', ref.note));

  const actions = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '16px' } });

  const canToggle = (item.type === 'expense' && ref.kind !== undefined) || item.type === 'installment';
  if (canToggle) {
    const isPaid = ref.status === STATUS.PAID;
    actions.append(el('button.btn.btn-ghost.btn-block', {
      type: 'button',
      text: isPaid ? 'Marcar como pendente' : 'Marcar como paga',
      onclick: async () => {
        const next = isPaid ? STATUS.PENDING : STATUS.PAID;
        if (item.type === 'installment') await repo.setInstallmentStatus(ref.id, next);
        else await repo.setExpenseStatus(ref.id, next);
        toastOk(next === STATUS.PAID ? 'Marcada como paga' : 'Marcada como pendente');
        emit('data:changed');
        s.close(true);
      }
    }));
  }

  actions.append(el('button.btn.btn-primary.btn-block', {
    type: 'button', text: 'Editar',
    onclick: () => s.close('edit')
  }));

  if (item.type === 'debtPayment') {
    actions.append(el('button.btn.btn-danger.btn-block', {
      type: 'button', text: 'Excluir pagamento',
      onclick: async () => {
        const ok = await confirm({
          title: 'Excluir pagamento',
          text: 'O valor voltará a constar como devido nesta dívida.',
          okLabel: 'Excluir', danger: true
        });
        if (!ok) return;
        await repo.deleteDebtPayment(ref.id);
        toastOk('Pagamento excluído');
        emit('data:changed');
        s.close(true);
      }
    }));
  }

  // Abre a edição só quando esta tela realmente terminou de fechar (via onClose),
  // em vez de um tempo fixo correndo contra a animação de fechamento.
  const s = sheet({
    title: item.name, body: el('div', {}, [rows, actions]),
    onClose: (result) => { if (result === 'edit') editItem(item, month); }
  });
  return s;
}

async function editItem(item, month) {
  const ref = item.ref;
  if (item.type === 'income') return incomeForm(ref);
  if (item.type === 'installment') {
    const purchase = await repo.getPurchase(ref.purchaseId);
    if (purchase) return purchaseForm(purchase);
    return;
  }
  if (item.type === 'debtPayment') {
    const debt = await repo.getDebt(ref.debtId);
    if (debt) return debtPaymentForm(debt);
    return;
  }
  if (ref.kind === 'fixed' && ref.recurringId) {
    const list = await repo.listRecurring();
    const model = list.find((r) => r.id === ref.recurringId);
    if (model) return recurringForm(model, month || ref.month);
  }
  return expenseForm(ref);
}

/* ============================== Filtros ================================== */

async function openFilters(ctx, onApply) {
  const [cats, cards] = await Promise.all([repo.listCategories(), repo.listCards()]);
  const draft = {
    categoryIds: [...filters.categoryIds],
    methods: [...filters.methods],
    statuses: [...filters.statuses],
    cardIds: [...filters.cardIds],
    minAmount: filters.minAmount,
    maxAmount: filters.maxAmount
  };

  const toggle = (arr, v) => {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
  };

  const body = el('div');

  const catWrap = el('div');
  const paintCats = () => {
    catWrap.replaceChildren(chips(
      cats.map((c) => ({ value: c.id, label: `${c.icon} ${c.name}` })),
      draft.categoryIds,
      (v) => { toggle(draft.categoryIds, v); paintCats(); },
      { multi: true }
    ));
  };
  paintCats();
  body.append(el('div.field-label', { text: 'Categorias' }), catWrap);

  const methodWrap = el('div.mt-3');
  const paintMethods = () => {
    methodWrap.replaceChildren(chips(
      repo.PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label })),
      draft.methods,
      (v) => { toggle(draft.methods, v); paintMethods(); },
      { multi: true }
    ));
  };
  paintMethods();
  body.append(el('div.field-label.mt-3', { text: 'Forma de pagamento' }), methodWrap);

  const statusWrap = el('div.mt-3');
  const paintStatus = () => {
    statusWrap.replaceChildren(chips(
      [{ value: 'pending', label: 'Pendente' }, { value: 'paid', label: 'Pago' }],
      draft.statuses,
      (v) => { toggle(draft.statuses, v); paintStatus(); },
      { multi: true }
    ));
  };
  paintStatus();
  body.append(el('div.field-label.mt-3', { text: 'Situação' }), statusWrap);

  if (cards.length) {
    const cardWrap = el('div.mt-3');
    const paintCards = () => {
      cardWrap.replaceChildren(chips(
        cards.map((c) => ({ value: c.id, label: c.name })),
        draft.cardIds,
        (v) => { toggle(draft.cardIds, v); paintCards(); },
        { multi: true }
      ));
    };
    paintCards();
    body.append(el('div.field-label.mt-3', { text: 'Cartão' }), cardWrap);
  }

  const minIn = el('input.input', { type: 'text', inputmode: 'numeric', placeholder: 'Mínimo (R$)' });
  const maxIn = el('input.input', { type: 'text', inputmode: 'numeric', placeholder: 'Máximo (R$)' });
  if (draft.minAmount != null) minIn.value = (draft.minAmount / 100).toFixed(2).replace('.', ',');
  if (draft.maxAmount != null) maxIn.value = (draft.maxAmount / 100).toFixed(2).replace('.', ',');

  body.append(el('div.field-label.mt-3', { text: 'Faixa de valor' }));
  body.append(el('div', { style: { display: 'flex', gap: '12px' } }, [minIn, maxIn]));

  const s = sheet({
    title: 'Filtros',
    body,
    footer: (api) => el('div', { style: { display: 'flex', gap: '12px', width: '100%' } }, [
      el('button.btn.btn-ghost', {
        type: 'button', text: 'Limpar',
        onclick: () => { resetFilters(); api.close(null); ctx.refresh(); }
      }),
      el('button.btn.btn-primary', {
        type: 'button', text: 'Aplicar',
        onclick: () => {
          filters.categoryIds = draft.categoryIds;
          filters.methods = draft.methods;
          filters.statuses = draft.statuses;
          filters.cardIds = draft.cardIds;
          filters.minAmount = minIn.value.trim() ? parseAmount(minIn.value) : null;
          filters.maxAmount = maxIn.value.trim() ? parseAmount(maxIn.value) : null;
          api.close(true);
          ctx.refresh();
        }
      })
    ])
  });
  return s;
}

function parseAmount(str) {
  const clean = String(str).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const v = Number(clean);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
}
