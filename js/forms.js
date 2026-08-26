/* ==========================================================================
   forms.js — construtor de formulários em bottom sheet + formulários do app.
   Todo valor monetário circula em CENTAVOS.
   ========================================================================== */

import {
  money, digitsToCents, todayISO, currentMonth, monthLabel, addMonths,
  splitAmount, dateInMonth, dayOf, monthOf, logError
} from './core.js';

import { el, sheet, toastOk, toastErr, confirm, choose, once, emit } from './ui.js';
import * as repo from './repo.js';
import { ValidationError, DuplicateError } from './repo.js';

/* ============================ Máscara de dinheiro ======================== */

export function moneyInput({ value = 0, autofocus = false, id = null } = {}) {
  const input = el('input.input.input-money', {
    type: 'text', inputmode: 'numeric', autocomplete: 'off',
    'aria-label': 'Valor em reais', id: id || undefined
  });
  let cents = Math.max(0, Number(value) || 0);
  const render = () => { input.value = money(cents); input.dataset.cents = String(cents); };
  render();

  const caretToEnd = () => {
    requestAnimationFrame(() => {
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
    });
  };

  input.addEventListener('input', () => {
    cents = digitsToCents(input.value);
    render(); caretToEnd();
  });
  input.addEventListener('focus', caretToEnd);
  input.addEventListener('click', caretToEnd);
  input.getCents = () => cents;
  input.setCents = (v) => { cents = Math.max(0, Number(v) || 0); render(); };
  if (autofocus) setTimeout(() => input.focus(), 300);
  return input;
}

/* ============================ Construtor genérico ======================== */

/**
 * Campos suportados:
 *  text | money | date | month | number | day | select | textarea | segment | custom
 */
export function buildForm(fields, initial = {}) {
  const form = el('form', { novalidate: true });
  const controls = new Map();
  // Criado vazio antes do laço: campos "custom" e callbacks recebem esta
  // referência enquanto os controles ainda estão sendo construídos.
  const api = {};

  for (const f of fields) {
    if (!f) continue;
    const value = initial[f.name] !== undefined ? initial[f.name] : f.value;
    const wrap = el('label.field', { for: `f_${f.name}` });
    if (f.label) wrap.append(el('span.field-label', { text: f.label + (f.required ? ' *' : '') }));

    let control;
    switch (f.type) {
      case 'money':
        control = moneyInput({ value: value || 0, autofocus: f.autofocus });
        break;
      case 'textarea':
        control = el('textarea.textarea', {
          rows: f.rows || 3, placeholder: f.placeholder || '', maxlength: f.maxlength || 240
        });
        control.value = value || '';
        break;
      case 'select': {
        control = el('select.select');
        const opts = typeof f.options === 'function' ? f.options() : (f.options || []);
        for (const o of opts) {
          control.append(el('option', { value: o.value, text: o.label, selected: String(o.value) === String(value ?? '') }));
        }
        if (value === undefined || value === null || value === '') control.value = '';
        break;
      }
      case 'segment': {
        control = el('div.segment', { role: 'tablist' });
        const opts = typeof f.options === 'function' ? f.options() : (f.options || []);
        let current = value ?? (opts[0] && opts[0].value);
        const paint = () => {
          [...control.children].forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(current))));
        };
        for (const o of opts) {
          control.append(el('button', {
            type: 'button', role: 'tab', dataset: { value: String(o.value) }, text: o.label,
            onclick: () => {
              current = o.value; paint();
              if (f.onChange) f.onChange(current, api);
            }
          }));
        }
        paint();
        control.getValue = () => current;
        control.setValue = (v) => { current = v; paint(); };
        break;
      }
      case 'day':
        control = el('input.input', {
          type: 'number', min: '1', max: '31', step: '1', inputmode: 'numeric',
          placeholder: f.placeholder || 'Dia'
        });
        control.value = value ?? '';
        break;
      case 'number':
        control = el('input.input', {
          type: 'number', min: f.min ?? '', max: f.max ?? '', step: f.step || '1',
          inputmode: 'numeric', placeholder: f.placeholder || ''
        });
        control.value = value ?? '';
        break;
      case 'date':
        control = el('input.input', { type: 'date' });
        control.value = value || todayISO();
        break;
      case 'month':
        control = el('input.input', { type: 'month' });
        control.value = value || currentMonth();
        break;
      case 'custom':
        control = f.render(initial, api);
        break;
      default:
        control = el('input.input', {
          type: 'text', placeholder: f.placeholder || '',
          maxlength: f.maxlength || 80,
          autocomplete: f.autocomplete || 'off',
          autocapitalize: 'sentences'
        });
        control.value = value ?? '';
    }

    control.id = `f_${f.name}`;
    if (f.autofocus && f.type !== 'money') setTimeout(() => control.focus(), 300);
    if (f.onInput) control.addEventListener('input', () => f.onInput(readOne(f, control), api));
    if (f.type === 'select' && f.onChange) control.addEventListener('change', () => f.onChange(control.value, api));

    wrap.append(control);
    const hint = f.hint ? el('span.field-hint', { text: f.hint }) : null;
    if (hint) wrap.append(hint);
    const errNode = el('span.field-error', { style: { display: 'none' } });
    wrap.append(errNode);

    controls.set(f.name, { field: f, control, wrap, errNode, hint });
    form.append(wrap);
    if (f.after) form.append(f.after);
  }

  function readOne(f, control) {
    if (f.type === 'money') return control.getCents();
    if (f.type === 'segment') return control.getValue();
    if (f.type === 'number' || f.type === 'day') {
      const v = control.value === '' ? null : Number(control.value);
      return Number.isFinite(v) ? v : null;
    }
    if (f.type === 'custom') return f.read ? f.read(control) : null;
    return control.value;
  }

  Object.assign(api, {
    form,
    controls,
    values() {
      const out = {};
      for (const [name, c] of controls) out[name] = readOne(c.field, c.control);
      return out;
    },
    get(name) {
      const c = controls.get(name);
      return c ? readOne(c.field, c.control) : undefined;
    },
    set(name, value) {
      const c = controls.get(name);
      if (!c) return;
      if (c.field.type === 'money') c.control.setCents(value);
      else if (c.field.type === 'segment') c.control.setValue(value);
      else c.control.value = value ?? '';
    },
    setHint(name, text) {
      const c = controls.get(name);
      if (!c) return;
      if (!c.hint) {
        const h = el('span.field-hint', { text });
        c.wrap.insertBefore(h, c.errNode);
        c.hint = h;
      } else c.hint.textContent = text;
    },
    setError(name, message) {
      const c = controls.get(name);
      if (!c) return;
      c.wrap.classList.toggle('invalid', !!message);
      c.errNode.textContent = message || '';
      c.errNode.style.display = message ? '' : 'none';
      if (message) c.control.focus();
    },
    clearErrors() {
      for (const [, c] of controls) {
        c.wrap.classList.remove('invalid');
        c.errNode.textContent = '';
        c.errNode.style.display = 'none';
      }
    },
    element(name) { const c = controls.get(name); return c ? c.control : null; },
    wrapper(name) { const c = controls.get(name); return c ? c.wrap : null; }
  });

  return api;
}

