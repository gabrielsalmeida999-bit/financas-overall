# Overall Finanças

Controle financeiro pessoal **100% offline**, instalável como aplicativo (PWA), otimizado para celular.
Seus dados ficam **apenas no seu dispositivo** — não há servidor, conta, login ou sincronização.

---

## Como rodar

O app precisa ser servido por HTTP (o `file://` bloqueia módulos e Service Worker).

### Opção 1 — duplo clique (mais fácil)

```
iniciar.bat
```

Usa o PHP do XAMPP que já está instalado e abre `http://localhost:8123`.

### Opção 2 — XAMPP/Apache

Copie a pasta para `C:\xampp\htdocs\financas` e acesse `http://localhost/financas/`.

### Instalar no celular

1. No PC, descubra o IP da máquina (`ipconfig`) e acesse pelo celular na mesma rede:
   `http://SEU_IP:8123`
2. No Chrome (Android): menu → **Instalar aplicativo**.
   No Safari (iPhone): compartilhar → **Adicionar à Tela de Início**.
3. Depois de instalado, **funciona sem internet**.

> Para instalação em celular fora da rede local, hospede a pasta em qualquer HTTPS
> (GitHub Pages, Netlify, etc.). O app continua sem enviar dados a lugar nenhum.

---

## Testes

Abra `testes.html`. São **150 verificações** automáticas rodando numa base isolada
(`overall_financas_teste`) — seus dados reais nunca são tocados.

| Grupo | Testes |
|---|---|
| Valores monetários (centavos) | 14 |
| Datas financeiras (sem fuso horário) | 11 |
| Banco de dados e migrações | 5 |
| Despesas e receitas | 10 |
| Compras parceladas | 23 |
| Despesas fixas (recorrência) | 13 |
| Dívidas e pagamentos | 7 |
| Metas | 3 |
| Cálculos do mês | 12 |
| Backup, validação e restauração | 26 |
| Segurança | 10 |
| Desempenho e volume (500 lançamentos) | 5 |
| Cenários de recuperação | 11 |

Os cenários de recuperação cobrem: fechar e reabrir o app com centenas de
lançamentos, estrutura íntegra após reabertura, restauração interrompida no meio
(dados anteriores preservados) e alteração da data do aparelho (nenhum lançamento
muda de mês).

---

## Arquitetura

```
index.html            Shell do app (tema aplicado antes da primeira pintura)
manifest.webmanifest  PWA: instalação, ícones, atalhos
sw.js                 Service Worker — cacheia SÓ os arquivos do app, nunca dados
css/app.css           Design System Overall (preto/branco/cinza/laranja)

js/core.js            Centavos, datas financeiras, IDs, estado, log sanitizado
js/db.js              IndexedDB versionado (v2), migrações, transações, snapshots
js/repo.js            Regras de negócio (parcelas, recorrência, dívidas, cálculos)
js/backup.js          Exportação, validação rigorosa, restauração transacional
js/security.js        PIN com PBKDF2, biometria (WebAuthn), bloqueio automático
js/ui.js              Toast, bottom sheet, modal, confirmações, componentes
js/forms.js           Construtor de formulários + formulários do app
js/app.js             Boot, rotas, tema, tela de bloqueio, erros globais
js/views/*.js         Dashboard, Lançamentos, Cartões, Relatórios, Mais, Configurações
js/testes.js          Suíte de testes
```

### Decisões que protegem seus dados

