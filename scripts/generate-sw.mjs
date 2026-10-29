import { readdir, writeFile } from "node:fs/promises";

const assets = await readdir(new URL("../dist/assets/", import.meta.url));
const urls = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./ada.svg", "./night.png", "./usdcx.png", ...assets.map((name) => `./assets/${name}`)];
const source = `const CACHE = "cardano-watch-${Date.now()}";\n` +
  `const ASSETS = ${JSON.stringify(urls)};\n` +
  `self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));\n` +
  `self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));\n` +
  `self.addEventListener("fetch", event => { const url = new URL(event.request.url); if (url.origin !== self.location.origin || event.request.method !== "GET") return; event.respondWith(caches.match(event.request).then(hit => hit || fetch(event.request))); });\n`;
await writeFile(new URL("../dist/sw.js", import.meta.url), source);