/**
 * Abre um formulário em bottom sheet.
 * onSubmit(values, { api, form, force }) — pode lançar ValidationError.
 * DuplicateError é tratado automaticamente com confirmação do usuário.
 */
export function openForm({
  title, fields, initial = {}, submitLabel = 'Salvar',
  onSubmit, onDelete, deleteLabel = 'Excluir', extra = null, onReady = null, onClose = null
}) {
  const formApi = buildForm(fields, initial);

  const s = sheet({
    title,
    onClose,
    body: () => {
      const wrap = el('div');
      wrap.append(formApi.form);
      if (extra) wrap.append(typeof extra === 'function' ? extra(formApi) : extra);
      if (onDelete) {
        wrap.append(el('button.btn.btn-danger.btn-block.mt-2', {
          type: 'button', text: deleteLabel,
          onclick: once(async () => {
            const done = await onDelete();
            if (done !== false) { emit('data:changed'); s.close('deleted'); }
          })
        }));
      }
      return wrap;
    },
    footer: (api) => el('div', { style: { display: 'flex', gap: '12px', width: '100%' } }, [
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancelar', onclick: () => api.close(null) }),
      el('button.btn.btn-primary', { type: 'submit', text: submitLabel, onclick: (e) => { e.preventDefault(); submit(api); } })
    ])
  });

  formApi.form.addEventListener('submit', (e) => { e.preventDefault(); submit(s); });

  const submit = once(async (api, force = false) => {
    formApi.clearErrors();
    api.setBusy(true);
    try {
      const values = formApi.values();
      const result = await onSubmit(values, { form: formApi, force, sheet: api });
      if (result !== false) emit('data:changed');
      api.close(result === undefined ? true : result);
    } catch (err) {
      api.setBusy(false);
      if (err instanceof DuplicateError) {
        const ok = await confirm({
          title: 'Registro parecido encontrado',
          text: 'Um lançamento idêntico foi criado há poucos instantes. Deseja adicionar mesmo assim?',
          okLabel: 'Adicionar mesmo assim',
          cancelLabel: 'Não adicionar'
        });
        if (ok) return submit(api, true);
        return;
      }
      if (err instanceof ValidationError) {
        if (err.field) formApi.setError(err.field, err.message);
        toastErr(err.message);
        return;
      }
      logError('form.submit', err);
      toastErr(err && err.message ? err.message : 'Não foi possível salvar.');
    }
  });

  if (onReady) onReady(formApi, s);
  return { sheet: s, form: formApi };
}