| Risco | Como foi tratado |
|---|---|
| Erro de arredondamento | Todo valor é **inteiro em centavos**. `R$ 25,90` → `2590`. A soma das parcelas sempre fecha com o total (o resto é distribuído centavo a centavo). |
| Lançamento no mês errado | Datas financeiras são **strings** `YYYY-MM-DD`. Nenhuma conversão de fuso decide o mês. `createdAt` (timestamp técnico) é separado de `date` (data financeira). |
| Parcela duplicada | ID determinístico `inst_<compra>~<n>` + índice **único** `[purchaseId, number]` no banco. Duplicar é impossível por construção. |
| Ocorrência de despesa fixa duplicada | ID determinístico `occ_<recorrência>~<mês>`. Materializar o mesmo mês N vezes gera sempre 1 registro. Ocorrência excluída não é recriada. |
| Editar compra com parcelas pagas | Parcelas pagas nunca são tocadas. Só as pendentes são recalculadas, e o total continua fechando. Reduzir o total abaixo do já pago é recusado. |
| Toque duplo no botão | Chave de deduplicação + janela de 90s: um registro idêntico exige confirmação explícita. Botões de envio travam durante o salvamento. |
| Importar backup ruim | Validação em camadas (formato, versão, estrutura, tipos, IDs, relacionamentos, soma das parcelas). Se falhar, **nada muda** e o motivo é mostrado. |
| Restauração interrompida | Uma única transação IndexedDB sobre todas as stores. Falhou no meio = rollback total. Antes disso, uma cópia interna é criada automaticamente. |
| Exclusão acidental | *Soft delete* + Lixeira com recuperação. Ações destrutivas pedem confirmação; apagar tudo exige três etapas e digitar `APAGAR`. |
| PIN vazando | Nunca armazenado. Só `salt` aleatório + hash **PBKDF2-SHA256, 210.000 iterações**. Comparação em tempo constante e bloqueio progressivo após 8 tentativas. |
| Log com dado sensível | Sanitizador remove campos com `pin`, `senha`, `hash`, `valor`, `amount`… Nomes de lançamentos não entram no log. |
| Atualização apagando dados | Migrações idempotentes e aditivas; o Service Worker versiona só o cache de **código**. O banco nunca é recriado. |

---

## Backup — leia isto

Seus dados vivem no armazenamento do navegador. Eles somem se você:

- limpar os dados do site / do navegador;
- desinstalar o app;
- trocar de aparelho.

**Configurações → Dados e Segurança → Exportar backup** gera um `.json` com tudo.
O app avisa quando passam 14 dias sem backup (o lembrete pode ser desligado).

### Trocar de aparelho

```
Aparelho antigo:  Configurações → Exportar backup   →  arquivo .json
Aparelho novo:    Configurações → Importar backup   →  conferir resumo → Restaurar
```

Na importação o app mostra a data do backup e a contagem de cada tipo de registro
**antes** de qualquer alteração, e oferece exportar os dados atuais primeiro.

---

## O que o app tem

**Dashboard** — disponível, renda, gastos, saldo projetado, composição (fixas /
variáveis / cartão / dívidas), comprometido nos próximos 12 meses, próximas
despesas, categorias, dívidas e metas.

**Lançamentos** — busca por nome e filtros por categoria, forma de pagamento,
situação, cartão e faixa de valor.

**Cartões** — limite, comprometido, disponível, fatura do mês, próximas 6 faturas,
compras parceladas com escolha do mês da 1ª cobrança e pagamento da fatura inteira.

**Relatórios** — evolução de 6/12/24 meses (gastos, receitas ou saldo), comparação
com o mês anterior, média mensal, maior e menor mês, composição e mês a mês.

**Mais** — dívidas com pagamentos e percentual quitado, metas com progresso,
despesas fixas e categorias personalizáveis.

**Configurações** — tema, PIN, biometria, bloqueio automático, backup, cópias
internas, lixeira, estatísticas de armazenamento, diagnóstico e apagar tudo.

---

## Limites conhecidos

- **Biometria** só funciona em contexto seguro (HTTPS ou `localhost`) e em
  navegadores com WebAuthn de plataforma. Sem ela, o PIN funciona normalmente.
- **Não há sincronização** entre aparelhos. É proposital — o backup é o caminho.
- iOS pode descartar dados de sites pouco usados. O app pede *armazenamento
  persistente* ao navegador, mas quem decide é o sistema. Faça backups.
