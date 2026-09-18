import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  root: "src/client",
  plugins: [react()],
  resolve: { alias: { "@": resolve("src/client/src") } },
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // In development the client runs on its own port and proxies to the API,
    // so both can hot-reload without CORS or a build step in between.
    //
    // 127.0.0.1, never localhost: on Windows localhost resolves to ::1 first,
    // the server listens on IPv4, and every proxied call fails ECONNREFUSED.
    proxy: { "/api": { target: "http://127.0.0.1:4000", changeOrigin: true } },
  },
});