/* =========================== Opções reutilizáveis ======================== */

async function categoryOptions(kind) {
  const cats = await repo.listCategories(kind);
  return [{ value: '', label: 'Sem categoria' },
    ...cats.map((c) => ({ value: c.id, label: `${c.icon}  ${c.name}` }))];
}

async function cardOptions() {
  const cards = await repo.listCards();
  return cards.map((c) => ({ value: c.id, label: c.name }));
}

function monthOptions(center, back = 6, forward = 18) {
  const out = [];
  for (let i = -back; i <= forward; i++) {
    const m = addMonths(center, i);
    out.push({ value: m, label: monthLabel(m) });
  }
  return out;
}

/* ============================ Despesa variável =========================== */

export async function expenseForm(existing = null, defaults = {}) {
  const cats = await categoryOptions('expense');
  const isEdit = !!existing;

  return openForm({
    title: isEdit ? 'Editar despesa' : 'Nova despesa',
    submitLabel: isEdit ? 'Salvar alterações' : 'Adicionar despesa',
    initial: existing ? {
      name: existing.name, amount: existing.amount, date: existing.date,
      categoryId: existing.categoryId || '', paymentMethod: existing.paymentMethod || 'pix',
      status: existing.status, note: existing.note || ''
    } : {
      date: defaults.date || todayISO(),
      paymentMethod: 'pix', status: 'paid', categoryId: defaults.categoryId || ''
    },
    fields: [
      { name: 'amount', type: 'money', label: 'Valor', required: true, autofocus: !isEdit },
      { name: 'name', type: 'text', label: 'Descrição', required: true, placeholder: 'Ex.: Mercado, gasolina…' },
      { name: 'date', type: 'date', label: 'Data', required: true },
      { name: 'categoryId', type: 'select', label: 'Categoria', options: cats },
      {
        name: 'paymentMethod', type: 'select', label: 'Forma de pagamento',
        options: repo.PAYMENT_METHODS.map((p) => ({ value: p.value, label: p.label }))
      },
      {
        name: 'status', type: 'segment', label: 'Situação',
        options: [{ value: 'paid', label: 'Paga' }, { value: 'pending', label: 'Pendente' }]
      },
      { name: 'note', type: 'textarea', label: 'Observação', placeholder: 'Opcional' }
    ],
    onSubmit: async (v, { force }) => {
      const payload = {
        name: v.name, amount: v.amount, date: v.date,
        categoryId: v.categoryId || null, paymentMethod: v.paymentMethod,
        status: v.status, note: v.note
      };
      if (isEdit) { await repo.updateExpense(existing.id, payload); toastOk('Despesa atualizada'); }
      else { await repo.createExpense(payload, { force }); toastOk('Despesa adicionada'); }
      return true;
    },
    onDelete: isEdit ? async () => {
      const ok = await confirm({
        title: 'Excluir despesa',
        text: `"${existing.name}" será removida do mês. Você poderá recuperá-la na lixeira.`,
        okLabel: 'Excluir', danger: true
      });
      if (!ok) return false;
      await repo.deleteExpense(existing.id);
      toastOk('Despesa excluída');
      return true;
    } : null
  });
}

/* ================================ Receita ================================ */

