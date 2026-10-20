/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs on :5000 and Vite proxies /api to it, so the
// browser sees one origin (cookies and CSRF work exactly as in production,
// where Express serves the built frontend).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: process.env.VITE_API_TARGET ?? "http://localhost:5000", changeOrigin: false } },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 900 },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
