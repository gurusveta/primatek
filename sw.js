const CACHE_NAME = 'primatek-v2.0';
const ASSETS = [
  './manifest.json',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Для запросов к API Supabase и Telegram идем напрямую в сеть
  if (e.request.url.includes('supabase.co') || e.request.url.includes('telegram.org')) {
    return;
  }

  // Стратегия Network-First для HTML: сначала запрашиваем свежий с сервера, 
  // если нет интернета — берем из кэша
  e.respondWith(
    fetch(e.request)
      .then((networkResponse) => {
        // Если ответ хороший, обновляем кэш свежей версией
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(e.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Интернета нет (в подвале/цеху) — достаем из памяти
        return caches.match(e.request);
      })
  );
});