export async function incomeForm(existing = null, defaults = {}) {
  const cats = await categoryOptions('income');
  const isEdit = !!existing;

  return openForm({
    title: isEdit ? 'Editar receita' : 'Nova receita',
    submitLabel: isEdit ? 'Salvar alterações' : 'Adicionar receita',
    initial: existing ? {
      name: existing.name, amount: existing.amount, date: existing.date,
      categoryId: existing.categoryId || '', note: existing.note || ''
    } : { date: defaults.date || todayISO(), categoryId: '' },
    fields: [
      { name: 'amount', type: 'money', label: 'Valor', required: true, autofocus: !isEdit },
      { name: 'name', type: 'text', label: 'Descrição', required: true, placeholder: 'Ex.: Pró-labore de agosto' },
      { name: 'date', type: 'date', label: 'Data', required: true },
      { name: 'categoryId', type: 'select', label: 'Categoria', options: cats },
      { name: 'note', type: 'textarea', label: 'Observação', placeholder: 'Opcional' }
    ],
    onSubmit: async (v, { force }) => {
      const payload = { name: v.name, amount: v.amount, date: v.date, categoryId: v.categoryId || null, note: v.note };
      if (isEdit) { await repo.updateIncome(existing.id, payload); toastOk('Receita atualizada'); }
      else { await repo.createIncome(payload, { force }); toastOk('Receita adicionada'); }
      return true;
    },
    onDelete: isEdit ? async () => {
      const ok = await confirm({
        title: 'Excluir receita', text: `"${existing.name}" será removida.`,
        okLabel: 'Excluir', danger: true
      });
      if (!ok) return false;
      await repo.deleteIncome(existing.id);
      toastOk('Receita excluída');
      return true;
    } : null
  });
}

/* ============================= Despesa fixa ============================== */

export async function recurringForm(existing = null, month = currentMonth()) {
  const cats = await categoryOptions('expense');
  const cards = await cardOptions();
  const cardSelectOptions = [{ value: '', label: 'Nenhum (não é no cartão)' }, ...cards];
  const isEdit = !!existing;

  return openForm({
    title: isEdit ? 'Editar despesa fixa' : 'Nova despesa fixa',
    submitLabel: isEdit ? 'Salvar' : 'Criar despesa fixa',
    initial: existing ? {
      name: existing.name, amount: existing.amount, dueDay: existing.dueDay,
      categoryId: existing.categoryId || '', cardId: existing.cardId || '',
      note: existing.note || '', startMonth: existing.startMonth
    } : { dueDay: 5, startMonth: month, categoryId: '', cardId: '' },
    fields: [
      { name: 'amount', type: 'money', label: 'Valor mensal', required: true, autofocus: !isEdit },
      { name: 'name', type: 'text', label: 'Nome', required: true, placeholder: 'Ex.: Internet, academia, Netflix' },
      { name: 'dueDay', type: 'day', label: 'Dia do vencimento', required: true, hint: 'Se o mês não tiver esse dia, usamos o último dia disponível.' },
      { name: 'categoryId', type: 'select', label: 'Categoria', options: cats },
      cards.length ? {
        name: 'cardId', type: 'select', label: 'Cobrada em qual cartão?', options: cardSelectOptions,
        hint: 'Se marcar um cartão, o valor entra na fatura e no limite dele automaticamente, todo mês.'
      } : null,
      !isEdit ? { name: 'startMonth', type: 'month', label: 'A partir de', required: true } : null,
      { name: 'note', type: 'textarea', label: 'Observação', placeholder: 'Opcional' }
    ].filter(Boolean),
    onSubmit: async (v, { force }) => {
      if (!isEdit) {
        await repo.createRecurring({
          name: v.name, amount: v.amount, dueDay: v.dueDay,
          categoryId: v.categoryId || null, cardId: v.cardId || null,
          note: v.note, startMonth: v.startMonth
        }, { force });
        toastOk('Despesa fixa criada');
        return true;
      }
      // Edição: perguntar o alcance
      const scope = await choose({
        title: 'Aplicar alteração em…',
        text: 'Escolha o que deve mudar. O histórico já pago nunca é alterado.',
        choices: [
          { value: 'occurrence', label: `Somente ${monthLabel(month)}`, description: 'Altera apenas a ocorrência deste mês.' },
          { value: 'future', label: 'Deste mês em diante', description: 'Atualiza o modelo e as próximas ocorrências ainda não pagas.' }
        ]
      });
      if (!scope) return false;
      await repo.updateRecurring(existing.id, {
        name: v.name, amount: v.amount, dueDay: v.dueDay,
        categoryId: v.categoryId || null, cardId: v.cardId || null, note: v.note
      }, scope, month);
      toastOk(scope === 'occurrence' ? 'Alterado somente neste mês' : 'Alterado deste mês em diante');
      return true;
    },
    onDelete: isEdit ? async () => {
      const stats = await repo.recurringStats(existing.id);
      const action = await choose({
        title: 'Excluir despesa fixa',
        text: `Esta despesa possui ${stats.total} ocorrência(s), ${stats.paid} já paga(s).`,
        choices: [
          { value: 'occurrence', label: `Somente ${monthLabel(month)}`, description: 'Remove apenas a ocorrência deste mês.' },
          { value: 'end', label: 'Encerrar recorrência', description: 'Mantém o histórico passado e não gera meses futuros.' },
          { value: 'all', label: 'Excluir tudo', description: 'Remove o modelo e todas as ocorrências, inclusive o histórico.', danger: true }
        ]
      });
      if (!action) return false;

      if (action === 'occurrence') {
        await repo.deleteRecurringOccurrence(existing.id, month);
        toastOk('Ocorrência removida deste mês');
        return true;
      }
      if (action === 'end') {
        const r = await repo.endRecurring(existing.id, month);
        toastOk(`Recorrência encerrada em ${monthLabel(r.endMonth)}`);
        return true;
      }
      const sure = await confirm({
        title: 'Excluir todo o histórico?',
        text: `${stats.total} lançamento(s) desta despesa fixa serão removidos, incluindo ${stats.paid} já pago(s). Você poderá recuperá-los na lixeira.`,
        okLabel: 'Excluir tudo', danger: true
      });
      if (!sure) return false;
      await repo.deleteRecurringAll(existing.id);
      toastOk('Despesa fixa excluída');
      return true;
    } : null
  });
}

