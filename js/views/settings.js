/* ==========================================================================
   views/settings.js — Aparência, Segurança, Dados e Segurança, Sobre.
   ========================================================================== */

import {
  APP_VERSION, money, relativeFrom, formatStamp, daysSince, formatDate,
  getLogBuffer, log
} from '../core.js';

import {
  el, section, sheet, modal, confirm, confirmTwice, toastOk, toastErr, toastInfo,
  switchRow, navRow, summaryLine, emptyState, listItem, segmented, emit, once
} from '../ui.js';

import * as repo from '../repo.js';
import * as db from '../db.js';
import { DB_VERSION } from '../db.js';
import {
  exportBackup, readBackupFile, validateBackup, restoreBackup, wipeAllData,
  STORE_LABELS
} from '../backup.js';
import * as security from '../security.js';
import { BACKUP_VERSION } from '../core.js';

export async function render(root, ctx) {
  root.replaceChildren();

  const [settings, counts, lockEnabled, bioAvailable, bioEnabled, persisted, storage] = await Promise.all([
    repo.getSettings(),
    repo.totalRecords(),
    security.isLockEnabled(),
    security.biometricAvailable(),
    security.biometricEnabled(),
    db.isPersisted(),
    db.estimateStorage()
  ]);

  /* ------------------------- Aviso de armazenamento ------------------------ */
  root.append(el('div.card', {}, [
    el('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start' } }, [
      el('span', { text: '📱', style: { fontSize: '20px' } }),
      el('div', {}, [
        el('div', { text: 'Seus dados ficam neste dispositivo', style: { fontWeight: '650', fontSize: '15px' } }),
        el('div.small.muted.mt-2', {
          text: 'O aplicativo funciona offline e não envia nada para a internet. Não existe sincronização entre aparelhos: para levar seus dados para outro celular, use o backup.'
        })
      ])
    ])
  ]));

  /* ------------------------------ Aparência ------------------------------- */
  const themeCard = el('div.card', {}, [
    el('div.field-label', { text: 'Tema' }),
    segmented([
      { value: 'dark', label: 'Escuro' },
      { value: 'light', label: 'Claro' },
      { value: 'system', label: 'Sistema' }
    ], settings.theme || 'dark', async (v) => {
      await repo.setSetting('theme', v);
      emit('theme:changed', v);
      ctx.refresh();
    })
  ]);
  root.append(section('Aparência', themeCard));

  /* ------------------------------ Segurança ------------------------------- */
  const secCard = el('div.list');

  secCard.append(switchRow(
    'Bloquear aplicativo',
    lockEnabled,
    async (next) => {
      if (next) { await openSetPin(ctx); }
      else { await openDisableLock(ctx); }
    },
    lockEnabled ? 'Protegido por PIN' : 'Exigir PIN para abrir o aplicativo'
  ));

  if (lockEnabled) {
    secCard.append(navRow('Alterar PIN', { icon: '🔑', onClick: () => openSetPin(ctx, true) }));
    secCard.append(navRow('Bloqueio automático', {
      icon: '⏱',
      value: security.currentAutoLockMinutes() === 0 ? 'Nunca' : `${security.currentAutoLockMinutes()} min`,
      onClick: () => openAutoLock(ctx)
    }));
    if (bioAvailable) {
      secCard.append(switchRow(
        'Usar biometria',
        bioEnabled,
        async (next) => {
          try {
            if (next) { await security.enableBiometric(); toastOk('Biometria ativada'); }
            else { await security.disableBiometric(); toastOk('Biometria desativada'); }
          } catch (e) { toastErr(e.message || 'Não foi possível configurar a biometria.'); }
          ctx.refresh();
        },
        'Desbloquear com digital ou reconhecimento facial'
      ));
    } else {
      secCard.append(el('div.switch-row', {}, [
        el('div', { style: { flex: '1' } }, [
          el('div', { text: 'Biometria', style: { fontSize: '15px', fontWeight: '550', color: 'var(--text-3)' } }),
          el('div.tiny.muted', { text: 'Não disponível neste navegador. O PIN continua funcionando normalmente.' })
        ])
      ]));
    }
  }
  root.append(section('Segurança', secCard));

  /* ------------------------- Dados e Segurança ---------------------------- */
  const days = daysSince(settings.lastBackupAt);
  const backupCard = el('div.list');

  backupCard.append(el('div.switch-row', {}, [
    el('div', { style: { flex: '1' } }, [
      el('div', { text: 'Último backup', style: { fontSize: '15px', fontWeight: '550' } }),
      el('div.tiny', {
        style: { color: days >= (settings.backupReminderDays || 14) ? 'var(--accent)' : 'var(--text-3)', marginTop: '2px' },
        text: settings.lastBackupAt
          ? `${relativeFrom(settings.lastBackupAt)} · ${formatStamp(new Date(settings.lastBackupAt).toISOString())}`
          : 'Nenhum backup realizado'
      })
    ])
  ]));

  backupCard.append(navRow('Exportar backup', {
    icon: '⬇️',
    onClick: once(async () => {
      try {
        const r = await exportBackup();
        toastOk(`Backup criado — ${r.name}`);
        ctx.refresh();
      } catch (e) { toastErr('Não foi possível gerar o backup.'); }
    })
  }));

  backupCard.append(navRow('Importar backup', {
    icon: '⬆️',
    onClick: () => openImport(ctx)
  }));

  backupCard.append(switchRow(
    'Lembrete de backup',
    settings.backupReminder !== false,
    async (next) => { await repo.setSetting('backupReminder', next); },
    `Avisar após ${settings.backupReminderDays || 14} dias sem backup`
  ));

  root.append(section('Dados e Segurança', backupCard));

  /* --------------------------- Cópias internas ---------------------------- */
  const snaps = await db.listSnapshots();
  const extraCard = el('div.list');
  extraCard.append(navRow('Cópias de segurança internas', {
    icon: '🗄',
    value: String(snaps.length),
    onClick: () => openSnapshots(ctx)
  }));
  extraCard.append(navRow('Lixeira', {
    icon: '🗑',
    onClick: () => openTrash(ctx)
  }));
  root.append(section('Recuperação', extraCard));

  /* ------------------------------ Estatísticas ---------------------------- */
  const statsCard = el('div.card');
  const labels = Object.entries(counts.counts).filter(([k]) => k !== 'settings');
  for (const [store, n] of labels) {
    if (!n) continue;
    statsCard.append(summaryLine(capitalize(STORE_LABELS[store] || store), String(n)));
  }
  statsCard.append(el('div.divider'));
  statsCard.append(summaryLine('Total de registros', String(counts.total)));
  if (storage && storage.usage) {
    statsCard.append(summaryLine('Espaço utilizado', formatBytes(storage.usage)));
  }
  statsCard.append(el('div.summary-line', {}, [
    el('span.k', { text: 'Armazenamento persistente' }),
    el('span.v', { style: { color: persisted ? 'var(--good)' : 'var(--text-3)' }, text: persisted ? 'Ativo' : 'Não garantido' })
  ]));
  if (!persisted) {
    statsCard.append(el('button.btn.btn-sm.btn-ghost.btn-block.mt-3', {
      type: 'button', text: 'Solicitar armazenamento persistente',
      onclick: async () => {
        const ok = await db.requestPersistence();
        toastOk(ok ? 'Armazenamento protegido' : 'O navegador não concedeu a permissão.');
        ctx.refresh();
      }
    }));
  }
  root.append(section('Seus dados', statsCard));

  /* ------------------------------ Zona crítica ---------------------------- */
  const danger = el('div.list');
  danger.append(navRow('Apagar todos os dados', {
    icon: '⚠️', danger: true,
    onClick: () => openWipe(ctx)
  }));
  root.append(section('Zona de risco', danger));

  /* --------------------------------- Sobre -------------------------------- */
  const about = el('div.card', {}, [
    summaryLine('Versão do aplicativo', APP_VERSION),
    summaryLine('Versão do banco de dados', `v${DB_VERSION}`),
    summaryLine('Formato de backup', `v${BACKUP_VERSION}`),
    el('div.divider'),
    el('div.summary-line', {}, [
      el('span.k', { text: 'Funciona offline' }),
      el('span.v', { style: { color: 'var(--good)' }, text: 'Sim' })
    ]),
    el('div.summary-line', {}, [
      el('span.k', { text: 'Sincronização online' }),
      el('span.v', { style: { color: 'var(--text-3)' }, text: 'Não possui' })
    ])
  ]);
  root.append(section('Sobre', about));

  const diag = el('div.list');
  diag.append(navRow('Diagnóstico técnico', { icon: '🧪', onClick: () => openLogs(ctx) }));
  diag.append(navRow('Verificar estrutura do banco', {
    icon: '✅',
    onClick: async () => {
      const r = await db.validateSchema();
      if (r.ok) toastOk(`Banco íntegro (v${r.version})`);
      else toastErr(`Estrutura incompleta: faltam ${r.missing.join(', ')}`);
    }
  }));
  root.append(section('Avançado', diag));

  root.append(el('div.tiny.muted.center.mt-5', {
    text: 'Overall Finanças — seus dados, no seu dispositivo.'
  }));
}

