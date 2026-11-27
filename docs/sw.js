const scope = new URL(self.registration.scope);
const cachePrefix = 'primatek-operator-' + scope.pathname + ':';
const cacheName = cachePrefix + '1';
const app = new URL('index.html', scope).href;
const dependencies = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.tailwindcss.com/'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await cache.add(app);
    await Promise.all(dependencies.map(async url => {
      const response = await fetch(url, { mode: 'no-cors' });
      if (response.type !== 'opaque' && !response.ok) throw new Error('Dependency unavailable: ' + url);
      await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith(cachePrefix) && key !== cacheName)
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isOperatorPage = request.mode === 'navigate' && url.origin === scope.origin &&
    [scope.pathname, new URL(app).pathname].includes(url.pathname);
  const isDependency = dependencies.includes(url.href);
  const isLocalAsset = url.origin === scope.origin && ['image', 'manifest'].includes(request.destination);
  const isMascot = request.destination === 'image' && url.origin === 'https://raw.githubusercontent.com' &&
    url.pathname.startsWith('/gurusveta/primatek/main/assets/');
  if (!isOperatorPage && !isDependency && !isLocalAsset && !isMascot) return;

  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const key = isOperatorPage ? app : request;
    if (isDependency) {
      const cached = await cache.match(url.href);
      if (cached) return cached;
    }
    try {
      const response = await fetch(request);
      if ((response.ok || response.type === 'opaque') && !response.redirected) {
        await cache.put(key, response.clone()).catch(error => console.error(error));
      }
      return response;
    } catch (error) {
      const cached = await cache.match(key);
      if (cached) return cached;
      throw error;
    }
  })());
});