/* ================================ Cartão ================================= */

export async function cardForm(existing = null) {
  const isEdit = !!existing;
  return openForm({
    title: isEdit ? 'Editar cartão' : 'Novo cartão',
    submitLabel: isEdit ? 'Salvar' : 'Adicionar cartão',
    initial: existing ? {
      name: existing.name, institution: existing.institution, limit: existing.limit,
      closingDay: existing.closingDay, dueDay: existing.dueDay
    } : { closingDay: 1, dueDay: 10, limit: 0 },
    fields: [
      { name: 'name', type: 'text', label: 'Nome do cartão', required: true, placeholder: 'Ex.: Nubank', autofocus: !isEdit },
      { name: 'institution', type: 'text', label: 'Instituição', placeholder: 'Opcional' },
      { name: 'limit', type: 'money', label: 'Limite' },
      { name: 'closingDay', type: 'day', label: 'Dia de fechamento', required: true },
      { name: 'dueDay', type: 'day', label: 'Dia de vencimento', required: true }
    ],
    onSubmit: async (v) => {
      const payload = {
        name: v.name, institution: v.institution, limit: v.limit,
        closingDay: v.closingDay, dueDay: v.dueDay
      };
      if (isEdit) { await repo.updateCard(existing.id, payload); toastOk('Cartão atualizado'); }
      else { await repo.createCard(payload); toastOk('Cartão adicionado'); }
      return true;
    },
    onDelete: isEdit ? async () => {
      const usage = await repo.cardUsage(existing.id);
      const action = await choose({
        title: 'Excluir cartão',
        text: usage.purchases
          ? `Este cartão possui ${usage.purchases} compra(s) e ${usage.openInstallments} parcela(s) em aberto.`
          : 'Este cartão não possui compras registradas.',
        choices: [
          { value: 'with-purchases', label: 'Excluir cartão e compras em aberto', description: 'Parcelas já pagas são preservadas no histórico.', danger: true },
          { value: 'keep', label: 'Excluir somente o cartão', description: 'Compras e parcelas continuam registradas.' }
        ]
      });
      if (!action) return false;
      await repo.deleteCard(existing.id, action);
      toastOk('Cartão excluído');
      return true;
    } : null
  });
}

/* ========================== Compra parcelada ============================= */

