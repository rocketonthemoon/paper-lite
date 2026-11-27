// Checkpoints as git commits: one bare repo per project (data/projects/<id>.git), branch `main`.
// A commit's tree is `weft.json` (pages, root CSS, …) plus `nodes/<id>.json`, one file per layer, so unchanged
// layers are stored once across checkpoints and a diff shows exactly which layers changed. Checkpoint details
// live in commit-message trailers, so a repo pulled from a remote is self-describing.
// Remotes: any git host over HTTPS with a pasted token (GitHub, GitLab, Bitbucket, Gitea, …). The remote config
// and token live in data/projects/<id>.remote.json, outside the repo, and are never sent to the browser.
import fs from "node:fs";
import fsp from "node:fs/promises";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

const FORMAT = 1;
const BRANCH = "main";
const REF = `refs/heads/${BRANCH}`;
const AUTHOR = { name: "weft", email: "weft@localhost" };
const TRAILER_RE = /^Weft-([A-Za-z]+):\s?(.*)$/gm;

export class GitError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Write `text` to `file` via a temp file, owner-readable only (it may hold a token).
async function writePrivate(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(tmp, file);
}

function commitMessage(cp) {
  return [
    cp.name,
    "",
    `Weft-Checkpoint: ${cp.id}`,
    `Weft-Kind: ${cp.kind}`,
    `Weft-Auto: ${cp.auto ? "yes" : "no"}`,
    `Weft-At: ${cp.at}`,
    `Weft-History: ${cp.historyId || "-"}`,
    `Weft-Layers: ${cp.layerCount}`,
    "",
  ].join("\n");
}

// Commit → checkpoint entry, or null for commits weft didn't make (merges, a README from the git host, …).
function parseCommit({ oid, commit }) {
  const t = {};
  for (const [, k, v] of commit.message.matchAll(TRAILER_RE)) t[k.toLowerCase()] = v.trim();
  if (!t.checkpoint) return null;
  const kind = t.kind || "manual";
  return {
    id: t.checkpoint,
    name: commit.message.split("\n")[0].trim() || "Checkpoint",
    auto: t.auto ? t.auto === "yes" : kind !== "manual",
    kind,
    at: t.at || new Date(commit.author.timestamp * 1000).toISOString(),
    historyId: t.history && t.history !== "-" ? t.history : null,
    layerCount: Number(t.layers) || 0,
    commit: oid,
  };
}

// Default HTTPS username per host when a token is used as the password.
export function defaultUsername(url) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (host === "github.com" || host.endsWith(".github.com")) return "x-access-token";
  if (host === "gitlab.com" || host.startsWith("gitlab.")) return "oauth2";
  if (host === "bitbucket.org") return "x-token-auth";
  return "git";
}

export function validateRemoteUrl(url) {
  let u;
  try { u = new URL(String(url || "").trim()); } catch { throw new GitError(400, "Enter the repository's HTTPS URL, e.g. https://github.com/you/design.git"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new GitError(400, "Only https:// remotes are supported (http:// only for localhost)");
  if (u.username || u.password) throw new GitError(400, "Put the token in the token field, not in the URL");
  return u.toString();
}

// Turn isomorphic-git's errors into messages a person can act on.
function remoteError(err, action) {
  const code = err?.code || "";
  const status = err?.data?.statusCode;
  if (code === "HttpError" && (status === 401 || status === 403)) return new GitError(401, `The git host refused the token while trying to ${action}. Check the token and that it can read and write this repository.`);
  if (code === "HttpError" && status === 404) return new GitError(404, "Repository not found. Check the URL, and that the token can access it.");
  if (code === "PushRejectedError") return new GitError(409, "The remote has checkpoints you don't have yet. Pull first, then push.");
  if (code === "UserCanceledError") return new GitError(401, "The git host asked for credentials; add a token.");
  if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code)) return new GitError(502, `Could not reach the git host (${code}).`);
  return new GitError(502, `Could not ${action}: ${err?.message || err}`);
}

export class CheckpointRepo {
  constructor(gitdir, remoteFile) {
    this.gitdir = gitdir;
    this.remoteFile = remoteFile;
    this.queue = Promise.resolve();
    this.blobCache = new Map(); // file text -> blob oid, so unchanged layers aren't re-hashed
  }

