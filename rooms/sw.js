/* 회의실 예약 — 서비스 워커
   예약 데이터는 절대 캐시하지 않습니다(항상 최신을 봐야 하므로).
   캐시 대상은 앱 껍데기(HTML·아이콘·폰트)뿐입니다. */
const CACHE = 'meetingroom-v1';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(a => c.add(a).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;               // 예약 저장/조회(POST)는 그대로 통과
  const url = new URL(e.request.url);

  // 앱 본체: 네트워크 우선 → 실패(오프라인) 시 캐시
  if (e.request.mode === 'navigate' || url.pathname.endsWith('/rooms/index.html')) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  const isStatic =
    (url.origin === location.origin && /\.(png|webmanifest|css|js)$/.test(url.pathname)) ||
    url.hostname === 'cdn.jsdelivr.net';

  if (!isStatic) return;   // Supabase 등 API 요청은 캐시하지 않고 그대로 둡니다

  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(r => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return r;
      })
    )
  );
});
