// weft (formerly Paper-Lite): HTML/CSS design canvas with an MCP-first API.
// One process: static UI, projects/pages/checkpoints/sessions/fonts on disk, SSE live sync, Streamable HTTP MCP at /mcp.
import express from "express";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  HttpError, ID_RE, SLOT_NAME_RE, SVG_TAGS, VOID_TAGS, cleanName, cleanText, didYouMean, holdsNoText, cleanTag, emptyPage, emptyProject, lenientMerge, mergeAttrs, mergeStyles,
  newId, normalizeProject, emptyRootCss, mergeRootCss, rootCssText, rootCssFlat, rootBaseClasses, definedRootClasses,
  isBaseRule, rootClassesIn, cleanClassList, varsIn, analyzeRootCssUsage, pruneUnusedRootCss,
} from "./model.js";
import { FontLibrary, familiesIn, renameWithRetry } from "./fonts.js";
import { htmlToSpecs } from "./html-import.js";
import { Renderer } from "./renderer.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./mcp-tools.js";
import { CheckpointRepo } from "./checkpoint-store.js";
import { MAX_ICONS, expandIconSpecs, parseSvgIcon } from "./icons.js";
import { analyzeDesignLint, exportDesignTokens, importDesignTokens } from "./design-tokens.js";
import { createComponentEngine, extractComponentOverridesFromSpec, trackNodeOverrides } from "./components.js";
import { revertPatches } from "./selective-revert.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); // the repo root (data/, public/, shared/)
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const WORKSPACE_FILE = path.join(DATA_DIR, "workspace.json");
const LEGACY_FILE = path.join(DATA_DIR, "canvas.json");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const ALLOWED_HOSTS = new Set(
  ["localhost", "127.0.0.1", "[::1]", ...(process.env.ALLOWED_HOSTS || "").split(",")]
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);
const HISTORY_LIMIT = 60;
const HISTORY_LOG_LIMIT = 5000; // edit-log lines kept per project (metadata only; undo stays in memory)
// Edits update memory at once; their disk writes are coalesced and land at most this often.
const PERSIST_THROTTLE_MS = Number(process.env.PERSIST_THROTTLE_MS ?? 300);
// get_computed_styles asks an open editor tab first (it already has the artboard laid out); this long for an answer
// before falling back to headless Chrome. 0 turns it off.
const TAB_MEASURE_MS = Number(process.env.TAB_MEASURE_MS ?? 500);
const SESSION_GAP_MS = 120_000;
const CURSOR_TTL_MS = 8_000;
const PRESENCE_TTL = 90_000;
const PROJECT_COLORS = ["#9ad6a4", "#7aa7ff", "#f5b971", "#f4a7c3", "#c3b5f5"];
const AGENT_COLORS = ["#d97757", "#4c7dff", "#2c7a3f", "#9a5b12", "#7c3aed", "#c2417e"];
const PKG_VERSION = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")).version;

// ---------------------------------------------------------------------------
// Workspace: projects on disk, one open project in memory (`state`)
// ---------------------------------------------------------------------------
let workspace = { activeProjectId: null, projects: [] }; // projects: [{ id, name, accentColor, createdAt, updatedAt }]
let state; // { version, id, name, pages: [pageRootId], rootId: activePageId, nodes, comments }
let historyTimeline = []; // [{ id, patch: { before, after }, source, tool, target, label, nodeIds, layerCount, at }]
let historyCursor = -1;
let projectCheckpoints = []; // [{ id, name, auto, kind, at, historyId, layerCount, commit }] — snapshots live in git
let projectRemote = { connected: false }; // open project's git remote, as the browser may see it (no token)
let projectSessions = []; // [{ id, projectId, projectName, source, agentName, title, artboard, startedAt, updatedAt, editCount, toolCounts, checkpointId, live, reverted }]
// Last write per agent session: each agent's run gets its own "Before agent run" checkpoint, so every agent's
// activity session can be reverted, not only the first agent's.
const lastMcpWriteAt = new Map();
const mcpAgentKey = () => mcpContextStore.getStore()?.agent?.id || "default";
let lastCheckpointHistoryKey = null;
const pendingSessionTitles = new Map(); // agent session id -> a title set before that agent's first edit

const mcpContextStore = new AsyncLocalStorage();
const sseClients = new Set();
const editorClients = new Set(); // the SSE streams of editor tabs (not previews), which can measure layers
const fonts = new FontLibrary(path.join(DATA_DIR, "fonts"));
let diskQueue = Promise.resolve();
const sessionsCache = new Map(); // projectId -> sessions list, for projects that aren't open

const projectFile = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.json`);
};
// Before checkpoints moved to git they were stored here, snapshots included; read once to migrate.
const legacyCheckpointFile = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.checkpoints.json`);
};
const repoDir = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.git`);
};
// Git remote settings and token for a project. Kept outside the repo so they are never pushed.
const remoteFile = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.remote.json`);
};
const repos = new Map(); // projectId -> CheckpointRepo (one git job queue per repo)
function repoOf(id) {
  if (!repos.has(id)) repos.set(id, new CheckpointRepo(repoDir(id), remoteFile(id)));
  return repos.get(id);
}
const sessionsFile = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.sessions.json`);
};
// Append-only edit log: one JSON line per history step ({ id, at, source, tool, target, label, nodeIds }), no patches.
// It answers "when did this layer change?" across restarts; undo/redo still only use the in-memory timeline.
const historyLogFile = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.history.jsonl`);
};
const metaOf = (id) => {
  const m = workspace.projects.find((p) => p.id === id);
  if (!m) throw new HttpError(404, `Project "${id}" not found${didYouMean("project", id, workspace.projects)}`);
  return m;
};

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(2).toString("hex")}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await renameWithRetry(tmp, file);
}

// All disk writes are serialized so files are never written concurrently.
function queueDisk(job) {
  diskQueue = diskQueue.then(job).catch((err) => console.error("[weft] write failed:", err.message));
  return diskQueue;
}

// Throttled writes: a burst of edits to the same file becomes one write. `getText` runs at flush time so the
// latest content is written; returning null skips the write. flushWrites() runs before anything reads these
// files back or switches project, and on shutdown.
const pendingWrites = new Map(); // key -> { file, getText }
let flushTimer = null;
function scheduleWrite(key, file, getText) {
  pendingWrites.set(key, { file, getText });
  if (PERSIST_THROTTLE_MS <= 0) return flushWrites();
  if (!flushTimer) flushTimer = setTimeout(flushWrites, PERSIST_THROTTLE_MS);
  return diskQueue;
}
const pendingLogLines = new Map(); // projectId -> [jsonLine]
function scheduleLogAppend(id, entry) {
  const line = JSON.stringify(entry);
  pendingLogLines.set(id, [...(pendingLogLines.get(id) || []), line]);
  if (PERSIST_THROTTLE_MS <= 0) return flushWrites();
  if (!flushTimer) flushTimer = setTimeout(flushWrites, PERSIST_THROTTLE_MS);
  return diskQueue;
}
function flushWrites() {
  clearTimeout(flushTimer);
  flushTimer = null;
  for (const [id, lines] of pendingLogLines) {
    queueDisk(() => fs.appendFile(historyLogFile(id), `${lines.join("\n")}\n`, "utf8"));
  }
  pendingLogLines.clear();
  const jobs = [...pendingWrites.values()];
  pendingWrites.clear();
  for (const { file, getText } of jobs) {
    const text = getText();
    if (text != null) queueDisk(() => writeAtomic(file, text));
  }
  return diskQueue;
}

const saveWorkspace = () => {
  const text = JSON.stringify(workspace, null, 2);
  return queueDisk(() => writeAtomic(WORKSPACE_FILE, text));
};
const saveSessions = (id = state.id, list = projectSessions) =>
  scheduleWrite(`sessions:${id}`, sessionsFile(id), () => JSON.stringify(list));

// A project's sessions: the open project's live list, or the cached / on-disk list of another project.
async function sessionsOf(id) {
  if (id === state?.id) return projectSessions;
  return storedSessions(id);
}
async function storedSessions(id) {
  if (!sessionsCache.has(id)) {
    const list = await readJsonSafe(sessionsFile(id), []);
    sessionsCache.set(id, Array.isArray(list) ? list.filter((x) => x && x.id) : []);
  }
  return sessionsCache.get(id);
}

async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

const previewCache = new Map(); // id -> { key, data }

function layerCountOf(doc = state) {
  if (!doc) return 0;
  return Math.max(0, Object.keys(doc.nodes).length - doc.pages.length);
}

function projectSummary(doc) {
  const pages = doc.pages.length;
  const artboards = doc.pages.reduce((a, pid) => a + (doc.nodes[pid]?.children?.length || 0), 0);
  const layers = layerCountOf(doc);
  const bg = doc.nodes[doc.rootId]?.styles?.backgroundColor || "#eef2f6";
  return { pages, artboards, layers, bg };
}

function buildPreview(doc) {
  const page = doc.nodes[doc.rootId] || doc.nodes[doc.pages[0]];
  const bg = page?.styles?.backgroundColor || "#eef2f6";
  const sorted = [...(page?.children || [])].sort((a, b) => {
    const sa = doc.nodes[a]?.styles || {}, sb = doc.nodes[b]?.styles || {};
    const ya = Math.round((parseFloat(sa.top) || 0) / 300), yb = Math.round((parseFloat(sb.top) || 0) / 300);
    return ya !== yb ? ya - yb : (parseFloat(sa.left) || 0) - (parseFloat(sb.left) || 0);
  });
  const nodes = {};
  const rootIds = [];
  let total = 0;
  const copySub = (id) => {
    const n = doc.nodes[id];
    if (!n) return;
    nodes[id] = n;
    total += 1;
    for (const c of n.children) copySub(c);
  };
  const countSub = (id) => 1 + (doc.nodes[id]?.children || []).reduce((a, c) => a + countSub(c), 0);
  for (const id of sorted) {
    if (rootIds.length >= 6) break;
    const sz = countSub(id);
    if (rootIds.length > 0 && total + sz > 600) continue;
    copySub(id);
    rootIds.push(id);
  }
  return { bg, rootIds, nodes, rootCss: doc.rootCss || emptyRootCss() };
}

async function projectPreview(id) {
  const meta = metaOf(id);
  const key = `${meta.updatedAt}:${meta.bg || ""}`;
  const cached = previewCache.get(id);
  if (cached?.key === key) return cached.data;
  const doc = state?.id === id ? state : await readProject(id);
  const data = buildPreview(doc);
  if (previewCache.size > 40) previewCache.delete(previewCache.keys().next().value);
  previewCache.set(id, { key, data });
  return data;
}

function persist({ touchUpdatedAt = true } = {}) {
  const id = state.id;
  const meta = workspace.projects.find((p) => p.id === id);
  if (meta) {
    if (touchUpdatedAt) {
      meta.updatedAt = new Date().toISOString();
      delete meta.placeholder; // edited: it's the user's project now
    }
    Object.assign(meta, projectSummary(state));
  }
  previewCache.delete(id);
  scheduleWrite(`project:${id}`, projectFile(id), () => (state?.id === id ? JSON.stringify(state) : null));
  const out = scheduleWrite("workspace", WORKSPACE_FILE, () => JSON.stringify(workspace, null, 2));
  sendEvent("projects", { projects: projectList() });
  return out;
}

function projectList() {
  const hasEditing = presenceList().length > 0;
  return [...workspace.projects]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((p) => ({
      ...p,
      accentColor: p.accentColor || PROJECT_COLORS[0],
      active: p.id === state?.id,
      agentEditing: p.id === state?.id && hasEditing,
    }));
}

async function loadWorkspace() {
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  try {
    workspace = JSON.parse(await fs.readFile(WORKSPACE_FILE, "utf8"));
  } catch {
    workspace = { activeProjectId: null, projects: [] };
    if (existsSync(LEGACY_FILE)) {
      // One-time migration of the original single-canvas file into a project.
      const id = newId();
      const doc = normalizeProject(JSON.parse(await fs.readFile(LEGACY_FILE, "utf8")), { id, name: "My canvas", warnings: [] });
      await writeAtomic(projectFile(id), JSON.stringify(doc));
      const now = new Date().toISOString();
      workspace.projects.push({ id, name: doc.name, accentColor: PROJECT_COLORS[0], createdAt: now, updatedAt: now, ...projectSummary(doc) });
      workspace.activeProjectId = id;
      await fs.rename(LEGACY_FILE, `${LEGACY_FILE}.migrated`);
    }
  }
  workspace.projects = workspace.projects.filter((p) => ID_RE.test(p.id) && existsSync(projectFile(p.id)));
  let backfilled = false;
  workspace.projects.forEach((p, idx) => {
    if (!p.accentColor) {
      p.accentColor = PROJECT_COLORS[idx % PROJECT_COLORS.length];
      backfilled = true;
    }
  });
  for (const p of workspace.projects) {
    if (p.artboards === undefined || p.pages === undefined || p.layers === undefined) {
      try {
        const doc = normalizeProject(JSON.parse(await fs.readFile(projectFile(p.id), "utf8")), { id: p.id, name: p.name, warnings: [] });
        Object.assign(p, projectSummary(doc));
        backfilled = true;
      } catch {}
    }
  }
  // Older versions created the startup "Untitled" project without the placeholder flag. Only the workspace's first
  // project can be that one (the New project dialog also suggests "Untitled", so the name alone proves nothing), and
  // only while it is still empty and has never been edited.
  const first = workspace.projects.reduce((a, p) => (!a || String(p.createdAt) < String(a.createdAt) ? p : a), null);
  if (first && !first.placeholder && !workspace.placeholderChecked && first.name === "Untitled" && first.createdAt === first.updatedAt && !first.layers && !first.artboards && first.pages === 1) {
    first.placeholder = true;
  }
  if (!workspace.placeholderChecked) {
    workspace.placeholderChecked = true; // one-time migration: projects created from now on carry the flag themselves
    backfilled = true;
  }
  if (backfilled) await saveWorkspace();
  if (!workspace.projects.length) {
    await createProject("Untitled", { open: false, placeholder: true });
  }
  // Open the last active project; if its file is unreadable, fall back to the next one instead of failing to boot.
  const active = workspace.projects.find((p) => p.id === workspace.activeProjectId);
  for (const p of [...new Set([active, ...workspace.projects].filter(Boolean))]) {
    try {
      await openProject(p.id, "init");
      return;
    } catch (err) {
      console.error(`[weft] could not open project "${p.name}" (${p.id}): ${err.message}`);
    }
  }
  await createProject("Untitled", { open: true, source: "init", placeholder: true });
}

async function readProject(id) {
  const meta = metaOf(id);
  if (state?.id === id) return structuredClone(state);
  await flushWrites();
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(projectFile(id), "utf8"));
  } catch (err) {
    throw new HttpError(422, `Project "${meta.name}" could not be read (${err.code === "ENOENT" ? "file missing" : "file is corrupt"})`);
  }
  return normalizeProject(raw, { id, name: meta.name, warnings: [] });
}

function docSnapshot(doc = state) {
  return structuredClone({
    version: doc.version,
    id: doc.id,
    name: doc.name,
    pages: doc.pages,
    rootId: doc.rootId,
    nodes: doc.nodes,
    rootCss: doc.rootCss || emptyRootCss(),
    icons: doc.icons || {},
    components: doc.components || {},
  });
}

function publicCheckpoints(list = projectCheckpoints) {
  return list.map(({ id, name, auto, kind, at, historyId, layerCount, commit }) => ({ id, name, auto, kind, at, historyId, layerCount, commit: commit || null }));
}

function historyPayload() {
  const entries = historyTimeline.map(({ patch: _p, ...rest }) => rest);
  return { entries, cursor: historyCursor, limit: HISTORY_LIMIT, checkpoints: publicCheckpoints(), remote: projectRemote };
}

function sendHistory() {
  sendEvent("history", historyPayload());
}

// Move checkpoints from the old JSON file (full snapshots) into the project's git repo, oldest first.
// Safe to re-run after a crash: checkpoints already in the repo are skipped. The old file is kept as *.migrated.
async function migrateLegacyCheckpoints(id) {
  const file = legacyCheckpointFile(id);
  if (!existsSync(file)) return;
  const legacy = await readJsonSafe(file, []);
  const repo = repoOf(id);
  const have = new Set((await repo.list()).map((c) => c.id));
  for (const c of Array.isArray(legacy) ? legacy : []) {
    if (!c?.id || !c.snapshot || have.has(c.id)) continue;
    const { snapshot, ...cp } = c;
    await repo.commit({ ...cp, name: cleanName(cp.name, "Checkpoint"), kind: cp.kind || (cp.auto ? "auto" : "manual") }, snapshot);
  }
  await fs.rename(file, `${file}.migrated`);
}

// Keep the edit log bounded: on open, rewrite it with only the newest HISTORY_LOG_LIMIT lines.
function trimHistoryLog(id) {
  return queueDisk(async () => {
    let text;
    try { text = await fs.readFile(historyLogFile(id), "utf8"); } catch { return; }
    const lines = text.split("\n").filter(Boolean);
    if (lines.length > HISTORY_LOG_LIMIT) await writeAtomic(historyLogFile(id), `${lines.slice(-HISTORY_LOG_LIMIT).join("\n")}\n`);
  });
}

// Search the edit log (and anything not yet flushed) by layer id, time range and source; newest first.
async function searchHistory({ nodeId, after, before, source, limit } = {}) {
  await flushWrites();
  const afterMs = after ? Date.parse(after) : -Infinity;
  const beforeMs = before ? Date.parse(before) : Infinity;
  if (Number.isNaN(afterMs) || Number.isNaN(beforeMs)) throw new HttpError(400, "after / before must be ISO dates");
  if (source && source !== "mcp" && source !== "you") throw new HttpError(400, 'source must be "mcp" or "you"');
  const max = Math.max(1, Math.min(Number(limit) || 100, 1000));
  let text = "";
  try { text = await fs.readFile(historyLogFile(state.id), "utf8"); } catch {}
  const live = new Set(historyTimeline.map((e) => e.id));
  const out = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    if (!lines[i]) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    const t = Date.parse(e.at);
    if (!(t >= afterMs && t <= beforeMs)) continue;
    if (source && e.source !== source) continue;
    if (nodeId && !(e.nodeIds || []).includes(nodeId)) continue;
    out.push({ ...e, inUndoHistory: live.has(e.id) });
  }
  return { entries: out, count: out.length, limit: max };
}

async function loadProjectExtras(id) {
  trimHistoryLog(id);
  try {
    await migrateLegacyCheckpoints(id);
    projectCheckpoints = await repoOf(id).list();
  } catch (err) {
    console.error(`[weft] could not read checkpoints for ${id}: ${err.message}`);
    projectCheckpoints = [];
  }
  projectRemote = await repoOf(id).publicRemote();
  projectSessions = await storedSessions(id);
  sessionsCache.delete(id);
}

async function openProject(id, source = "api") {
  metaOf(id);
  if (state?.id === id) return state;
  const doc = await readProject(id);
  if (state) {
    flushWrites();
    sessionsCache.set(state.id, projectSessions);
  }
  state = doc;
  projectSessions = []; // until loadProjectExtras() reads this project's own sessions
  historyTimeline = [];
  historyCursor = -1;
  lastMcpWriteAt.clear();
  lastCheckpointHistoryKey = null;
  pendingSessionTitles.clear();
  await loadProjectExtras(id);
  presence.clear();
  agentCursors.clear();
  uiSelection = { ids: [], at: 0 };
  workspace.activeProjectId = id;
  await saveWorkspace();
  broadcast(source);
  sendEvent("projects", { projects: projectList() });
  sendEvent("presence", presencePayload());
  sendEvent("comments", { comments: state.comments || [] });
  sendHistory();
  sendActivity();
  return state;
}

function makeCheckpointEntry(name, { auto = false, kind = auto ? "auto" : "manual", doc = state, historyId = null } = {}) {
  return {
    id: newId(),
    name: cleanName(name, "Checkpoint"),
    auto: Boolean(auto),
    kind,
    at: new Date().toISOString(),
    historyId,
    layerCount: layerCountOf(doc),
    commit: null,
  };
}

// Commit a checkpoint to the project's repo in the background. The document is copied now, so later edits
// don't leak into it; restore waits for the commit (pendingCommits) if it hasn't landed yet.
const pendingCommits = new Map(); // checkpointId -> Promise<oid>
function commitCheckpoint(projectId, cp, doc) {
  const job = repoOf(projectId).commit(cp, docSnapshot(doc))
    .then((oid) => {
      cp.commit = oid;
      autoPush(projectId);
      return oid;
    })
    .finally(() => pendingCommits.delete(cp.id));
  pendingCommits.set(cp.id, job);
  job.catch((err) => console.error(`[weft] checkpoint "${cp.name}" could not be saved: ${err.message}`));
  return job;
}

// The startup "Untitled" project exists only so the editor always has something open. It is a placeholder until it is
// edited or renamed; the first project the user creates replaces it, so it doesn't linger as an empty extra card.
async function dropPlaceholders(keepId, source) {
  for (const p of [...workspace.projects]) {
    if (p.placeholder && p.id !== keepId && workspace.projects.length > 1) await deleteProject(p.id, source);
  }
}

async function createProject(name, { open = true, source = "api", placeholder = false } = {}) {
  const id = newId();
  const doc = emptyProject(id, cleanName(name, "Untitled"));
  const now = new Date().toISOString();
  const initCp = makeCheckpointEntry("Project created", { auto: true, kind: "init", doc, historyId: null });
  await queueDisk(async () => {
    await writeAtomic(projectFile(id), JSON.stringify(doc));
    await writeAtomic(sessionsFile(id), JSON.stringify([]));
  });
  await commitCheckpoint(id, initCp, doc);
  sessionsCache.set(id, []);
  const accentColor = PROJECT_COLORS[workspace.projects.length % PROJECT_COLORS.length];
  workspace.projects.push({ id, name: doc.name, accentColor, createdAt: now, updatedAt: now, ...(placeholder && { placeholder: true }), ...projectSummary(doc) });
  await saveWorkspace();
  if (open) await openProject(id, source);
  else sendEvent("projects", { projects: projectList() });
  if (!placeholder) await dropPlaceholders(id, source);
  return { id, name: doc.name };
}

async function renameProject(id, name, source = "api") {
  const meta = metaOf(id);
  meta.name = cleanName(name, meta.name);
  delete meta.placeholder;
  meta.updatedAt = new Date().toISOString();
  if (state.id === id) {
    state.name = meta.name;
    persist();
    broadcastPatch(source, []);
  } else {
    const doc = await readProject(id);
    doc.name = meta.name;
    await queueDisk(() => writeAtomic(projectFile(id), JSON.stringify(doc)));
    await saveWorkspace();
  }
  sendEvent("projects", { projects: projectList() });
  sendActivity();
  return { id, name: meta.name };
}

