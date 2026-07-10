import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");

  return {
    root,
    envDir: projectRoot,
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: {
        "/v1": {
          target: env.API_TARGET ?? "http://127.0.0.1:3000",
          changeOrigin: true
        }
      }
    },
    build: {
      outDir: "dist",
      emptyOutDir: true
    }
  };
});
