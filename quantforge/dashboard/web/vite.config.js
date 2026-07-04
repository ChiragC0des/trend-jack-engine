import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Production build is served as static files by the dashboard server itself
// (dashboard/server/server.js). The dev-server proxy below exists only for
// `npm run dev` frontend work against a running dashboard server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:4100",
      "/ws": { target: "ws://localhost:4100", ws: true },
    },
  },
});
