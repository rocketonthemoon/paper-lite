// Runs before `npm start`: builds the editor UI (ui/ → public/) when public/ is missing or older than the UI sources.
// With production-only dependencies (no Vite) and no build, it explains what to do instead of failing obscurely.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const built = path.join(ROOT, "public", "index.html");

function newest(dir) {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}

const builtAt = fs.existsSync(built) ? fs.statSync(built).mtimeMs : 0;
if (builtAt && builtAt >= newest(path.join(ROOT, "ui"))) process.exit(0);

let hasVite = true;
try { fs.accessSync(path.join(ROOT, "node_modules", "vite", "package.json")); } catch { hasVite = false; }
if (!hasVite) {
  if (builtAt) process.exit(0); // an older build is still usable
  console.error("[weft] The editor UI isn't built and Vite isn't installed. Run `npm install` (with dev dependencies), then `npm start`.");
  process.exit(1);
}
console.log("[weft] Building the editor UI…");
execFileSync(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "ui/vite.config.js", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
