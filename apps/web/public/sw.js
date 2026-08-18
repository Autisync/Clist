/*
 * FieldReady service worker — minimal, hand-rolled app-shell cache.
 *
 * Scope: only the /field/* technician PWA. Office/desktop pages are not
 * cached (they assume a live connection). All actual offline WRITES (sync
 * mutations, checklist updates, test results, closeout, etc.) go through
 * the IndexedDB-backed queue in src/lib/offline-queue.ts, NOT through this
 * worker — this file only makes GET navigations/assets available offline
 * so the app shell itself can boot with no network.
 *
 * Strategy:
 *  - App-shell routes are pre-cached on install.
 *  - Navigations (HTML documents) under /field/*: network-first, falling
 *    back to the cached shell when offline.
 *  - Everything else same-origin GET (JS/CSS chunks, manifest, icon):
 *    stale-while-revalidate — serve from cache immediately if present,
 *    and refresh the cache in the background from the network.
 *  - POST/PATCH/etc. and any /api/* request are never intercepted; they
 *    always go straight to the network (or fail, and the offline queue
 *    handles retry).
 */

const CACHE_VERSION = "fieldready-v1";
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Minimum viable app shell: the two routes explicitly required, plus the
// manifest/icon so the installed-app chrome also works offline.
const APP_SHELL_URLS = ["/field/home", "/field/login", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // Cache each shell URL individually (not cache.addAll) so a single
      // route that 404s/fails (e.g. login not reachable pre-auth in some
      // configs) doesn't abort caching the rest of the shell.
      await Promise.all(
        APP_SHELL_URLS.map(async (url) => {
          try {
            const res = await fetch(url, { cache: "no-store" });
            if (res && res.ok) {
              await cache.put(url, res.clone());
            }
          } catch {
            // Offline at install time, or route not available yet — skip.
            // Runtime caching will pick it up on first successful visit.
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("fieldready-") && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

function isNavigationRequest(request) {
  return request.mode === "navigate" || (request.method === "GET" && request.headers.get("accept")?.includes("text/html"));
}

async function networkFirst(request) {
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // Last resort: fall back to the /field/home shell page so the app
    // shell still boots offline even for an unvisited /field/* route.
    const shellFallback = await caches.match("/field/home");
    if (shellFallback) return shellFallback;
    throw new Error("offline and no cached shell available");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  return cached || (await networkPromise) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Only ever handle GET. Mutations always go straight to the network
  // (and through the app's own IndexedDB offline queue if that fails).
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Never intercept API calls — they must reflect real server state or
  // fail fast so the caller's own retry/queue logic can react.
  if (url.pathname.startsWith("/api/")) return;

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return;

  const underField = url.pathname.startsWith("/field");
  const isShellAsset = APP_SHELL_URLS.includes(url.pathname);

  if (isNavigationRequest(request) && (underField || url.pathname === "/")) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (underField || isShellAsset || url.pathname.startsWith("/_next/")) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