/* ============================== Importação =============================== */

function openImport(ctx) {
  const input = el('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } });
  document.body.append(input);

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;

    let raw;
    try {
      raw = await readBackupFile(file);
    } catch (e) {
      await modal({
        title: 'Arquivo inválido',
        text: e.message || 'Não foi possível ler este arquivo.',
        actions: [{ label: 'Entendi', value: null, variant: 'btn-primary' }]
      });
      return;
    }

    const result = validateBackup(raw);

    if (!result.ok) {
      await modal({
        title: 'Backup inválido',
        text: 'Não foi possível restaurar este backup porque o arquivo está inválido ou incompatível.',
        content: el('div', {}, [
          el('div.tiny.muted', { text: 'Detalhes:' }),
          el('ul', { style: { margin: '8px 0 0', paddingLeft: '18px' } },
            result.errors.slice(0, 6).map((e) => el('li.small', { text: e, style: { marginBottom: '4px' } }))
          ),
          el('div.tiny.muted.mt-3', { text: 'Seus dados atuais permanecem intactos.' })
        ]),
        actions: [{ label: 'Fechar', value: null, variant: 'btn-primary' }]
      });
      return;
    }

    /* ---- Resumo antes de restaurar (nunca substitui direto) ---- */
    const body = el('div');
    body.append(el('div.card', { style: { background: 'var(--card-2)', border: 'none' } }, [
      el('div.section-title', { text: 'Backup encontrado' }),
      el('div.mt-2', {}, [
        summaryLine('Criado em', result.meta.createdAt ? formatStamp(result.meta.createdAt) : 'desconhecido'),
        summaryLine('Versão do app', String(result.meta.appVersion)),
        summaryLine('Formato', `v${result.meta.backupVersion}`)
      ])
    ]));

    const list = el('div.card.mt-3');
    list.append(el('div.section-title', { text: 'Dados encontrados' }));
    let any = false;
    for (const [store, n] of Object.entries(result.summary)) {
      if (store === 'settings' || !n) continue;
      any = true;
      list.append(summaryLine(capitalize(STORE_LABELS[store] || store), String(n)));
    }
    if (!any) list.append(el('div.small.muted', { text: 'Nenhum lançamento financeiro neste backup.' }));
    body.append(list);

    if (result.warnings.length) {
      body.append(el('div.banner.mt-3', {}, [
        el('span.bico', { text: '⚠️' }),
        el('div.banner-body', {}, [
          el('div.banner-title', { text: 'Avisos' }),
          el('div.banner-text', { text: result.warnings.slice(0, 3).join(' · ') })
        ])
      ]));
    }

    const current = await repo.totalRecords();
    body.append(el('div.banner.info.mt-3', {}, [
      el('span.bico', { text: 'ℹ️' }),
      el('div.banner-body', {}, [
        el('div.banner-title', { text: 'A restauração substitui os dados atuais' }),
        el('div.banner-text', {
          text: `Você tem ${current.total} registro(s) neste dispositivo. Faremos uma cópia interna antes de continuar, e recomendamos exportar um backup dos dados atuais.`
        })
      ])
    ]));

    body.append(el('button.btn.btn-ghost.btn-block.mt-3', {
      type: 'button', text: 'Exportar backup dos dados atuais',
      onclick: once(async () => {
        try { const r = await exportBackup({ markAsBackup: false }); toastOk(`Backup atual salvo — ${r.name}`); }
        catch (_) { toastErr('Não foi possível exportar.'); }
      })
    }));

    const s = sheet({
      title: 'Restaurar backup',
      body,
      size: 'tall',
      footer: (api) => el('div', { style: { display: 'flex', gap: '12px', width: '100%' } }, [
        el('button.btn.btn-ghost', { type: 'button', text: 'Cancelar', onclick: () => api.close(null) }),
        el('button.btn.btn-primary', {
          type: 'button', text: 'Restaurar backup',
          onclick: once(async () => {
            const ok = await confirm({
              title: 'Confirmar restauração',
              text: `Todos os dados atuais serão substituídos por ${result.total} registro(s) do backup. Uma cópia interna dos dados atuais será criada automaticamente.`,
              okLabel: 'Restaurar agora', danger: true
            });
            if (!ok) return;
            api.setBusy(true);
            try {
              const r = await restoreBackup(result);
              api.close(true);
              await modal({
                title: 'Dados restaurados',
                text: `${r.written} registro(s) foram restaurados com sucesso.`,
                actions: [{ label: 'Continuar', value: null, variant: 'btn-primary' }]
              });
              emit('data:changed');
              ctx.refresh();
            } catch (e) {
              api.setBusy(false);
              toastErr(e.message || 'A restauração falhou.');
            }
          })
        })
      ])
    });
  });

  input.click();
}

