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
  path.join(ROOT, "public", "root-css.js"), // shared by the server and the editor
];

for (const file of jsFiles) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error("Missing inline <script> in public/index.html");

const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error("Missing <style> block in public/index.html");
let cssDepth = 0;
for (const ch of styleMatch[1]) {
  if (ch === "{") cssDepth++;
  else if (ch === "}") {
    cssDepth--;
    if (cssDepth < 0) throw new Error("Unbalanced CSS closing brace in public/index.html");
  }
}
if (cssDepth !== 0) throw new Error(`Unbalanced CSS braces in public/index.html (depth=${cssDepth})`);

const bodyStart = html.indexOf("<body>");
const scriptStart = html.indexOf("<script>");
const markup = html.slice(bodyStart, scriptStart);
const seenIds = new Set();
for (const m of markup.matchAll(/\sid="([^"]+)"/g)) {
  if (seenIds.has(m[1])) throw new Error(`Duplicate DOM id="#${m[1]}" in public/index.html`);
  seenIds.add(m[1]);
}

const tmpUi = path.join(ROOT, ".tmp-ui-lint.js");
fs.writeFileSync(tmpUi, scriptMatch[1], "utf8");
try {
  execFileSync(process.execPath, ["--check", tmpUi], { stdio: "inherit" });
  const eslintArgs = [
    "--yes",
    "eslint@9",
    "--config",
    path.join(ROOT, "eslint.config.mjs"),
    ...jsFiles,
    tmpUi,
  ];
  if (process.platform === "win32") {
    execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npx", ...eslintArgs], { cwd: ROOT, stdio: "inherit" });
  } else {
    execFileSync("npx", eslintArgs, { cwd: ROOT, stdio: "inherit" });
  }
} finally {
  fs.rmSync(tmpUi, { force: true });
}

console.log(`Lint passed (${jsFiles.length} JS modules + public/index.html CSS/DOM/${seenIds.size} IDs/inline script).`);