  // Run git work one job at a time per repo.
  run(job) {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => {});
    return next;
  }

  async ensure() {
    if (fs.existsSync(`${this.gitdir}/HEAD`)) return;
    await git.init({ fs, gitdir: this.gitdir, bare: true, defaultBranch: BRANCH });
  }

  async head() {
    try { return await git.resolveRef({ fs, gitdir: this.gitdir, ref: REF }); } catch { return null; }
  }

  async blob(text) {
    let oid = this.blobCache.get(text);
    if (!oid) {
      oid = await git.writeBlob({ fs, gitdir: this.gitdir, blob: Buffer.from(text, "utf8") });
      if (this.blobCache.size > 50_000) this.blobCache.clear();
      this.blobCache.set(text, oid);
    }
    return oid;
  }

  // Commit `snapshot` ({ id, name, version, pages, rootId, nodes, rootCss }) as checkpoint `cp`. Returns the oid.
  commit(cp, snapshot) {
    return this.run(async () => {
      await this.ensure();
      const { nodes, ...rest } = snapshot;
      delete rest.version; // bumps on every edit; keeping it would make weft.json change in every checkpoint
      const nodeEntries = [];
      for (const [id, node] of Object.entries(nodes)) {
        nodeEntries.push({ mode: "100644", path: `${id}.json`, type: "blob", oid: await this.blob(`${JSON.stringify(node, null, 2)}\n`) });
      }
      const nodesTree = await git.writeTree({ fs, gitdir: this.gitdir, tree: nodeEntries });
      const docOid = await this.blob(`${JSON.stringify({ format: FORMAT, ...rest }, null, 2)}\n`);
      const tree = await git.writeTree({
        fs,
        gitdir: this.gitdir,
        tree: [
          { mode: "040000", path: "nodes", type: "tree", oid: nodesTree },
          { mode: "100644", path: "weft.json", type: "blob", oid: docOid },
        ],
      });
      const parent = await this.head();
      const when = Math.floor(Date.parse(cp.at) / 1000) || Math.floor(Date.now() / 1000);
      const sig = { ...AUTHOR, timestamp: when, timezoneOffset: 0 };
      const oid = await git.writeCommit({
        fs,
        gitdir: this.gitdir,
        commit: { message: commitMessage(cp), tree, parent: parent ? [parent] : [], author: sig, committer: sig },
      });
      await git.writeRef({ fs, gitdir: this.gitdir, ref: REF, value: oid, force: true });
      return oid;
    });
  }

  // Checkpoints on `main`, oldest first.
  list() {
    return this.run(async () => {
      if (!(await this.head())) return [];
      const seen = new Set();
      const out = [];
      for (const entry of await git.log({ fs, gitdir: this.gitdir, ref: REF })) {
        if (seen.has(entry.oid)) continue;
        seen.add(entry.oid);
        const cp = parseCommit(entry);
        if (cp) out.push(cp);
      }
      // Commits from different machines can interleave; order by the time the checkpoint was made.
      return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    });
  }

  // The document stored in a checkpoint commit.
  read(commitOid) {
    return this.run(async () => {
      const { tree } = await git.readTree({ fs, gitdir: this.gitdir, oid: commitOid });
      const docEntry = tree.find((e) => e.path === "weft.json");
      const nodesEntry = tree.find((e) => e.path === "nodes");
      if (!docEntry || !nodesEntry) throw new GitError(422, "This checkpoint commit is not a weft snapshot");
      const readText = async (oid) => Buffer.from((await git.readBlob({ fs, gitdir: this.gitdir, oid })).blob).toString("utf8");
      const doc = JSON.parse(await readText(docEntry.oid));
      delete doc.format;
      const nodes = {};
      const entries = (await git.readTree({ fs, gitdir: this.gitdir, oid: nodesEntry.oid })).tree;
      for (let i = 0; i < entries.length; i += 64) {
        const chunk = entries.slice(i, i + 64);
        const texts = await Promise.all(chunk.map((e) => readText(e.oid)));
        chunk.forEach((e, j) => { nodes[e.path.replace(/\.json$/, "")] = JSON.parse(texts[j]); });
      }
      return { ...doc, nodes };
    });
  }

  // ----------------------------------------------------------------------------- remote
  async readRemote() {
    try {
      const cfg = JSON.parse(await fsp.readFile(this.remoteFile, "utf8"));
      return cfg && cfg.url ? cfg : null;
    } catch {
      return null;
    }
  }

  // What the browser and agents may see: never the token.
  async publicRemote() {
    const cfg = await this.readRemote();
    if (!cfg) return { connected: false };
    return {
      connected: true,
      url: cfg.url,
      username: cfg.username,
      hasToken: Boolean(cfg.token),
      autoPush: Boolean(cfg.autoPush),
      lastPushAt: cfg.lastPushAt || null,
      lastPullAt: cfg.lastPullAt || null,
      lastError: cfg.lastError || null,
    };
  }

  // Save the remote. An omitted token keeps the saved one (so the UI can change settings without re-pasting it).
  async setRemote({ url, token, username, autoPush }) {
    const prev = (await this.readRemote()) || {};
    const cleanUrl = url === undefined ? prev.url : validateRemoteUrl(url);
    if (!cleanUrl) throw new GitError(400, "A repository URL is required");
    const sameUrl = cleanUrl === prev.url;
    const cfg = {
      url: cleanUrl,
      username: String(username || "").trim() || (sameUrl && prev.username) || defaultUsername(cleanUrl),
      token: token === undefined ? (sameUrl ? prev.token || "" : "") : String(token).trim(),
      autoPush: autoPush === undefined ? Boolean(prev.autoPush) : Boolean(autoPush),
      lastPushAt: sameUrl ? prev.lastPushAt || null : null,
      lastPullAt: sameUrl ? prev.lastPullAt || null : null,
    };
    await writePrivate(this.remoteFile, JSON.stringify(cfg, null, 2));
    return this.publicRemote();
  }

  async clearRemote() {
    await fsp.rm(this.remoteFile, { force: true });
    return { connected: false };
  }

  async noteRemote(patch) {
    const cfg = await this.readRemote();
    if (cfg) await writePrivate(this.remoteFile, JSON.stringify({ ...cfg, ...patch }, null, 2));
  }

  // The repo's `origin` must exist with a fetch refspec for isomorphic-git to fetch; keep its URL current.
  async remoteOpts() {
    const cfg = await this.readRemote();
    if (!cfg) throw new GitError(400, "No git remote is connected to this project");
    await this.ensure();
    await git.addRemote({ fs, gitdir: this.gitdir, remote: "origin", url: cfg.url, force: true });
    return {
      cfg,
      opts: {
        fs,
        http,
        gitdir: this.gitdir,
        url: cfg.url,
        onAuth: () => (cfg.token ? { username: cfg.username || defaultUsername(cfg.url), password: cfg.token } : { cancel: true }),
      },
    };
  }

  // Push `main`. A remote that moved ahead is rejected: pull first.
  push() {
    return this.run(async () => {
      const { opts } = await this.remoteOpts();
      const head = await this.head();
      if (!head) return { pushed: false, reason: "No checkpoints to push yet" };
      try {
        const res = await git.push({ ...opts, ref: BRANCH, remoteRef: BRANCH });
        if (res.ok === false || (res.error && res.error !== "")) throw Object.assign(new Error(res.error || "push failed"), { code: "PushRejectedError" });
      } catch (err) {
        const e = remoteError(err, "push");
        await this.noteRemote({ lastError: e.message });
        throw e;
      }
      const at = new Date().toISOString();
      await this.noteRemote({ lastPushAt: at, lastError: null });
      return { pushed: true, commit: head, at };
    });
  }

  // Fetch the remote's `main` and bring its checkpoints in. The open document is never changed: if both sides
  // have new checkpoints, a merge commit keeps this side's content and makes both sides' checkpoints reachable,
  // so they show up in the list and can be restored.
  pull() {
    return this.run(async () => {
      const { opts } = await this.remoteOpts();
      let fetched;
      try {
        fetched = await git.fetch({ ...opts, ref: BRANCH, singleBranch: true, tags: false });
      } catch (err) {
        if (err?.code === "NotFoundError") { // the remote has branches, but no `main` yet
          await this.noteRemote({ lastPullAt: new Date().toISOString(), lastError: null });
          return { pulled: false, mode: "empty-remote", added: 0 };
        }
        const e = remoteError(err, "pull");
        await this.noteRemote({ lastError: e.message });
        throw e;
      }
      const remote = fetched.fetchHead;
      const local = await this.head();
      const at = new Date().toISOString();
      const done = async (mode) => {
        await this.noteRemote({ lastPullAt: at, lastError: null });
        return { pulled: mode !== "up-to-date", mode, commit: await this.head() };
      };
      if (!remote) return done("empty-remote");
      if (!local) {
        await git.writeRef({ fs, gitdir: this.gitdir, ref: REF, value: remote, force: true });
        return done("fast-forward");
      }
      if (remote === local || (await git.isDescendent({ fs, gitdir: this.gitdir, oid: local, ancestor: remote, depth: -1 }))) return done("up-to-date");
      if (await git.isDescendent({ fs, gitdir: this.gitdir, oid: remote, ancestor: local, depth: -1 })) {
        await git.writeRef({ fs, gitdir: this.gitdir, ref: REF, value: remote, force: true });
        return done("fast-forward");
      }
      const { commit: localCommit } = await git.readCommit({ fs, gitdir: this.gitdir, oid: local });
      const sig = { ...AUTHOR, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
      const merge = await git.writeCommit({
        fs,
        gitdir: this.gitdir,
        commit: { message: "Bring in checkpoints from the remote\n", tree: localCommit.tree, parent: [local, remote], author: sig, committer: sig },
      });
      await git.writeRef({ fs, gitdir: this.gitdir, ref: REF, value: merge, force: true });
      return done("merged");
    });
  }
}