/* =============================== Apagar tudo ============================= */

async function openWipe(ctx) {
  const counts = await repo.totalRecords();

  if (counts.total === 0) {
    toastInfo('Não há dados para apagar.');
    return;
  }

  const wantBackup = await modal({
    title: 'Apagar todos os dados',
    text: `Esta ação excluirá ${counts.total} registros financeiros.\n\nRecomendamos criar um backup antes de continuar.`,
    actions: [
      { label: 'Criar backup agora', value: 'backup', variant: 'btn-primary' },
      { label: 'Continuar sem backup', value: 'continue', variant: 'btn-ghost' },
      { label: 'Cancelar', value: null, variant: 'btn-ghost' }
    ]
  });
  if (!wantBackup) return;

  if (wantBackup === 'backup') {
    try { const r = await exportBackup(); toastOk(`Backup criado — ${r.name}`); }
    catch (_) { toastErr('Não foi possível gerar o backup. Ação cancelada.'); return; }
  }

  const sure = await confirmTwice({
    title: 'Tem certeza?',
    text: `${counts.total} registros serão apagados deste dispositivo. Esta ação não pode ser desfeita pelo aplicativo.`,
    okLabel: 'Continuar',
    secondTitle: 'Confirmação final',
    typeToConfirm: 'APAGAR'
  });
  if (!sure) { toastInfo('Nada foi apagado.'); return; }

  try {
    await wipeAllData();
    await repo.ensureSeed();
    emit('data:changed');
    await modal({
      title: 'Dados apagados',
      text: 'Todos os registros financeiros foram removidos deste dispositivo.',
      actions: [{ label: 'Entendi', value: null, variant: 'btn-primary' }]
    });
    ctx.refresh();
  } catch (e) {
    toastErr('Não foi possível apagar os dados.');
  }
}

