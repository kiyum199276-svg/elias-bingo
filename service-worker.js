"use strict";
const CACHE_NAME = "elias-bingo-pwa-v3";
const APP_SHELL = [
  "/", "/index.html", "/offline.html", "/manifest.webmanifest",
  "/icons/elias-bingo.svg",
  "/ELIAS_BINGO_300_CARDS_MOBILE.html", "/register.html",
  "/admin-live.html", "/owner.html"
];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("elias-bingo-pwa-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
  }
});