async function duplicateProject(id, name) {
  const doc = await readProject(id);
  const copyId = newId();
  doc.id = copyId;
  doc.name = cleanName(name, uniqueProjectName(`${metaOf(id).name} copy`));
  const now = new Date().toISOString();
  const initCp = makeCheckpointEntry("Project created", { auto: true, kind: "init", doc, historyId: null });
  await queueDisk(async () => {
    await writeAtomic(projectFile(copyId), JSON.stringify(doc));
    await writeAtomic(sessionsFile(copyId), JSON.stringify([]));
  });
  await commitCheckpoint(copyId, initCp, doc);
  sessionsCache.set(copyId, []);
  const accentColor = PROJECT_COLORS[workspace.projects.length % PROJECT_COLORS.length];
  workspace.projects.push({ id: copyId, name: doc.name, accentColor, createdAt: now, updatedAt: now, ...projectSummary(doc) });
  await saveWorkspace();
  sendEvent("projects", { projects: projectList() });
  return { id: copyId, name: doc.name };
}

// "Main copy", then "Main copy 2", "Main copy 3", … so duplicates stay tell-apart in lists.
function uniqueProjectName(base) {
  const taken = new Set(workspace.projects.map((p) => p.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

async function deleteProject(id, source = "api") {
  metaOf(id);
  if (workspace.projects.length === 1) throw new HttpError(400, "Cannot delete the only project");
  // Switch away first so there is never a moment without an open project (requests and timers read `state`).
  if (state.id === id) {
    const next = projectList().find((p) => p.id !== id);
    await openProject(next.id, source);
  }
  workspace.projects = workspace.projects.filter((p) => p.id !== id);
  previewCache.delete(id);
  sessionsCache.delete(id);
  for (const key of [`project:${id}`, `sessions:${id}`]) pendingWrites.delete(key);
  await queueDisk(async () => {
    await fs.rm(projectFile(id), { force: true });
    await repoOf(id).queue; // let in-flight git work finish before removing the repo
    await fs.rm(repoDir(id), { recursive: true, force: true });
    await fs.rm(legacyCheckpointFile(id), { force: true });
    await fs.rm(remoteFile(id), { force: true });
    await fs.rm(sessionsFile(id), { force: true });
    await fs.rm(historyLogFile(id), { force: true });
  });
  repos.delete(id);
  await saveWorkspace();
  sendEvent("projects", { projects: projectList() });
  sendActivity();
  return { deleted: id };
}

// ---------------------------------------------------------------------------
// Live sync, labelled undo history, checkpoints & activity sessions
// ---------------------------------------------------------------------------
function sendEvent(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
// Full document: on connect and when another project opens. Edits send only what changed (broadcastPatch).
const broadcast = (source) => {
  lastSentRootCss = state.rootCss;
  lastSentComponents = state.components;
  sendEvent("state", { source, state });
};

// Send browsers the nodes that changed ({ id: node | null } for deleted), the page list, and the root CSS when
// it changed. A browser applies it only on top of `baseVersion`; one that missed a step reloads the full state.
let lastSentRootCss = null;
let lastSentComponents = null;
function broadcastPatch(source, ids, baseVersion = state.version) {
  const nodes = {};
  for (const id of ids) nodes[id] = state.nodes[id] ?? null;
  const rootCss = state.rootCss !== lastSentRootCss ? state.rootCss : undefined;
  const components = state.components !== lastSentComponents ? state.components : undefined;
  lastSentRootCss = state.rootCss;
  lastSentComponents = state.components;
  sendEvent("patch", {
    source,
    id: state.id,
    baseVersion,
    version: state.version,
    name: state.name,
    pages: state.pages,
    rootId: state.rootId,
    ...(rootCss ? { rootCss } : {}),
    ...(components ? { components } : {}),
    nodes,
  });
}

function currentHistoryId() {
  return historyCursor >= 0 ? historyTimeline[historyCursor]?.id || null : null;
}

function currentStateKey() {
  return `${historyCursor}:${currentHistoryId() || "init"}:${state?.version || 0}`;
}

function createCheckpoint(name, { auto = false, kind = auto ? "auto" : "manual" } = {}) {
  const cp = makeCheckpointEntry(name, { auto, kind, doc: state, historyId: currentHistoryId() });
  projectCheckpoints.push(cp);
  lastCheckpointHistoryKey = currentStateKey();
  commitCheckpoint(state.id, cp, state).then(sendHistory, () => {});
  sendHistory();
  return cp;
}

function ensureAgentStartCheckpoint(beforeState) {
  const now = Date.now();
  const last = lastMcpWriteAt.get(mcpAgentKey()) || 0;
  const isNewRun = last === 0 || (now - last >= SESSION_GAP_MS);
  if (!isNewRun) return null;
  const curKey = currentStateKey();
  if (lastCheckpointHistoryKey === curKey && projectCheckpoints.length) {
    return projectCheckpoints[projectCheckpoints.length - 1].id;
  }
  const hasInitAtZero =
    historyTimeline.length === 0 &&
    projectCheckpoints.length === 1 &&
    projectCheckpoints[0].kind === "init" &&
    projectCheckpoints[0].layerCount === layerCountOf(beforeState);
  if (hasInitAtZero) {
    lastCheckpointHistoryKey = curKey;
    return projectCheckpoints[0].id;
  }
  const cp = makeCheckpointEntry("Before agent run", {
    auto: true,
    kind: "agent-start",
    doc: beforeState,
    historyId: currentHistoryId(),
  });
  projectCheckpoints.push(cp);
  lastCheckpointHistoryKey = curKey;
  commitCheckpoint(state.id, cp, beforeState).catch(() => {});
  return cp.id;
}

// ---------------------------------------------------------------------------
// Edit tracking: undo stores only the layers an edit touched, not two copies of the whole document.
// While an edit runs, `state.nodes` is a proxy that copies each node the first time the edit reads or writes it.
// Afterwards those copies are compared with the live nodes; the ones that differ become the undo patch.
// ---------------------------------------------------------------------------
const docMeta = (doc) => ({ pages: [...doc.pages], rootCss: structuredClone(doc.rootCss || emptyRootCss()), icons: structuredClone(doc.icons || {}), components: structuredClone(doc.components || {}) });
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function beginTracking() {
  const raw = state.nodes;
  const touched = new Map(); // id -> copy of the node before the edit, or null if it didn't exist
  const remember = (id) => {
    if (typeof id === "string" && !touched.has(id)) touched.set(id, Object.hasOwn(raw, id) ? structuredClone(raw[id]) : null);
  };
  const proxy = new Proxy(raw, {
    get(t, k, r) {
      if (typeof k === "string" && Object.hasOwn(t, k)) remember(k);
      return Reflect.get(t, k, r);
    },
    set(t, k, v, r) { remember(k); return Reflect.set(t, k, v, r); },
    defineProperty(t, k, d) { remember(k); return Reflect.defineProperty(t, k, d); },
    deleteProperty(t, k) { remember(k); return Reflect.deleteProperty(t, k); },
  });
  state.nodes = proxy;
  return { raw, proxy, touched, meta: docMeta(state) };
}

// Undo an unfinished edit (it threw): put every touched node and the page list back.
function rollbackTracking(tr) {
  state.nodes = tr.raw; // even if the edit swapped in a new map, the original is intact apart from touched nodes
  for (const [id, prev] of tr.touched) {
    if (prev) state.nodes[id] = prev;
    else delete state.nodes[id];
  }
  state.pages = tr.meta.pages;
  state.rootCss = tr.meta.rootCss;
  state.icons = tr.meta.icons;
  state.components = tr.meta.components;
}

// Finish an edit: returns { before, after } with only the nodes that changed ({ id: node | null }) and the
// page list / root CSS when those changed.
function endTracking(tr) {
  const replaced = state.nodes !== tr.proxy;
  if (!replaced) state.nodes = tr.raw;
  const before = { nodes: {} }, after = { nodes: {} };
  const ids = replaced ? new Set([...Object.keys(tr.raw), ...Object.keys(state.nodes)]) : tr.touched.keys();
  for (const id of ids) {
    const prev = tr.touched.has(id) ? tr.touched.get(id) : (Object.hasOwn(tr.raw, id) ? tr.raw[id] : null);
    const cur = Object.hasOwn(state.nodes, id) ? state.nodes[id] : null;
    if (!prev && !cur) continue;
    if (prev && cur && sameJson(prev, cur)) continue;
    before.nodes[id] = prev;
    after.nodes[id] = cur ? structuredClone(cur) : null;
  }
  const meta = docMeta(state);
  if (!sameJson(tr.meta, meta)) {
    before.meta = tr.meta;
    after.meta = meta;
  }
  return { before, after };
}

// A read-only view of the document as it was before `patch`, for labels (which layer, which artboard).
function beforeView(patch) {
  const nodes = new Proxy({}, {
    get: (_t, k) => (Object.hasOwn(patch.before.nodes, k) ? patch.before.nodes[k] || undefined : state.nodes[k]),
  });
  return { pages: patch.before.meta?.pages || state.pages, rootId: state.rootId, nodes };
}

// Apply one side of a history patch to the live document.
function applyPatchSide(side) {
  for (const [id, n] of Object.entries(side.nodes)) {
    if (n) state.nodes[id] = structuredClone(n);
    else delete state.nodes[id];
  }
  if (side.meta) {
    state.pages = [...side.meta.pages];
    state.rootCss = structuredClone(side.meta.rootCss);
    if (side.meta.icons !== undefined) state.icons = structuredClone(side.meta.icons);
    state.components = structuredClone(side.meta.components || {});
  }
  if (!state.pages.includes(state.rootId)) state.rootId = state.pages[0];
}

function artboardNameForNodes(nodeIds, doc = state, prevDoc = null) {
  for (const id of nodeIds) {
    const src = doc.nodes[id] ? doc : (prevDoc?.nodes[id] ? prevDoc : null);
    if (!src) continue;
    let cur = src.nodes[id];
    if (src.pages.includes(cur.id)) continue;
    while (cur && cur.parentId && !src.pages.includes(cur.parentId)) {
      cur = src.nodes[cur.parentId];
    }
    if (cur && src.pages.includes(cur.parentId)) return cur.name;
  }
  const activePage = doc.nodes[doc.rootId];
  const firstBoard = activePage?.children?.[0];
  if (firstBoard && doc.nodes[firstBoard]) return doc.nodes[firstBoard].name;
  return activePage?.name || "Page 1";
}

function targetSummary(nodeIds, before, after, meta) {
  if (meta?.target) return meta.target;
  const store = mcpContextStore.getStore();
  if (store?.target) return store.target;
  const nonPages = nodeIds.filter((id) => !after.pages.includes(id) && !before.pages.includes(id));
  const idsToUse = nonPages.length ? nonPages : nodeIds;
  // Filter to top-most roots in this edit when write_html/delete inserts a tree.
  const idSet = new Set(idsToUse);
  const topRoots = idsToUse.filter((id) => {
    const n = after.nodes[id] || before.nodes[id];
    return n && !idSet.has(n.parentId);
  });
  const roots = topRoots.length ? topRoots : idsToUse;
  if (roots.length === 1) {
    const n = after.nodes[roots[0]] || before.nodes[roots[0]];
    return cleanName(n?.name, "Layer").slice(0, 36);
  }
  if (roots.length > 1) return `${roots.length} layers`;
  const page = after.nodes[after.rootId] || before.nodes[before.rootId];
  return cleanName(page?.name, "Canvas").slice(0, 36);
}

function recordSessionActivity({ histSource, tool, artboard, checkpointId, at }) {
  const nowMs = Date.parse(at);
  const store = mcpContextStore.getStore();
  const agentName = histSource === "mcp" ? (store?.agent?.name || "Claude") : "You";
  const agentId = histSource === "mcp" ? (store?.agent?.id || null) : null;
  // The most recent session of this same author (you, or this agent session), so two agents working at the same
  // time each get their own session instead of one merged one that the last of them names.
  const last = [...projectSessions].reverse().find((x) => x.source === histSource && (x.agentId ?? null) === agentId);
  const canAppend =
    last &&
    !last.reverted &&
    last.projectId === state.id &&
    (nowMs - Date.parse(last.updatedAt)) < SESSION_GAP_MS;
  const pendingTitle = pendingSessionTitles.get(agentId) || null;

  if (canAppend) {
    last.updatedAt = at;
    last.editCount += 1;
    last.toolCounts[tool] = (last.toolCounts[tool] || 0) + 1;
    if (artboard) last.artboard = artboard;
    if (histSource === "mcp") {
      last.live = true;
      last.agentName = agentName;
      if (pendingTitle && !last.title) {
        last.title = pendingTitle;
        pendingSessionTitles.delete(agentId);
      }
    }
  } else {
    projectSessions.push({
      id: newId(),
      projectId: state.id,
      projectName: state.name,
      source: histSource,
      agentName,
      ...(agentId ? { agentId } : {}),
      title: histSource === "mcp" ? pendingTitle : null,
      artboard: artboard || "Page 1",
      startedAt: at,
      updatedAt: at,
      editCount: 1,
      toolCounts: { [tool]: 1 },
      checkpointId: checkpointId || null,
      live: histSource === "mcp",
      reverted: false,
    });
    if (histSource === "mcp") pendingSessionTitles.delete(agentId);
    if (projectSessions.length > 60) projectSessions.splice(0, projectSessions.length - 60);
  }
  saveSessions();
  sendActivity();
}

async function allActivitySessions() {
  const nameById = new Map(workspace.projects.map((p) => [p.id, p.name]));
  const colorById = new Map(workspace.projects.map((p) => [p.id, p.accentColor || PROJECT_COLORS[0]]));
  const now = Date.now();
  const all = [];
  for (const p of workspace.projects) {
    const list = await sessionsOf(p.id);
    for (const s of list) {
      if (!s || !s.id) continue;
      const isLive = Boolean(
        s.source === "mcp" &&
        s.live &&
        !s.reverted &&
        s.projectId === state?.id &&
        (presence.size > 0 || now - Date.parse(s.updatedAt) < SESSION_GAP_MS),
      );
      all.push({
        ...s,
        projectName: nameById.get(s.projectId) || s.projectName || "Project",
        accentColor: colorById.get(s.projectId) || PROJECT_COLORS[0],
        live: isLive,
      });
    }
  }
  all.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return all.slice(0, 50);
}

function sendActivity() {
  allActivitySessions()
    .then((sessions) => sendEvent("activity", { sessions }))
    .catch(() => {});
}

// Every edit goes through here: snapshot for undo, apply, bump version, save, push to browsers.
// Inside batch() edits apply directly and the batch records a single undo step.
let batchDepth = 0;
let batchStartCheckpointId = null;

function mutate(source, fn, meta = null) {
  if (batchDepth) return fn(state);
  const histSource = source === "mcp" ? "mcp" : "you";
  const startCpId = histSource === "mcp" ? ensureAgentStartCheckpoint(state) : null;
  const tr = beginTracking();
  let result;
  try {
    result = fn(state);
  } catch (err) {
    rollbackTracking(tr);
    throw err;
  }
  commit(source, endTracking(tr), meta, startCpId);
  return result;
}

function batch(source, fn, meta = null) {
  if (batchDepth) return fn();
  const histSource = source === "mcp" ? "mcp" : "you";
  batchStartCheckpointId = histSource === "mcp" ? ensureAgentStartCheckpoint(state) : null;
  const tr = beginTracking();
  batchDepth += 1;
  let result;
  try {
    result = fn();
  } catch (err) {
    rollbackTracking(tr); // all-or-nothing
    throw err;
  } finally {
    batchDepth -= 1;
  }
  const cpId = batchStartCheckpointId;
  batchStartCheckpointId = null;
  commit(source, endTracking(tr), meta, cpId);
  return result;
}

function safePageOf(id) {
  let n = state?.nodes?.[id];
  while (n?.parentId && state.nodes[n.parentId]) n = state.nodes[n.parentId];
  return n && isPage(n.id) ? n.id : null;
}

function syncCommentsWithState(stepNum) {
  const list = state?.comments;
  if (!list?.length) return false;
  let changed = false;
  for (const c of list) {
    const n = state.nodes[c.nodeId];
    if (n) {
      if (c.layerName !== n.name) { c.layerName = n.name; changed = true; }
      const pid = safePageOf(c.nodeId);
      if (pid && c.pageId !== pid) { c.pageId = pid; changed = true; }
      if (c.deletedInStep !== undefined) { delete c.deletedInStep; changed = true; }
    } else if (c.deletedInStep === undefined) {
      c.deletedInStep = Math.max(1, stepNum);
      changed = true;
    }
  }
  return changed;
}

function commit(source, patch, meta = null, startCpId = null) {
  if (historyCursor < historyTimeline.length - 1) {
    historyTimeline.length = historyCursor + 1;
  }
  state.version += 1;
  const histSource = source === "mcp" ? "mcp" : "you";
  const store = histSource === "mcp" ? mcpContextStore.getStore() : null;
  const tool = meta?.tool || store?.tool || (histSource === "mcp" ? "mcp_edit" : "Edit");
  const before = beforeView(patch);
  const nodeIds = meta?.nodeIds?.length
    ? meta.nodeIds
    : Object.keys(patch.before.nodes).filter((id) => !state.pages.includes(id) && !before.pages.includes(id)).slice(0, 60);
  const target = targetSummary(nodeIds, before, state, meta);
  const label = meta?.label || `${tool} · ${target}`;
  const at = new Date().toISOString();
  const entry = {
    id: newId(),
    patch,
    source: histSource,
    ...(histSource === "mcp" ? { agentId: mcpContextStore.getStore()?.agent?.id || null, agentName: mcpContextStore.getStore()?.agent?.name || "Claude" } : {}),
    tool,
    target,
    label,
    nodeIds,
    ...(meta?.entryExtra || {}), // e.g. { kind: "agent-undo", revertOf } for a selective undo
    layerCount: layerCountOf(state),
    at,
  };
  historyTimeline.push(entry);
  if (historyTimeline.length > HISTORY_LIMIT) historyTimeline.shift();
  scheduleLogAppend(state.id, { id: entry.id, at, source: histSource, tool, target, label, nodeIds });
  historyCursor = historyTimeline.length - 1;
  const commentsChanged = syncCommentsWithState(historyCursor + 1);

  if (histSource === "mcp") lastMcpWriteAt.set(mcpAgentKey(), Date.now());
  const artboard = meta?.artboard || artboardNameForNodes(nodeIds, state, before);
  recordSessionActivity({ histSource, tool, artboard, checkpointId: startCpId, at });

  persist();
  broadcastPatch(source, Object.keys(patch.after.nodes), state.version - 1);
  sendHistory();
  if (commentsChanged) sendEvent("comments", { comments: state.comments });
}

// Walk the live document to history position `target` (-1 = before the first entry), one patch at a time.
// Returns the ids of every node the move touched.
function moveHistoryCursor(target) {
  const touched = new Set();
  const apply = (side) => {
    for (const id of Object.keys(side.nodes)) touched.add(id);
    applyPatchSide(side);
  };
  while (historyCursor > target) {
    apply(historyTimeline[historyCursor].patch.before);
    historyCursor -= 1;
  }
  while (historyCursor < target) {
    historyCursor += 1;
    apply(historyTimeline[historyCursor].patch.after);
  }
  state.version += 1;
  return touched;
}

function afterHistoryMove(source, touched) {
  const commentsChanged = syncCommentsWithState(Math.max(1, historyCursor + 1));
  persist();
  broadcastPatch(source, touched, state.version - 1);
  sendHistory();
  if (commentsChanged) sendEvent("comments", { comments: state.comments });
}

function stepHistory(source, direction) {
  if (direction === "undo") {
    if (historyCursor < 0) return false;
    afterHistoryMove(source, moveHistoryCursor(historyCursor - 1));
  } else {
    if (historyCursor >= historyTimeline.length - 1) return false;
    afterHistoryMove(source, moveHistoryCursor(historyCursor + 1));
  }
  return true;
}

// undo / redo for agents. They report which step moved, and refuse to move a step the user made unless asked:
// an agent undoing "its last change" must not silently throw away an edit the user made in between.
// undo / redo for agents, like per-user undo in multiplayer editors (and `git revert`): an agent only ever takes back
// its own steps, and never anyone else's work. When the agent's step is the latest edit overall it is a plain history
// step; when someone edited after it, only that step's own changes are reverted, field by field, and whatever others
// changed since is kept and reported (selective-revert.js). includeUserEdits / includeOtherAgentsEdits still let an
// agent move someone else's step at the top of the history when the user asks for that.
function agentHistoryStep(direction, { includeUserEdits = false, includeOtherAgentsEdits = false } = {}) {
  const me = mcpContextStore.getStore()?.agent?.id || null;
  // Steps recorded before agents were told apart (no agentId) count as this agent's.
  const mine = (e) => e.source === "mcp" && (!e.agentId || !me || e.agentId === me);
  const key = direction === "undo" ? "undone" : "redone";
  const top = historyTimeline[direction === "undo" ? historyCursor : historyCursor + 1];
  if (top && !mine(top) && ((top.source !== "mcp" && includeUserEdits) || (top.source === "mcp" && includeOtherAgentsEdits))) {
    stepHistory("mcp", direction);
    return { [key]: true, mode: "history", step: stepInfo(top, mine) };
  }
  return direction === "undo" ? agentUndo(mine) : agentRedo(mine);
}

const stepInfo = (e, mine) => {
  const by = e.source !== "mcp" ? "user" : mine(e) ? "agent" : "another agent";
  return { label: e.label, by, ...(by === "another agent" ? { agent: e.agentName } : {}), at: e.at };
};

function agentUndo(mine) {
  let idx = -1;
  for (let i = historyCursor; i >= 0; i--) {
    const e = historyTimeline[i];
    if (mine(e) && !e.revertedBy && e.kind !== "agent-undo") { idx = i; break; }
  }
  if (idx === -1) return { undone: false, reason: "Nothing of yours to undo in the recent history" };
  const e = historyTimeline[idx];
  if (idx === historyCursor) {
    stepHistory("mcp", "undo");
    return { undone: true, mode: "history", step: stepInfo(e, mine) };
  }
  const res = selectiveRevert([e], { source: "mcp", tool: "undo", label: `Undo · ${e.label}`, kind: "agent-undo", mine });
  e.revertedBy = res.entryId;
  return { undone: true, mode: "selective", step: stepInfo(e, mine), ...res.report };
}

function agentRedo(mine) {
  const next = historyTimeline[historyCursor + 1];
  if (next && mine(next)) {
    stepHistory("mcp", "redo");
    return { redone: true, mode: "history", step: stepInfo(next, mine) };
  }
  // The latest selective undo of this agent that wasn't redone yet, unless the agent has edited since.
  let undoEntry = null;
  for (let i = historyCursor; i >= 0; i--) {
    const e = historyTimeline[i];
    if (!mine(e)) continue;
    if (e.kind === "agent-undo") { if (!e.redoneBy) { undoEntry = e; break; } continue; }
    if (e.kind === "agent-redo") continue;
    break;
  }
  if (!undoEntry) return { redone: false, reason: "Nothing of yours to redo" };
  const target = historyTimeline.find((x) => x.id === undoEntry.revertOf?.[0]);
  const res = selectiveRevert([undoEntry], { source: "mcp", tool: "redo", label: `Redo · ${target?.label || undoEntry.label}`, kind: "agent-redo", mine });
  undoEntry.redoneBy = res.entryId;
  return { redone: true, mode: "selective", step: target ? stepInfo(target, mine) : { label: undoEntry.label }, ...res.report };
}

// Revert history entries' own changes as one new step. Throws (and records nothing) when nothing could be reverted.
function selectiveRevert(entries, { source, tool, label, kind, mine = () => true }) {
  let out;
  mutate(source, (s) => {
    out = revertPatches(s, entries.map((e) => e.patch));
    if (!out.reverted.length) {
      const err = new HttpError(409, `Nothing was changed: everything ${entries.length === 1 ? `"${entries[0].label}"` : "those steps"} did has been edited since by someone else${describeSkipped(out, entries, mine)}`);
      err.details = { skipped: annotateSkipped(out.skipped, entries, mine) };
      throw err;
    }
    return out;
  }, { tool, target: label, label, entryExtra: { kind, revertOf: entries.map((e) => e.id) } });
  const report = {
    changed: out.reverted.length,
    ...(out.skipped.length ? { kept: annotateSkipped(out.skipped, entries, mine) } : {}),
    ...(out.metaSkipped.length ? { keptShared: out.metaSkipped } : {}),
  };
  if (report.kept || report.keptShared) report.note = "Some changes were kept because someone else edited them afterwards; see kept";
  return { entryId: historyTimeline[historyCursor].id, report };
}

// Who changed each skipped layer after the reverted steps (for the agent and the dashboard to act on).
function annotateSkipped(skipped, entries, mine) {
  const from = Math.min(...entries.map((e) => historyTimeline.indexOf(e)).filter((i) => i >= 0));
  return skipped.map((sk) => {
    const by = new Set();
    for (let i = from + 1; i <= historyCursor; i++) {
      const e = historyTimeline[i];
      if (!e || entries.includes(e) || mine(e)) continue;
      if (Object.hasOwn(e.patch.after.nodes, sk.id)) by.add(e.source === "mcp" ? e.agentName || "another agent" : "you");
    }
    return { layer: sk.name, id: sk.id, fields: sk.fields, ...(by.size ? { editedBy: [...by] } : {}) };
  });
}
function describeSkipped(out, entries, mine) {
  const ann = annotateSkipped(out.skipped, entries, mine);
  return ann.length ? ` (${ann.slice(0, 3).map((k) => `${k.layer}${k.editedBy ? ` by ${k.editedBy.join(", ")}` : ""}`).join("; ")})` : "";
}

function jumpHistory(source, targetIndex) {
  if (!Number.isInteger(targetIndex) || targetIndex < -1 || targetIndex >= historyTimeline.length) {
    throw new HttpError(400, "Invalid history index");
  }
  if (targetIndex === historyCursor) return { cursor: historyCursor, moved: 0 };
  const moved = Math.abs(targetIndex - historyCursor);
  afterHistoryMove(source, moveHistoryCursor(targetIndex));
  return { cursor: historyCursor, moved };
}

function undoLastAgentRun(source) {
  let lastMcp = -1;
  for (let i = historyCursor; i >= 0; i--) {
    if (historyTimeline[i].source === "mcp") { lastMcp = i; break; }
  }
  if (lastMcp === -1) return { ok: false, undone: 0, cursor: historyCursor };
  // The latest agent's run only: stop where another agent session's steps begin.
  const runAgent = historyTimeline[lastMcp].agentId ?? null;
  let firstMcp = lastMcp;
  while (firstMcp > 0 && historyTimeline[firstMcp - 1].source === "mcp" && (historyTimeline[firstMcp - 1].agentId ?? null) === runAgent) firstMcp -= 1;
  const res = jumpHistory(source, firstMcp - 1);
  return { ok: true, undone: res.moved, cursor: res.cursor };
}

async function restoreCheckpointById(id, source = "api") {
  const cp = projectCheckpoints.find((c) => c.id === id);
  if (!cp) throw new HttpError(404, `Checkpoint "${id}" not found${didYouMean("checkpoint", id, projectCheckpoints)}`);
  const projectId = state.id;
  const oid = cp.commit || (await pendingCommits.get(cp.id));
  if (!oid) throw new HttpError(409, `Checkpoint "${cp.name}" was not saved and can't be restored`);
  const snap = await repoOf(projectId).read(oid);
  if (state.id !== projectId) throw new HttpError(409, "The open project changed while restoring; try again");
  mutate(source, (s) => {
    s.pages = snap.pages;
    s.rootId = snap.pages.includes(s.rootId) ? s.rootId : snap.rootId;
    s.nodes = snap.nodes;
    if (snap.rootCss) s.rootCss = snap.rootCss;
    s.icons = snap.icons || {};
    s.components = snap.components ? structuredClone(snap.components) : {};
    return cp;
  }, { tool: "Restore checkpoint", target: cp.name, label: `Restore checkpoint · ${cp.name}` });
  return { id: cp.id, name: cp.name };
}

// ---------------------------------------------------------------------------
// Git remote: push/pull a project's checkpoint repo to GitHub, GitLab, Bitbucket, Gitea, … over HTTPS
// ---------------------------------------------------------------------------
async function refreshRemote(projectId) {
  if (state?.id !== projectId) return;
  projectRemote = await repoOf(projectId).publicRemote();
  sendHistory();
}

const gitApi = {
  status: async () => ({ ...(await repoOf(state.id).publicRemote()), branch: "main", checkpoints: projectCheckpoints.length }),
  connect: async (body = {}) => {
    const id = state.id;
    const out = await repoOf(id).setRemote({ url: body.url, token: body.token, username: body.username, autoPush: body.autoPush });
    await refreshRemote(id);
    return out;
  },
  disconnect: async () => {
    const id = state.id;
    const out = await repoOf(id).clearRemote();
    await refreshRemote(id);
    return out;
  },
  push: async () => {
    const id = state.id;
    try {
      return await repoOf(id).push();
    } finally {
      await refreshRemote(id);
    }
  },
  // Pull brings in checkpoints only; the open document stays as it is until one is restored.
  pull: async () => {
    const id = state.id;
    try {
      const repo = repoOf(id);
      const res = await repo.pull();
      const before = new Set(projectCheckpoints.map((c) => c.id));
      const list = await repo.list();
      if (state.id === id) projectCheckpoints = list;
      return { ...res, added: list.filter((c) => !before.has(c.id)).map(({ id: cid, name, at }) => ({ id: cid, name, at })) };
    } finally {
      await refreshRemote(id);
    }
  },
};

// After a checkpoint commit: push in the background when the project's remote asks for it.
async function autoPush(projectId) {
  const repo = repoOf(projectId);
  const cfg = await repo.readRemote();
  if (!cfg?.autoPush || !cfg.token) return;
  try {
    await repo.push();
  } catch (err) {
    console.error(`[weft] auto-push failed: ${err.message}`);
  }
  await refreshRemote(projectId).catch(() => {});
}

// ---------------------------------------------------------------------------
// Agent presence, live agent cursors & UI selection
// ---------------------------------------------------------------------------
const presence = new Map(); // nodeId -> { label, at }
const agentSessions = new Map(); // sessionKey -> { id, name, color }
const agentCursors = new Map(); // agentId -> { id, name, color, nodeIds, tool, detail, mode, at }
let uiSelection = { ids: [], at: 0 };

function friendlyAgentName(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Claude";
  if (/^claude([_-]?code)?$/i.test(s)) return "Claude";
  return s.slice(0, 32);
}

// A color no agent active on the canvas right now is using, so agents working side by side never share one. Falls
// back to cycling by session count once every color is taken.
const AGENT_ACTIVE_MS = 30 * 60_000; // a session that made a request this recently still "owns" its color
function freeAgentColor() {
  const now = Date.now();
  const busy = new Set([...agentSessions.values()].filter((x) => now - (x.seenAt || 0) <= AGENT_ACTIVE_MS).map((x) => x.color));
  const free = AGENT_COLORS.find((c) => !busy.has(c));
  if (free) return free;
  // All taken: reuse the color whose most recent holder has been idle longest.
  const lastSeen = new Map(AGENT_COLORS.map((c) => [c, 0]));
  for (const x of agentSessions.values()) lastSeen.set(x.color, Math.max(lastSeen.get(x.color) || 0, x.seenAt || 0));
  return [...lastSeen].sort((a, b) => a[1] - b[1])[0][0];
}

// "Claude", then "Claude 2", "Claude 3", … while other active sessions already use the name, so two agents in the
// same canvas can be told apart by label as well as by color.
function distinctAgentName(base) {
  const now = Date.now();
  const taken = new Set([...agentSessions.values()].filter((x) => now - (x.seenAt || 0) <= AGENT_ACTIVE_MS).map((x) => x.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

// Who is calling. The MCP endpoint is stateless, so the server hands every client its own Mcp-Session-Id on
// initialize (see the /mcp handler); clients send it back on each request. Without it, every instance of the same
// client (same User-Agent) would be one agent: one color, and each could undo the others' steps.
function agentFromRequest(req, initClientName = null, issuedKey = null) {
  const key = req.get("x-weft-client") || issuedKey || req.get("mcp-session-id") || req.get("user-agent") || "mcp-default";
  let sess = agentSessions.get(key);
  if (!sess) {
    sess = {
      id: newId(),
      name: distinctAgentName(friendlyAgentName(initClientName)),
      color: freeAgentColor(),
      seenAt: Date.now(),
    };
    agentSessions.set(key, sess);
    // Every new MCP session adds one; keep the most recent few hundred so a long-running server doesn't grow forever.
    if (agentSessions.size > 500) agentSessions.delete(agentSessions.keys().next().value);
  } else {
    agentSessions.delete(key); // most recently used last, so eviction drops idle sessions first
    agentSessions.set(key, sess);
    sess.seenAt = Date.now();
    if (initClientName && friendlyAgentName(initClientName) !== sess.name.replace(/ \d+$/, "")) sess.name = distinctAgentName(friendlyAgentName(initClientName));
  }
  return sess;
}

function presenceList() {
  const now = Date.now();
  for (const [id, p] of presence) if (now - p.at > PRESENCE_TTL || !state?.nodes[id]) presence.delete(id);
  return [...presence].map(([id, p]) => ({ id, label: p.label, color: p.color }));
}

function agentCursorList() {
  const now = Date.now();
  const out = [];
  for (const [id, c] of agentCursors) {
    if (now - c.at > CURSOR_TTL_MS) {
      agentCursors.delete(id);
      continue;
    }
    const validIds = (c.nodeIds || []).filter((nid) => state?.nodes[nid]);
    if (!validIds.length) {
      agentCursors.delete(id);
      continue;
    }
    out.push({ id: c.id, name: c.name, color: c.color, nodeIds: validIds, tool: c.tool, detail: c.detail, mode: c.mode || "edit", at: c.at });
  }
  return out;
}

function presencePayload() {
  return { nodes: presenceList(), agents: agentCursorList() };
}

function emitPresence(projectsMaybeChanged = false) {
  sendEvent("presence", presencePayload());
  if (projectsMaybeChanged) sendEvent("projects", { projects: projectList() });
}

function setAgentCursor({ nodeIds, tool, detail, mode = "edit" }) {
  const store = mcpContextStore.getStore();
  const agent = store?.agent || { id: "default", name: "Claude", color: AGENT_COLORS[0] };
  const validIds = (nodeIds || []).filter((id) => state.nodes[id] && !isPage(id));
  if (!validIds.length) return;
  agentCursors.set(agent.id, {
    id: agent.id,
    name: agent.name,
    color: agent.color,
    nodeIds: validIds,
    tool: tool || store?.tool || "edit",
    detail: detail || store?.detail || "",
    mode,
    at: Date.now(),
  });
}

function touch(nodeIds, toolName = null, detail = null) {
  const store = mcpContextStore.getStore();
  const label = store?.agent?.name || "Agent";
  const agentId = store?.agent?.id || null;
  const color = store?.agent?.color || AGENT_COLORS[0];
  const wasEmpty = presenceList().length === 0;
  const now = Date.now();
  for (const id of nodeIds) if (state.nodes[id] && !isPage(id)) presence.set(id, { label, agentId, color, at: now });
  setAgentCursor({ nodeIds, tool: toolName || store?.tool, detail: detail || store?.detail, mode: "edit" });
  const nowNonEmpty = presenceList().length > 0;
  emitPresence(wasEmpty !== nowNonEmpty);
}

function look(nodeIds, toolName = null, detail = null) {
  const store = mcpContextStore.getStore();
  setAgentCursor({ nodeIds, tool: toolName || store?.tool, detail: detail || store?.detail, mode: "look" });
  emitPresence(false);
}

function finishWorking(nodeIds) {
  const wasNonEmpty = presenceList().length > 0;
  const store = mcpContextStore.getStore();
  // Only this agent's outlines: another agent still working must keep showing what it's on.
  const mine = (id) => !store?.agent?.id || presence.get(id)?.agentId === store.agent.id;
  if (!nodeIds?.length) {
    for (const id of [...presence.keys()]) if (mine(id)) presence.delete(id);
    if (store?.agent?.id) agentCursors.delete(store.agent.id);
    else agentCursors.clear();
  } else {
    nodeIds.forEach((id) => { if (mine(id)) presence.delete(id); });
    if (store?.agent?.id) agentCursors.delete(store.agent.id);
  }
  const nowEmpty = presenceList().length === 0;
  if (nowEmpty) {
    let updated = false;
    for (const s of projectSessions) {
      if (s.source === "mcp" && s.live) { s.live = false; updated = true; }
    }
    if (updated) { saveSessions(); sendActivity(); }
  }
  emitPresence(wasNonEmpty && nowEmpty);
}

setInterval(() => {
  const pBefore = presence.size;
  const cBefore = agentCursors.size;
  const pAfter = presenceList().length;
  const cAfter = agentCursorList().length;
  if (pAfter !== pBefore || cAfter !== cBefore) {
    emitPresence(pBefore > 0 && pAfter === 0);
  }
}, 1000).unref();

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
const isPage = (id) => state.pages.includes(id);

function getPage(id) {
  if (!isPage(id)) {
    const hint = didYouMean("page", id, state.pages.map((pid) => state.nodes[pid]));
    const notPage = !hint && state.nodes[id] ? ` (that's a layer, not a page; its page is ${pageOf(id)})` : "";
    throw new HttpError(404, `Page "${id}" not found${hint || notPage}`);
  }
  return state.nodes[id];
}

function pageOf(id) {
  let n = getNode(id);
  while (n.parentId) {
    if (!state.nodes[n.parentId]) throw new HttpError(404, `Parent "${n.parentId}" not found`);
    n = state.nodes[n.parentId];
  }
  return n.id;
}

function createPage(name, source = "api") {
  const nextName = cleanName(name, `Page ${state.pages.length + 1}`);
  return mutate(source, (s) => {
    const page = emptyPage(nextName);
    s.nodes[page.id] = page;
    s.pages.push(page.id);
    s.rootId = page.id;
    return page;
  }, { tool: source === "mcp" ? "create_page" : "New page", target: nextName });
}

function switchPage(id, source = "api") {
  getPage(id);
  if (state.rootId !== id) {
    state.rootId = id;
    uiSelection = { ids: [], at: 0 };
    persist({ touchUpdatedAt: false });
    broadcastPatch(source, []);
  }
  return state.nodes[id];
}

function updatePage(id, { name, index }, source = "api") {
  const page = getPage(id);
  return mutate(source, (s) => {
    if (name !== undefined) s.nodes[id].name = cleanName(name, s.nodes[id].name);
    if (Number.isInteger(index)) {
      s.pages = s.pages.filter((p) => p !== id);
      s.pages.splice(Math.max(0, Math.min(index, s.pages.length)), 0, id);
    }
    return s.nodes[id];
  }, { tool: source === "mcp" ? "update_page" : "Update page", target: name !== undefined ? cleanName(name, page.name) : page.name });
}

function deletePage(id, source = "api") {
  const page = getPage(id);
  if (state.pages.length === 1) throw new HttpError(400, "A project needs at least one page");
  return mutate(source, (s) => {
    const drop = (nid) => {
      for (const c of s.nodes[nid].children) drop(c);
      for (const cm of s.comments || []) {
        if (cm.nodeId === nid) {
          if (!cm.layerName) cm.layerName = s.nodes[nid].name;
          if (!cm.pageId) cm.pageId = id;
        }
      }
      delete s.nodes[nid];
    };
    drop(id);
    s.pages = s.pages.filter((p) => p !== id);
    if (s.rootId === id) s.rootId = s.pages[0];
    return { deleted: id };
  }, { tool: source === "mcp" ? "delete_page" : "Delete page", target: page.name });
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------
function getNode(id) {
  const n = state.nodes[id];
  if (!n) {
    const hint = state ? didYouMean("layer", id, Object.values(state.nodes).filter((x) => !state.pages.includes(x.id))) : "";
    throw new HttpError(404, `Node "${id}" not found in the open project "${state?.name}"${hint || " (it was deleted, or it belongs to another project)"}`);
  }
  return n;
}

function isAncestor(ancestorId, id) {
  for (let cur = state.nodes[id]; cur; cur = state.nodes[cur.parentId]) if (cur.id === ancestorId) return true;
  return false;
}

// Which layers can hold which, so agents and API clients can't put content where it silently won't render:
// HTML inside SVG, SVG shapes outside an <svg>/<g>, children of <img>/<hr>/<br> or of a shape, artboards inside
// layers. (The UI's drag rules are a little stricter still, e.g. no <svg> nested in an <svg>, which does render.)
// Returns why `childTag` can't go in `parent`, or null when it can.
function nestError(parent, childTag, { artboard = false } = {}) {
  const childSvg = SVG_TAGS.has(childTag);
  if (isPage(parent.id)) return childSvg && childTag !== "svg" ? `<${childTag}> must be inside an <svg> or <g>` : null;
  if (artboard) return "Artboards stay at the top level of a page; move it to a page or move its layers instead";
  if (VOID_TAGS.has(parent.tag)) return `<${parent.tag}> can't contain child layers`;
  if (SVG_TAGS.has(parent.tag)) {
    if (parent.tag !== "svg" && parent.tag !== "g") return `<${parent.tag}> can't contain child layers; use an <svg> or <g>`;
    if (!childSvg) return `<${childTag}> can't go inside <${parent.tag}>; only SVG elements can`;
    return null;
  }
  return childSvg && childTag !== "svg" ? `<${childTag}> must be inside an <svg> or <g>` : null;
}
function assertCanNest(parent, childTag, opts) {
  const why = nestError(parent, childTag, opts);
  if (why) throw new HttpError(400, why);
}

function insertChild(parent, id, index) {
  const i = Number.isInteger(index) ? Math.max(0, Math.min(index, parent.children.length)) : parent.children.length;
  parent.children.splice(i, 0, id);
}

const ARTBOARD_DEFAULTS = { position: "absolute", left: "0px", top: "0px", width: "390px", height: "844px", backgroundColor: "#ffffff", overflow: "hidden" };

function createNode(input, source = "api", meta = null) {
  const parent = getNode(input.parentId || state.rootId);
  const tag = cleanTag(input.tag);
  assertCanNest(parent, tag);
  let styles = mergeStyles({}, input.styles);
  // Top-level nodes on a page are artboards placed in world space, like Paper frames.
  if (isPage(parent.id)) styles = mergeStyles(ARTBOARD_DEFAULTS, styles);
  const attrs = mergeAttrs({}, input.attrs, tag);
  const classes = input.classes === undefined ? [] : definedClasses(cleanClassList(input.classes));
  const nodeName = cleanName(input.name, tag);
  const text = cleanText(input.text);
  if (holdsNoText(tag) && text.trim()) throw new HttpError(400, `<${tag}> can't hold text`);
  const toolFallback = isPage(parent.id) ? "Draw Frame" : (tag === "p" && input.text !== undefined ? "Create Text" : "Draw Rect");
  return mutate(source, (s) => {
    const id = newId();
    s.nodes[id] = { id, name: nodeName, tag, parentId: parent.id, children: [], text: holdsNoText(tag) ? "" : text, styles, attrs };
    if (classes.length) s.nodes[id].classes = classes;
    insertChild(s.nodes[parent.id], id, input.index);
    return s.nodes[id];
  }, meta || { tool: source === "mcp" ? "create_node" : toolFallback, target: nodeName });
}

function updateNode(id, patch, source = "api", meta = null) {
  const node = getNode(id);
  const next = {};
  if (patch.name !== undefined) next.name = cleanName(patch.name, node.name);
  if (patch.tag !== undefined) {
    next.tag = cleanTag(patch.tag);
    // img/hr/br can't hold children, and HTML and SVG children don't render inside each other.
    if (node.children.length && next.tag !== node.tag) {
      if (VOID_TAGS.has(next.tag)) throw new HttpError(400, `<${next.tag}> can't contain child layers; move or delete them first`);
      const toSvg = SVG_TAGS.has(next.tag), wasSvg = SVG_TAGS.has(node.tag);
      if (toSvg !== wasSvg) throw new HttpError(400, `Can't switch between HTML and SVG tags while the layer has children`);
    }
  }
  const finalTag = next.tag ?? node.tag;
  if (patch.text !== undefined) {
    next.text = cleanText(patch.text);
    if (holdsNoText(finalTag) && next.text.trim()) throw new HttpError(400, `<${finalTag}> can't hold text`);
  }
  if (next.tag && holdsNoText(next.tag) && node.text) next.text = ""; // switching to img/svg/… drops text it can't show
  if (patch.styles !== undefined) next.styles = mergeStyles(patch.replaceStyles ? {} : node.styles, patch.styles);
  if (patch.attrs !== undefined) next.attrs = mergeAttrs(node.attrs, patch.attrs, next.tag ?? node.tag);
  if (patch.classes !== undefined || patch.addClasses !== undefined || patch.removeClasses !== undefined) {
    let list = patch.classes !== undefined ? definedClasses(cleanClassList(patch.classes ?? [])) : [...(node.classes || [])];
    if (patch.removeClasses !== undefined) {
      const rm = new Set(cleanClassList(patch.removeClasses ?? []));
      list = list.filter((c) => !rm.has(c));
    }
    if (patch.addClasses !== undefined) {
      const add = definedClasses(cleanClassList(patch.addClasses ?? []));
      for (const c of add) if (!list.includes(c)) list.push(c);
      list = cleanClassList(list);
    }
    next.classes = list;
  }
  const moving = patch.parentId !== undefined || patch.index !== undefined;
  if (moving) {
    if (isPage(id)) throw new HttpError(400, "Pages are reordered with update_page");
    const target = getNode(patch.parentId ?? node.parentId);
    if (isAncestor(id, target.id)) throw new HttpError(400, "Cannot move a node inside itself");
    if (target.id !== node.parentId) assertCanNest(target, next.tag ?? node.tag, { artboard: isPage(node.parentId) });
  }
  // A new tag must still fit where the layer already sits (e.g. a <circle> inside an <svg> can't become a <div>).
  if (next.tag && next.tag !== node.tag && !(moving && (patch.parentId ?? node.parentId) !== node.parentId)) {
    assertCanNest(getNode(node.parentId), next.tag);
  }
  let uiTool = "Edit layer";
  if (moving) uiTool = "Move layer";
  else if (patch.text !== undefined && patch.styles === undefined) uiTool = "Edit text";
  else if (patch.name !== undefined && patch.styles === undefined) uiTool = "Rename";
  else if (patch.styles !== undefined) uiTool = "Edit styles";
  else if (patch.classes !== undefined || patch.addClasses !== undefined || patch.removeClasses !== undefined) uiTool = "Edit classes";
  else if (patch.tag !== undefined) uiTool = "Change tag";
  if (patch.detachComponent) {
    return mutate(source, (s) => {
      const target = s.nodes[id];
      const rootId = target.componentRootId || target.id;
      for (const item of Object.values(s.nodes)) {
        if (item.id === rootId || item.componentRootId === rootId) {
          delete item.componentId; delete item.componentRootId; delete item.componentKey; delete item.componentOverrides;
        }
      }
      return target;
    }, meta || { tool: "detach_component", target: node.name, nodeIds: [id] });
  }
  if (!meta?.skipOverrideTracking && node.componentId && node.componentKey) {
    const ov = trackNodeOverrides(node, patch, next);
    if (ov) next.componentOverrides = ov;
  }
  return mutate(source, (s) => {
    const n = s.nodes[id];
    Object.assign(n, next);
    if (n.classes && !n.classes.length) delete n.classes;
    if (moving) {
      const oldParent = s.nodes[n.parentId];
      oldParent.children = oldParent.children.filter((c) => c !== id);
      const wasArtboard = isPage(n.parentId);
      n.parentId = patch.parentId ?? n.parentId;
      // Anything moved onto a page becomes an artboard and needs a world position: the next free spot (not 0,0, where
      // it would sit on top of the first artboard), unless this same patch places it.
      const placed = patch.styles && (patch.styles.left !== undefined || patch.styles.top !== undefined);
      if (isPage(n.parentId) && !wasArtboard && !placed) {
        const pos = nextArtboardPosition(n.parentId);
        n.styles = mergeStyles(n.styles, { position: "absolute", left: pos.x, top: pos.y });
      }
      // It is an artboard now, so it gets an artboard's fill and clipping, unless it already sets its own.
      if (isPage(n.parentId) && !wasArtboard) {
        const st = n.styles;
        const ownFill = st.background !== undefined || st.backgroundColor !== undefined || st.backgroundImage !== undefined;
        n.styles = mergeStyles(st, {
          ...(ownFill ? {} : { backgroundColor: ARTBOARD_DEFAULTS.backgroundColor }),
          ...(st.overflow !== undefined || st.overflowX !== undefined || st.overflowY !== undefined ? {} : { overflow: ARTBOARD_DEFAULTS.overflow }),
        });
      }
      insertChild(s.nodes[n.parentId], id, patch.index);
      if (isPage(n.parentId) && n.styles.position !== "absolute") n.styles = mergeStyles(n.styles, { position: "absolute", left: 0, top: 0 });
    }
    return n;
  }, meta || (source === "mcp" ? null : { tool: uiTool, target: next.name || node.name, nodeIds: [id] }));
}

// Every node in the open project, pages first, each tree depth-first: the order of the layers panel.
function documentOrder() {
  const out = [];
  const walk = (id) => {
    const n = state.nodes[id];
    if (!n) return;
    out.push(n);
    for (const c of n.children) walk(c);
  };
  for (const pid of state.pages) walk(pid);
  return out;
}

function updateNodesMatching({ artboardIds, pageId, query, tag, hasClass, classes, addClasses, removeClasses, styles, replaceStyles, attrs } = {}, source = "mcp") {
  const filterArtboards = artboardIds?.length ? new Set(artboardIds.map((aid) => getNode(aid).id)) : null;
  if (pageId) getPage(pageId);
  const hasFilter = Boolean(filterArtboards || pageId || (typeof query === "string" && query.trim()) || tag || hasClass);
  if (!hasFilter) throw new HttpError(400, "Provide at least one filter (artboardIds, pageId, query, tag, or hasClass)");
  const tagFilter = tag ? cleanTag(tag) : null;
  const classFilter = hasClass ? cleanClassList([String(hasClass).replace(/^\./, "")])[0] : null;
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  const hasPatch = classes !== undefined || addClasses !== undefined || removeClasses !== undefined || styles !== undefined || attrs !== undefined;
  if (!hasPatch) throw new HttpError(400, "Provide at least one change (classes, addClasses, removeClasses, styles, or attrs)");
  const patch = {};
  if (classes !== undefined) patch.classes = classes;
  if (addClasses !== undefined) patch.addClasses = addClasses;
  if (removeClasses !== undefined) patch.removeClasses = removeClasses;
  if (styles !== undefined) patch.styles = styles;
  if (replaceStyles !== undefined) patch.replaceStyles = replaceStyles;
  if (attrs !== undefined) patch.attrs = attrs;

  const matched = [];
  for (const n of documentOrder()) {
    if (isPage(n.id)) continue;
    if (pageId && pageOf(n.id) !== pageId) continue;
    if (filterArtboards && !filterArtboards.has(artboardOf(n.id))) continue;
    if (tagFilter && n.tag !== tagFilter) continue;
    if (classFilter && !n.classes?.includes(classFilter)) continue;
    if (q && !n.name.toLowerCase().includes(q) && !n.text.toLowerCase().includes(q) && n.id !== query) continue;
    matched.push(n.id);
  }
  if (!matched.length) return { matched: 0, updated: 0, nodeIds: [] };
  const targetName = matched.length === 1 ? state.nodes[matched[0]]?.name : `${matched.length} layers`;
  batch(source, () => matched.map((id) => updateNode(id, patch, source).id), {
    tool: source === "mcp" ? "update_nodes_matching" : "Batch edit",
    target: targetName,
    nodeIds: matched,
  });
  return { matched: matched.length, updated: matched.length, nodeIds: matched };
}

function deleteNode(id, source = "api") {
  if (isPage(id)) throw new HttpError(400, "Use delete_page to remove a page");
  const node = getNode(id);
  return mutate(source, (s) => {
    const removed = [];
    const pid = pageOf(id);
    const drop = (nid) => {
      for (const c of s.nodes[nid].children) drop(c);
      for (const cm of s.comments || []) {
        if (cm.nodeId === nid) {
          if (!cm.layerName) cm.layerName = s.nodes[nid].name;
          if (!cm.pageId) cm.pageId = pid;
        }
      }
      removed.push(nid);
      delete s.nodes[nid];
    };
    s.nodes[node.parentId].children = s.nodes[node.parentId].children.filter((c) => c !== id);
    drop(id);
    return { deleted: removed };
  }, source === "mcp" ? null : { tool: "Delete", target: node.name, nodeIds: [id] });
}

function duplicateNode(id, source = "api") {
  if (isPage(id)) throw new HttpError(400, "Pages cannot be duplicated");
  const node = getNode(id);
  return mutate(source, (s) => {
    // Every component instance root inside the copied subtree (not only the duplicated node itself) gets a new id, and
    // its layers must point at that copy: otherwise update_component sees them as strays and rebuilds them, dropping
    // their overrides. Roots are always visited before their layers, so the map is filled in time.
    const newRootOf = new Map();
    const copy = (srcId, parentId) => {
      const src = s.nodes[srcId];
      const nid = newId();
      const cloned = { ...structuredClone(src), id: nid, parentId, children: [] };
      if (src.componentId && !src.componentRootId) newRootOf.set(srcId, nid);
      if (cloned.componentRootId && newRootOf.has(cloned.componentRootId)) cloned.componentRootId = newRootOf.get(cloned.componentRootId);
      // A copy of a layer from inside an instance (whose instance root isn't being copied) would claim the same slot
      // as the original, and the next update_component would keep one and delete the other. It becomes a plain layer.
      else if (cloned.componentRootId) {
        delete cloned.componentId; delete cloned.componentKey; delete cloned.componentRootId; delete cloned.componentOverrides;
      }
      s.nodes[nid] = cloned;
      s.nodes[nid].children = src.children.map((c) => copy(c, nid));
      return nid;
    };
    const nid = copy(id, node.parentId);
    const dup = s.nodes[nid];
    dup.name = `${node.name} copy`;
    if (dup.styles.position === "absolute") {
      const top = isPage(node.parentId);
      dup.styles.left = `${(parseFloat(dup.styles.left) || 0) + (top ? (parseFloat(dup.styles.width) || 0) + 80 : 16)}px`;
      if (!top) dup.styles.top = `${(parseFloat(dup.styles.top) || 0) + 16}px`;
      // An artboard copy goes right of the original, unless another artboard is already there.
      else if (artboardOverlaps(node.parentId, dup, id)) {
        const pos = nextArtboardPosition(node.parentId);
        dup.styles.left = `${pos.x}px`;
        dup.styles.top = `${pos.y}px`;
      }
    }
    insertChild(s.nodes[node.parentId], nid, s.nodes[node.parentId].children.indexOf(id) + 1);
    return dup;
  }, source === "mcp" ? null : { tool: "Duplicate", target: node.name });
}

function artboardOf(id) {
  let n = getNode(id);
  if (isPage(n.id)) throw new HttpError(400, "A page is not inside an artboard");
  while (!isPage(n.parentId)) {
    if (!state.nodes[n.parentId]) throw new HttpError(404, `Parent "${n.parentId}" not found`);
    n = state.nodes[n.parentId];
  }
  return n.id;
}

function artboardSize(id) {
  const st = state.nodes[id].styles;
  const w = parseFloat(st.width), h = parseFloat(st.height);
  return { width: /px$/.test(st.width || "") && w > 0 ? w : 1280, height: /px$/.test(st.height || "") && h > 0 ? h : 900 };
}

function artboardRect(st) {
  const x = parseFloat(st.left) || 0, y = parseFloat(st.top) || 0;
  return { x, y, w: parseFloat(st.width) || 390, h: parseFloat(st.height) || 844 };
}

// Does `board` (styles of an artboard not yet on the page) overlap any artboard on the page other than `ignoreId`?
function artboardOverlaps(pageId, board, ignoreId) {
  const r = artboardRect(board.styles);
  return state.nodes[pageId].children.some((cid) => {
    if (cid === ignoreId || cid === board.id) return false;
    const o = artboardRect(state.nodes[cid].styles);
    return r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h;
  });
}

// Next free spot for a new artboard on a page: right of the existing ones on the top row.
function nextArtboardPosition(pageId = state.rootId) {
  const boards = state.nodes[pageId].children.map((id) => state.nodes[id].styles);
  if (!boards.length) return { x: 0, y: 0 };
  const top = Math.min(...boards.map((st) => parseFloat(st.top) || 0));
  const right = Math.max(...boards.map((st) => (parseFloat(st.left) || 0) + (parseFloat(st.width) || 390)));
  return { x: Math.round(right + 80), y: Math.round(top) };
}

const MAX_ARTBOARD_SIZE = 100_000;
// A numeric or px artboard size must be positive and sane: a negative one makes artboards overlap, and a huge one
// pushes every later artboard far off to the right. Keywords and other units ("fit-content", "100%") pass through.
function checkArtboardSize(label, v) {
  const px = typeof v === "number" ? v : /^\s*-?\d*\.?\d+(px)?\s*$/.test(String(v)) ? parseFloat(v) : null;
  if (px !== null && !(px > 0 && px <= MAX_ARTBOARD_SIZE)) throw new HttpError(400, `Artboard ${label} must be between 1 and ${MAX_ARTBOARD_SIZE}px (got ${JSON.stringify(v)})`);
}

function createArtboard({ name = "Frame", width = 390, height = 844, x, y, styles = {}, pageId }, source = "mcp") {
  checkArtboardSize("width", width);
  checkArtboardSize("height", height);
  const trimmedPage = typeof pageId === "string" ? pageId.trim() : "";
  const page = trimmedPage ? getPage(trimmedPage).id : state.rootId;
  const pos = x === undefined || y === undefined ? nextArtboardPosition(page) : { x, y };
  return createNode(
    { parentId: page, tag: "div", name, styles: { ...styles, width, height, left: x ?? pos.x, top: y ?? pos.y } },
    source,
    { tool: source === "mcp" ? "create_artboard" : "Draw Frame", target: cleanName(name, "Frame"), artboard: cleanName(name, "Frame") },
  );
}

// ---------------------------------------------------------------------------
// Root CSS: project-wide variables + shared classes (see model.js)
// ---------------------------------------------------------------------------
function definedClasses(list) {
  const defined = new Set(definedRootClasses(state.rootCss));
  const missing = list.filter((c) => !defined.has(c));
  if (missing.length) throw new HttpError(400, `${missing.map((c) => `.${c}`).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} defined in the root CSS; add ${missing.length === 1 ? "it" : "them"} with update_root_css first`);
  return list;
}

function getRootCss(opts = {}, doc = state) {
  const root = doc.rootCss || emptyRootCss();
  const { usage, unusedClasses: allUnusedClasses, unusedVars: allUnusedVars } = analyzeRootCssUsage(root, doc.nodes);
  const include = Array.isArray(opts?.include) && opts.include.length ? opts.include : null;
  const classesOpt = Array.isArray(opts?.classes) && opts.classes.length ? opts.classes : null;
  const format = opts?.format || "full";

  const wantedClasses = classesOpt
    ? new Set(cleanClassList(classesOpt.map((c) => String(c ?? "").trim().replace(/^\./, ""))))
    : null;
  const collectVarsFrom = (rulesList) => {
    const used = new Set();
    const addVars = (val) => {
      for (const ref of varsIn(val)) {
        if (used.has(ref)) continue;
        used.add(ref);
        if (ref in root.vars) addVars(root.vars[ref]);
        for (const rr of root.rules) if (rr.selector === ":root" && ref in rr.styles) addVars(rr.styles[ref]);
      }
    };
    for (const r of rulesList) for (const val of Object.values(r.styles)) addVars(val);
    return used;
  };

  let scopedRules = root.rules;
  let scopedVars = root.vars;
  let scopedDefined = definedRootClasses(root);
  let scopedUsage = usage;
  let unusedClasses = allUnusedClasses;
  let unusedVars = allUnusedVars;
  if (wantedClasses) {
    const classRules = root.rules.filter((r) => rootClassesIn(r.selector).some((c) => wantedClasses.has(c)));
    const neededVars = collectVarsFrom(classRules);
    scopedRules = [];
    for (const r of root.rules) {
      if (r.selector === ":root") {
        const sub = Object.fromEntries(Object.entries(r.styles).filter(([k]) => neededVars.has(k)));
        if (Object.keys(sub).length) scopedRules.push({ ...r, styles: sub });
      } else if (rootClassesIn(r.selector).some((c) => wantedClasses.has(c))) {
        scopedRules.push(r);
      }
    }
    scopedVars = Object.fromEntries(Object.entries(root.vars).filter(([k]) => neededVars.has(k)));
    scopedDefined = scopedDefined.filter((c) => wantedClasses.has(c));
    scopedUsage = Object.fromEntries(Object.entries(usage).filter(([c]) => wantedClasses.has(c)));
    unusedClasses = allUnusedClasses.filter((c) => wantedClasses.has(c));
    const unusedVarSet = new Set(allUnusedVars);
    unusedVars = Object.keys(scopedVars).filter((k) => unusedVarSet.has(k));
  }

  const scopedRoot = { vars: scopedVars, rules: scopedRules };
  const baseClasses = rootBaseClasses(scopedRoot);
  const nonBaseRules = scopedRules.filter((r) => !isBaseRule(r));
  const cssText = rootCssText(scopedRoot);

  if (include) {
    const want = new Set(include);
    if (want.has("unused")) { want.add("unusedClasses"); want.add("unusedVars"); }
    if (format === "css") want.add("css");
    const out = {};
    if (want.has("vars")) out.vars = scopedVars;
    if (want.has("classes")) out.classes = baseClasses;
    if (want.has("rules")) out.rules = nonBaseRules;
    if (want.has("definedClasses")) out.definedClasses = scopedDefined;
    if (want.has("css")) out.css = cssText;
    if (want.has("usage")) out.usage = scopedUsage;
    if (want.has("unusedClasses")) out.unusedClasses = unusedClasses;
    if (want.has("unusedVars")) out.unusedVars = unusedVars;
    return out;
  }

  if (format === "summary") {
    return {
      varsCount: Object.keys(scopedVars).length,
      rulesCount: scopedRules.length,
      varNames: Object.keys(scopedVars),
      definedClasses: scopedDefined,
      usage: scopedUsage,
      unusedClasses,
      unusedVars,
    };
  }

  if (format === "css") {
    return {
      css: cssText,
      definedClasses: scopedDefined,
      varsCount: Object.keys(scopedVars).length,
      rulesCount: scopedRules.length,
    };
  }

  // classes: the plain `.name { }` rules; rules: everything else (states, @media, nested, element selectors).
  return {
    vars: scopedVars,
    classes: baseClasses,
    rules: nonBaseRules,
    definedClasses: scopedDefined,
    css: cssText,
    usage: scopedUsage,
    unusedClasses,
    unusedVars,
  };
}

// Patch the root CSS. `css` text is parsed and merged like vars/classes; replace: true starts from empty.
// Removing a class also removes it from every layer that used it, in the same undo step.
// Each var() reference loop among :root variables, e.g. [["--a", "--b", "--a"]].
function varCycles(vars) {
  const cycles = [], done = new Set();
  const walk = (name, path) => {
    if (path.includes(name)) { cycles.push([...path.slice(path.indexOf(name)), name]); return; }
    if (done.has(name) || !(name in vars)) return;
    for (const ref of varsIn(String(vars[name]))) walk(ref, [...path, name]);
    done.add(name);
  };
  for (const name of Object.keys(vars)) walk(name, []);
  return cycles;
}

async function updateRootCss({ vars, classes, css, rules, replace = false, pruneUnused = false } = {}, source = "api") {
  const before = state.rootCss || emptyRootCss();
  let next = mergeRootCss(before, { css, vars, classes, rules }, { replace });
  if (pruneUnused) next = pruneUnusedRootCss(next, state.nodes);
  // Changed variables and rules, by name (a rule is named by its selector and @media).
  const ruleKey = (r) => (r.media ? `@media ${r.media} { ${r.selector} }` : r.selector);
  const ruleMap = (root) => {
    const m = new Map();
    for (const r of root.rules) m.set(ruleKey(r), JSON.stringify([m.get(ruleKey(r)), r.styles]));
    return m;
  };
  const classSig = (root) => {
    const m = new Map();
    for (const r of root.rules) {
      for (const c of rootClassesIn(r.selector)) {
        const list = m.get(c) || [];
        list.push([r.selector, r.media || "", r.styles]);
        m.set(c, list);
      }
    }
    for (const [c, list] of m) m.set(c, JSON.stringify(list));
    return m;
  };
  const rb = ruleMap(before), rn = ruleMap(next);
  const cb = classSig(before), cn = classSig(next);
  const changed = [
    ...Object.keys({ ...before.vars, ...next.vars }).filter((k) => before.vars[k] !== next.vars[k]),
    ...[...new Set([...rb.keys(), ...rn.keys()])].filter((k) => rb.get(k) !== rn.get(k)),
  ];
  const addedClasses = [...cn.keys()].filter((c) => !cb.has(c));
  const removedClasses = [...cb.keys()].filter((c) => !cn.has(c));
  const updatedClasses = [...cn.keys()].filter((c) => cb.has(c) && cb.get(c) !== cn.get(c));
  const addedVars = Object.keys(next.vars).filter((k) => !(k in before.vars));
  const removedVars = Object.keys(before.vars).filter((k) => !(k in next.vars));
  const updatedVars = Object.keys(next.vars).filter((k) => k in before.vars && before.vars[k] !== next.vars[k]);

  const stillDefinedList = definedRootClasses(next);
  const stillDefined = new Set(stillDefinedList);
  const dropped = definedRootClasses(before).filter((c) => !stillDefined.has(c));
  const touchedIds = [];
  const warnings = [];
  mutate(source, (s) => {
    s.rootCss = next;
    if (dropped.length) {
      for (const n of Object.values(s.nodes)) {
        if (!n.classes?.some((c) => dropped.includes(c))) continue;
        n.classes = n.classes.filter((c) => !dropped.includes(c));
        if (!n.classes.length) delete n.classes;
        touchedIds.push(n.id);
      }
      const pruneTree = (t) => {
        if (t.classes?.length) { t.classes = t.classes.filter((c) => !dropped.includes(c)); if (!t.classes.length) delete t.classes; }
        (t.children || []).forEach(pruneTree);
      };
      for (const comp of Object.values(s.components || {})) if (comp?.tree) pruneTree(comp.tree);
    }
  }, { tool: source === "mcp" ? "update_root_css" : "Edit root CSS", target: changed.length ? `Root CSS · ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? "…" : ""}` : "Root CSS", nodeIds: touchedIds });
  // Ensure full persistence before returning so subsequent write_html / restarts always see the updated root CSS.
  await flushWrites();
  if (touchedIds.length) {
    warnings.push(`Removed ${dropped.map((c) => `.${c}`).join(", ")} from ${touchedIds.length} layer${touchedIds.length === 1 ? "" : "s"}`);
  }
  const missingVars = new Set();
  for (const r of next.rules) {
    for (const v of Object.values(r.styles)) {
      for (const ref of varsIn(v)) {
        if (!(ref in next.vars) && !next.rules.some((rr) => rr.selector === ":root" && ref in rr.styles)) {
          missingVars.add(ref);
        }
      }
    }
  }
  if (missingVars.size) warnings.push(`Undefined variables referenced in root CSS: ${[...missingVars].join(", ")}`);
  const cycles = varCycles(next.vars);
  if (cycles.length) warnings.push(`Variables that reference each other in a loop are invalid in CSS and resolve to nothing: ${cycles.map((c) => c.join(" → ")).join("; ")}`);
  return {
    addedClasses,
    updatedClasses,
    removedClasses,
    addedVars,
    updatedVars,
    removedVars,
    changed,
    definedClasses: stillDefinedList,
    varsCount: Object.keys(next.vars).length,
    rulesCount: next.rules.length,
    ...(touchedIds.length ? { removedFromLayers: touchedIds.length } : {}),
    warnings,
  };
}

async function importRootCss({ sourceProjectId, mode = "merge", varsOnly = false, classes } = {}, source = "mcp") {
  if (!["merge", "replace"].includes(mode)) throw new HttpError(400, `Invalid mode "${mode}" (use merge or replace)`);
  if (!sourceProjectId || !ID_RE.test(String(sourceProjectId))) throw new HttpError(400, "Invalid sourceProjectId");
  if (sourceProjectId === state.id) throw new HttpError(400, `"${state.name}" is the open project; pass the id of the project to import from`);
  const srcDoc = await readProject(sourceProjectId);
  const srcRoot = srcDoc.rootCss || emptyRootCss();
  const classSet = Array.isArray(classes) && classes.length ? new Set(cleanClassList(classes)) : null;
  const srcClasses = new Set(srcRoot.rules.flatMap((r) => rootClassesIn(r.selector)));
  const missingClasses = classSet ? [...classSet].filter((c) => !srcClasses.has(c)) : [];

  let rulesToImport = [];
  if (!varsOnly) {
    rulesToImport = classSet
      ? srcRoot.rules.filter((r) => rootClassesIn(r.selector).some((c) => classSet.has(c)))
      : srcRoot.rules;
  }

  let varsToImport = {};
  if (classSet && !varsOnly) {
    const needed = new Set();
    const queue = [];
    for (const r of rulesToImport) {
      for (const stVal of Object.values(r.styles || {})) {
        for (const v of varsIn(stVal)) if (!needed.has(v)) { needed.add(v); queue.push(v); }
      }
    }
    while (queue.length) {
      const v = queue.shift();
      if (!(v in srcRoot.vars)) continue;
      varsToImport[v] = srcRoot.vars[v];
      for (const ref of varsIn(srcRoot.vars[v])) {
        if (!needed.has(ref)) { needed.add(ref); queue.push(ref); }
      }
    }
  } else {
    varsToImport = { ...srcRoot.vars };
  }

  const res = await updateRootCss({ vars: varsToImport, rules: rulesToImport, replace: mode === "replace" }, source);
  return {
    importedFrom: { id: srcDoc.id, name: srcDoc.name },
    mode,
    varsImported: Object.keys(varsToImport).length,
    rulesImported: rulesToImport.length,
    ...(missingClasses.length ? { notInSource: missingClasses } : {}),
    ...res,
  };
}

async function applyDesignTokens({ tokens, mode = "merge" } = {}, source = "mcp") {
  if (!["merge", "replace"].includes(mode)) throw new HttpError(400, `Invalid mode "${mode}" (use merge or replace)`);
  const parsed = importDesignTokens(tokens);
  const existingVars = state.rootCss?.vars || {};
  const varsPatch = mode === "replace"
    ? { ...Object.fromEntries(Object.keys(existingVars).map((k) => [k, null])), ...parsed.vars }
    : parsed.vars;
  const res = await updateRootCss({ vars: varsPatch }, source);
  return {
    mode,
    imported: parsed.tokenCount,
    ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}),
    ...res,
  };
}

// Design system linter + nudges for agents (exact duplicates, unknown var(), spacing/radii/font-size/color lints).
function rootCssHints(nodeIds, doc = state, options = {}) {
  return analyzeDesignLint(nodeIds, doc, options);
}

// Insert a parsed HTML spec tree (lenient: bad tags/styles/attrs are dropped with warnings). Call inside mutate/batch.
function addSubtree(spec, parentId, index, warnings) {
  if (spec.component) {
    const comp = state.components?.[spec.component];
    if (comp) {
      const overrides = extractComponentOverridesFromSpec(spec);
      const rootName = spec.name && spec.name !== "Frame" ? spec.name : undefined;
      return components.instantiateIntoState(comp, parentId, index, overrides, rootName, warnings).rootId;
    }
    warnings.push(`Component "${spec.component}" is not registered; built as a regular layer`);
  }
  const parent = getNode(parentId);
  const label = cleanName(spec.name, spec.tag);
  let tag;
  try {
    tag = cleanTag(spec.tag);
  } catch (err) {
    warnings.push(`${label}: ${err.message}; using div`);
    tag = "div";
  }
  let styles = lenientMerge(mergeStyles, spec.styles, warnings, label);
  if (isPage(parent.id)) {
    const pos = nextArtboardPosition(parent.id);
    styles = { left: `${pos.x}px`, top: `${pos.y}px`, width: "390px", height: "fit-content", backgroundColor: "#ffffff", overflow: "hidden", ...styles, position: "absolute" };
  }
  const attrs = lenientMerge((b, p) => mergeAttrs(b, p, tag), spec.attrs, warnings, label);
  const id = newId();
  const noText = holdsNoText(tag);
  const text = cleanText(spec.text);
  if (noText && text.trim()) warnings.push(`${label}: <${tag}> can't hold text; dropped "${text.length > 40 ? `${text.slice(0, 37)}…` : text}"`);
  state.nodes[id] = { id, name: label, tag, parentId: parent.id, children: [], text: noText ? "" : text, styles, attrs };
  if (spec.slot && SLOT_NAME_RE.test(spec.slot)) state.nodes[id].slot = spec.slot; // kept for create_component({ nodeId })
  let classes = [];
  for (const c of spec.classes || []) {
    try { classes = cleanClassList([...classes, c]); } catch (err) { warnings.push(`${label}: ${err.message}`); }
  }
  const defined = new Set(definedRootClasses(state.rootCss));
  const missing = classes.filter((c) => !defined.has(c));
  if (missing.length) warnings.push(`${label}: ${missing.map((c) => `.${c}`).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in the root CSS; add ${missing.length === 1 ? "it" : "them"} with update_root_css first. Dropped`);
  classes = classes.filter((c) => !missing.includes(c));
  if (classes.length) state.nodes[id].classes = classes;
  insertChild(state.nodes[parent.id], id, index);
  for (const child of spec.children || []) {
    // Lenient like the rest of write_html: a nested element that couldn't render where it was written is skipped
    // (with its subtree) and reported, instead of failing the whole call or leaving an invisible layer.
    const why = nestError(state.nodes[id], specTag(child));
    if (why) { warnings.push(`${cleanName(child.name, child.tag)}: ${why}; skipped`); continue; }
    addSubtree(child, id, undefined, warnings);
  }
  return id;
}

// The tag addSubtree will actually use for a spec (unknown tags become div).
function specTag(spec) {
  try { return cleanTag(spec.tag); } catch { return "div"; }
}

function listIcons(doc = state) {
  return Object.values(doc.icons || {})
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((ic) => ({ name: ic.name, ...(ic.viewBox ? { viewBox: ic.viewBox } : {}), shapes: ic.children.length }));
}

function registerIcons({ icons, name, svg, replace = false } = {}, source = "mcp") {
  const entries = Array.isArray(icons) ? icons : (name !== undefined || svg !== undefined ? [{ name, svg }] : []);
  if (!entries.length) throw new HttpError(400, "Provide icons: [{ name, svg }] or { name, svg }");
  const parsed = entries.map((e) => parseSvgIcon(e?.name, e?.svg));
  const next = replace ? {} : structuredClone(state.icons || {});
  for (const asset of parsed) next[asset.name] = asset;
  if (Object.keys(next).length > MAX_ICONS) throw new HttpError(400, `At most ${MAX_ICONS} registered icons per project`);
  mutate(source, (s) => { s.icons = next; }, {
    tool: source === "mcp" ? "register_icons" : "Register icons",
    target: parsed.length === 1 ? parsed[0].name : `${parsed.length} icons`,
  });
  return { registered: parsed.map((p) => p.name), total: Object.keys(next).length };
}

function deleteIcon(name, source = "mcp") {
  const key = String(name ?? "").trim();
  if (!key || !Object.hasOwn(state.icons || {}, key)) throw new HttpError(404, `Icon "${key}" not found`);
  mutate(source, (s) => {
    const next = { ...(s.icons || {}) };
    delete next[key];
    s.icons = next;
  }, { tool: source === "mcp" ? "delete_icon" : "Delete icon", target: key });
  return { deleted: key, total: Object.keys(state.icons || {}).length };
}

function writeHtml({ html, parentId, targetNodeId, mode = "insert-children", index, lint = true }, source = "mcp") {
  const { specs: rawSpecs, warnings } = htmlToSpecs(html);
  if (!rawSpecs.length) throw new HttpError(400, "No elements found in html");
  const specs = expandIconSpecs(rawSpecs, state.icons, warnings);
  if (!specs.length) throw new HttpError(400, warnings[0] || "No elements found in html");
  let parent = (typeof parentId === "string" ? parentId.trim() : "") || state.rootId;
  let at = index;
  let replaceTargetName = null;
  if (mode === "replace") {
    if (!targetNodeId) throw new HttpError(400, "targetNodeId is required for mode=replace");
    const target = getNode(targetNodeId);
    if (isPage(target.id)) throw new HttpError(400, "A page cannot be replaced");
    replaceTargetName = target.name;
    parent = target.parentId;
    at = state.nodes[parent].children.indexOf(target.id);
    if (isPage(parent)) for (const sp of specs) sp.styles = { left: target.styles.left, top: target.styles.top, ...sp.styles };
  }
  const parentNode = getNode(parent);
  // The top-level elements are what the caller asked for, so a misplaced one fails the call with a clear reason.
  for (const sp of specs) assertCanNest(parentNode, specTag(sp));
  const firstLabel = cleanName(specs[0].name, specs[0].tag);
  const targetLabel = mode === "replace"
    ? (specs.length === 1 ? firstLabel : replaceTargetName)
    : (specs.length === 1 ? firstLabel : (isPage(parent) ? `${specs.length} artboards` : parentNode.name));
  const created = batch(source, () => {
    if (mode === "replace") deleteNode(targetNodeId, source);
    return specs.map((sp, i) => addSubtree(sp, parent, at === undefined ? undefined : at + i, warnings));
  }, { tool: "write_html", target: targetLabel });
  const countAll = (id) => 1 + state.nodes[id].children.reduce((a, c) => a + countAll(c), 0);
  const subtree = (id) => [id, ...state.nodes[id].children.flatMap(subtree)];
  warnings.push(...rootCssHints(created.flatMap(subtree), state, { lint }));
  return {
    created: created.map((id) => ({ id, name: state.nodes[id].name, tag: state.nodes[id].tag })),
    layers: created.reduce((a, id) => a + countAll(id), 0),
    parentId: parent,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Comments (pinned to nodeId; persisted in project JSON, excluded from exports)
// ---------------------------------------------------------------------------
function latestMcpStep() {
  for (let i = historyCursor; i >= 0; i--) {
    if (historyTimeline[i].source === "mcp") {
      const e = historyTimeline[i];
      return { historyId: e.id, label: e.label, nodeIds: e.nodeIds || [], step: i + 1 };
    }
  }
  return null;
}

function listComments({ status, nodeId, agentView = false } = {}) {
  const list = state.comments || [];
  return list.filter((c) => {
    if (agentView && c.agentsCanSee === false) return false;
    if (nodeId && c.nodeId !== nodeId) return false;
    if (status && c.status !== status) return false;
    return true;
  });
}

function addComment({ nodeId, text, agentsCanSee = true }) {
  const node = getNode(nodeId);
  if (isPage(nodeId)) throw new HttpError(400, "Comments must attach to a layer or artboard");
  const cleanText = String(text ?? "").trim().slice(0, 4000);
  if (!cleanText) throw new HttpError(400, "Comment text cannot be empty");
  const now = new Date().toISOString();
  const thread = {
    id: newId(),
    nodeId,
    pageId: pageOf(nodeId),
    layerName: node.name,
    status: "open",
    agentsCanSee: agentsCanSee !== false,
    messages: [{ id: newId(), author: "you", text: cleanText, at: now }],
    createdAt: now,
  };
  if (!state.comments) state.comments = [];
  state.comments.push(thread);
  persist({ touchUpdatedAt: false });
  sendEvent("comments", { comments: state.comments });
  return thread;
}

function replyComment(id, { text, author = "you", linkStep = false, agentsCanSee, reopen = false } = {}) {
  const thread = (state.comments || []).find((c) => c.id === id);
  if (!thread) throw new HttpError(404, `Comment "${id}" not found`);
  const fullText = String(text ?? "").trim();
  const cleanText = fullText.slice(0, 4000);
  if (!cleanText) throw new HttpError(400, "Reply text cannot be empty");
  const now = new Date().toISOString();
  const isAgent = author !== "you";
  const linkedStep = isAgent && linkStep ? latestMcpStep() : null;
  thread.messages.push({
    id: newId(),
    author: cleanName(author, "you"),
    text: cleanText,
    at: now,
    ...(linkedStep ? { linkedStep } : {}),
  });
  if (agentsCanSee !== undefined && !isAgent) thread.agentsCanSee = Boolean(agentsCanSee);
  // A thread the user resolved stays resolved when an agent adds a note to it, unless the agent reopens it on purpose.
  // A reply from the user reopens it: they're asking again.
  const keptResolved = isAgent && thread.status === "resolved" && !reopen;
  if (!keptResolved) thread.status = isAgent ? "replied" : "open";
  persist({ touchUpdatedAt: false });
  sendEvent("comments", {
    comments: state.comments,
    ...(isAgent ? { replyNotification: { commentId: thread.id, nodeId: thread.nodeId, author: cleanName(author, "Claude"), text: cleanText } } : {}),
  });
  return {
    ...thread,
    ...(fullText.length > cleanText.length ? { truncated: `Reply cut to ${cleanText.length} of ${fullText.length} characters` } : {}),
    ...(keptResolved ? { note: "The thread was resolved and stays resolved; pass reopen: true to reopen it" } : {}),
  };
}

function updateComment(id, { status, agentsCanSee } = {}) {
  const thread = (state.comments || []).find((c) => c.id === id);
  if (!thread) throw new HttpError(404, `Comment "${id}" not found`);
  const now = new Date().toISOString();
  if (status !== undefined) {
    if (!["open", "read", "replied", "resolved"].includes(status)) throw new HttpError(400, "Invalid comment status");
    thread.status = status;
    if (status === "read") thread.readAt = now;
    if (status === "resolved") thread.resolvedAt = now;
  }
  if (agentsCanSee !== undefined) thread.agentsCanSee = Boolean(agentsCanSee);
  persist({ touchUpdatedAt: false });
  sendEvent("comments", { comments: state.comments });
  return thread;
}

function deleteComment(id) {
  const before = (state.comments || []).length;
  state.comments = (state.comments || []).filter((c) => c.id !== id);
  if (state.comments.length === before) throw new HttpError(404, `Comment "${id}" not found`);
  persist({ touchUpdatedAt: false });
  sendEvent("comments", { comments: state.comments });
  return { deleted: id };
}

function mcpGetComments({ status, nodeId } = {}) {
  const list = listComments({ status, nodeId, agentView: true });
  const now = new Date().toISOString();
  let changed = false;
  for (const c of list) {
    if (c.status === "open") {
      c.status = "read";
      c.readAt = now;
      changed = true;
    } else if (!c.readAt && c.status !== "resolved") {
      c.readAt = now;
      changed = true;
    }
  }
  if (changed) {
    persist({ touchUpdatedAt: false });
    sendEvent("comments", { comments: state.comments });
  }
  return list.map((c) => ({
    ...c,
    layerName: state.nodes[c.nodeId]?.name || null,
    layerDeleted: !state.nodes[c.nodeId],
  }));
}

// Threads hidden from agents must stay hidden on every MCP path, not just get_comments: answer "not found" so an
// agent holding a private thread's id can neither read it (via the reply/resolve result) nor post into it.
function agentVisibleComment(id) {
  const thread = (state.comments || []).find((c) => c.id === id);
  if (!thread || thread.agentsCanSee === false) throw new HttpError(404, `Comment "${id}" not found`);
  return thread;
}

function openCommentCount() {
  return (state.comments || []).filter((c) => c.agentsCanSee !== false && c.status !== "resolved").length;
}

// ---------------------------------------------------------------------------
// Export: HTML + CSS, JSX, and full-project ZIP (folders per page, files per artboard)
// ---------------------------------------------------------------------------
const kebab = (k) => k.replace(/^(Webkit|Moz|ms)(?=[A-Z])/, (m) => `-${m.toLowerCase()}`).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Artboards keep world-space left/top for the canvas only; exported code starts at 0,0.
function exportStyles(node, doc = state) {
  const st = { ...node.styles };
  if (doc.pages.includes(node.parentId)) {
    delete st.left;
    delete st.top;
    st.position = "relative";
  }
  return st;
}

function exportRoots(nodeId, doc = state) {
  if (nodeId) {
    if (!doc.nodes[nodeId]) throw new HttpError(404, `Node "${nodeId}" not found`);
    return doc.pages.includes(nodeId) ? doc.nodes[nodeId].children : [nodeId];
  }
  return doc.nodes[doc.rootId].children;
}

// Library fonts (uploads / Google) used anywhere in the exported subtrees.
function usedFonts(rootIds, doc = state) {
  const used = new Set();
  const walk = (id) => {
    const n = doc.nodes[id];
    if (!n) return;
    familiesIn(n.styles.fontFamily).forEach((f) => used.add(f));
    n.children.forEach(walk);
  };
  rootIds.forEach(walk);
  const library = new Set(fonts.families().map((f) => f.toLowerCase()));
  return [...used].filter((f) => library.has(f.toLowerCase()));
}

const RESET_CSS = "*, *::before, *::after { box-sizing: border-box; }\nbutton { font: inherit; color: inherit; }";

// The part of the root CSS a set of layers actually uses: rules whose classes those layers use (rules without
// classes, like `li:first-child`, always count), plus every variable they reference (following var() chains).
function usedRootCss(rootIds, doc = state) {
  const root = doc.rootCss || emptyRootCss();
  const used = new Set(), vars = new Set();
  const addVars = (v) => varsIn(v).forEach((ref) => {
    if (vars.has(ref)) return;
    vars.add(ref);
    if (ref in root.vars) addVars(root.vars[ref]);
    for (const r of root.rules) if (r.selector === ":root" && ref in r.styles) addVars(r.styles[ref]);
  });
  const walk = (id) => {
    const n = doc.nodes[id];
    if (!n) return;
    (n.classes || []).forEach((c) => used.add(c));
    Object.values(n.styles).forEach(addVars);
    n.children.forEach(walk);
  };
  rootIds.forEach(walk);
  const applies = (r) => r.selector !== ":root" && r.selector.split(",").some((part) => rootClassesIn(part).every((c) => used.has(c)));
  const rules = root.rules.filter(applies);
  for (const r of rules) for (const [k, v] of Object.entries(r.styles)) { if (k.startsWith("--")) vars.add(k); addVars(v); }
  const keepVars = (st) => Object.fromEntries(Object.entries(st).filter(([k]) => vars.has(k)));
  const out = [];
  for (const r of root.rules) {
    if (r.selector !== ":root") { if (rules.includes(r)) out.push(r); continue; }
    const styles = keepVars(r.styles); // :root variables inside @media, e.g. a dark theme
    if (Object.keys(styles).length) out.push({ ...r, styles });
  }
  return { vars: keepVars(root.vars), rules: out };
}

const layerClasses = (n, doc = state) => {
  const defined = new Set(definedRootClasses(doc.rootCss));
  return (n.classes || []).filter((c) => defined.has(c));
};

// Cascade, everywhere a design is rendered (canvas, screenshots, exports):
//   :root variables → plain .class rules → each layer's own styles → states, @media and nested rules on top.
// So a layer's own styles override its base classes, and :hover / breakpoints still apply over them.
function cssLayers(root, ownCss) {
  const vars = Object.entries(root.vars || {});
  return {
    vars: vars.length ? `:root {\n${vars.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}` : "",
    base: rootCssFlat(root.rules.filter(isBaseRule)),
    own: ownCss,
    contextual: rootCssFlat(root.rules.filter((r) => !isBaseRule(r))),
  };
}

// One stylesheet for a whole export: the root CSS, the reset, layer overrides, then the root's states / media / nested
// rules. Layers with identical overrides share one rule, named after the first layer that uses it.
function sharedSheet(doc = state) {
  const byDecl = new Map(), classNames = new Set(definedRootClasses(doc.rootCss)), rules = [];
  return {
    classFor(n) {
      const decl = Object.entries(exportStyles(n, doc)).map(([k, v]) => `  ${kebab(k)}: ${v};`).join("\n");
      if (!decl) return null;
      if (!byDecl.has(decl)) {
        // Class names must start with a letter; "404 page" becomes "layer-404-page".
        const raw = /^[a-z]/.test(slugName(n.name, "")) ? n.name : `layer ${n.name}`;
        const cls = uniqueSlug(classNames, raw, n.tag);
        byDecl.set(decl, cls);
        rules.push(`.${cls} {\n${decl}\n}`);
      }
      return byDecl.get(decl);
    },
    // tokens.css: fonts and the root CSS variables, the design's colours, sizes and font stacks.
    tokensCss(fontCss = "") {
      const l = cssLayers(doc.rootCss || emptyRootCss(), "");
      const parts = [fontCss, l.vars && `/* Root CSS variables */\n${l.vars}`].filter(Boolean);
      return `${parts.length ? parts.join("\n\n") : "/* No fonts or root CSS variables in this project yet. */"}\n`;
    },
    // components.css: the root CSS classes, the reset, layer overrides, then the root's states / media / nested rules.
    // Linked after tokens.css, so the cascade is the same as one sheet.
    componentsCss() {
      const l = cssLayers(doc.rootCss || emptyRootCss(), rules.join("\n\n"));
      return [
        l.base && `/* Root CSS: shared classes */\n${l.base}`,
        `${RESET_CSS}\nbody { margin: 0; }`,
        l.own && `/* Layer overrides */\n${l.own}`,
        l.contextual && `/* Root CSS: states, breakpoints and nested rules (they apply over layer overrides) */\n${l.contextual}`,
      ].filter(Boolean).join("\n\n") + "\n";
    },
  };
}

// A subtree's identity for de-duplication: same tags, attributes, text, export styles and classes all the way down.
function subtreeKeys(doc) {
  const memo = new Map();
  const keyOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    const n = doc.nodes[id];
    const key = JSON.stringify([n.tag, n.attrs || {}, n.text || "", exportStyles(n, doc), n.classes || [], n.children.map(keyOf)]);
    memo.set(id, key);
    return key;
  };
  return keyOf;
}

// Root CSS selectors that reach into SVG content (`.btn:hover path`, `svg *`) wouldn't match inside a <use>
// copy, so icons are only shared through <symbol>/<use> when nothing in the root CSS targets SVG elements.
const SVG_SELECTOR_RE = /(^|[\s>+~(,])(svg|g|path|circle|rect|ellipse|line|polyline|polygon|\*)(?![\w-])/;
const canShareSvgs = (doc) => !(doc.rootCss?.rules || []).some((r) => SVG_SELECTOR_RE.test(r.selector));

// With a shared sheet the markup carries class names only; otherwise it's a self-contained snippet.
// markIds tags every element with data-layer="<id>" so the renderer can find layers that have no class of their own.
// Exports stay small: layers with identical styles share one rule (named after the first such layer), and an SVG
// that appears more than once is written once as a <symbol> and reused with <use>.
function toHtml(nodeId, { fontBase = PUBLIC_URL, filesBase, doc = state, sheet, markIds = false } = {}) {
  const roots = exportRoots(nodeId, doc);
  const css = [];
  const byDecl = new Map();
  const ownClass = sheet ? (n) => sheet.classFor(n) : (n, id) => {
    const decl = Object.entries(exportStyles(n, doc)).map(([k, v]) => `  ${kebab(k)}: ${v};`).join("\n");
    // Unstyled layers get neither an empty rule nor a class nothing targets.
    if (!decl) return null;
    if (!byDecl.has(decl)) {
      byDecl.set(decl, `layer-${id}`);
      // Layer names are free text: drop "*/" and angle brackets so a name can't end the comment or the <style> element.
      css.push(`/* ${n.name.replace(/\*\//g, "").replace(/[<>]/g, "")} */\n.layer-${id} {\n${decl}\n}`);
    }
    return byDecl.get(decl);
  };

  // SVGs (outermost ones) that occur at least twice in what's exported.
  const keyOf = subtreeKeys(doc);
  const svgCount = new Map();
  if (!markIds && canShareSvgs(doc)) {
    const walk = (id) => {
      const n = doc.nodes[id];
      if (n.tag === "svg") svgCount.set(keyOf(id), (svgCount.get(keyOf(id)) || 0) + 1);
      else n.children.forEach(walk);
    };
    roots.forEach(walk);
  }
  const symbols = new Map(); // subtree key -> { id, markup }

  const markup = (id, depth) => {
    const n = doc.nodes[id];
    const pad = "  ".repeat(depth);
    const cls = [...layerClasses(n, doc), ownClass(n, id)].filter(Boolean).join(" ");
    const attrs = Object.entries(n.attrs || {}).map(([k, v]) => ` ${k}="${escHtml(v)}"`).join("");
    const open = `${pad}<${n.tag}${cls ? ` class="${cls}"` : ""}${markIds ? ` data-layer="${id}"` : ""}${attrs}>`;
    if (VOID_TAGS.has(n.tag)) return open;
    if (n.tag === "svg" && n.children.length && svgCount.get(keyOf(id)) > 1) {
      const key = keyOf(id);
      if (!symbols.has(key)) {
        const viewBox = n.attrs?.viewBox ? ` viewBox="${escHtml(n.attrs.viewBox)}"` : "";
        const inner = n.children.map((c) => markup(c, 2)).join("\n");
        symbols.set(key, { id: `icon-${symbols.size + 1}`, markup: `  <symbol id="icon-${symbols.size + 1}"${viewBox}>\n${inner}\n  </symbol>` });
      }
      return `${open}<use href="#${symbols.get(key).id}"/></svg>`;
    }
    const kids = n.children.map((c) => markup(c, depth + 1));
    if (!kids.length) return `${open}${escHtml(n.text)}</${n.tag}>`;
    const text = n.text ? [`${pad}  ${escHtml(n.text)}`] : [];
    return [open, ...text, ...kids, `${pad}</${n.tag}>`].join("\n");
  };
  let body = roots.map((id) => markup(id, 0)).join("\n\n");
  if (symbols.size) {
    const sprite = [...symbols.values()].map((s) => s.markup).join("\n");
    body = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">\n${sprite}\n</svg>\n\n${body}`;
  }
  if (sheet) return `${body}\n`;
  const fam = usedFonts(roots, doc);
  const fontCss = fam.length ? `${fonts.css({ families: fam, baseUrl: fontBase, filesBase })}\n\n` : "";
  const l = cssLayers(usedRootCss(roots, doc), css.join("\n\n"));
  const styleText = [l.vars, l.base, RESET_CSS, l.own, l.contextual].filter(Boolean).join("\n\n");
  return `<style>\n${fontCss}${styleText}\n</style>\n\n${body}\n`;
}

// icons.svg in the project export: every icon in the project once, as a <symbol>, for reuse in an app
// (<svg><use href="icons.svg#icon-search"/></svg> when served over http). Registered icons (register_icons) come
// first under their registered names; any other distinct SVG on a page follows, named after its layer, unless it is a
// copy of a registered icon. Styles are written inline, so the sprite works without the export's stylesheets.
// Exported screens keep the icons they use inline, because browsers won't load <use> from another file when a page is
// opened from disk.
function iconSprite(doc = state) {
  // Registry icons are specs ({ tag, attrs, styles, children }); page SVGs are layers. Both become plain shapes.
  const fromSpec = (sp) => ({ tag: sp.tag, attrs: sp.attrs || {}, styles: sp.styles || {}, text: sp.text || "", kids: (sp.children || []).map(fromSpec) });
  const fromNode = (id) => {
    const n = doc.nodes[id];
    return { tag: n.tag, attrs: n.attrs || {}, styles: exportStyles(n, doc), text: n.text || "", kids: n.children.filter((c) => doc.nodes[c]).map(fromNode) };
  };
  const shapesKey = (kids) => JSON.stringify(kids.map(function k(x) { return [x.tag, x.attrs, x.styles, x.text, x.kids.map(k)]; }));
  const attrsOf = (x, skip = new Set()) => {
    const style = Object.entries(x.styles).filter(([k]) => !skip.has(k)).map(([k, v]) => `${kebab(k)}: ${v}`).join("; ");
    return Object.entries(x.attrs).filter(([k]) => !skip.has(k)).map(([k, v]) => ` ${k}="${escHtml(v)}"`).join("") + (style ? ` style="${escHtml(style)}"` : "");
  };
  // The outer <svg>'s size and placement belong to where the icon is used; its paint (fill="none", stroke, …) is
  // inherited by the shapes, so it goes on the <symbol>.
  const PLACEMENT = new Set(["width", "height", "viewBox", "xmlns", "x", "y", "position", "left", "top", "right", "bottom",
    "margin", "display", "flexShrink", "flexGrow", "alignSelf", "order"]);
  const element = (x, depth) => {
    const pad = "  ".repeat(depth);
    if (!x.kids.length) return `${pad}<${x.tag}${attrsOf(x)}${x.text ? `>${escHtml(x.text)}</${x.tag}>` : "/>"}`;
    return [`${pad}<${x.tag}${attrsOf(x)}>`, ...x.kids.map((c) => element(c, depth + 1)), `${pad}</${x.tag}>`].join("\n");
  };
  const seen = new Map(), ids = new Set();
  const add = (svg, name) => {
    const key = shapesKey(svg.kids);
    if (!svg.kids.length || seen.has(key)) return;
    const viewBox = svg.attrs.viewBox ? ` viewBox="${escHtml(svg.attrs.viewBox)}"` : "";
    const symbolId = uniqueSlug(ids, `icon ${name}`, "icon");
    seen.set(key, `  <symbol id="${symbolId}"${viewBox}${attrsOf(svg, PLACEMENT)}>\n${svg.kids.map((c) => element(c, 2)).join("\n")}\n  </symbol>`);
  };
  for (const icon of Object.values(doc.icons || {}).sort((a, b) => a.name.localeCompare(b.name))) add(fromSpec({ tag: "svg", ...icon }), icon.name);
  const walk = (id) => {
    const n = doc.nodes[id];
    if (!n) return;
    if (n.tag === "svg") add(fromNode(id), n.name);
    else n.children.forEach(walk);
  };
  for (const pid of doc.pages) walk(pid);
  if (!seen.size) return null;
  return `<svg xmlns="http://www.w3.org/2000/svg">\n${[...seen.values()].join("\n")}\n</svg>\n`;
}

function componentName(name) {
  const base = String(name).replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return /^[A-Z]/.test(base) ? base : `Layer${base}`;
}

// JSX for a set of screens. Repeated identical subtrees (a sidebar on every screen, the same icon twice) become one
// component, and without a shared sheet repeated inline styles become one entry in a `styles` object.
// `roots` are the exported top-level nodes (artboards or a single layer); they themselves are never folded.
function jsxBuilder(doc, roots, { sheet } = {}) {
  const keyOf = subtreeKeys(doc);
  // Declared components (create_component): an instance that matches its component's definition, apart from the
  // text of its slots, is written as <Card title="…" />, and the component once, from the definition, with a prop per
  // text slot. Instances changed in other ways (styles, attributes, layers added or removed) are written out in full.
  const declared = new Map(); // instance root id -> { comp, props: { prop: text } }
  const slotProps = new Map(); // component id -> Map(slot key -> prop name)
  const propsOf = (comp) => {
    if (slotProps.has(comp.id)) return slotProps.get(comp.id);
    const map = new Map(), used = new Set();
    const RESERVED = new Set(["class", "default", "function", "return", "new", "delete", "in", "if", "for", "var", "let", "const", "key", "children"]);
    (function walk(sp) {
      if (sp.slot && !SVG_TAGS.has(sp.tag) && !VOID_TAGS.has(sp.tag)) {
        let name = String(sp.slot).replace(/[-_]+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");
        if (!/^[A-Za-z]/.test(name) || RESERVED.has(name)) name = `${name ? `slot${name[0].toUpperCase()}${name.slice(1)}` : "slot"}Text`;
        let unique = name, i = 2;
        while (used.has(unique)) unique = `${name}${i++}`;
        used.add(unique);
        map.set(sp.key, unique);
      }
      (sp.children || []).forEach(walk);
    })(comp.tree);
    slotProps.set(comp.id, map);
    return map;
  };
  const same = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
  const definedClasses = new Set(definedRootClasses(doc.rootCss));
  const matchInstance = (id, sp, props, out) => {
    const n = doc.nodes[id];
    if (!n || n.tag !== sp.tag || !same(n.styles, sp.styles) || !same(n.attrs, sp.attrs)) return false;
    if (JSON.stringify(n.classes || []) !== JSON.stringify((sp.classes || []).filter((c) => definedClasses.has(c)))) return false;
    const prop = props.get(sp.key);
    if (prop) { if ((n.text || "") !== (sp.text || "")) out[prop] = n.text || ""; }
    else if ((n.text || "") !== (sp.text || "")) return false;
    const kids = sp.children || [];
    return n.children.length === kids.length && n.children.every((c, i) => matchInstance(c, kids[i], props, out));
  };
  const instanceOf = (id) => {
    const n = doc.nodes[id];
    const comp = n.componentId && !n.componentRootId && !roots.includes(id) ? doc.components?.[n.componentId] : null;
    if (!comp?.tree) return null;
    const props = {};
    return matchInstance(id, comp.tree, propsOf(comp), props) ? { comp, props } : null;
  };
  const scan = (id) => { const d = instanceOf(id); if (d) declared.set(id, d); else doc.nodes[id].children.forEach(scan); };
  roots.forEach((r) => doc.nodes[r].children.forEach(scan));

  // Count every subtree under the roots, then walk again so a subtree inside a repeated one is only counted once
  // per distinct parent (icons inside three identical sidebars aren't "used three times"). Declared instances are
  // already components, so they aren't counted.
  const raw = new Map();
  const countAll = (id) => { if (declared.has(id)) return; raw.set(keyOf(id), (raw.get(keyOf(id)) || 0) + 1); doc.nodes[id].children.forEach(countAll); };
  roots.forEach((r) => doc.nodes[r].children.forEach(countAll));
  const uses = new Map(), firstId = new Map();
  const visit = (id) => {
    if (declared.has(id)) return;
    const k = keyOf(id), n = doc.nodes[id];
    if (raw.get(k) > 1 && n.children.length) {
      uses.set(k, (uses.get(k) || 0) + 1);
      if (uses.get(k) > 1) return;
      firstId.set(k, id);
    }
    n.children.forEach(visit);
  };
  roots.forEach((r) => doc.nodes[r].children.forEach(visit));
  const names = new Set(roots.map((r) => componentName(doc.nodes[r].name)));
  const comps = new Map(); // key -> { name, id, body, deps, params? }
  for (const { comp } of declared.values()) {
    if (comps.has(`declared:${comp.id}`)) continue;
    const base = componentName(comp.name);
    let name = base, i = 2;
    while (names.has(name)) name = `${base}${i++}`;
    names.add(name);
    comps.set(`declared:${comp.id}`, { name, comp, body: null, deps: new Set(), params: "" });
  }
  // Named after the first layer, without a trailing number ("Nav item 3" → NavItem); unnamed SVGs are Icon.
  const compBase = (n) => {
    if (n.tag === "svg" && (!n.name || n.name.toLowerCase() === "svg")) return "Icon";
    const trimmed = String(n.name).replace(/[\s\d_-]+$/, "");
    return componentName(trimmed || n.name);
  };
  for (const [k, count] of uses) {
    if (count < 2) continue;
    const base = compBase(doc.nodes[firstId.get(k)]);
    let name = base, i = 2;
    while (names.has(name)) name = `${base}${i++}`;
    names.add(name);
    comps.set(k, { name, id: firstId.get(k), body: null, deps: new Set() });
  }

  const styleEntries = []; // { json, inline, count, name, hint }
  const styleIdx = new Map();
  const styleToken = (n) => {
    const styles = exportStyles(n, doc);
    if (sheet || !Object.keys(styles).length) return "";
    const inline = Object.entries(styles).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
    if (!styleIdx.has(inline)) { styleIdx.set(inline, styleEntries.length); styleEntries.push({ inline, count: 0, hint: n.name }); }
    const i = styleIdx.get(inline);
    styleEntries[i].count += 1;
    return ` style={\u0000${i}\u0000}`;
  };

  const jsxText = (t) => `{${JSON.stringify(t)}}`;
  const JSX_ATTR_NAMES = { tabindex: "tabIndex" };
  const jsxName = (k) => JSX_ATTR_NAMES[k] || (k.startsWith("aria-") ? k : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  // A declared component's body, from its definition; text slots read their prop.
  const renderSpec = (sp, depth, props) => {
    const pad = "  ".repeat(depth);
    const cls = [...layerClasses(sp, doc), sheet && sheet.classFor(sp)].filter(Boolean).join(" ");
    const attrs = Object.entries(sp.attrs || {}).map(([k, v]) => ` ${jsxName(k)}=${JSON.stringify(v)}`).join("");
    const open = `${pad}<${sp.tag}${cls ? ` className="${cls}"` : ""}${attrs}${styleToken(sp)}`;
    if (VOID_TAGS.has(sp.tag)) return `${open} />`;
    const prop = props.get(sp.key);
    const text = prop ? `{${prop}}` : sp.text ? jsxText(sp.text) : "";
    const kids = sp.children || [];
    if (!kids.length) return text ? `${open}>${text}</${sp.tag}>` : `${open} />`;
    return [`${open}>`, ...(text ? [`${pad}  ${text}`] : []), ...kids.map((c) => renderSpec(c, depth + 1, props)), `${pad}</${sp.tag}>`].join("\n");
  };
  const render = (id, depth, deps, self = null) => {
    const n = doc.nodes[id];
    const pad = "  ".repeat(depth);
    const inst = declared.get(id);
    if (inst) {
      const c = comps.get(`declared:${inst.comp.id}`);
      deps.add(c);
      if (!c.body) {
        const props = propsOf(inst.comp);
        c.params = props.size ? `{ ${[...props].map(([key, name]) => {
          const sp = (function find(t) { return t.key === key ? t : (t.children || []).map(find).find(Boolean); })(inst.comp.tree);
          return `${name} = ${JSON.stringify(sp.text || "")}`;
        }).join(", ")} }` : "";
        c.body = renderSpec(inst.comp.tree, 2, props);
      }
      // A plain "…" attribute can't hold quotes or backslashes in JSX, and & would be read as an entity: those use {…}.
      const passed = Object.entries(inst.props).map(([k, v]) => ` ${k}=${/["\\\n&{}<>]/.test(v) ? `{${JSON.stringify(v)}}` : `"${v}"`}`).join("");
      return `${pad}<${c.name}${passed} />`;
    }
    const comp = id !== self && !roots.includes(id) ? comps.get(keyOf(id)) : null;
    if (comp) {
      deps.add(comp);
      if (!comp.body) {
        comp.body = "…"; // being rendered
        comp.body = render(comp.id, 2, comp.deps, comp.id);
      }
      return `${pad}<${comp.name} />`;
    }
    const cls = [...layerClasses(n, doc), sheet && sheet.classFor(n)].filter(Boolean).join(" ");
    const classProp = cls ? ` className="${cls}"` : "";
    const attrs = Object.entries(n.attrs || {}).map(([k, v]) => ` ${jsxName(k)}=${JSON.stringify(v)}`).join("");
    const open = `${pad}<${n.tag}${classProp}${attrs}${styleToken(n)}`;
    if (VOID_TAGS.has(n.tag)) return `${open} />`;
    if (!n.children.length) return n.text ? `${open}>${jsxText(n.text)}</${n.tag}>` : `${open} />`;
    const text = n.text ? [`${pad}  ${jsxText(n.text)}`] : [];
    return [`${open}>`, ...text, ...n.children.map((c) => render(c, depth + 1, deps)), `${pad}</${n.tag}>`].join("\n");
  };

  const fn = (name, body, exported = true, params = "") => `${exported ? "export " : ""}function ${name}(${params}) {\n  return (\n${body}\n  );\n}`;
  return {
    // Render one root as an exported component; returns { code, deps } (code still holds style tokens).
    screen(id) {
      const deps = new Set();
      const body = render(id, 2, deps, id);
      return { code: fn(componentName(doc.nodes[id].name), body), deps };
    },
    components: () => [...comps.values()].filter((c) => c.body),
    component: (c, exported) => fn(c.name, c.body, exported, c.params || ""),
    // Replace style tokens: styles used more than once point at one `styles` entry, others stay inline.
    finishStyles(chunks) {
      const used = new Set(["styles"]);
      for (const e of styleEntries) {
        if (e.count < 2) continue;
        // Named after the first layer that used it, without a trailing number; "1000" (a text layer) → style.
        const words = String(e.hint || "").replace(/[^A-Za-z0-9]+/g, " ").replace(/[\s\d]+$/, "").trim().split(/\s+/).filter(Boolean);
        const camel = words.map((w, j) => (j ? w[0].toUpperCase() + w.slice(1) : w[0].toLowerCase() + w.slice(1))).join("");
        const base = /^[A-Za-z_]/.test(camel) ? camel : "style";
        let name = base, i = 2;
        while (used.has(name)) name = `${base}${i++}`;
        used.add(name);
        e.name = name;
      }
      const shared = styleEntries.filter((e) => e.name);
      const decl = shared.length ? `const styles = {\n${shared.map((e) => `  ${e.name}: { ${e.inline} },`).join("\n")}\n};\n\n` : "";
      const fill = (code) => code.replace(/\u0000(\d+)\u0000/g, (_, i) => (styleEntries[i].name ? `styles.${styleEntries[i].name}` : `{ ${styleEntries[i].inline} }`));
      return { decl, chunks: chunks.map(fill) };
    },
  };
}

function toJsx(nodeId, { filesBase, doc = state, sheet } = {}) {
  const roots = exportRoots(nodeId, doc);
  const b = jsxBuilder(doc, roots, { sheet });
  const screens = roots.map((id) => b.screen(id).code);
  const comps = b.components().map((c) => b.component(c, false));
  const { decl, chunks } = b.finishStyles([...comps, ...screens]);
  let header = "";
  if (sheet) header = `import "../tokens.css";\nimport "../components.css";\n\n`; // the project export's stylesheets
  else {
    const fam = usedFonts(roots, doc);
    // "*/" inside a value would end the comment early.
    const root = rootCssText(usedRootCss(roots, doc)).replace(/\*\//g, "* /");
    if (root) header += `/* Root CSS used by these components; put it in your global stylesheet:\n${root}\n*/\n\n`;
    if (fam.length) header += `/* Fonts used: ${fam.join(", ")}. Load them with:\n${fonts.css({ families: fam, baseUrl: PUBLIC_URL, filesBase })}\n*/\n\n`;
  }
  return header + decl + chunks.join("\n\n") + "\n";
}

function exportCode(format = "html", nodeId) {
  if (format === "jsx") return toJsx(nodeId);
  if (format === "html") return toHtml(nodeId);
  throw new HttpError(400, `Unknown format "${format}" (use html or jsx)`);
}

// Minimal dependency-free PKZIP builder (UTF-8 names, Deflate/Store, CRC-32).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const now = new Date();
  const dosTime = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
  const dosDate = (((Math.max(1980, now.getFullYear()) - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);
  const localParts = [], centralParts = [];
  let offset = 0;

  for (const e of entries) {
    const isDir = e.name.endsWith("/");
    const nameBuf = Buffer.from(e.name, "utf8");
    const raw = isDir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ""), "utf8");
    const defl = !isDir && raw.length > 0 ? zlib.deflateRawSync(raw) : null;
    const useDeflate = Boolean(defl && defl.length < raw.length);
    const comp = useDeflate ? defl : raw;
    const method = useDeflate ? 8 : 0;
    const crc = isDir ? 0 : crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(dosTime, 10);
    lfh.writeUInt16LE(dosDate, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(comp.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    localParts.push(lfh, nameBuf, comp);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(dosTime, 12);
    cdh.writeUInt16LE(dosDate, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(comp.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(isDir ? 0x10 : 0, 38);
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(cdh, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, cdBuf, eocd]);
}

function slugName(raw, fallback = "item") {
  const s = String(raw || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return s || fallback;
}

function uniqueSlug(used, raw, fallback) {
  const base = slugName(raw, fallback);
  let name = base, i = 2;
  while (used.has(name)) name = `${base}-${i++}`;
  used.add(name);
  return name;
}

async function exportProjectZip(projectId, format = "html") {
  if (!["html", "jsx", "both"].includes(format)) throw new HttpError(400, `Unknown format "${format}" (use html, jsx, or both)`);
  const doc = state?.id === projectId ? state : await readProject(projectId);
  const wantHtml = format === "html" || format === "both";
  const wantJsx = format === "jsx" || format === "both";
  const entries = [];
  const usedPageDirs = new Set(["fonts", "components"]);
  // Every screen links one root stylesheet instead of carrying its own copy of the CSS.
  const sheet = sharedSheet(doc);
  const allFamilies = new Set();
  const manifest = [];
  // JSX: one builder across every screen, so a sidebar shared by several screens is one components/ file.
  const jsx = wantJsx ? jsxBuilder(doc, doc.pages.flatMap((pid) => doc.nodes[pid]?.children || []), { sheet }) : null;

  for (let pi = 0; pi < doc.pages.length; pi++) {
    const pid = doc.pages[pi];
    const page = doc.nodes[pid];
    if (!page) continue;
    const pageDir = uniqueSlug(usedPageDirs, page.name, `page-${pi + 1}`);
    entries.push({ name: `${pageDir}/` });
    const usedFiles = new Set();
    const items = [];

    for (let ai = 0; ai < page.children.length; ai++) {
      const abId = page.children[ai];
      const ab = doc.nodes[abId];
      if (!ab) continue;
      usedFonts([abId], doc).forEach((f) => allFamilies.add(f));
      const slug = uniqueSlug(usedFiles, ab.name, `screen-${ai + 1}`);
      if (wantHtml) {
        const body = toHtml(abId, { doc, sheet });
        const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escHtml(ab.name)} · ${escHtml(doc.name)}</title>\n<link rel="stylesheet" href="../tokens.css">\n<link rel="stylesheet" href="../components.css">\n</head>\n<body>\n${body}</body>\n</html>\n`;
        entries.push({ name: `${pageDir}/${slug}.html`, data: html });
      }
      if (wantJsx) {
        const { code, deps } = jsx.screen(abId);
        const imports = [...deps].map((c) => `import { ${c.name} } from "../components/${c.name}.jsx";\n`).join("");
        entries.push({ name: `${pageDir}/${slug}.jsx`, data: `import "../tokens.css";\nimport "../components.css";\n${imports}\n${code}\n` });
      }
      items.push({ name: ab.name, fileBase: `${pageDir}/${slug}`, width: ab.styles.width || "auto", height: ab.styles.height || "auto" });
    }
    manifest.push({ name: page.name, dir: pageDir, items });
  }

  if (jsx && jsx.components().length) {
    entries.push({ name: "components/" });
    for (const c of jsx.components()) {
      const imports = [...c.deps].map((d) => `import { ${d.name} } from "./${d.name}.jsx";\n`).join("");
      entries.push({ name: `components/${c.name}.jsx`, data: `${imports}${imports ? "\n" : ""}${jsx.component(c, true)}\n` });
    }
  }

  const fontCss = allFamilies.size ? fonts.css({ families: [...allFamilies], filesBase: "fonts" }) : "";
  entries.push({ name: "tokens.css", data: sheet.tokensCss(fontCss) });
  entries.push({ name: "components.css", data: sheet.componentsCss() });
  // The same tokens as tokens.css, in the W3C Design Tokens format, for design tools and token pipelines.
  entries.push({ name: "tokens.json", data: `${JSON.stringify(exportDesignTokens(doc), null, 2)}\n` });
  const sprite = iconSprite(doc);
  if (sprite) entries.push({ name: "icons.svg", data: sprite });

  // Bundle uploaded font files used anywhere in the project so exported HTML works offline.
  const fontFiles = allFamilies.size ? fonts.uploadedFor([...allFamilies]) : [];
  if (fontFiles.length) {
    entries.push({ name: "fonts/" });
    for (const f of fontFiles) {
      try { entries.push({ name: `fonts/${f.file}`, data: await fs.readFile(f.path) }); } catch {}
    }
  }

  // Root index listing every page folder and individual exported file.
  const indexSections = manifest.map((pg) => `  <section>
    <h2>${escHtml(pg.name)} <small>/${escHtml(pg.dir)}/</small></h2>
    ${pg.items.length ? `<ul>\n${pg.items.map((it) => `      <li>${wantHtml ? `<a href="${escHtml(it.fileBase)}.html">${escHtml(it.name)}</a>` : `<strong>${escHtml(it.name)}</strong>`}${wantJsx ? ` <a class="jsx" href="${escHtml(it.fileBase)}.jsx">JSX</a>` : ""} <span>${escHtml(it.width)} × ${escHtml(it.height)}</span></li>`).join("\n")}\n    </ul>` : '<p class="empty">No artboards on this page.</p>'}
  </section>`).join("\n");
  entries.unshift({
    name: "index.html",
    data: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${escHtml(doc.name)} — Export</title>\n<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#1d1d1f;background:#fff}h1{margin:0 0 6px;font-size:24px}h2{margin:28px 0 10px;font-size:16px;border-bottom:1px solid #ebebea;padding-bottom:6px}h2 small{color:#8a8a87;font-weight:400;font-family:ui-monospace,monospace;font-size:12px}ul{list-style:none;padding:0;margin:0;display:grid;gap:6px}li{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid #ebebea;border-radius:8px}a{color:#2f5bd3;text-decoration:none;font-weight:500}a:hover{text-decoration:underline}a.jsx{font-family:ui-monospace,monospace;font-size:12px;background:#f4f4f2;padding:2px 6px;border-radius:4px}li span{margin-left:auto;color:#8a8a87;font-family:ui-monospace,monospace;font-size:12px}.empty{color:#8a8a87}</style>\n</head>\n<body>\n<h1>${escHtml(doc.name)}</h1>\n<p style="color:#8a8a87;margin:0">${manifest.length} page${manifest.length === 1 ? "" : "s"} exported</p>\n${indexSections}\n</body>\n</html>\n`,
  });

  return { fileName: `${slugName(doc.name, "project")}.zip`, buffer: buildZip(entries) };
}

// Compact indented outline: cheap for agents to read.
// Indented outline for agents. Bounded so a big page can't flood the context: long sibling runs are cut after
// `maxChildren` (with a pointer to get_children), and the whole outline stops after `maxLines`.
function outline(nodeId = state.rootId, depth = 4, { maxLines = 400, maxChildren = 40 } = {}) {
  const lines = [];
  let cut = false;
  const walk = (id, lvl) => {
    if (lines.length >= maxLines) { cut = true; return; }
    const n = state.nodes[id];
    const size = n.styles.width || n.styles.height ? ` [${n.styles.width || "auto"} x ${n.styles.height || "auto"}]` : "";
    const txt = n.text ? ` "${n.text.length > 40 ? `${n.text.slice(0, 37)}...` : n.text}"` : "";
    const hidden = lvl >= depth && n.children.length ? ` (+${n.children.length} children)` : "";
    lines.push(`${"  ".repeat(lvl)}${id} <${isPage(id) ? "page" : n.tag}> ${n.name}${size}${txt}${hidden}`);
    if (lvl >= depth) return;
    n.children.slice(0, maxChildren).forEach((c) => walk(c, lvl + 1));
    if (n.children.length > maxChildren && lines.length < maxLines) {
      lines.push(`${"  ".repeat(lvl + 1)}… ${n.children.length - maxChildren} more children of ${n.name} (get_children({ nodeId: "${id}", offset: ${maxChildren} }))`);
    }
  };
  walk(getNode(nodeId).id, 0);
  if (cut) lines.push(`… outline cut at ${maxLines} lines; pass a deeper nodeId or a smaller depth`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------
let fontsRev = 0; // bumps when the font library changes, so the renderer reloads pages that use fonts
const fontsChanged = () => {
  fontsRev += 1;
  sendEvent("fonts", { fonts: fonts.list(), v: Date.now(), rev: fontsRev });
};
async function addFont(input) {
  let entry;
  if (input.source === "google" || (input.family && !input.data && !input.filePath)) entry = await fonts.addGoogle(input);
  else if (input.filePath) entry = await fonts.addFromPath(input.filePath, input);
  else entry = await fonts.addUpload(input);
  fontsChanged();
  return { ...entry, cssFamily: fonts.stack(entry.family) };
}
async function removeFont(id) {
  const f = await fonts.remove(id);
  fontsChanged();
  return { removed: f.family };
}

function setSessionTitle(text) {
  const title = cleanName(text, "");
  if (!title) throw new HttpError(400, "Session title cannot be empty");
  // The calling agent's own session: another agent's title must not overwrite it.
  const agentId = mcpContextStore.getStore()?.agent?.id || null;
  const last = [...projectSessions].reverse().find((x) => x.source === "mcp" && (x.agentId ?? null) === agentId);
  const now = Date.now();
  if (last && !last.reverted && (last.live || now - Date.parse(last.updatedAt) < SESSION_GAP_MS * 2)) {
    last.title = title;
    saveSessions();
    sendActivity();
    return { title, sessionId: last.id };
  }
  pendingSessionTitles.set(agentId, title);
  return { title, pending: true };
}

// ---------------------------------------------------------------------------
// MCP (tools live in mcp-tools.js)
// ---------------------------------------------------------------------------
const renderer = new Renderer(`http://127.0.0.1:${PORT}`, { contentKey: () => `${state.id}:${state.version}:${fontsRev}` });

// Computed styles from an open editor tab. The canvas already has the page laid out with the same CSS as the
// render page, so a tab that shows this artboard at the current version answers in a few ms, where headless Chrome
// would load the artboard first. Every editor tab is asked; the first usable answer wins. A tab that can't answer
// (another project or page, an older version, a drag in progress, fonts still loading) says so, and if none can
// within TAB_MEASURE_MS, the caller uses headless Chrome.
const tabMeasures = new Map(); // request id -> { resolve, waiting: number of tabs yet to answer, timer }
let tabMeasureSeq = 0;
function measureInTab({ artboardId, nodeIds, properties }) {
  if (TAB_MEASURE_MS <= 0 || !editorClients.size) return Promise.resolve(null);
  const id = `m${++tabMeasureSeq}`;
  const req = { id, projectId: state.id, version: state.version, fontsRev, artboardId, nodeIds, properties };
  return new Promise((resolve) => {
    const done = (result) => { const m = tabMeasures.get(id); if (!m) return; clearTimeout(m.timer); tabMeasures.delete(id); resolve(result); };
    tabMeasures.set(id, { done, waiting: editorClients.size, timer: setTimeout(() => done(null), TAB_MEASURE_MS) });
    for (const res of editorClients) res.write(`event: measure\ndata: ${JSON.stringify(req)}\n\n`);
  });
}
function answerTabMeasure(id, body) {
  const m = tabMeasures.get(id);
  if (!m) return { ok: false }; // already answered, or timed out
  if (body && body.result && typeof body.result === "object" && body.version === state.version) m.done(body.result);
  else if (--m.waiting <= 0) m.done(null);
  return { ok: true };
}
async function auditArtboards({ nodeIds, nodeId, width, checkContrast = false, checkTapTargets } = {}) {
  const rawIds = nodeIds?.length
    ? nodeIds
    : nodeId
      ? [nodeId]
      : uiSelection.ids.filter((id) => state.nodes[id] && !isPage(id));
  const artboards = [];
  const seen = new Set();
  const pushAb = (ab) => {
    if (ab && !seen.has(ab)) {
      seen.add(ab);
      artboards.push(ab);
    }
  };
  if (rawIds.length) {
    for (const id of rawIds) {
      getNode(id);
      if (isPage(id)) {
        for (const cid of state.nodes[id].children || []) pushAb(cid);
      } else {
        pushAb(artboardOf(id));
      }
    }
  } else {
    for (const cid of state.nodes[state.rootId]?.children || []) pushAb(cid);
  }
  if (!artboards.length) throw new HttpError(400, "Canvas is empty");
  look(artboards, "audit_artboard", artboards.length === 1 ? state.nodes[artboards[0]].name : `${artboards.length} artboards`);
  const audits = [];
  const summary = { brokenImages: 0, overflows: 0, missingFonts: 0, tapTargets: 0, lowContrast: 0 };
  for (const ab of artboards) {
    const size = artboardSize(ab);
    const report = await renderer.audit({
      artboardId: ab,
      ...size,
      widthOverride: width,
      checkContrast,
      checkTapTargets,
    });
    explainAudit(report);
    for (const k of Object.keys(summary)) summary[k] += report.summary?.[k] || 0;
    audits.push({ artboardId: ab, name: state.nodes[ab].name, ...report });
  }
  return { ok: audits.every((a) => a.ok), summary, audits };
}

// Make an audit report easy to act on: every finding names its layer, and a container that only overflows because a
// layer inside it is too wide points at that layer (causedBy) instead of counting as a separate problem.
function explainAudit(report) {
  if (!report || report.error) return report;
  const named = (list) => (list || []).map((f) => (f.nodeId && state.nodes[f.nodeId] ? { nodeId: f.nodeId, name: state.nodes[f.nodeId].name, ...f } : f));
  for (const k of ["brokenImages", "tapTargets", "lowContrast"]) report[k] = named(report[k]);
  const overflows = named(report.overflows);
  const ids = overflows.map((o) => o.nodeId);
  for (const o of overflows) {
    if (o.type !== "horizontal-overflow") continue;
    const inside = ids.filter((id) => id !== o.nodeId && state.nodes[id] && isAncestor(o.nodeId, id));
    if (inside.length) o.causedBy = inside;
  }
  // Point at the real causes only, not at containers that are themselves just overflowing because of them.
  const effects = new Set(overflows.filter((o) => o.causedBy).map((o) => o.nodeId));
  for (const o of overflows) if (o.causedBy) o.causedBy = o.causedBy.filter((id) => !effects.has(id));
  report.overflows = overflows;
  if (report.summary) {
    report.summary.overflows = overflows.filter((o) => !o.causedBy).length;
    report.ok = Object.values(report.summary).every((v) => v === 0);
  }
  return report;
}

const components = createComponentEngine({
  getState: () => state, getNode, isPage, safePageOf, nestError, insertChild, nextArtboardPosition, definedClasses, mutate, specTag,
});

const mcpContext = {
  state: () => state,
  urls: { ui: PUBLIC_URL, mcp: `${PUBLIC_URL}/mcp` },
  getNode, isPage, pageOf, artboardOf, artboardSize, outline, exportCode, renderer, measureInTab, auditArtboards, explainAudit,
  createNode, updateNode, updateNodesMatching, deleteNode, duplicateNode, createArtboard, writeHtml,
  components: { list: () => components.list(), create: (a, s) => components.create(a, s), instantiate: (a, s) => components.instantiate(a, s), update: (a, s) => components.update(a, s), remove: (a, s) => components.remove(a, s) },
  rootCss: { get: (opts) => getRootCss(opts), update: (patch) => updateRootCss(patch, "mcp"), import: (opts) => importRootCss(opts, "mcp"), hints: (ids, opts) => rootCssHints(ids, state, opts) },
  tokens: { export: () => exportDesignTokens(state), import: (opts) => applyDesignTokens(opts, "mcp") },
  icons: { list: () => listIcons(), register: (opts) => registerIcons(opts, "mcp"), remove: (name) => deleteIcon(name, "mcp") },
  batch: (source, fn, meta) => batch(source, fn, meta),
  undo: (source) => stepHistory(source, "undo"),
  agentStep: (direction, opts) => agentHistoryStep(direction, opts),
  redo: (source) => stepHistory(source, "redo"),
  selection: () => ({ ...uiSelection, ids: uiSelection.ids.filter((id) => state.nodes[id]) }),
  presence: presenceList,
  touch,
  look,
  finishWorking,
  focusNodes: (ids, zoom) => {
    if (!ids?.length) { sendEvent("focus", { ids: [], zoom: false }); return; }
    const page = pageOf(ids[0]);
    if (page !== state.rootId) switchPage(page, "mcp");
    sendEvent("focus", { ids, zoom });
  },
  projects: { list: projectList, create: createProject, open: openProject, rename: renameProject, duplicate: duplicateProject, remove: deleteProject },
  pages: { create: createPage, open: switchPage, update: updatePage, remove: deletePage },
  fonts: { list: () => fonts.list().map((f) => ({ ...f, cssFamily: fonts.stack(f.family) })), add: addFont, remove: removeFont },
  checkpoints: {
    list: () => publicCheckpoints(),
    save: (name) => {
      const cp = createCheckpoint(name || "Manual checkpoint", { auto: false, kind: "manual" });
      return { id: cp.id, name: cp.name, at: cp.at, layerCount: cp.layerCount };
    },
    restore: async (id, { force = false } = {}) => {
      const cp = projectCheckpoints.find((c) => c.id === id);
      if (cp && !force) {
        // Restoring rolls the whole project back: refuse while that would throw away the user's or another agent's
        // later work, unless the agent was told to.
        const others = editsByOthersSince({ startedAt: cp.at, source: "mcp", agentId: mcpContextStore.getStore()?.agent?.id || null });
        if (others.count) {
          throw new HttpError(409, `Restoring "${cp.name}" would also discard ${others.count} later edit${others.count === 1 ? "" : "s"} by ${others.who.join(", ")}, so nothing was done. To take back only your own changes use undo; pass force: true only if the user asked to restore the whole project`);
        }
      }
      return restoreCheckpointById(id, "mcp");
    },
  },
  git: { status: gitApi.status, push: gitApi.push, pull: gitApi.pull },
  comments: {
    openCount: openCommentCount,
    list: mcpGetComments,
    reply: (id, text, linkStep = true, reopen = false) => {
      agentVisibleComment(id);
      const store = mcpContextStore.getStore();
      return replyComment(id, { text, author: store?.agent?.name || "Claude", linkStep, reopen });
    },
    resolve: (id) => {
      agentVisibleComment(id);
      return updateComment(id, { status: "resolved" });
    },
  },
  session: {
    setTitle: setSessionTitle,
  },
};

function buildMcpServer() {
  const server = new McpServer({ name: "weft", version: PKG_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, mcpContext);
  return server;
}

// Building a server registers every tool schema, so idle servers are pooled and reused. Each request still gets
// a server of its own (one transport per server at a time), so concurrent requests never share one.
const MCP_POOL_MAX = 8;
const mcpPool = [];
const acquireMcpServer = () => mcpPool.pop() || buildMcpServer();
async function releaseMcpServer(server, transport) {
  try {
    await transport.close();
    await server.close();
  } catch {
    return; // don't reuse a server that didn't close cleanly
  }
  if (mcpPool.length < MCP_POOL_MAX) mcpPool.push(server);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const app = express();
app.disable("x-powered-by");

// Block DNS-rebinding and cross-site writes: only accept requests addressed to (and sent from) localhost.
const hostOk = (h) => Boolean(h) && ALLOWED_HOSTS.has(h.toLowerCase().replace(/:\d+$/, ""));
app.use((req, res, next) => {
  if (!hostOk(req.headers.host)) return res.status(403).json({ error: "Host not allowed" });
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      if (!hostOk(new URL(origin).host)) return res.status(403).json({ error: "Origin not allowed" });
    } catch {
      return res.status(403).json({ error: "Bad origin" });
    }
  }
  next();
});
app.use(express.json({ limit: "25mb" }));
// public/ is the built editor UI (npm run build: ui/ → public/). root-css.js is shared with the server, so it lives
// in shared/ and is served from there.
app.get("/root-css.js", (req, res) => res.type("text/javascript").sendFile(path.join(ROOT, "shared", "root-css.js")));
app.use(express.static(path.join(ROOT, "public")));
if (!existsSync(path.join(ROOT, "public", "index.html"))) {
  console.warn("[weft] the editor UI isn't built yet (public/index.html is missing): run `npm run build`. The API and MCP work without it.");
}

const who = (req) => req.get("x-client-id") || "api";
const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!err.status) console.error("[weft]", err);
    res.status(err.status || 500).json({ error: err.message, ...(err.details || {}) });
  }
};

app.get("/events", async (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`event: state\ndata: ${JSON.stringify({ source: "init", state })}\n\n`);
  res.write(`event: projects\ndata: ${JSON.stringify({ projects: projectList() })}\n\n`);
  res.write(`event: fonts\ndata: ${JSON.stringify({ fonts: fonts.list(), v: 0, rev: fontsRev })}\n\n`);
  res.write(`event: presence\ndata: ${JSON.stringify(presencePayload())}\n\n`);
  res.write(`event: history\ndata: ${JSON.stringify(historyPayload())}\n\n`);
  res.write(`event: comments\ndata: ${JSON.stringify({ comments: state.comments || [] })}\n\n`);
  const sessions = await allActivitySessions().catch(() => []);
  if (!res.destroyed && !res.closed) {
    res.write(`event: activity\ndata: ${JSON.stringify({ sessions })}\n\n`);
  }
  sseClients.add(res);
  if (req.query.role === "editor") editorClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); editorClients.delete(res); });
});

// An editor tab's answer to a "measure" event (see measureInTab).
app.post("/api/measure/:id", wrap((req) => answerTabMeasure(req.params.id, req.body)));

// Open project document
app.get("/api/state", wrap(() => state));
app.post("/api/state", wrap((req) => {
  const next = normalizeProject(req.body, { id: state.id, name: state.name, warnings: [] });
  mutate(who(req), (s) => { s.pages = next.pages; s.rootId = next.rootId; s.nodes = next.nodes; }, { tool: "Replace state", target: state.name });
  return state;
}));

// Nodes
app.get("/api/root-css", wrap(() => getRootCss()));
app.patch("/api/root-css", wrap((req) => updateRootCss(req.body || {}, who(req))));
app.get("/api/icons", wrap(() => listIcons()));
app.post("/api/icons", wrap((req) => registerIcons(req.body || {}, who(req))));
app.delete("/api/icons/:name", wrap((req) => deleteIcon(req.params.name, who(req))));
app.post("/api/root-css/import", wrap((req) => importRootCss(req.body || {}, who(req))));
app.get("/api/tokens", wrap(() => exportDesignTokens(state)));
app.post("/api/tokens", wrap((req) => applyDesignTokens(req.body || {}, who(req))));
app.post("/api/nodes", wrap((req) => createNode(req.body || {}, who(req))));
app.patch("/api/nodes/:id", wrap((req) => updateNode(req.params.id, req.body || {}, who(req))));
app.delete("/api/nodes/:id", wrap((req) => deleteNode(req.params.id, who(req))));
app.post("/api/nodes/:id/duplicate", wrap((req) => duplicateNode(req.params.id, who(req))));
// Several edits from the editor as one undo step (a multi-selection moved, nudged, duplicated or deleted together).
// ops: [{ op: "update", id, patch } | { op: "delete", id } | { op: "duplicate", id }]. All or nothing; a delete
// of a layer already removed with its parent earlier in the list is skipped.
app.post("/api/nodes/batch", wrap((req) => {
  const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
  if (!ops.length || ops.length > 500) throw new HttpError(400, "ops: a list of 1–500 operations");
  const source = who(req);
  const ids = ops.map((o) => String(o?.id ?? ""));
  const kinds = new Set(ops.map((o) => o?.op));
  const label = kinds.size === 1 ? { update: "Edit", delete: "Delete", duplicate: "Duplicate" }[[...kinds][0]] || "Edit" : "Edit";
  const results = batch(source, () => ops.map((o, i) => {
    const id = ids[i];
    if (o?.op === "update") return updateNode(id, o.patch || {}, source);
    if (o?.op === "delete") return state.nodes[id] ? deleteNode(id, source) : { deleted: [] };
    if (o?.op === "duplicate") return duplicateNode(id, source);
    throw new HttpError(400, `Unknown op "${o?.op}" (use update, delete or duplicate)`);
  }), { tool: label, target: ops.length === 1 ? state.nodes[ids[0]]?.name || "1 layer" : `${ops.length} layers`, nodeIds: ids.filter((id) => state.nodes[id]) });
  return { results };
}));
app.post("/api/undo", wrap((req) => ({ ok: stepHistory(who(req), "undo") })));
app.post("/api/redo", wrap((req) => ({ ok: stepHistory(who(req), "redo") })));
app.post("/api/selection", wrap((req) => {
  const list = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === "string" && state.nodes[id]).slice(0, 200) : [];
  uiSelection = { ids: list, at: Date.now() };
  return { ok: true };
}));

// History (§1) & Checkpoints (§2)
app.get("/api/history", wrap(() => historyPayload()));
app.get("/api/history/search", wrap((req) => searchHistory(req.query || {})));
app.post("/api/history/jump", wrap((req) => {
  let idx = req.body?.index;
  if (idx === undefined && req.body?.id) {
    idx = historyTimeline.findIndex((e) => e.id === req.body.id);
    if (idx === -1) throw new HttpError(404, `History entry "${req.body.id}" not found`);
  }
  return jumpHistory(who(req), idx);
}));
app.post("/api/history/undo-agent-run", wrap((req) => undoLastAgentRun(who(req))));

app.get("/api/checkpoints", wrap(() => publicCheckpoints()));
app.post("/api/checkpoints", wrap((req) => {
  const cp = createCheckpoint(req.body?.name || "Checkpoint", { auto: false, kind: "manual" });
  return { id: cp.id, name: cp.name, auto: cp.auto, kind: cp.kind, at: cp.at, historyId: cp.historyId, layerCount: cp.layerCount };
}));
app.post("/api/checkpoints/:id/restore", wrap((req) => restoreCheckpointById(req.params.id, who(req))));

// Git remote for the open project's checkpoints (the token is write-only: never returned)
app.get("/api/git", wrap(() => gitApi.status()));
app.put("/api/git/remote", wrap((req) => gitApi.connect(req.body || {})));
app.delete("/api/git/remote", wrap(() => gitApi.disconnect()));
app.post("/api/git/push", wrap(() => gitApi.push()));
app.post("/api/git/pull", wrap(() => gitApi.pull()));

// Comments (§3)
app.get("/api/comments", wrap((req) => listComments({
  status: req.query.status ? String(req.query.status) : undefined,
  nodeId: req.query.nodeId ? String(req.query.nodeId) : undefined,
})));
app.post("/api/comments", wrap((req) => addComment(req.body || {})));
app.post("/api/comments/:id/reply", wrap((req) => replyComment(req.params.id, {
  text: req.body?.text,
  author: "you",
  agentsCanSee: req.body?.agentsCanSee,
})));
app.patch("/api/comments/:id", wrap((req) => updateComment(req.params.id, req.body || {})));
app.delete("/api/comments/:id", wrap((req) => deleteComment(req.params.id)));

// The author test for a session's steps: you, or that one agent session.
const sessionAuthor = (session) => (e) => e.source === session.source && (session.source !== "mcp" || !session.agentId || e.agentId === session.agentId);

// This session's own steps still in the undo history (oldest first), minus steps already taken back by an undo that
// wasn't redone, and minus the undo / redo / revert steps themselves.
function sessionSteps(session) {
  const start = Date.parse(session.startedAt), end = Date.parse(session.updatedAt) + 1000;
  const author = sessionAuthor(session);
  const byId = new Map(historyTimeline.map((e) => [e.id, e]));
  return historyTimeline.slice(0, historyCursor + 1).filter((e) => {
    const at = Date.parse(e.at);
    if (!author(e) || at < start || at > end || e.kind) return false;
    if (e.revertedBy) { const r = byId.get(e.revertedBy); if (!r || !r.redoneBy) return false; }
    return true;
  });
}

// Edits in the open project's history made after a session started by anyone other than that session's author.
function editsByOthersSince(session) {
  const start = Date.parse(session.startedAt);
  const sameAuthor = sessionAuthor(session);
  const later = historyTimeline.slice(0, historyCursor + 1).filter((e) => Date.parse(e.at) >= start && !sameAuthor(e));
  const who = [...new Set(later.map((e) => (e.source === "mcp" ? e.agentName || "another agent" : "you")))];
  return { count: later.length, who };
}

// Activity (§5)
app.get("/api/activity", wrap(async () => ({ sessions: await allActivitySessions() })));
app.post("/api/activity/:id/revert", wrap(async (req) => {
  const sid = req.params.id;
  let targetProject = null;
  let targetSession = null;
  for (const p of workspace.projects) {
    const list = await sessionsOf(p.id);
    const found = list.find((s) => s.id === sid);
    if (found) { targetProject = p.id; targetSession = found; break; }
  }
  if (!targetSession) throw new HttpError(404, `Session "${sid}" not found`);
  if (state.id !== targetProject) await openProject(targetProject, who(req));
  const markReverted = () => {
    const activeSession = projectSessions.find((s) => s.id === sid);
    if (!activeSession) return;
    activeSession.reverted = true;
    activeSession.live = false;
    saveSessions();
    sendActivity();
  };

  // Default: take back only this session's own changes and keep everything anyone else did since.
  if (req.body?.mode !== "restore") {
    const steps = sessionSteps(targetSession);
    if (steps.length) {
      const author = sessionAuthor(targetSession);
      const res = selectiveRevert(steps, {
        source: who(req), tool: "Revert session", kind: "session-revert", mine: author,
        label: `Revert session · ${targetSession.title || targetSession.agentName || "session"}`,
      });
      for (const e of steps) e.revertedBy = res.entryId;
      markReverted();
      const older = historyTimeline[0] && Date.parse(historyTimeline[0].at) > Date.parse(targetSession.startedAt);
      return { ok: true, mode: "own", ...res.report, ...(older ? { olderStepsNotReverted: true } : {}) };
    }
    const others = editsByOthersSince(targetSession);
    const err = new HttpError(409, "This session's steps are no longer in the undo history (the server restarted, or they are too old), so its own changes can't be picked out. Restore the project to how it was before the session instead?");
    err.details = { needsRestore: true, othersEdits: others.count, othersWho: others.who };
    throw err;
  }

  // Restore: the whole project goes back to the session's start checkpoint. That also discards everything anyone
  // else did since, so it needs force when there is such work.
  if (!targetSession.checkpointId) throw new HttpError(400, "No checkpoint recorded for this session");
  if (!req.body?.force) {
    const others = editsByOthersSince(targetSession);
    if (others.count) {
      const err = new HttpError(409, `Restoring to before this session also discards ${others.count} later edit${others.count === 1 ? "" : "s"} by ${others.who.join(", ")}`);
      err.details = { othersEdits: others.count, othersWho: others.who };
      throw err;
    }
  }
  const restored = await restoreCheckpointById(targetSession.checkpointId, who(req));
  markReverted();
  return { ok: true, mode: "restore", restored };
}));

// Pages
app.post("/api/pages", wrap((req) => createPage(req.body?.name, who(req))));
app.post("/api/pages/:id/open", wrap((req) => switchPage(req.params.id, who(req))));
app.patch("/api/pages/:id", wrap((req) => updatePage(req.params.id, req.body || {}, who(req))));
app.delete("/api/pages/:id", wrap((req) => deletePage(req.params.id, who(req))));

// Projects
app.get("/api/projects", wrap(() => projectList()));
app.get("/api/projects/:id/preview", wrap((req) => projectPreview(req.params.id)));
app.post("/api/projects", wrap((req) => createProject(req.body?.name, { source: who(req) })));
app.post("/api/projects/:id/open", wrap(async (req) => ({ id: (await openProject(req.params.id, who(req))).id })));
app.patch("/api/projects/:id", wrap((req) => renameProject(req.params.id, req.body?.name, who(req))));
app.post("/api/projects/:id/duplicate", wrap((req) => duplicateProject(req.params.id, req.body?.name)));
app.delete("/api/projects/:id", wrap((req) => deleteProject(req.params.id, who(req))));

// Fonts
app.get("/api/fonts", wrap(() => fonts.list()));
app.post("/api/fonts", wrap((req) => addFont({ ...req.body, source: "upload", filePath: undefined })));
app.post("/api/fonts/google", wrap((req) => addFont({ family: req.body?.family, axes: req.body?.axes, source: "google" })));
app.delete("/api/fonts/:id", wrap((req) => removeFont(req.params.id)));
app.get("/fonts.css", (req, res) => res.type("text/css").set("Cache-Control", "no-cache").send(fonts.css()));
app.get("/fonts/files/:file", (req, res) => {
  const f = fonts.fileFor(req.params.file);
  if (!f) return res.status(404).end();
  res.set({ "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" }).type(`font/${f.format === "otf" ? "otf" : f.format === "ttf" ? "ttf" : f.format}`);
  res.sendFile(f.path);
});

// Rendering, export
// Live preview of one screen in its own browser tab: /preview/:id is a slim shell that shows the screen in an iframe
// sized to the artboard (so @media breakpoints match the canvas), can switch to filling the window, and reloads the
// frame when the project changes. /preview/:id/frame is the screen itself, the same HTML + CSS as the export.
function previewTarget(id) {
  const ab = artboardOf(id);
  return { ab, node: state.nodes[ab] };
}
app.get("/preview/:id/frame", wrap((req, res) => {
  const { ab, node } = previewTarget(req.params.id);
  const fill = req.query.fill === "1";
  res.type("html").set("Cache-Control", "no-store").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(node.name)} · ${escHtml(state.name)}</title>
<link rel="stylesheet" href="/fonts.css">
<style>html,body{margin:0}${fill ? "body>[data-layer]{width:100%!important;min-height:100vh}" : ""}</style></head>
<body>${toHtml(ab, { fontBase: "", markIds: true })}</body></html>`);
}));
app.get("/preview/:id", wrap((req, res) => {
  const { ab, node } = previewTarget(req.params.id);
  const { width } = artboardSize(ab);
  const pageBg = state.nodes[pageOf(ab)]?.styles.backgroundColor || "#eef2f6";
  const title = `${escHtml(node.name)} · ${escHtml(state.name)}`;
  res.type("html").set("Cache-Control", "no-store").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview · ${title}</title>
<link rel="icon" href="/favicon.svg">
<style>
  html, body { margin: 0; height: 100%; }
  body { display: flex; flex-direction: column; background: ${escHtml(pageBg)}; font: 13px/1.4 system-ui, -apple-system, sans-serif; color: #0a0b0d; }
  header { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 14px; background: #fff; border-bottom: 1px solid #dde3e9; flex-shrink: 0; }
  header b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  header .muted { color: #787878; white-space: nowrap; }
  .live { display: inline-flex; align-items: center; gap: 6px; color: #787878; font-size: 12px; margin-left: auto; white-space: nowrap; }
  .live i { width: 7px; height: 7px; border-radius: 50%; background: #c4c9cf; }
  .live.on i { background: #22a06b; }
  .seg { display: inline-flex; border: 1px solid #dde3e9; border-radius: 8px; overflow: hidden; flex-shrink: 0; }
  .seg button { border: 0; background: #fff; padding: 0 10px; height: 28px; font: inherit; color: #0a0b0d; cursor: pointer; }
  .seg button + button { border-left: 1px solid #dde3e9; }
  .seg button[aria-pressed="true"] { background: #f4f6f8; font-weight: 600; }
  a.raw { color: #0000ff; text-decoration: none; white-space: nowrap; }
  a.raw:hover { text-decoration: underline; }
  main { flex: 1; overflow: auto; display: flex; justify-content: center; align-items: flex-start; padding: 32px 16px; }
  main.fill { padding: 0; }
  iframe { border: 0; background: #fff; display: block; width: ${width}px; max-width: none; height: 200px; box-shadow: 0 0 0 1px #dde3e9; }
  main.fill iframe { width: 100%; box-shadow: none; }
  .gone { margin: auto; color: #787878; }
</style></head>
<body>
<header>
  <b>${escHtml(node.name)}</b><span class="muted">${escHtml(state.name)} · ${width}px</span>
  <div class="seg" role="group" aria-label="Preview width">
    <button type="button" id="w-screen" aria-pressed="true">Screen width</button><button type="button" id="w-fill" aria-pressed="false">Fill window</button>
  </div>
  <a class="raw" id="raw" href="/preview/${escHtml(ab)}/frame" target="_blank" rel="noopener">Open page only ↗</a>
  <span class="live" id="live"><i></i><span>Connecting…</span></span>
</header>
<main id="main"><iframe id="frame" title="${title}" src="/preview/${escHtml(ab)}/frame"></iframe></main>
<script>
"use strict";
const AB = ${JSON.stringify(ab)};
const frame = document.getElementById("frame"), main = document.getElementById("main"), live = document.getElementById("live");
let fill = false, scroll = 0, timer = 0, lastKey = "", gone = false, fontsSeen = false;
const src = () => "/preview/" + encodeURIComponent(AB) + "/frame" + (fill ? "?fill=1" : "");
// Grow the frame to its content so the page scrolls like the real screen would.
function fit() {
  try {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return;
    if (fill) { frame.style.height = Math.max(main.clientHeight, doc.documentElement.scrollHeight) + "px"; return; }
    frame.style.height = doc.documentElement.scrollHeight + "px";
  } catch { /* cross-origin: keep the last height */ }
}
frame.addEventListener("load", () => {
  fit();
  main.scrollTop = scroll;
  try { new ResizeObserver(fit).observe(frame.contentDocument.documentElement); } catch {}
});
function reload() {
  scroll = main.scrollTop;
  frame.src = src();
}
function setFill(on) {
  fill = on;
  main.classList.toggle("fill", on);
  document.getElementById("w-fill").setAttribute("aria-pressed", String(on));
  document.getElementById("w-screen").setAttribute("aria-pressed", String(!on));
  document.getElementById("raw").href = src();
  reload();
}
document.getElementById("w-screen").onclick = () => setFill(false);
document.getElementById("w-fill").onclick = () => setFill(true);
window.addEventListener("resize", fit);
// Reload when this screen (or the root CSS / fonts) changes, not on every edit elsewhere.
function screenKey(s) {
  const out = [];
  const walk = (id) => { const n = s.nodes[id]; if (!n) return; out.push(id, n.tag, n.text, n.styles, n.attrs, n.classes); n.children.forEach(walk); };
  walk(AB);
  return out.length ? JSON.stringify([out, s.rootCss]) : "";
}
const es = new EventSource("/events");
es.addEventListener("open", () => { live.classList.add("on"); live.lastChild.textContent = "Live"; });
es.addEventListener("error", () => { live.classList.remove("on"); live.lastChild.textContent = "Reconnecting…"; });
// Keep a copy of the document: the full state on connect / project switch, then patches of changed nodes.
// A patch that doesn't follow on from this copy (a missed event) reloads the whole document.
let doc = null, chain = Promise.resolve();
es.addEventListener("state", (ev) => { chain = chain.then(() => { doc = JSON.parse(ev.data).state; onDoc(doc); }); });
es.addEventListener("patch", (ev) => { chain = chain.then(async () => {
  const p = JSON.parse(ev.data);
  if (!doc || doc.id !== p.id || doc.version !== p.baseVersion) {
    if (doc && doc.id === p.id && p.version <= doc.version) return;
    doc = await (await fetch("/api/state")).json();
  } else {
    for (const [id, n] of Object.entries(p.nodes)) { if (n) doc.nodes[id] = n; else delete doc.nodes[id]; }
    Object.assign(doc, { version: p.version, pages: p.pages, rootId: p.rootId }, p.rootCss ? { rootCss: p.rootCss } : {});
  }
  onDoc(doc);
}).catch(() => {}); });
function onDoc(state) {
  const key = state.nodes && state.nodes[AB] ? screenKey(state) : "";
  if (!key) { gone = true; main.innerHTML = '<p class="gone">This screen is no longer in the open project.</p>'; return; }
  if (gone) return location.reload(); // it came back (undo, or its project was reopened)
  if (key === lastKey) return;
  const first = !lastKey;
  lastKey = key;
  if (first) return;
  clearTimeout(timer);
  timer = setTimeout(reload, 120);
}
// The first fonts event is the snapshot sent on connect; later ones mean the library changed.
es.addEventListener("fonts", () => { if (!fontsSeen) { fontsSeen = true; return; } if (lastKey && !gone) { clearTimeout(timer); timer = setTimeout(reload, 120); } });
</script>
</body></html>`);
}));
app.get("/render/:id", wrap((req, res) => {
  const ab = artboardOf(req.params.id);
  const w = Number(req.query.width);
  const widthCss = Number.isFinite(w) && w > 0 ? `body>[data-layer="${ab}"]{width:${Math.round(w)}px!important}` : "";
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fonts.css">
<style>html,body{margin:0;background:transparent}${widthCss}</style></head><body>${toHtml(ab, { fontBase: "", markIds: true })}</body></html>`);
}));
app.get("/api/export", wrap((req, res) => {
  res.type("text/plain").send(exportCode(String(req.query.format || "html"), req.query.nodeId ? String(req.query.nodeId) : undefined));
}));
app.get("/api/export/zip", wrap(async (req, res) => {
  const id = req.query.projectId ? String(req.query.projectId) : state.id;
  const format = String(req.query.format || "html");
  const { fileName, buffer } = await exportProjectZip(id, format);
  res.set({
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-cache",
  }).send(buffer);
}));

// Stateless Streamable HTTP MCP (/mcp + legacy /paper-lite/mcp alias): a pooled server and fresh transport per request, sharing workspace & session context.
function mcpToolDetail(toolName, args) {
  if (!args || typeof args !== "object") return "";
  if (toolName === "update_styles" && Array.isArray(args.updates)) {
    const keys = [...new Set(args.updates.flatMap((u) => Object.keys(u.styles || {})))];
    return keys.slice(0, 3).join(", ");
  }
  if (toolName === "update_node" && args.styles) return Object.keys(args.styles).slice(0, 3).join(", ");
  if (toolName === "write_html") return args.mode === "replace" ? "replace" : "";
  if (toolName === "create_artboard" && args.name) return String(args.name).slice(0, 28);
  if (toolName === "get_screenshot" && args.scale) return `${args.scale}x`;
  if (toolName === "audit_artboard" && args.width) return `${args.width}px`;
  if (toolName === "get_jsx" && args.format) return String(args.format);
  return "";
}

app.post(["/mcp", "/paper-lite/mcp"], async (req, res) => {
  const msgs = Array.isArray(req.body) ? req.body : [req.body];
  const initMsg = msgs.find((m) => m?.method === "initialize");
  // A new connection without its own client id gets a session id; the client returns it on every later request.
  let issuedKey = null;
  if (initMsg && !req.get("x-weft-client") && !req.get("mcp-session-id")) {
    issuedKey = `weft-${randomUUID()}`;
    res.setHeader("Mcp-Session-Id", issuedKey);
  }
  const agent = agentFromRequest(req, initMsg?.params?.clientInfo?.name || null, issuedKey);
  const callMsg = msgs.find((m) => m?.method === "tools/call");
  const tool = callMsg?.params?.name || "";
  const detail = tool ? mcpToolDetail(tool, callMsg?.params?.arguments) : "";

  const server = acquireMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { releaseMcpServer(server, transport); });
  try {
    await server.connect(transport);
    await mcpContextStore.run({ agent, tool, detail }, () => transport.handleRequest(req, res, req.body));
  } catch (err) {
    console.error("[weft] MCP error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
const methodNotAllowed = (req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get(["/mcp", "/paper-lite/mcp"], methodNotAllowed);
// A client ending a session we issued: forget it and take its cursor off the canvas.
app.delete(["/mcp", "/paper-lite/mcp"], (req, res) => {
  const key = req.get("mcp-session-id");
  const sess = key?.startsWith("weft-") ? agentSessions.get(key) : null;
  if (!sess) return methodNotAllowed(req, res);
  agentSessions.delete(key);
  agentCursors.delete(sess.id);
  emitPresence(false);
  res.status(200).end();
});

// Graceful shutdown: wait for pending checkpoint commits and writes to reach disk, then exit. Signals cover POSIX and Ctrl+C / Ctrl+Break;
// on Windows `kill("SIGTERM")` terminates the process outright, so a parent can instead send "shutdown" over IPC.
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(1), 5000).unref(); // never hang on a stuck disk write
  try {
    await Promise.allSettled([...pendingCommits.values()]); // checkpoint commits still landing in git
    await flushWrites();
  } catch (err) { console.error(`[weft] flush on ${reason} failed:`, err); }
  renderer.stop();
  process.exit(0);
}
for (const sig of ["SIGINT", "SIGTERM", ...(process.platform === "win32" ? ["SIGBREAK"] : [])]) process.on(sig, () => shutdown(sig));
if (process.send) process.on("message", (msg) => { if (msg === "shutdown") shutdown("ipc"); });

await fonts.load();
await loadWorkspace();
// A leftover placeholder next to real projects (from an older version, or a crash) goes now rather than on the next create.
if (workspace.projects.some((p) => !p.placeholder)) await dropPlaceholders(workspace.projects.find((p) => !p.placeholder).id, "init");
app.listen(PORT, HOST, () => {
  console.log(`weft UI   ${PUBLIC_URL}`);
  console.log(`weft MCP  ${PUBLIC_URL}/mcp`);
});
