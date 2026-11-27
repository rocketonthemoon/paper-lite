// Checkpoints as git commits: one bare repo per project (data/projects/<id>.git), branch `main`.
// A commit's tree is `weft.json` (pages, root CSS, …) plus `nodes/<id>.json`, one file per layer, so unchanged
// layers are stored once across checkpoints and a diff shows exactly which layers changed. Checkpoint details
// live in commit-message trailers, so a repo pulled from a remote is self-describing.
import fs from "node:fs";
import git from "isomorphic-git";

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

export class CheckpointRepo {
  constructor(gitdir) {
    this.gitdir = gitdir;
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
}
