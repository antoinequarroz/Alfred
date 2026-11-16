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