/* ============================ Cópias internas ============================ */

async function openSnapshots(ctx) {
  const snaps = await db.listSnapshots();
  const body = el('div');

  body.append(el('div.small.muted', {
    text: 'Cópias criadas automaticamente antes de operações críticas. Servem como rede de segurança e não substituem o backup exportado.'
  }));

  if (!snaps.length) {
    body.append(el('div.card.mt-3', {}, [
      emptyState({ icon: '🗄', title: 'Nenhuma cópia interna', text: 'Elas são criadas automaticamente antes de restaurações e exclusões em massa.' })
    ]));
  } else {
    const list = el('div.list.mt-3');
    for (const s of snaps) {
      const total = Object.entries(s.counts || {})
        .filter(([k]) => k !== 'settings')
        .reduce((a, [, v]) => a + v, 0);
      list.append(listItem({
        icon: '🗄',
        title: formatStamp(new Date(s.createdAt).toISOString()),
        subtitle: `${s.reason} · ${total} registro(s)`,
        onClick: async () => {
          const ok = await confirm({
            title: 'Restaurar esta cópia?',
            text: `Os dados atuais serão substituídos por ${total} registro(s) desta cópia. Uma nova cópia dos dados atuais será criada antes.`,
            okLabel: 'Restaurar', danger: true
          });
          if (!ok) return;
          try {
            await db.restoreSnapshot(s.id);
            repo.invalidateSettingsCache();
            toastOk('Cópia restaurada');
            emit('data:changed');
            sh.close(true);
            ctx.refresh();
          } catch (e) { toastErr('Não foi possível restaurar esta cópia.'); }
        }
      }));
    }
    body.append(list);
  }

  body.append(el('button.btn.btn-ghost.btn-block.mt-4', {
    type: 'button', text: 'Criar cópia interna agora',
    onclick: once(async () => {
      const id = await db.createSnapshot('manual');
      if (id) { toastOk('Cópia interna criada'); sh.close(true); ctx.refresh(); }
      else toastErr('Não foi possível criar a cópia.');
    })
  }));

  const sh = sheet({ title: 'Cópias de segurança internas', body, size: 'tall' });
}