export async function purchaseForm(existing = null, defaults = {}) {
  const cards = await cardOptions();
  if (!cards.length) {
    toastErr('Cadastre um cartão antes de lançar uma compra.');
    return null;
  }
  const cats = await categoryOptions('expense');
  const isEdit = !!existing;
  const cardList = await repo.listCards();

  const preview = el('div.card.mt-2', { style: { background: 'var(--card-2)', border: 'none' } });

  const initial = existing ? {
    cardId: existing.cardId, name: existing.name, totalAmount: existing.totalAmount,
    installmentsCount: existing.installmentsCount, purchaseDate: existing.purchaseDate,
    firstMonth: existing.firstMonth, categoryId: existing.categoryId || '', note: existing.note || ''
  } : {
    cardId: defaults.cardId || cards[0].value,
    purchaseDate: todayISO(),
    installmentsCount: 1,
    firstMonth: '',
    categoryId: ''
  };

  let formRef = null;

  const updatePreview = () => {
    if (!formRef) return;
    const v = formRef.values();
    const n = Math.max(1, Math.min(72, Number(v.installmentsCount) || 1));
    const parts = splitAmount(v.totalAmount || 0, n);
    const first = v.firstMonth || currentMonth();
    preview.replaceChildren();
    if (!v.totalAmount) {
      preview.append(el('div.small.muted', { text: 'Informe o valor para ver as parcelas.' }));
      return;
    }
    preview.append(el('div.section-title', { text: `${n}x — soma ${money(parts.reduce((a, b) => a + b, 0))}` }));
    const list = el('div.mt-2');
    const show = Math.min(n, 4);
    for (let i = 0; i < show; i++) {
      list.append(el('div.summary-line', {}, [
        el('span.k', { text: `${monthLabel(addMonths(first, i))} — ${i + 1}/${n}` }),
        el('span.v', { text: money(parts[i]) })
      ]));
    }
    if (n > show) {
      list.append(el('div.summary-line', {}, [
        el('span.k', { text: `… até ${monthLabel(addMonths(first, n - 1))}` }),
        el('span.v', { text: money(parts[n - 1]) })
      ]));
    }
    preview.append(list);
  };

  const syncFirstMonth = () => {
    if (!formRef || isEdit) return;
    const v = formRef.values();
    const card = cardList.find((c) => c.id === v.cardId);
    if (card && v.purchaseDate) {
      formRef.set('firstMonth', repo.suggestFirstMonth(card, v.purchaseDate));
    }
    updatePreview();
  };

  const result = openForm({
    title: isEdit ? 'Editar compra' : 'Nova compra no cartão',
    submitLabel: isEdit ? 'Salvar alterações' : 'Lançar compra',
    initial,
    fields: [
      { name: 'totalAmount', type: 'money', label: 'Valor total da compra', required: true, autofocus: !isEdit, onInput: updatePreview },
      { name: 'name', type: 'text', label: 'Descrição', required: true, placeholder: 'Ex.: Notebook' },
      { name: 'cardId', type: 'select', label: 'Cartão', required: true, options: cards, onChange: syncFirstMonth },
      { name: 'installmentsCount', type: 'number', label: 'Parcelas', required: true, min: 1, max: 72, onInput: updatePreview },
      { name: 'purchaseDate', type: 'date', label: 'Data da compra', required: true, onInput: syncFirstMonth },
      {
        name: 'firstMonth', type: 'month', label: 'Mês da 1ª parcela', required: true,
        hint: 'Sugerido pelo fechamento do cartão. Você pode alterar.', onInput: updatePreview
      },
      { name: 'categoryId', type: 'select', label: 'Categoria', options: cats },
      { name: 'note', type: 'textarea', label: 'Observação', placeholder: 'Opcional' }
    ],
    extra: preview,
    onReady: (api) => {
      formRef = api;
      if (!isEdit && !api.get('firstMonth')) syncFirstMonth();
      updatePreview();
    },
    onSubmit: async (v, { force }) => {
      const payload = {
        cardId: v.cardId, name: v.name, totalAmount: v.totalAmount,
        installmentsCount: v.installmentsCount, purchaseDate: v.purchaseDate,
        firstMonth: v.firstMonth, categoryId: v.categoryId || null, note: v.note
      };
      if (isEdit) {
        const r = await repo.updatePurchase(existing.id, payload);
        toastOk(r.preservedPaid ? `Compra atualizada — ${r.preservedPaid} parcela(s) paga(s) preservada(s)` : 'Compra atualizada');
      } else {
        const r = await repo.createPurchase(payload, { force });
        toastOk(`Compra lançada em ${r.installments.length}x`);
      }
      return true;
    },
    onDelete: isEdit ? async () => {
      const sum = await repo.purchaseSummary(existing.id);
      const action = await choose({
        title: 'Excluir compra parcelada',
        text: sum.paidCount
          ? `Atenção: ${sum.paidCount} parcela(s) já foram pagas (${money(sum.paidTotal)}). Elas não serão apagadas.`
          : `Esta compra possui ${sum.pendingCount} parcela(s) em aberto.`,
        choices: [
          { value: 'with-future', label: 'Excluir compra e parcelas futuras', description: 'Parcelas já pagas permanecem no histórico.', danger: true },
          { value: 'keep', label: 'Manter parcelas', description: 'Remove só o registro da compra; as parcelas continuam nas faturas.' }
        ]
      });
      if (!action) return false;
      await repo.deletePurchase(existing.id, action);
      toastOk('Compra excluída');
      return true;
    } : null
  });

  return result;
}

/* ================================ Dívida ================================= */

