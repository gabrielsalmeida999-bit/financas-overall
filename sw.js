/* ==========================================================================
   Service Worker — Overall Finanças
   Guarda APENAS os arquivos da aplicação (código, estilo, ícones).
   NUNCA guarda dados financeiros: esses vivem exclusivamente no IndexedDB.
   ========================================================================== */

const APP_VERSION = '1.0.0';
const CACHE = `overall-financas-app-v${APP_VERSION}-5`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './icons/icon.svg',
  './icons/maskable.svg',
  './js/app.js',
  './js/core.js',
  './js/db.js',
  './js/repo.js',
  './js/backup.js',
  './js/security.js',
  './js/ui.js',
  './js/forms.js',
  './js/views/dashboard.js',
  './js/views/transactions.js',
  './js/views/cards.js',
  './js/views/reports.js',
  './js/views/more.js',
  './js/views/settings.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll falha inteiro se um arquivo falhar; adicionamos um a um para ser resiliente.
    await Promise.all(APP_SHELL.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res);
      } catch (_) { /* offline no install: será buscado depois */ }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('overall-financas-app-') && k !== CACHE)
          .map((k) => caches.delete(k))
    );
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'GET_VERSION') {
    event.source && event.source.postMessage({ type: 'VERSION', version: APP_VERSION });
  }
});

/** Caminhos absolutos dos arquivos do app, para saber o que atender pelo cache. */
const SHELL_PATHS = new Set(
  APP_SHELL.map((p) => new URL(p, self.location.href).pathname)
);

/**
 * Estratégia:
 *  - Navegação (HTML): network-first com fallback para o index em cache
 *    (garante abrir offline e pegar atualizações quando houver rede).
 *  - Arquivos do app (APP_SHELL): stale-while-revalidate.
 *  - Qualquer outra coisa: passa direto para a rede, sem cache.
 *    Assim páginas auxiliares (ex.: testes.html) nunca ficam presas numa
 *    versão antiga, e o cache guarda só o que o app precisa para abrir offline.
 *  - Requisições externas / não-GET: passam direto (o app não depende delas).
 */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    const isShellPage = SHELL_PATHS.has(url.pathname);
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) { if (isShellPage) putInCache(req, preload.clone()); return preload; }
        const net = await fetch(req);
        if (isShellPage) putInCache(req, net.clone());
        return net;
      } catch (_) {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) ||
               (await cache.match('./index.html')) ||
               (await cache.match('./')) ||
               new Response(
                 '<h1>Offline</h1><p>Abra o aplicativo uma vez com internet para instalá-lo.</p>',
                 { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
               );
      }
    })());
    return;
  }

  if (!SHELL_PATHS.has(url.pathname)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);

    if (cached) { network.catch(() => {}); return cached; }
    const res = await network;
    return res || new Response('', { status: 504, statusText: 'Offline' });
  })());
});

function putInCache(req, res) {
  if (!res || !res.ok) return;
  caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});
}
