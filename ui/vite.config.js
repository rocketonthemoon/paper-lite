// The editor UI: ui/ is the source, `npm run build` writes the served files to public/.
// `npm run dev:ui` serves ui/ with hot reload on :5173 and proxies everything else to the weft server on :3000.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = `http://127.0.0.1:${process.env.PORT || 3000}`;

export default defineConfig({
  root: here,
  plugins: [svelte()],
  build: {
    outDir: path.join(here, "..", "public"),
    emptyOutDir: true,
    // Keep the page's CSS as written (it is served once and gzipped; minifying would also rewrite values).
    cssMinify: false,
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/api", "/events", "/mcp", "/fonts.css", "/fonts", "/render", "/preview", "/root-css.js"].map((p) => [p, server])),
  },
});
