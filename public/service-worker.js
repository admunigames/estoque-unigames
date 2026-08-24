const CACHE_NAME = "estoque-unigames-v58";
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

  const refresh = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type !== "opaque") {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    });

  event.respondWith(
    caches.match(request).then((cached) => cached || refresh),
  );
  event.waitUntil(refresh.then(() => undefined).catch(() => undefined));
});

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
