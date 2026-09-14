import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Kumasi Car Wash POS",
        short_name: "WashPOS",
        description: "Offline-first point of sale for the wash yard",
        theme_color: "#111827",
        background_color: "#111827",
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
        navigateFallback: "/index.html"
      }
    })
  ],
  server: {
    host: true,
    port: 5173
  }
});