export async function debtForm(existing = null) {
  const isEdit = !!existing;
  return openForm({
    title: isEdit ? 'Editar dívida' : 'Nova dívida',
    submitLabel: isEdit ? 'Salvar' : 'Registrar dívida',
    initial: existing ? {
      person: existing.person, reason: existing.reason, originalAmount: existing.originalAmount,
      date: existing.date, note: existing.note || ''
    } : { date: todayISO() },
    fields: [
      { name: 'originalAmount', type: 'money', label: 'Valor da dívida', required: true, autofocus: !isEdit },
      { name: 'person', type: 'text', label: 'Pessoa ou instituição', required: true, placeholder: 'Ex.: João, Banco X' },
      { name: 'reason', type: 'text', label: 'Motivo', placeholder: 'Ex.: Empréstimo' },
      { name: 'date', type: 'date', label: 'Data', required: true },
      { name: 'note', type: 'textarea', label: 'Observação', placeholder: 'Opcional' }
    ],
    onSubmit: async (v, { force }) => {
      const payload = {
        person: v.person, reason: v.reason, originalAmount: v.originalAmount,
        date: v.date, note: v.note
      };
      if (isEdit) { await repo.updateDebt(existing.id, payload); toastOk('Dívida atualizada'); }
      else { await repo.createDebt(payload, { force }); toastOk('Dívida registrada'); }
      return true;
    },
    onDelete: isEdit ? async () => {
      const s = await repo.debtSummary(existing.id);
      const action = await choose({
        title: 'Excluir dívida',
        text: s.payments.length
          ? `Esta dívida possui ${s.payments.length} pagamento(s) registrado(s), somando ${money(s.paid)}.`
          : 'Esta dívida não possui pagamentos registrados.',
        choices: [
          { value: 'keep', label: 'Excluir somente a dívida', description: 'Os pagamentos continuam no histórico.' },
          { value: 'with-payments', label: 'Excluir dívida e pagamentos', description: 'Remove também o histórico de pagamentos.', danger: true }
        ]
      });
      if (!action) return false;
      await repo.deleteDebt(existing.id, action);
      toastOk('Dívida excluída');
      return true;
    } : null
  });
}

export async function debtPaymentForm(debt) {
  const s = await repo.debtSummary(debt.id);
  return openForm({
    title: 'Registrar pagamento',
    submitLabel: 'Registrar',
    initial: { date: todayISO(), amount: 0 },
    fields: [
      { name: 'amount', type: 'money', label: 'Valor pago', required: true, autofocus: true },
      { name: 'date', type: 'date', label: 'Data', required: true },
      { name: 'note', type: 'textarea', label: 'Observação', placeholder: 'Opcional' }
    ],
    extra: el('div.card.mt-2', { style: { background: 'var(--card-2)', border: 'none' } }, [
      el('div.summary-line', {}, [el('span.k', { text: 'Valor original' }), el('span.v', { text: money(debt.originalAmount) })]),
      el('div.summary-line', {}, [el('span.k', { text: 'Já pago' }), el('span.v', { text: money(s.paid) })]),
      el('div.summary-line', {}, [el('span.k', { text: 'Restante' }), el('span.v', { text: money(s.remaining) })])
    ]),
    onSubmit: async (v, { force }) => {
      const r = await repo.createDebtPayment(debt.id, { amount: v.amount, date: v.date, note: v.note }, { force });
      toastOk(r.quitada ? 'Dívida quitada 🎉' : 'Pagamento registrado');
      return true;
    }
  });
}

/* ================================= Meta ================================== */

export async function goalForm(existing = null) {
  const isEdit = !!existing;
  return openForm({
    title: isEdit ? 'Editar meta' : 'Nova meta',
    submitLabel: isEdit ? 'Salvar' : 'Criar meta',
    initial: existing ? {
      name: existing.name, targetAmount: existing.targetAmount,
      currentAmount: existing.currentAmount, deadline: existing.deadline || '', note: existing.note || ''
    } : { currentAmount: 0 },
    fields: [
      { name: 'targetAmount', type: 'money', label: 'Valor desejado', required: true, autofocus: !isEdit },
      { name: 'name', type: 'text', label: 'Nome da meta', required: true, placeholder: 'Ex.: Reserva de emergência' },
      { name: 'currentAmount', type: 'money', label: 'Valor já guardado' },
      { name: 'deadline', type: 'date', label: 'Prazo', hint: 'Opcional' },
      { name: 'note', type: 'textarea', label: 'Observação', placeholder: 'Opcional' }
    ],
    onSubmit: async (v) => {
      const payload = {
        name: v.name, targetAmount: v.targetAmount, currentAmount: v.currentAmount,
        deadline: v.deadline || null, note: v.note
      };
      if (isEdit) { await repo.updateGoal(existing.id, payload); toastOk('Meta atualizada'); }
      else { await repo.createGoal(payload); toastOk('Meta criada'); }
      return true;
    },
    onDelete: isEdit ? async () => {
      const ok = await confirm({ title: 'Excluir meta', text: `"${existing.name}" será removida.`, okLabel: 'Excluir', danger: true });
      if (!ok) return false;
      await repo.deleteGoal(existing.id);
      toastOk('Meta excluída');
      return true;
    } : null
  });
}

