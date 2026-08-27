/* ==========================================================================
   testes.js — verificação das regras críticas em base isolada.
   Abrir: testes.html
   ========================================================================== */

import * as core from './core.js';
import * as db from './db.js';
import * as repo from './repo.js';
import * as backup from './backup.js';

const out = document.getElementById('out');
const summary = document.getElementById('summary');
let pass = 0, fail = 0;
let group = null;

function grupo(nome) {
  group = document.createElement('div');
  group.className = 'grp';
  const h = document.createElement('h2');
  h.textContent = nome;
  group.append(h);
  out.append(group);
}

function check(desc, condition, why = '') {
  const ok = !!condition;
  ok ? pass++ : fail++;
  const row = document.createElement('div');
  row.className = `t ${ok ? 'ok' : 'fail'}`;
  const m = document.createElement('span'); m.className = 'm'; m.textContent = ok ? '✓' : '✕';
  const d = document.createElement('span'); d.className = 'd'; d.textContent = desc;
  if (!ok && why) { const w = document.createElement('span'); w.className = 'why'; w.textContent = why; d.append(w); }
  row.append(m, d);
  (group || out).append(row);
  return ok;
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function limparBase() {
  await db.clearAllData();
  repo.invalidateSettingsCache();
  await repo.ensureSeed();
}

/* ========================================================================= */

async function run() {
  const t0 = performance.now();

  /* ------------------------------ Valores ------------------------------- */
  grupo('Valores monetários (centavos)');

  // Intl usa espaço rígido (U+00A0) entre "R$" e o número — normalizamos ao comparar.
  const fmt = (c) => core.money(c).replace(/ /g, ' ');
  check('R$ 0,01 formata corretamente', fmt(1) === 'R$ 0,01', fmt(1));
  check('R$ 1.000,00 formata corretamente', fmt(100000) === 'R$ 1.000,00', fmt(100000));
  check('R$ 10.000,00 formata corretamente', fmt(1000000) === 'R$ 10.000,00', fmt(1000000));
  check('R$ 1.234,56 formata corretamente', fmt(123456) === 'R$ 1.234,56', fmt(123456));
  check('parseMoney("1.234,56") = 123456', core.parseMoney('1.234,56') === 123456);
  check('parseMoney("R$ 25,90") = 2590', core.parseMoney('R$ 25,90') === 2590);
  check('parseMoney("1234.56") = 123456', core.parseMoney('1234.56') === 123456);
  check('digitsToCents("2590") = 2590', core.digitsToCents('2590') === 2590);

  const s3 = core.splitAmount(90000, 3);
  check('R$ 900 em 3x = 3 × R$ 300', eq(s3, [30000, 30000, 30000]), JSON.stringify(s3));
  const s7 = core.splitAmount(10000, 7);
  check('R$ 100 em 7x soma exatamente R$ 100', s7.reduce((a, b) => a + b, 0) === 10000, JSON.stringify(s7));
  check('R$ 100 em 7x distribui o resto nas primeiras', s7[0] === 1429 && s7[6] === 1428, JSON.stringify(s7));
  const s12 = core.splitAmount(100001, 12);
  check('R$ 1000,01 em 12x soma exato', s12.reduce((a, b) => a + b, 0) === 100001);
  check('1x devolve o valor inteiro', eq(core.splitAmount(4599, 1), [4599]));
  check('Nenhuma parcela é fracionada', core.splitAmount(99999, 13).every(Number.isInteger));

  /* -------------------------------- Datas -------------------------------- */
  grupo('Datas financeiras (sem fuso horário)');

  check('addMonths vira o ano', core.addMonths('2026-12', 1) === '2027-01');
  check('addMonths retrocede o ano', core.addMonths('2026-01', -1) === '2025-12');
  check('addMonths +14 meses', core.addMonths('2026-08', 14) === '2027-10');
  check('dateInMonth limita fevereiro', core.dateInMonth('2026-02', 31) === '2026-02-28');
  check('dateInMonth em ano bissexto', core.dateInMonth('2028-02', 31) === '2028-02-29');
  check('dateInMonth mantém dia válido', core.dateInMonth('2026-08', 25) === '2026-08-25');
  check('monthOf extrai o mês da data', core.monthOf('2026-08-25') === '2026-08');
  check('diffMonths conta corretamente', core.diffMonths('2026-01', '2026-04') === 3);
  check('data inválida é rejeitada', core.isValidDate('2026-02-30') === false);
  check('mês inválido é rejeitado', core.isValidMonth('2026-13') === false);
  check('formatDate exibe padrão brasileiro', core.formatDate('2026-08-25') === '25/08/2026');

  /* ---------------------------- Banco / esquema -------------------------- */
  grupo('Banco de dados e migrações');

  await db.openDB();
  const schema = await db.validateSchema();
  check(`Banco abriu na versão v${db.DB_VERSION}`, schema.ok, `faltando: ${schema.missing.join(', ')}`);
  check('Todas as stores existem', schema.missing.length === 0);

  await limparBase();
  const cats = await repo.listCategories();
  check('Categorias padrão foram criadas', cats.length >= 10, `${cats.length} categorias`);
  check('Existe categoria de receita', cats.some((c) => c.kind === 'income'));

  const catAlim = (await repo.listCategories('expense')).find((c) => c.name === 'Alimentação');
  check('Categoria "Alimentação" disponível', !!catAlim);

  /* ------------------------------ Despesas ------------------------------- */
  grupo('Despesas e receitas');

  const e1 = await repo.createExpense({
    name: 'Mercado', amount: 15990, date: '2026-08-10',
    categoryId: catAlim ? catAlim.id : null, paymentMethod: 'pix'
  });
  check('Despesa criada com ID único', typeof e1.id === 'string' && e1.id.startsWith('exp_'));
  check('Despesa guardou valor em centavos', e1.amount === 15990);
  check('Mês derivado da data financeira', e1.month === '2026-08');

  let duplicou = false;
  try {
    await repo.createExpense({ name: 'Mercado', amount: 15990, date: '2026-08-10', paymentMethod: 'pix' });
    duplicou = true;
  } catch (err) {
    check('Duplicidade acidental é bloqueada', err instanceof repo.DuplicateError, err.name);
  }
  if (duplicou) check('Duplicidade acidental é bloqueada', false, 'criou registro duplicado');

  const e1b = await repo.createExpense(
    { name: 'Mercado', amount: 15990, date: '2026-08-10', paymentMethod: 'pix' },
    { force: true }
  );
  check('Duplicata é permitida com confirmação explícita', e1b.id !== e1.id);
  await repo.deleteExpense(e1b.id);

  await repo.updateExpense(e1.id, { amount: 17550 });
  const e1r = (await repo.listExpenses('2026-08')).find((x) => x.id === e1.id);
  check('Edição de despesa persiste', e1r.amount === 17550);

  await repo.deleteExpense(e1.id);
  const aposDelete = (await repo.listExpenses('2026-08')).find((x) => x.id === e1.id);
  check('Exclusão é lógica (some da lista)', !aposDelete);
  const naLixeira = (await repo.listTrash()).some((t) => t.id === e1.id);
  check('Registro excluído vai para a lixeira', naLixeira);
  await repo.restoreFromTrash('expenses', e1.id);
  check('Registro pode ser recuperado', !!(await repo.listExpenses('2026-08')).find((x) => x.id === e1.id));
  await repo.deleteExpense(e1.id);

  const r1 = await repo.createIncome({ name: 'Pró-labore', amount: 500000, date: '2026-08-05' });
  check('Receita criada', r1.amount === 500000 && r1.month === '2026-08');

  /* --------------------------- Compras parceladas ------------------------ */
  grupo('Compras parceladas');

  const card = await repo.createCard({ name: 'Cartão Teste', limit: 1000000, closingDay: 20, dueDay: 5 });
  check('Cartão criado', !!card.id);

  // Vencimento no mesmo mês do fechamento (ex.: fecha 19, paga 25).
  const cardMesmoMes = { closingDay: 19, dueDay: 25 };
  check('Compra antes do fechamento sugere o mês atual',
    repo.suggestFirstMonth(cardMesmoMes, '2026-08-18') === '2026-08');
  check('Compra no dia do fechamento ainda conta como "antes"',
    repo.suggestFirstMonth(cardMesmoMes, '2026-08-19') === '2026-08');
  check('Compra depois do fechamento sugere o mês seguinte',
    repo.suggestFirstMonth(cardMesmoMes, '2026-08-20') === '2026-09');
  check('Compra bem depois do fechamento também sugere o mês seguinte',
    repo.suggestFirstMonth(cardMesmoMes, '2026-08-27') === '2026-09');

  // Vencimento no mês seguinte ao fechamento (ex.: fecha 20, paga 5 do mês que vem).
  const cardMesSeguinte = { closingDay: 20, dueDay: 5 };
  check('Fechamento com vencimento no mês seguinte: antes do fechamento paga 1 mês à frente',
    repo.suggestFirstMonth(cardMesSeguinte, '2026-08-10') === '2026-09');
  check('Fechamento com vencimento no mês seguinte: depois do fechamento paga 2 meses à frente',
    repo.suggestFirstMonth(cardMesSeguinte, '2026-08-25') === '2026-10');

  const c1 = await repo.createPurchase({
    cardId: card.id, name: 'Notebook', totalAmount: 90000,
    installmentsCount: 3, purchaseDate: '2026-08-10', firstMonth: '2026-08'
  });
  check('Compra 3x gerou 3 parcelas', c1.installments.length === 3);
  check('Parcelas de R$ 300 cada', c1.installments.every((i) => i.amount === 30000));
  check('Meses sequenciais das parcelas',
    eq(c1.installments.map((i) => i.month), ['2026-08', '2026-09', '2026-10']));
  check('Numeração 1/3, 2/3, 3/3',
    eq(c1.installments.map((i) => `${i.number}/${i.total}`), ['1/3', '2/3', '3/3']));
  check('Soma das parcelas = total da compra',
    c1.installments.reduce((a, b) => a + b.amount, 0) === 90000);
  check('IDs de parcela são únicos', new Set(c1.installments.map((i) => i.id)).size === 3);

  await repo.materializeMonth('2026-08');
  await repo.materializeMonth('2026-08');
  const insts08 = await repo.listInstallmentsOf(c1.purchase.id);
  check('Reexecutar não duplica parcelas', insts08.length === 3, `${insts08.length} parcelas`);

  const c1x = await repo.createPurchase({
    cardId: card.id, name: 'À vista', totalAmount: 4599,
    installmentsCount: 1, purchaseDate: '2026-08-11', firstMonth: '2026-08'
  });
  check('Compra 1x gera 1 parcela com valor total',
    c1x.installments.length === 1 && c1x.installments[0].amount === 4599);

  const c12 = await repo.createPurchase({
    cardId: card.id, name: 'Celular', totalAmount: 100001,
    installmentsCount: 12, purchaseDate: '2026-08-12', firstMonth: '2026-10'
  });
  check('Compra 12x gera 12 parcelas', c12.installments.length === 12);
  check('12x soma exatamente o total',
    c12.installments.reduce((a, b) => a + b.amount, 0) === 100001);
  check('Primeira parcela no mês escolhido', c12.installments[0].month === '2026-10');
  check('Última parcela 12 meses depois', c12.installments[11].month === '2027-09');

  // Editar preservando parcelas pagas
  await repo.setInstallmentStatus(c1.installments[0].id, repo.STATUS.PAID);
  await repo.updatePurchase(c1.purchase.id, { totalAmount: 120000 });
  const editadas = await repo.listInstallmentsOf(c1.purchase.id);
  check('Edição não duplica parcelas', editadas.length === 3, `${editadas.length} parcelas`);
  check('Parcela paga permanece intacta',
    editadas[0].amount === 30000 && editadas[0].status === repo.STATUS.PAID,
    `parcela 1 = ${editadas[0].amount} / ${editadas[0].status}`);
  check('Somente as pendentes foram recalculadas',
    editadas[1].amount + editadas[2].amount === 90000,
    `${editadas[1].amount} + ${editadas[2].amount}`);
  check('Soma total continua fechando',
    editadas.reduce((a, b) => a + b.amount, 0) === 120000);

  let reduziuAbaixoDoPago = false;
  try { await repo.updatePurchase(c1.purchase.id, { totalAmount: 10000 }); reduziuAbaixoDoPago = true; } catch (_) {}
  check('Total menor que o já pago é recusado', !reduziuAbaixoDoPago);

  let reduziuParcelas = false;
  try { await repo.updatePurchase(c12.purchase.id, { installmentsCount: 6 }); reduziuParcelas = true; } catch (_) {}
  check('Reduzir parcelas remove só as futuras (sem pagas)', reduziuParcelas);
  const c12r = await repo.listInstallmentsOf(c12.purchase.id);
  check('Após reduzir, ficam 6 parcelas', c12r.length === 6, `${c12r.length}`);
  check('Após reduzir, soma bate com o total',
    c12r.reduce((a, b) => a + b.amount, 0) === 100001);
  check('Nunca cria parcela acima do total', c12r.every((i) => i.number <= i.total));

  // Exclusão preservando o histórico pago
  await repo.deletePurchase(c1.purchase.id, 'with-future');
  const restantes = await repo.listInstallmentsOf(c1.purchase.id);
  check('Exclusão remove só parcelas não pagas',
    restantes.length === 1 && restantes[0].status === repo.STATUS.PAID,
    `${restantes.length} restante(s)`);

  /* ------------------- Cadastro de despesas retroativas ------------------- */
  grupo('Cadastro de despesas retroativas');

  await limparBase();
  const cardRetro = await repo.createCard({ name: 'Cartão Antigo', limit: 500000, closingDay: 20, dueDay: 5 });
  const hoje = core.currentMonth();

  // 10 parcelas, já pagas 3 (fora do sistema) -> estamos na 4ª
  const retro = await repo.createRetroactivePurchase({
    name: 'Notebook antigo', cardId: cardRetro.id, installmentAmount: 20000,
    installmentsCount: 10, currentNumber: 4
  });
  check('Cria só as parcelas restantes (4 a 10 = 7)', retro.installments.length === 7,
    `${retro.installments.length}`);
  check('Não cria nenhuma parcela com número menor que 4',
    retro.installments.every((i) => i.number >= 4));
  check('Numeração real preservada (4/10 até 10/10)',
    retro.installments[0].number === 4 && retro.installments[0].total === 10 &&
    retro.installments[6].number === 10);
  check('Cada parcela vale exatamente o valor informado (sem arredondamento)',
    retro.installments.every((i) => i.amount === 20000));
  check('Parcela atual (4ª) cai neste mês', retro.installments[0].month === hoje,
    `${retro.installments[0].month} vs ${hoje}`);
  check('Nenhuma parcela paga foi criada (histórico antigo não entra)',
    retro.installments.every((i) => i.status === repo.STATUS.PENDING));

  const resumoRetro = await repo.purchaseSummary(retro.purchase.id);
  check('Resumo mostra 7 parcelas no banco, mas total real é 10',
    resumoRetro.installments.length === 7 && retro.purchase.installmentsCount === 10);

  const invoiceRetro = await repo.cardInvoice(cardRetro.id, hoje);
  check('Fatura deste mês mostra a parcela "4 de 10"',
    invoiceRetro.items.some((i) => i.name === 'Notebook antigo' && i.subtitle === 'Parcela 4 de 10'),
    JSON.stringify(invoiceRetro.items.map((i) => `${i.name} | ${i.subtitle}`)));

  // Proteção: editar depois não pode recriar as parcelas 1-3 (nunca existiram de propósito)
  await repo.updatePurchase(retro.purchase.id, { installmentsCount: 12 });
  const aposEditar = await repo.listInstallmentsOf(retro.purchase.id);
  check('Editar não recria parcelas anteriores à retroativa',
    aposEditar.every((i) => i.number >= 4), `menor número: ${Math.min(...aposEditar.map(i=>i.number))}`);
  check('Editar aumenta corretamente até a nova quantidade',
    aposEditar.length === 9 && Math.max(...aposEditar.map((i) => i.number)) === 12,
    `${aposEditar.length} parcelas, máx ${Math.max(...aposEditar.map((i) => i.number))}`);

  let reduziuAbaixoDoInicio = false;
  try { await repo.updatePurchase(retro.purchase.id, { installmentsCount: 2 }); reduziuAbaixoDoInicio = true; } catch (_) {}
  check('Não permite reduzir abaixo da parcela inicial retroativa', !reduziuAbaixoDoInicio);

  // Caso "estamos na 1" == igual a uma compra nova normal
  const retroNova = await repo.createRetroactivePurchase({
    name: 'Compra recente', cardId: cardRetro.id, installmentAmount: 5000,
    installmentsCount: 3, currentNumber: 1
  });
  check('Com "estamos na 1", cria todas as parcelas (igual compra nova)',
    retroNova.installments.length === 3);
  check('Primeira parcela cai neste mês quando currentNumber=1',
    retroNova.installments[0].month === hoje);

  /* ---------------------------- Despesas fixas --------------------------- */
  grupo('Despesas fixas (recorrência)');

  const rec = await repo.createRecurring({
    name: 'Internet', amount: 12000, dueDay: 31, startMonth: '2026-08'
  });
  check('Despesa fixa criada', !!rec.id);

  await repo.materializeMonth('2026-09');
  await repo.materializeMonth('2026-09');
  const set09 = (await repo.listExpenses('2026-09')).filter((e) => e.recurringId === rec.id);
  check('Materialização é idempotente', set09.length === 1, `${set09.length} ocorrências`);
  check('Dia 31 vira 30 em setembro', set09[0].date === '2026-09-30', set09[0].date);

  await repo.materializeMonth('2026-11');
  const set11 = (await repo.listExpenses('2026-11')).filter((e) => e.recurringId === rec.id);
  check('Ocorrência criada em novembro', set11.length === 1);

  await repo.setExpenseStatus(set09[0].id, repo.STATUS.PAID);
  await repo.updateRecurring(rec.id, { amount: 15000 }, 'future', '2026-09');
  const set09b = (await repo.listExpenses('2026-09')).find((e) => e.id === set09[0].id);
  const set11b = (await repo.listExpenses('2026-11')).find((e) => e.recurringId === rec.id);
  check('Alteração futura não mexe em ocorrência paga', set09b.amount === 12000, String(set09b.amount));
  check('Alteração futura atualiza meses seguintes', set11b.amount === 15000, String(set11b.amount));

  await repo.updateRecurring(rec.id, { amount: 20000 }, 'occurrence', '2026-11');
  const set11c = (await repo.listExpenses('2026-11')).find((e) => e.recurringId === rec.id);
  check('Alteração de um mês só afeta aquele mês', set11c.amount === 20000);
  const modelo = (await repo.listRecurring()).find((r) => r.id === rec.id);
  check('Modelo permanece com o valor anterior', modelo.amount === 15000, String(modelo.amount));

  await repo.materializeMonth('2026-10');
  await repo.deleteRecurringOccurrence(rec.id, '2026-10');
  const set10 = (await repo.listExpenses('2026-10')).filter((e) => e.recurringId === rec.id);
  check('Exclusão de uma ocorrência remove só o mês', set10.length === 0);
  await repo.materializeMonth('2026-10');
  const set10b = (await repo.listExpenses('2026-10')).filter((e) => e.recurringId === rec.id);
  check('Ocorrência excluída não é recriada', set10b.length === 0);

  const fim = await repo.endRecurring(rec.id, '2026-12');
  check('Encerrar define o mês final anterior', fim.endMonth === '2026-11');
  await repo.materializeMonth('2027-01');
  const set2701 = (await repo.listExpenses('2027-01')).filter((e) => e.recurringId === rec.id);
  check('Após encerrar, não gera meses futuros', set2701.length === 0);
  const historico09 = (await repo.listExpenses('2026-09')).filter((e) => e.recurringId === rec.id);
  check('Histórico passado é preservado ao encerrar', historico09.length === 1);

  /* ---------------------- Despesa fixa no cartão -------------------------- */
  grupo('Despesa fixa vinculada ao cartão de crédito');

  await limparBase();
  const cardNF = await repo.createCard({ name: 'Cartão Assinaturas', limit: 200000, closingDay: 20, dueDay: 5 });
  const netflix = await repo.createRecurring({
    name: 'Netflix', amount: 4490, dueDay: 15, startMonth: '2026-08', cardId: cardNF.id
  });
  check('Despesa fixa aceita cardId', netflix.cardId === cardNF.id);

  const invAgo = await repo.cardInvoice(cardNF.id, '2026-08');
  check('Assinatura aparece na fatura do mês', invAgo.items.length === 1, `${invAgo.items.length} item(ns)`);
  check('Valor da fatura reflete a assinatura', invAgo.total === 4490, String(invAgo.total));
  check('Item da fatura é do tipo "fixed"', invAgo.items[0] && invAgo.items[0].kind === 'fixed');

  const usageNF = await repo.cardUsage(cardNF.id);
  check('Assinatura conta no comprometido do cartão', usageNF.committed === 4490, String(usageNF.committed));

  const dataAgo = await repo.getMonthData('2026-08');
  check('Assinatura entra no total "Cartão" do mês', dataAgo.totals.card === 4490, String(dataAgo.totals.card));
  check('Assinatura NÃO entra no total "Fixas" (evita contar 2x)', dataAgo.totals.fixed === 0, String(dataAgo.totals.fixed));

  // Fatura futura (mês nunca aberto) já projeta a assinatura, sem precisar materializar manualmente
  const invFutura = await repo.cardInvoice(cardNF.id, '2026-11');
  check('Fatura de mês futuro já mostra a assinatura', invFutura.total === 4490, String(invFutura.total));

  // Pagar a fatura inteira marca a assinatura como paga também
  const pagos = await repo.payCardInvoice(cardNF.id, '2026-08');
  check('Pagar fatura inclui a despesa fixa do cartão', pagos === 1, String(pagos));
  const invPaga = await repo.cardInvoice(cardNF.id, '2026-08');
  check('Após pagar, fatura mostra tudo quitado', invPaga.pending === 0 && invPaga.paid === 4490);

  // Editar "deste mês em diante" preserva o mês já pago
  await repo.updateRecurring(netflix.id, { amount: 5490 }, 'future', '2026-09');
  const invSetembro = await repo.cardInvoice(cardNF.id, '2026-09');
  const invAgoDepois = await repo.cardInvoice(cardNF.id, '2026-08');
  check('Edição futura atualiza meses seguintes', invSetembro.total === 5490, String(invSetembro.total));
  check('Edição futura não mexe no mês já pago', invAgoDepois.total === 4490, String(invAgoDepois.total));

  // Excluir o cartão preserva a despesa fixa, só desvincula
  await repo.deleteCard(cardNF.id, 'keep');
  const netflixSemCartao = (await repo.listRecurring()).find((r) => r.id === netflix.id);
  check('Excluir cartão preserva a despesa fixa', !!netflixSemCartao);
  check('Excluir cartão desvincula (cardId vira null)', netflixSemCartao.cardId === null);
  const dataAgoSemCartao = await repo.getMonthData('2026-08');
  check('Sem cartão, valor volta a contar como "Fixas"',
    dataAgoSemCartao.totals.fixed === 4490, String(dataAgoSemCartao.totals.fixed));

  /* -------------------------------- Dívidas ------------------------------ */
  grupo('Dívidas e pagamentos');

  const d1 = await repo.createDebt({ person: 'João', reason: 'Empréstimo', originalAmount: 100000, date: '2026-08-01' });
  await repo.createDebtPayment(d1.id, { amount: 30000, date: '2026-08-15' });
  let sum1 = await repo.debtSummary(d1.id);
  check('Total pago acumula', sum1.paid === 30000);
  check('Valor restante calculado', sum1.remaining === 70000);
  check('Percentual quitado correto', sum1.percent === 30, String(sum1.percent));
  check('Dívida continua aberta', sum1.debt.status === 'open');

  await repo.createDebtPayment(d1.id, { amount: 70000, date: '2026-09-10' });
  sum1 = await repo.debtSummary(d1.id);
  check('Dívida é marcada como quitada', sum1.debt.status === 'paid' && sum1.remaining === 0);

  const pagamentos = await repo.listDebtPayments(d1.id);
  await repo.deleteDebtPayment(pagamentos[0].id);
  sum1 = await repo.debtSummary(d1.id);
  check('Excluir pagamento reabre a dívida', sum1.debt.status === 'open' && sum1.remaining > 0);

  let reduziuDivida = false;
  try { await repo.updateDebt(d1.id, { originalAmount: 1000 }); reduziuDivida = true; } catch (_) {}
  check('Dívida não pode valer menos que o já pago', !reduziuDivida);

  /* --------------------------------- Metas ------------------------------- */
  grupo('Metas');

  const g1 = await repo.createGoal({ name: 'Reserva', targetAmount: 500000, currentAmount: 100000 });
  await repo.addToGoal(g1.id, 150000);
  const g1r = (await repo.listGoals()).find((g) => g.id === g1.id);
  check('Contribuição soma ao valor guardado', g1r.currentAmount === 250000);
  check('Progresso da meta = 50%', core.pct(g1r.currentAmount, g1r.targetAmount) === 50);
  await repo.addToGoal(g1.id, -1000000);
  const g1z = (await repo.listGoals()).find((g) => g.id === g1.id);
  check('Retirada nunca deixa a meta negativa', g1z.currentAmount === 0);

  /* ---------------------------- Cálculos do mês -------------------------- */
  grupo('Cálculos do mês');

  await limparBase();
  await repo.createIncome({ name: 'Pró-labore', amount: 800000, date: '2026-08-05' });
  await repo.createExpense({ name: 'Gasolina', amount: 25000, date: '2026-08-06', paymentMethod: 'debit' });
  await repo.createExpense({ name: 'Conta pendente', amount: 10000, date: '2026-08-20', status: 'pending' });
  const cardX = await repo.createCard({ name: 'Cartão X', limit: 500000, closingDay: 20, dueDay: 5 });
  await repo.createPurchase({
    cardId: cardX.id, name: 'TV', totalAmount: 60000, installmentsCount: 2,
    purchaseDate: '2026-08-02', firstMonth: '2026-08'
  });

  const md = await repo.getMonthData('2026-08');
  check('Renda do mês somada', md.totals.income === 800000, String(md.totals.income));
  check('Variáveis somadas', md.totals.variable === 35000, String(md.totals.variable));
  check('Cartão do mês somado', md.totals.card === 30000, String(md.totals.card));
  check('Gastos totais do mês', md.totals.spent === 65000, String(md.totals.spent));
  check('Disponível = renda − já pago', md.totals.available === 800000 - 25000, String(md.totals.available));
  check('Saldo projetado = renda − gastos do mês', md.totals.projected === 800000 - 65000);
  check('Pendências somadas', md.totals.pending === 40000, String(md.totals.pending));

  const fut = await repo.futureCommitted('2026-08', 12);
  check('Parcela futura entra no comprometido', fut.installments === 30000, String(fut.installments));
  check('Próximo mês reflete a 2ª parcela', fut.nextMonth === 30000, String(fut.nextMonth));

  const bd = await repo.categoryBreakdown('2026-08');
  check('Gastos por categoria somam o total', bd.total === 65000, String(bd.total));

  const busca = await repo.search({ month: '2026-08', text: 'gasol' });
  check('Busca por nome encontra a despesa', busca.length === 1 && busca[0].name === 'Gasolina');
  const filtrado = await repo.search({ month: '2026-08', statuses: ['pending'], types: ['expense'] });
  check('Filtro por situação funciona', filtrado.length === 1 && filtrado[0].name === 'Conta pendente');

  /* --------------------------- Backup e restauração ---------------------- */
  grupo('Backup, validação e restauração');

  const bk = await backup.buildBackup();
  check('Backup possui versão de formato', bk.backupVersion === core.BACKUP_VERSION);
  check('Backup possui data de criação', typeof bk.createdAt === 'string' && !isNaN(Date.parse(bk.createdAt)));
  check('Backup possui versão do aplicativo', bk.appVersion === core.APP_VERSION);
  check('Backup contém todas as seções',
    db.DATA_STORES.every((s) => Array.isArray(bk.data[s])));
  check('Backup contém as despesas', bk.data.expenses.length === 2, String(bk.data.expenses.length));
  check('Backup contém as parcelas', bk.data.installments.length === 2);

  const v1 = backup.validateBackup(bk);
  check('Backup válido é aceito', v1.ok, (v1.errors || []).join(' | '));
  check('Resumo traz a contagem correta', v1.summary.expenses === 2);

  check('Arquivo aleatório é recusado', backup.validateBackup({ foo: 1 }).ok === false);
  check('Texto puro é recusado', backup.validateBackup('não sou um backup').ok === false);
  check('Backup sem versão é recusado', backup.validateBackup({ data: { expenses: [] } }).ok === false);
  check('Formato mais novo é recusado',
    backup.validateBackup({ backupVersion: 99, data: {} }).ok === false);

  const corrompido = core.clone(bk);
  corrompido.data.expenses[0].amount = 'muito dinheiro';
  check('Valor não numérico é detectado', backup.validateBackup(corrompido).ok === false);

  const semData = core.clone(bk);
  semData.data.expenses[0].date = '2026-13-45';
  check('Data inválida é detectada', backup.validateBackup(semData).ok === false);

  const orfao = core.clone(bk);
  orfao.data.creditPurchases = [];
  check('Parcela órfã é detectada', backup.validateBackup(orfao).ok === false);

  const idRepetido = core.clone(bk);
  idRepetido.data.expenses.push(core.clone(idRepetido.data.expenses[0]));
  check('ID repetido é detectado', backup.validateBackup(idRepetido).ok === false);

  const parcelaDupla = core.clone(bk);
  const dup = core.clone(parcelaDupla.data.installments[0]);
  dup.id = 'inst_falso';
  parcelaDupla.data.installments.push(dup);
  check('Parcela duplicada é detectada', backup.validateBackup(parcelaDupla).ok === false);

  // Restauração inválida não altera nada
  const antes = await repo.totalRecords();
  let restaurouInvalido = false;
  try { await backup.restoreBackup(backup.validateBackup({ lixo: true })); restaurouInvalido = true; } catch (_) {}
  const depois = await repo.totalRecords();
  check('Restauração inválida é bloqueada', !restaurouInvalido);
  check('Dados atuais permanecem após backup inválido', antes.total === depois.total,
    `${antes.total} → ${depois.total}`);

  // Restauração válida
  await repo.createExpense({ name: 'Lançamento extra', amount: 999, date: '2026-08-25' });
  const comExtra = await repo.totalRecords();
  check('Registro extra foi criado', comExtra.total === antes.total + 1);

  const rest = await backup.restoreBackup(v1);
  const restaurado = await repo.totalRecords();
  check('Restauração retorna quantidade escrita', rest.written > 0);
  check('Estado volta exatamente ao do backup', restaurado.total === antes.total,
    `${restaurado.total} vs ${antes.total}`);
  const semExtra = (await repo.listExpenses('2026-08')).find((e) => e.name === 'Lançamento extra');
  check('Registro posterior ao backup foi substituído', !semExtra);
  const parcelasRest = await repo.listInstallments('2026-08');
  check('Parcelas foram restauradas', parcelasRest.length === 1);
  const somaRest = (await repo.getMonthData('2026-08')).totals;
  check('Cálculos batem após restaurar', somaRest.spent === 65000, String(somaRest.spent));

  // Snapshot automático antes da restauração
  const snaps = await db.listSnapshots();
  check('Cópia interna criada antes de restaurar',
    snaps.some((s) => s.reason === 'antes-da-restauracao'));

  /* ------------------------------- Segurança ----------------------------- */
  grupo('Segurança');

  const security = await import('./security.js');
  check('WebCrypto disponível', security.isSupported());

  await security.setPin('4821');
  const secRec = await repo.getRawSetting('security');
  check('PIN não é armazenado em texto puro',
    JSON.stringify(secRec).includes('4821') === false, 'PIN encontrado no registro');
  check('Guarda salt aleatório', typeof secRec.salt === 'string' && secRec.salt.length > 10);
  check('Guarda hash derivado', typeof secRec.hashValue === 'string' && secRec.hashValue.length > 20);
  check('Usa PBKDF2 com muitas iterações',
    secRec.algorithm === 'PBKDF2' && secRec.iterations >= 100000, String(secRec.iterations));
  check('PIN correto é aceito', (await security.verifyPin('4821')) === true);
  check('PIN incorreto é recusado', (await security.verifyPin('1111')) === false);
  await security.disableLock('4821');
  check('Bloqueio pode ser removido com o PIN', (await security.isLockEnabled()) === false);

  const logs = await db.readLogs(200);
  const logTexto = JSON.stringify(logs);
  check('Logs não contêm o PIN', !logTexto.includes('4821'));
  check('Logs não contêm nomes de lançamentos', !logTexto.includes('Gasolina'));

  /* ------------------------------ Desempenho ----------------------------- */
  grupo('Desempenho e volume');

  await limparBase();
  const tIns = performance.now();
  const lote = [];
  for (let i = 0; i < 500; i++) {
    lote.push({
      id: core.uid('exp'), name: `Despesa ${i}`, amount: 1000 + i,
      date: core.dateInMonth('2026-07', (i % 28) + 1), month: '2026-07',
      categoryId: null, paymentMethod: 'pix', kind: 'variable', status: 'paid',
      note: '', recurringId: null, dedupeKey: `x${i}`,
      createdAt: Date.now(), updatedAt: Date.now(), deletedAt: null
    });
  }
  await db.putMany('expenses', lote);
  const insMs = Math.round(performance.now() - tIns);
  check(`500 despesas gravadas (${insMs}ms)`, insMs < 4000, `${insMs}ms`);

  const tRead = performance.now();
  const mes07 = await repo.getMonthData('2026-07');
  const readMs = Math.round(performance.now() - tRead);
  check(`Mês com 500 despesas calculado em ${readMs}ms`, readMs < 1500, `${readMs}ms`);
  check('Soma de 500 despesas correta',
    mes07.totals.variable === lote.reduce((a, b) => a + b.amount, 0),
    String(mes07.totals.variable));

  const tBk = performance.now();
  const bigBackup = await backup.buildBackup();
  const bkMs = Math.round(performance.now() - tBk);
  check(`Backup de 500+ registros em ${bkMs}ms`, bkMs < 3000, `${bkMs}ms`);
  check('Backup grande continua válido', backup.validateBackup(bigBackup).ok);

  /* ------------------------- Cenários de recuperação --------------------- */
  grupo('Cenários de recuperação');

  // Cenário 1 — usuário tem centenas de lançamentos e fecha o aplicativo
  const antesFechar = (await repo.totalRecords()).total;
  db.closeDB();
  await db.openDB();
  const depoisAbrir = (await repo.totalRecords()).total;
  check('Cenário 1 — dados permanecem após fechar e reabrir',
    antesFechar === depoisAbrir && depoisAbrir > 500, `${antesFechar} → ${depoisAbrir}`);

  // Cenário 2 — atualização do aplicativo (reabrir na mesma versão de banco)
  const schema2 = await db.validateSchema();
  check('Cenário 2 — estrutura íntegra após reabertura', schema2.ok);
  check('Cenário 2 — versão do banco preservada', schema2.version === db.DB_VERSION);

  // Cenário 4 — restauração interrompida por erro no meio
  const bkBom = await backup.buildBackup();
  const vBom = backup.validateBackup(bkBom);
  const estadoAntes = (await repo.totalRecords()).total;
  const envenenado = {
    ok: true,
    data: {
      ...core.clone(vBom.data),
      // Função não é clonável pelo IndexedDB: quebra no meio da transação.
      goals: [{ id: 'goal_quebrado', name: 'x', targetAmount: 1, currentAmount: 0, quebra: () => {} }]
    }
  };
  let restauracaoQuebrou = false;
  try { await backup.restoreBackup(envenenado); } catch (_) { restauracaoQuebrou = true; }
  const estadoDepois = (await repo.totalRecords()).total;
  check('Cenário 4 — restauração com erro é abortada', restauracaoQuebrou);
  check('Cenário 4 — dados anteriores permanecem intactos',
    estadoAntes === estadoDepois, `${estadoAntes} → ${estadoDepois}`);
  const despesasIntactas = await repo.listExpenses('2026-07');
  check('Cenário 4 — lançamentos continuam consultáveis', despesasIntactas.length === 500,
    String(despesasIntactas.length));

  // Cenário 6 — usuário altera a data do aparelho
  await limparBase();
  const passado = await repo.createExpense({ name: 'Compra antiga', amount: 5000, date: '2025-03-14' });
  check('Cenário 6 — mês vem da data informada, não do relógio', passado.month === '2025-03');
  const marco25 = await repo.listExpenses('2025-03');
  const hojeMes = await repo.listExpenses(core.currentMonth());
  check('Cenário 6 — aparece só no mês da própria data', marco25.length === 1);
  check('Cenário 6 — não vaza para o mês atual',
    !hojeMes.some((e) => e.id === passado.id));
  const dadosMarco = await repo.getMonthData('2025-03');
  check('Cenário 6 — cálculos do mês passado continuam corretos',
    dadosMarco.totals.variable === 5000, String(dadosMarco.totals.variable));
  check('Cenário 6 — data armazenada não muda ao reler',
    (await repo.listExpenses('2025-03'))[0].date === '2025-03-14');

  /* -------------------------------- Fim ---------------------------------- */
  await limparBase();
  await db.clearLogs();

  const total = pass + fail;
  const ms = Math.round(performance.now() - t0);
  summary.innerHTML = '';
  const pill = document.createElement('span');
  pill.className = `pill ${fail === 0 ? 'pass' : 'fail'}`;
  pill.textContent = fail === 0
    ? `${pass}/${total} testes passaram · ${ms}ms`
    : `${fail} falha(s) de ${total} testes · ${ms}ms`;
  summary.append(pill);
  window.__TEST_RESULT__ = { pass, fail, total, ms };
}

run().catch((err) => {
  summary.innerHTML = '';
  const pill = document.createElement('span');
  pill.className = 'pill fail';
  pill.textContent = `Erro na execução: ${err && err.message}`;
  summary.append(pill);
  window.__TEST_RESULT__ = { pass, fail: fail + 1, total: pass + fail + 1, error: String(err && err.message) };
  console.error(err);
});
