/* ==========================================================================
   views/reports.js — evolução mensal, comparações e gastos por categoria.
   ========================================================================== */

import {
  money, moneyShort, monthLabel, monthLabelShort, addMonths, pct, sum
} from '../core.js';

import { el, section, segmented, emptyState, progressBar, summaryLine, listItem, sheet } from '../ui.js';
import * as repo from '../repo.js';

let periodMonths = 12;
let metric = 'expense'; // expense | income | balance

export async function render(root, ctx) {
  const month = ctx.month;
  root.replaceChildren();

  const [stats, breakdown] = await Promise.all([
    repo.reportStats(month, periodMonths),
    repo.categoryBreakdown(month)
  ]);

  root.append(segmented([
    { value: 6, label: '6 meses' },
    { value: 12, label: '12 meses' },
    { value: 24, label: '24 meses' }
  ], periodMonths, (v) => { periodMonths = v; ctx.refresh(); }));

  root.append(el('div.mt-3', {}, [
    segmented([
      { value: 'expense', label: 'Gastos' },
      { value: 'income', label: 'Receitas' },
      { value: 'balance', label: 'Saldo' }
    ], metric, (v) => { metric = v; ctx.refresh(); })
  ]));

  if (!stats.monthsWithData) {
    root.append(el('div.card.mt-3', {}, [
      emptyState({
        icon: '📈',
        title: 'Sem histórico ainda',
        text: 'Assim que você registrar lançamentos, a evolução dos seus gastos aparecerá aqui.'
      })
    ]));
    return;
  }

  /* ---------- Gráfico de barras ---------- */
  const valueOf = (s) => metric === 'income' ? s.income
    : metric === 'balance' ? (s.income - s.expense)
    : s.expense;

  const values = stats.series.map(valueOf);
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));

  const chart = el('div.chart', { role: 'img', 'aria-label': 'Evolução mensal' });
  stats.series.forEach((s, i) => {
    const v = values[i];
    const h = Math.max(3, Math.round((Math.abs(v) / maxAbs) * 96));
    const isCurrent = s.month === month;
    const col = el(`div.chart-col${isCurrent ? '.cur' : ''}`, {
      title: `${monthLabel(s.month)}: ${money(v)}`
    }, [
      el('div.chart-val', { text: v ? moneyShort(v) : '' }),
      el('div.chart-bar', {
        style: {
          height: `${h}px`,
          background: metric === 'balance' && v < 0 ? 'var(--bad)' : undefined
        }
      }),
      el('div.chart-lbl', { text: monthLabelShort(s.month) })
    ]);
    chart.append(col);
  });

  root.append(section(`Evolução — ${periodMonths} meses`, el('div.card', {}, [chart])));

  /* ---------- Comparação ---------- */
  const cmpCard = el('div.card');
  const cur = stats.current, prev = stats.previous;
  cmpCard.append(summaryLine(`${monthLabel(month)}`, cur ? cur.expense : 0));
  if (prev) cmpCard.append(summaryLine(`${monthLabel(prev.month)}`, prev.expense));
  if (stats.variation !== null) {
    const up = stats.variation > 0;
    cmpCard.append(el('div.divider'));
    cmpCard.append(el('div.summary-line', {}, [
      el('span.k', { text: 'Variação' }),
      el('span.v', {
        style: { color: up ? 'var(--bad)' : 'var(--good)' },
        text: `${up ? '▲' : '▼'} ${Math.abs(stats.variation)}%`
      })
    ]));
  }
  root.append(section('Comparação com o mês anterior', cmpCard));

  /* ---------- Estatísticas ---------- */
  const statsCard = el('div.card', {}, [
    summaryLine('Média mensal de gastos', stats.avg),
    stats.max ? el('div.summary-line', {}, [
      el('span.k', { text: 'Maior mês' }),
      el('span.v', { text: `${monthLabel(stats.max.month)} — ${money(stats.max.expense)}` })
    ]) : null,
    stats.min ? el('div.summary-line', {}, [
      el('span.k', { text: 'Menor mês' }),
      el('span.v', { text: `${monthLabel(stats.min.month)} — ${money(stats.min.expense)}` })
    ]) : null,
    el('div.divider'),
    summaryLine(`Total de gastos (${periodMonths}m)`, stats.totalExpense),
    summaryLine(`Total de receitas (${periodMonths}m)`, stats.totalIncome),
    el('div.summary-line', {}, [
      el('span.k', { text: 'Saldo acumulado' }),
      el('span.v', {
        style: { color: stats.totalIncome - stats.totalExpense >= 0 ? 'var(--good)' : 'var(--bad)' },
        text: money(stats.totalIncome - stats.totalExpense)
      })
    ])
  ].filter(Boolean));
  root.append(section('Resumo do período', statsCard));

  /* ---------- Categorias do mês ---------- */
  if (breakdown.total > 0) {
    const bars = el('div.card.bars');
    for (const row of breakdown.rows) {
      bars.append(el('div.bar-row', {}, [
        el('div.bar-top', {}, [
          el('span', { text: row.icon }),
          el('span.nm', { text: row.name }),
          el('span.vl', { text: money(row.amount) }),
          el('span.pc', { text: `${row.percent}%` })
        ]),
        el('div.pbar', {}, [el('i', { style: { width: `${Math.max(2, row.percent)}%`, background: row.color } })])
      ]));
    }
    root.append(section(`Categorias — ${monthLabel(month)}`, bars));
  }

  /* ---------- Detalhe por tipo ---------- */
  const typeCard = el('div.card', {}, [
    summaryLine('Despesas fixas', cur ? cur.fixed : 0),
    summaryLine('Despesas variáveis', cur ? cur.variable : 0),
    summaryLine('Cartão de crédito', cur ? cur.card : 0),
    summaryLine('Pagamentos de dívidas', cur ? cur.debts : 0)
  ]);
  root.append(section('Composição do mês', typeCard));

  /* ---------- Tabela mês a mês ---------- */
  const table = el('div.list');
  for (const s of [...stats.series].reverse()) {
    if (!s.expense && !s.income) continue;
    const bal = s.income - s.expense;
    table.append(listItem({
      icon: null,
      title: monthLabel(s.month),
      subtitle: `Renda ${money(s.income)} · Gastos ${money(s.expense)}`,
      amount: money(bal),
      amountClass: bal >= 0 ? 'in' : '',
      onClick: () => ctx.setMonth(s.month),
      chevron: true
    }));
  }
  root.append(section('Mês a mês', table));
}