/* ================================ Lixeira ================================ */

async function openTrash(ctx) {
  const items = await repo.listTrash();
  const body = el('div');

  body.append(el('div.small.muted', {
    text: 'Registros excluídos ficam guardados aqui e podem ser recuperados. Nada é apagado silenciosamente.'
  }));

  if (!items.length) {
    body.append(el('div.card.mt-3', {}, [
      emptyState({ icon: '🗑', title: 'Lixeira vazia', text: 'Nenhum registro excluído.' })
    ]));
  } else {
    const list = el('div.list.mt-3');
    for (const it of items) {
      list.append(listItem({
        icon: '↩︎',
        title: it.label,
        subtitle: `${capitalize(STORE_LABELS[it.store] || it.store)} · excluído ${relativeFrom(it.deletedAt)}`,
        amount: it.amount != null ? it.amount : null,
        onClick: async () => {
          await repo.restoreFromTrash(it.store, it.id);
          toastOk('Registro recuperado');
          emit('data:changed');
          sh.close(true);
          ctx.refresh();
        }
      }));
    }
    body.append(list);

    body.append(el('button.btn.btn-danger.btn-block.mt-4', {
      type: 'button', text: 'Esvaziar lixeira definitivamente',
      onclick: async () => {
        const ok = await confirmTwice({
          title: 'Esvaziar lixeira',
          text: `${items.length} registro(s) serão removidos definitivamente e não poderão mais ser recuperados.`,
          okLabel: 'Continuar',
          secondTitle: 'Tem certeza?',
          secondText: 'Esta ação não pode ser desfeita.',
          secondOkLabel: 'Sim, esvaziar'
        });
        if (!ok) return;
        const n = await repo.purgeTrash();
        toastOk(`${n} registro(s) removidos`);
        sh.close(true);
        ctx.refresh();
      }
    }));
  }

  const sh = sheet({ title: 'Lixeira', body, size: 'tall' });
}

/* ================================ PIN ==================================== */

async function openSetPin(ctx, isChange = false) {
  if (!security.isSupported()) {
    toastErr('Este navegador não oferece as funções de segurança necessárias.');
    ctx.refresh();
    return;
  }

  const step = { current: '', pin: '', confirm: '' };
  const body = el('div');
  const label = el('div.field-label');
  const input = el('input.input', {
    type: 'password', inputmode: 'numeric', maxlength: '8',
    placeholder: '••••', autocomplete: 'off',
    style: { textAlign: 'center', fontSize: '24px', letterSpacing: '8px' }
  });
  const errNode = el('div.field-error', { style: { textAlign: 'center' } });

  body.append(label, input, errNode);
  body.append(el('div.tiny.muted.center.mt-3', {
    text: 'O PIN não é armazenado. Guardamos apenas uma verificação criptográfica dele (PBKDF2, 210.000 iterações).'
  }));

  let phase = isChange ? 'current' : 'new';
  const paint = () => {
    label.textContent = phase === 'current' ? 'PIN atual'
      : phase === 'new' ? 'Novo PIN (4 a 8 dígitos)'
      : 'Confirme o novo PIN';
    input.value = '';
    errNode.textContent = '';
    setTimeout(() => input.focus(), 120);
  };
  paint();

  const advance = once(async (api) => {
    const value = input.value.replace(/\D/g, '');
    errNode.textContent = '';

    if (phase === 'current') {
      const ok = await security.verifyPin(value);
      if (!ok) { errNode.textContent = 'PIN incorreto.'; input.value = ''; return; }
      step.current = value; phase = 'new'; paint(); return;
    }
    if (phase === 'new') {
      if (value.length < 4 || value.length > 8) { errNode.textContent = 'Use de 4 a 8 dígitos.'; return; }
      if (/^(\d)\1+$/.test(value)) { errNode.textContent = 'Escolha dígitos diferentes.'; return; }
      step.pin = value; phase = 'confirm'; paint(); return;
    }
    if (value !== step.pin) { errNode.textContent = 'Os PINs não conferem.'; input.value = ''; return; }
    try {
      await security.setPin(step.pin);
      toastOk(isChange ? 'PIN alterado' : 'Bloqueio ativado');
      api.close(true);
      ctx.refresh();
    } catch (e) {
      errNode.textContent = e.message || 'Não foi possível salvar o PIN.';
    }
  });

  const s = sheet({
    title: isChange ? 'Alterar PIN' : 'Ativar bloqueio',
    body,
    onClose: () => ctx.refresh(),
    footer: (api) => el('div', { style: { display: 'flex', gap: '12px', width: '100%' } }, [
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancelar', onclick: () => api.close(null) }),
      el('button.btn.btn-primary', { type: 'button', text: 'Continuar', onclick: () => advance(api) })
    ])
  });

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); advance(s); } });
}

