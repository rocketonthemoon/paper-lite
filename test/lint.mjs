import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jsFiles = [
  ...fs.readdirSync(ROOT).filter((f) => f.endsWith(".js") || f.endsWith(".mjs")).map((f) => path.join(ROOT, f)),
  ...fs.readdirSync(path.join(ROOT, "test"))
    .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"))
    .map((f) => path.join(ROOT, "test", f)),
  path.join(ROOT, "shared", "root-css.js"), // shared by the server and the editor
  ...fs.readdirSync(path.join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs")).map((f) => path.join(ROOT, "scripts", f)),
  path.join(ROOT, "ui", "vite.config.js"),
  ...fs.readdirSync(path.join(ROOT, "ui", "src"), { recursive: true })
    .filter((f) => f.endsWith(".js")).map((f) => path.join(ROOT, "ui", "src", f)),
];

for (const file of jsFiles) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

// The editor page's markup and CSS (its scripts are ui/src, linted above; Svelte components are checked by the build).
const html = fs.readFileSync(path.join(ROOT, "ui", "index.html"), "utf8");

const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error("Missing <style> block in ui/index.html");
let cssDepth = 0;
for (const ch of styleMatch[1]) {
  if (ch === "{") cssDepth++;
  else if (ch === "}") {
    cssDepth--;
    if (cssDepth < 0) throw new Error("Unbalanced CSS closing brace in ui/index.html");
  }
}
if (cssDepth !== 0) throw new Error(`Unbalanced CSS braces in ui/index.html (depth=${cssDepth})`);

const bodyStart = html.indexOf("<body>");
const markup = html.slice(bodyStart, html.indexOf("</body>"));
const seenIds = new Set();
for (const m of markup.matchAll(/\sid="([^"]+)"/g)) {
  if (seenIds.has(m[1])) throw new Error(`Duplicate DOM id="#${m[1]}" in ui/index.html`);
  seenIds.add(m[1]);
}

const eslintArgs = ["--yes", "eslint@9", "--config", path.join(ROOT, "eslint.config.mjs"), ...jsFiles];
if (process.platform === "win32") {
  execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npx", ...eslintArgs], { cwd: ROOT, stdio: "inherit" });
} else {
  execFileSync("npx", eslintArgs, { cwd: ROOT, stdio: "inherit" });
}

console.log(`Lint passed (${jsFiles.length} JS modules + ui/index.html CSS/DOM/${seenIds.size} IDs).`);
