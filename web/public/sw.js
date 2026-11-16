// Service worker minimal : l'interface s'ouvre instantanément (et hors ligne),
// les données passent toujours par le réseau.
const CACHE = 'alfred-shell-v3';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Jamais de cache pour l'API (privée comme publique) ni pour les pages publiques (rendez-vous, visio) :
  // ces requêtes vont toujours au réseau, sans passer par le service worker.
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname === '/rdv' || url.pathname.startsWith('/rdv/') || url.pathname.startsWith('/v/')) return;

  // Moteur du flou d'arrière-plan (plusieurs Mo) : le cache du navigateur suffit.
  if (url.pathname.startsWith('/assets/flou-')) return;
  if (url.pathname.startsWith('/assets/')) {
    // Fichiers versionnés : cache d'abord.
    event.respondWith(
      caches.match(request).then((hit) => hit ?? fetch(request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
        return res.clone();
      })),
    );
    return;
  }
  if (request.mode === 'navigate') {
    // Page : réseau d'abord, cache en secours.
    event.respondWith(
      fetch(request).then((res) => {
        if (res.ok) caches.open(CACHE).then((c) => c.put('/', res.clone()));
        return res.clone();
      }).catch(() => caches.match('/')),
    );
  }
});

// --- notifications (Web Push) ------------------------------------------------
// Le serveur envoie { title, body, url, tag } chiffré pour cet appareil ; le navigateur le déchiffre.

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Alfred';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      lang: 'fr',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // L'app est déjà ouverte : on la ramène au premier plan sur la bonne page.
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      if (client.url !== target && 'navigate' in client) await client.navigate(target).catch(() => undefined);
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// Le navigateur a renouvelé l'abonnement : on le signale au serveur (si la session est encore ouverte).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    const key = old?.options?.applicationServerKey;
    const sub = event.newSubscription ?? (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
    if (!sub) return;
    const json = sub.toJSON();
    await fetch('/api/push/devices', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, replaces: old?.endpoint }),
    }).catch(() => undefined);
  })());
});