async function openDisableLock(ctx) {
  const input = el('input.input', {
    type: 'password', inputmode: 'numeric', maxlength: '8', placeholder: '••••',
    style: { textAlign: 'center', fontSize: '24px', letterSpacing: '8px' }
  });
  const errNode = el('div.field-error', { style: { textAlign: 'center' } });

  const s = sheet({
    title: 'Desativar bloqueio',
    body: el('div', {}, [
      el('div.field-label', { text: 'Digite o PIN atual para confirmar' }),
      input, errNode
    ]),
    onClose: () => ctx.refresh(),
    footer: (api) => el('div', { style: { display: 'flex', gap: '12px', width: '100%' } }, [
      el('button.btn.btn-ghost', { type: 'button', text: 'Cancelar', onclick: () => api.close(null) }),
      el('button.btn.btn-danger-solid', {
        type: 'button', text: 'Desativar',
        onclick: once(async () => {
          try {
            await security.disableLock(input.value.replace(/\D/g, ''));
            toastOk('Bloqueio desativado');
            api.close(true);
            ctx.refresh();
          } catch (e) { errNode.textContent = e.message || 'PIN incorreto.'; }
        })
      })
    ])
  });
  setTimeout(() => input.focus(), 200);
}

async function openAutoLock(ctx) {
  const current = security.currentAutoLockMinutes();
  const options = [
    { value: 0, label: 'Nunca' },
    { value: 1, label: '1 minuto' },
    { value: 5, label: '5 minutos' },
    { value: 15, label: '15 minutos' },
    { value: 30, label: '30 minutos' }
  ];
  const body = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  for (const o of options) {
    body.append(el('button.opt-btn', {
      type: 'button',
      onclick: async () => {
        await security.setAutoLockMinutes(o.value);
        security.setAutoLockCache(o.value);
        toastOk(`Bloqueio automático: ${o.label.toLowerCase()}`);
        s.close(true);
        ctx.refresh();
      }
    }, [
      el('div', { style: { flex: '1' } }, [el('div.opt-title', { text: o.label })]),
      o.value === current ? el('span', { text: '✓', style: { color: 'var(--accent)' } }) : null
    ].filter(Boolean)));
  }
  const s = sheet({ title: 'Bloqueio automático', body });
}

/* ============================== Diagnóstico ============================== */

async function openLogs(ctx) {
  const stored = await db.readLogs(150);
  const buffer = getLogBuffer();
  const seen = new Set(stored.map((l) => l.id));
  const all = [...buffer.filter((l) => !seen.has(l.id)), ...stored]
    .sort((a, b) => b.ts - a.ts).slice(0, 150);

  const body = el('div');
  body.append(el('div.small.muted', {
    text: 'Registro técnico de eventos. Não contém PIN, senhas, nomes de lançamentos nem valores financeiros.'
  }));

  if (!all.length) {
    body.append(el('div.card.mt-3', {}, [emptyState({ icon: '🧪', title: 'Sem eventos registrados' })]));
  } else {
    const list = el('div.card.mt-3', { style: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } });
    for (const l of all) {
      const color = l.level === 'error' ? 'var(--bad)' : l.level === 'warn' ? 'var(--warn)' : 'var(--text-3)';
      list.append(el('div', {
        style: { fontSize: '11px', padding: '5px 0', borderBottom: '1px solid var(--line)', color: 'var(--text-2)' }
      }, [
        el('span', { style: { color }, text: `${new Date(l.ts).toLocaleTimeString('pt-BR')} ${l.event}` }),
        l.detail ? el('span', { style: { color: 'var(--text-3)' }, text: ` ${safeJson(l.detail)}` }) : null
      ].filter(Boolean)));
    }
    body.append(list);

    body.append(el('button.btn.btn-ghost.btn-block.mt-3', {
      type: 'button', text: 'Limpar registros',
      onclick: async () => { await db.clearLogs(); toastOk('Registros limpos'); s.close(true); }
    }));
  }

  const s = sheet({ title: 'Diagnóstico técnico', body, size: 'tall' });
}

/* ============================== Utilidades =============================== */

function capitalize(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

function safeJson(v) {
  try { return JSON.stringify(v).slice(0, 90); } catch (_) { return ''; }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB`;
}
