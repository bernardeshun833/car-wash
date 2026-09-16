import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// GitHub Pages serves a project site from /<repo>/, not from the domain root,
// so the demo build needs that prefix baked in. Everything else (Vercel, a
// plain static host, local dev) serves from the root and leaves this alone.
const base = process.env.VITE_BASE_PATH ?? "/";

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Registered by hand in src/main.tsx, which also polls for new builds
      // and reloads when one takes over. Two registrations of the same worker
      // would race.
      injectRegister: null,
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Kumasi Car Wash POS",
        short_name: "WashPOS",
        description: "Offline-first point of sale for the wash yard",
        theme_color: "#111827",
        background_color: "#111827",
        // Must match the base, or the installed app opens outside its own
        // scope and loses the service worker.
        start_url: base,
        scope: base,
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" }
        ]
      },
      workbox: {
        // App shell only — transaction data flows through IndexedDB + the sync
        // engine (src/lib/sync.ts), never through the SW cache.
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        navigateFallback: `${base}index.html`,
        // A new build must replace the old one without being asked twice: a
        // phone in a wash yard is not somewhere anyone will think to hard
        // refresh, and a stale app that still logs washes is worse than one
        // that visibly fails.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true
      }
    })
  ],
  server: {
    host: true,
    port: 5173
  }
});