export function goalContributeForm(goal) {
  return openForm({
    title: `Guardar em "${goal.name}"`,
    submitLabel: 'Adicionar',
    initial: { amount: 0, mode: 'add' },
    fields: [
      { name: 'amount', type: 'money', label: 'Valor', required: true, autofocus: true },
      {
        name: 'mode', type: 'segment', label: 'Operação',
        options: [{ value: 'add', label: 'Guardar' }, { value: 'remove', label: 'Retirar' }]
      }
    ],
    onSubmit: async (v) => {
      if (!v.amount) throw new ValidationError('Informe o valor.', 'amount');
      await repo.addToGoal(goal.id, v.mode === 'remove' ? -v.amount : v.amount);
      toastOk(v.mode === 'remove' ? 'Valor retirado' : 'Valor guardado');
      return true;
    }
  });
}

/* =============================== Categoria =============================== */

const ICON_CHOICES = ['🏠','🍽️','🚗','🎬','🛍️','💻','🔄','💊','📚','📦','💼','💵','⚡','📈','🎁','✈️','🐾','🎓','🏋️','☕'];

export function categoryForm(existing = null, kind = 'expense') {
  const isEdit = !!existing;
  let icon = existing ? existing.icon : '📦';

  const iconPicker = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } });
  const paint = () => {
    [...iconPicker.children].forEach((b) => {
      b.style.background = b.dataset.icon === icon ? 'var(--accent)' : 'var(--card-2)';
    });
  };
  for (const i of ICON_CHOICES) {
    iconPicker.append(el('button', {
      type: 'button', dataset: { icon: i }, text: i,
      style: { width: '44px', height: '44px', borderRadius: '12px', fontSize: '20px' },
      onclick: () => { icon = i; paint(); }
    }));
  }
  paint();

  return openForm({
    title: isEdit ? 'Editar categoria' : 'Nova categoria',
    submitLabel: isEdit ? 'Salvar' : 'Criar categoria',
    initial: existing ? { name: existing.name } : {},
    fields: [
      { name: 'name', type: 'text', label: 'Nome', required: true, autofocus: true, maxlength: 40 },
      { name: 'icon', type: 'custom', label: 'Ícone', render: () => iconPicker, read: () => icon }
    ],
    onSubmit: async (v) => {
      if (isEdit) { await repo.updateCategory(existing.id, { name: v.name, icon }); toastOk('Categoria atualizada'); }
      else { await repo.createCategory({ name: v.name, icon, kind }); toastOk('Categoria criada'); }
      return true;
    },
    onDelete: isEdit && !existing.isDefault ? async () => {
      const usage = await repo.categoryUsage(existing.id);
      const ok = await confirm({
        title: 'Excluir categoria',
        text: usage
          ? `${usage} lançamento(s) usam esta categoria. Eles continuarão existindo, mas ficarão sem categoria.`
          : 'Esta categoria não é usada por nenhum lançamento.',
        okLabel: 'Excluir', danger: true
      });
      if (!ok) return false;
      await repo.deleteCategory(existing.id);
      toastOk('Categoria excluída');
      return true;
    } : null
  });
}

/* ========================= Seletor de adição rápida ====================== */

export async function quickAdd(month) {
  const isCurrent = month === currentMonth();
  const date = isCurrent ? todayISO() : dateInMonth(month, 1);

  const choice = await choose({
    title: 'O que deseja adicionar?',
    choices: [
      { value: 'expense', label: 'Despesa', description: 'Pix, débito, dinheiro' },
      { value: 'purchase', label: 'Compra no cartão', description: 'À vista ou parcelada' },
      { value: 'income', label: 'Receita', description: 'Pró-labore, salário, freelance' },
      { value: 'recurring', label: 'Despesa fixa', description: 'Repete todo mês' },
      { value: 'debt', label: 'Dívida', description: 'Valor que você deve' }
    ]
  });
  if (!choice) return;

  const handlers = {
    expense: () => expenseForm(null, { date }),
    income: () => incomeForm(null, { date }),
    recurring: () => recurringForm(null, month),
    purchase: () => purchaseForm(null, {}),
    debt: () => debtForm(null)
  };
  return handlers[choice]();
}
