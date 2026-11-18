import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import agents from "agents/vite";

// These plugins connect Vite's dev/build pipeline to React and Cloudflare.
// `agents()` enables the Agents SDK integration; `cloudflare()` bundles the Worker.
export default defineConfig({
  plugins: [agents(), react(), cloudflare()]
});
