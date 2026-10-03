const CACHE_NAME = "estoque-unigames-v79";
const APP_SHELL = [
  "/estoque.html",
  "/favicon.svg",
  "/unigames-logo.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // Ilhas React: o manifest.json vem sempre da rede (aponta para os arquivos
  // da versão publicada); os módulos têm hash no nome e nunca mudam.
  if (url.pathname === "/islands/manifest.json") return;
  if (url.pathname.startsWith("/islands/")) {
    event.respondWith(islandModule(request, url));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match("/estoque.html")) ||
          new Response(
            "<!doctype html><html lang=\"pt-BR\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Sem conexão</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#08121e;color:#f5f9ff;font-family:Arial;padding:24px;text-align:center}main{max-width:420px}p{color:#a9bfd3;line-height:1.5}</style><main><h1>Sem conexão</h1><p>Abra o aplicativo novamente quando houver internet para sincronizar as alterações.</p></main></html>",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
      }),
    );
    return;
  }

  // Stale-while-revalidate. `refresh` nunca rejeita: falha de rede vira
  // `undefined`, e falha ao gravar no cache não descarta a resposta obtida.
  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type !== "opaque") {
        try {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        } catch {
          /* cache cheio/indisponível: segue com a resposta da rede */
        }
      }
      return response;
    })
    .catch(() => undefined);

  event.respondWith(
    caches
      .match(request)
      .catch(() => undefined)
      .then((cached) => cached || refresh)
      .then(
        (response) =>
          response || new Response(null, { status: 504, statusText: "Sem conexao" }),
      ),
  );
  event.waitUntil(refresh);
});

// Cache-first para /islands/<nome>-<hash>.js. Só guarda JavaScript de verdade
// (nunca a tela de login de uma sessão expirada) e, ao guardar uma versão
// nova, apaga as versões antigas do mesmo arquivo.
async function islandModule(request, url) {
  const cached = await caches.match(request).catch(() => undefined);
  if (cached) return cached;
  const response = await fetch(request);
  const isScript = /javascript/.test(response.headers.get("content-type") || "");
  if (response.ok && !response.redirected && isScript) {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
      const prefix = url.pathname.replace(/-[0-9a-z]+\.js$/, "-");
      for (const key of await cache.keys()) {
        const keyPath = new URL(key.url).pathname;
        if (keyPath !== url.pathname && keyPath.startsWith(prefix) && /^[0-9a-z]+\.js$/.test(keyPath.slice(prefix.length))) {
          await cache.delete(key);
        }
      }
    } catch {
      /* cache cheio/indisponível: segue com a resposta da rede */
    }
  }
  return response;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "Você possui uma tarefa pendente." };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "Lembrete de tarefa", {
      body: payload.body || "Você possui uma tarefa pendente.",
      tag: payload.tag || "unigames-task-reminder",
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      data: { url: payload.url || "/tarefas" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(
    event.notification.data?.url || "/tarefas",
    self.location.origin,
  ).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url.startsWith(self.location.origin));
      if (existing) {
        existing.navigate(targetUrl);
        return existing.focus();
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
