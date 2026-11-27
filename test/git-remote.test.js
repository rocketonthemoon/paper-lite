// End-to-end: two weft servers sync checkpoints through a real git smart-HTTP server (`git http-backend`
// behind a tiny Node CGI bridge that requires a token). Skipped when the git binary isn't installed.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { api, sleep, startServer } from "./helpers.js";

const TOKEN = "test-token-123";
const hasGit = (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();

// Serve every bare repo under `root` over HTTP basic auth (any username, password = TOKEN).
async function startGitHost(root) {
  const server = http.createServer((req, res) => {
    const auth = Buffer.from((req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
    if (auth.split(":").slice(1).join(":") !== TOKEN) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      return res.end("bad credentials");
    }
    const url = new URL(req.url, "http://x");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: auth.split(":")[0],
        REMOTE_ADDR: "127.0.0.1",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] || "",
        ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
      },
    });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0), sent = false;
    cgi.stdout.on("data", (chunk) => {
      if (sent) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const headers = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const i = line.indexOf(":");
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
      sent = true;
    });
    cgi.stdout.on("end", () => res.end());
    cgi.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test("checkpoints sync between two weft servers through a git host", { skip: !hasGit && "git not installed", timeout: 120_000 }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "weft-remote-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const hostRoot = path.join(tmp, "host");
  await fs.mkdir(hostRoot);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", path.join(hostRoot, "design.git")]);
  execFileSync("git", ["--git-dir", path.join(hostRoot, "design.git"), "config", "http.receivepack", "true"]);
  const host = await startGitHost(hostRoot);
  t.after(() => host.close());
  const remoteUrl = `${host.url}/design.git`;
  const remoteLog = () => execFileSync("git", ["--git-dir", path.join(hostRoot, "design.git"), "log", "--format=%s", "main"], { encoding: "utf8" }).trim().split("\n");

  const a = await startServer(path.join(tmp, "a"));
  const b = await startServer(path.join(tmp, "b"));
  t.after(() => Promise.all([a.stop(), b.stop()]));
  const A = api(a.baseUrl), B = api(b.baseUrl);

  // --- connect: validation, wrong token, then the right one
  assert.deepEqual(await A("GET", "/api/git"), { connected: false, branch: "main", checkpoints: 1 });
  await assert.rejects(A("PUT", "/api/git/remote", { url: "ftp://example.com/x.git", token: "x" }), /400/);
  await assert.rejects(A("PUT", "/api/git/remote", { url: "http://example.com/x.git", token: "x" }), /https/);
  await assert.rejects(A("PUT", "/api/git/remote", { url: "https://me:secret@github.com/x.git" }), /token field/);
  await A("PUT", "/api/git/remote", { url: remoteUrl, token: "wrong" });
  await assert.rejects(A("POST", "/api/git/push"), /401.*refused the token/);
  assert.match((await A("GET", "/api/git")).lastError, /refused the token/);

  const status = await A("PUT", "/api/git/remote", { url: remoteUrl, token: TOKEN });
  assert.equal(status.connected, true);
  assert.equal(status.hasToken, true);
  assert.equal(status.username, "git");
  assert.ok(!JSON.stringify(status).includes(TOKEN), "token never returned");
  assert.ok(!JSON.stringify(await A("GET", "/api/history")).includes(TOKEN), "token not in history payload");
  const sA = await A("GET", "/api/state");
  const remoteFile = path.join(tmp, "a", "projects", `${sA.id}.remote.json`);
  if (process.platform !== "win32") assert.equal((await fs.stat(remoteFile)).mode & 0o777, 0o600);
  // Saving settings without a token keeps the saved one.
  assert.equal((await A("PUT", "/api/git/remote", { url: remoteUrl, autoPush: false })).hasToken, true);

  // --- A designs something, checkpoints and pushes
  const board = await A("POST", "/api/nodes", { parentId: sA.rootId, tag: "div", name: "Shared board" });
  await A("POST", "/api/nodes", { parentId: board.id, tag: "p", name: "Hello", text: "Hello from A" });
  const cpA = await A("POST", "/api/checkpoints", { name: "From A" });
  const designA = (await A("GET", "/api/state")).nodes;
  assert.equal((await A("POST", "/api/git/push")).pushed, true);
  assert.deepEqual(remoteLog(), ["From A", "Project created"]);
  assert.ok((await A("GET", "/api/git")).lastPushAt);

  // --- B (a different project with its own history) pulls: A's checkpoints appear, B's design is untouched
  await B("PUT", "/api/git/remote", { url: remoteUrl, token: TOKEN });
  const sB = await B("GET", "/api/state");
  const pulled = await B("POST", "/api/git/pull");
  assert.equal(pulled.mode, "merged");
  assert.deepEqual(pulled.added.map((c) => c.name).sort(), ["From A", "Project created"]);
  assert.deepEqual((await B("GET", "/api/state")).nodes, sB.nodes, "pull does not change the design");
  await B("POST", `/api/checkpoints/${cpA.id}/restore`);
  assert.deepEqual((await B("GET", "/api/state")).nodes[board.id], designA[board.id], "restored A's design on B");
  assert.equal((await B("POST", "/api/git/pull")).mode, "up-to-date");

  // --- B pushes on top; A falls behind, makes its own checkpoint, push is rejected until it pulls
  await B("POST", "/api/checkpoints", { name: "From B" });
  assert.equal((await B("POST", "/api/git/push")).pushed, true);
  await A("POST", "/api/checkpoints", { name: "A again" });
  await assert.rejects(A("POST", "/api/git/push"), /409.*Pull first/);
  const pullA = await A("POST", "/api/git/pull");
  assert.equal(pullA.mode, "merged");
  assert.ok(pullA.added.some((c) => c.name === "From B"));
  assert.equal((await A("POST", "/api/git/push")).pushed, true);
  const names = remoteLog();
  for (const n of ["From A", "From B", "A again"]) assert.ok(names.includes(n), `${n} on the remote`);
  execFileSync("git", ["--git-dir", path.join(hostRoot, "design.git"), "fsck", "--strict"]);

  // --- auto-push: a new checkpoint reaches the remote without pressing Push
  await A("PUT", "/api/git/remote", { url: remoteUrl, autoPush: true });
  await A("POST", "/api/checkpoints", { name: "Auto pushed" });
  for (let i = 0; i < 50 && !remoteLog().includes("Auto pushed"); i++) await sleep(100);
  assert.ok(remoteLog().includes("Auto pushed"));

  // --- MCP tools see status but never the token; disconnect deletes the token file
  const rpc = async (name, args = {}) => {
    const res = await fetch(`${a.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await res.text();
    const line = raw.split(/\r?\n/).find((l) => l.startsWith("data: "));
    return JSON.parse(line ? line.slice(6) : raw).result;
  };
  const mcpStatus = await rpc("git_status");
  assert.ok(!JSON.stringify(mcpStatus).includes(TOKEN));
  assert.equal(JSON.parse(mcpStatus.content[0].text).autoPush, true);
  assert.equal(JSON.parse((await rpc("git_pull")).content[0].text).mode, "up-to-date");
  assert.deepEqual(await A("DELETE", "/api/git/remote"), { connected: false });
  await assert.rejects(fs.access(remoteFile));
  await assert.rejects(A("POST", "/api/git/push"), /400.*No git remote/);
});
