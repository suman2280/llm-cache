// DEV-ONLY. Vite serves dashboard/ with HMR during development and proxies
// the API to the FastAPI app so the browser still sees ONE origin (no CORS
// surface — same as production, where FastAPI mounts dashboard/ directly).
// There is no production build: `uv run uvicorn llm_cache.app:app` serves
// these exact files. See README ("no build step in production").
import { defineConfig } from "vite";

export default defineConfig({
  root: "dashboard",
  server: {
    port: 5173,
    proxy: {
      "/stats": "http://localhost:8000",
      "/v1": "http://localhost:8000",
      "/healthz": "http://localhost:8000",
    },
  },
});
