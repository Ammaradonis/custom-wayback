import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      // Use our hand-written service worker (sw.ts) via injectManifest.
      // This is required because sw.ts imports workbox-* directly and
      // references self.__WB_MANIFEST for precache manifest injection.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        // Shell-only precache: ≤ 5 MB per file; skip large archives.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
      },
      manifest: {
        name: "Custom Wayback",
        short_name: "Wayback",
        description: "Fast personal Wayback Machine browser",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        orientation: "any",
        start_url: "/",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any maskable",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      devOptions: {
        // Enable SW in dev so we can test the SW registration flow.
        enabled: true,
        type: "module",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Keep the shell under 60 KB gzipped by code-splitting aggressively.
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
          // Radix UI primitives are sizeable; split them out so the app shell
          // lazy-loads them only when the Dashboard or Viewer route is loaded.
          radix: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-popover",
            "@radix-ui/react-slot",
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      "/v1": "http://localhost:8787",
      "/a": "http://localhost:8787",
    },
  },
});
