// DEV-ONLY. Vite serves dashboard/ with HMR during development and proxies
// the API to the backend so the browser still sees ONE origin (no CORS
// surface — same as production, where the app serves these exact files).
// There is no production build: the app serves these files as they are.
//
// The proxy target is the port the backend listens on (default 8000).
// Override with BACKEND_PORT=xxxx npm run dev when the backend runs elsewhere.
//
// See docs/UI-CONTRACT.md — the frozen UI is the backend's spec.
import { defineConfig } from "vite";

const backend = `http://localhost:${process.env.BACKEND_PORT || 8000}`;

export default defineConfig({
  root: "dashboard",
  server: {
    port: 5173,
    proxy: {
      "/stats": backend,
      "/v1": backend,
      "/healthz": backend,
    },
  },
});