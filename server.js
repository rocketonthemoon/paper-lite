// weft (formerly Paper-Lite): HTML/CSS design canvas with an MCP-first API.
// One process: static UI, projects/pages/checkpoints/sessions/fonts on disk, SSE live sync, Streamable HTTP MCP at /mcp.
import express from "express";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  HttpError, ID_RE, SVG_TAGS, VOID_TAGS, cleanName, cleanTag, emptyPage, emptyProject, lenientMerge, mergeAttrs, mergeStyles,
  newId, normalizeProject, emptyRootCss, mergeRootCss, rootCssText, rootCssFlat, rootBaseClasses, definedRootClasses,
  isBaseRule, rootClassesIn, cleanClassList, varsIn,
} from "./model.js";
import { FontLibrary, familiesIn, renameWithRetry } from "./fonts.js";
import { htmlToSpecs } from "./html-import.js";
import { Renderer } from "./renderer.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./mcp-tools.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
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
let historyTimeline = []; // [{ id, before, after, source, tool, target, label, nodeIds, layerCount, at }]
let historyCursor = -1;
let projectCheckpoints = []; // [{ id, name, auto, kind, at, historyId, layerCount, snapshot }]
let projectSessions = []; // [{ id, projectId, projectName, source, agentName, title, artboard, startedAt, updatedAt, editCount, toolCounts, checkpointId, live, reverted }]
let lastMcpWriteAt = 0;
let lastCheckpointHistoryKey = null;
let pendingSessionTitle = null;

const mcpContextStore = new AsyncLocalStorage();
const sseClients = new Set();
const fonts = new FontLibrary(path.join(DATA_DIR, "fonts"));
let diskQueue = Promise.resolve();

const projectFile = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.json`);
};
const checkpointFile = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.checkpoints.json`);
};
const sessionsFile = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.sessions.json`);
};
const metaOf = (id) => {
  const m = workspace.projects.find((p) => p.id === id);
  if (!m) throw new HttpError(404, `Project "${id}" not found`);
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
const saveWorkspace = () => {
  const text = JSON.stringify(workspace, null, 2);
  return queueDisk(() => writeAtomic(WORKSPACE_FILE, text));
};
const saveCheckpoints = (id = state.id, list = projectCheckpoints) => {
  const text = JSON.stringify(list);
  return queueDisk(() => writeAtomic(checkpointFile(id), text));
};
const saveSessions = (id = state.id, list = projectSessions) => {
  const text = JSON.stringify(list);
  return queueDisk(() => writeAtomic(sessionsFile(id), text));
};

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
  const doc = JSON.stringify(state);
  const id = state.id;
  const meta = workspace.projects.find((p) => p.id === id);
  if (meta) {
    if (touchUpdatedAt) meta.updatedAt = new Date().toISOString();
    Object.assign(meta, projectSummary(state));
  }
  previewCache.delete(id);
  const ws = JSON.stringify(workspace, null, 2);
  const out = queueDisk(async () => {
    await writeAtomic(projectFile(id), doc);
    await writeAtomic(WORKSPACE_FILE, ws);
  });
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
  if (backfilled) await saveWorkspace();
  if (!workspace.projects.length) {
    await createProject("Untitled", { open: false });
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
  await createProject("Untitled", { open: true, source: "init" });
}

async function readProject(id) {
  const meta = metaOf(id);
  if (state?.id === id) return structuredClone(state);
  await diskQueue;
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
  });
}

function publicCheckpoints(list = projectCheckpoints) {
  return list.map(({ snapshot: _snap, ...rest }) => rest);
}

function historyPayload() {
  const entries = historyTimeline.map(({ before: _b, after: _a, ...rest }) => rest);
  return { entries, cursor: historyCursor, limit: HISTORY_LIMIT, checkpoints: publicCheckpoints() };
}

function sendHistory() {
  sendEvent("history", historyPayload());
}

async function loadProjectExtras(id) {
  const cps = await readJsonSafe(checkpointFile(id), []);
  projectCheckpoints = Array.isArray(cps) ? cps.filter((c) => c && c.id && c.snapshot) : [];
  const sess = await readJsonSafe(sessionsFile(id), []);
  projectSessions = Array.isArray(sess) ? sess.filter((s) => s && s.id) : [];
}

async function openProject(id, source = "api") {
  metaOf(id);
  if (state?.id === id) return state;
  const doc = await readProject(id);
  state = doc;
  historyTimeline = [];
  historyCursor = -1;
  lastMcpWriteAt = 0;
  lastCheckpointHistoryKey = null;
  pendingSessionTitle = null;
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
    snapshot: docSnapshot(doc),
  };
}

async function createProject(name, { open = true, source = "api" } = {}) {
  const id = newId();
  const doc = emptyProject(id, cleanName(name, "Untitled"));
  const now = new Date().toISOString();
  const initCp = makeCheckpointEntry("Project created", { auto: true, kind: "init", doc, historyId: null });
  await queueDisk(async () => {
    await writeAtomic(projectFile(id), JSON.stringify(doc));
    await writeAtomic(checkpointFile(id), JSON.stringify([initCp]));
    await writeAtomic(sessionsFile(id), JSON.stringify([]));
  });
  const accentColor = PROJECT_COLORS[workspace.projects.length % PROJECT_COLORS.length];
  workspace.projects.push({ id, name: doc.name, accentColor, createdAt: now, updatedAt: now, ...projectSummary(doc) });
  await saveWorkspace();
  if (open) await openProject(id, source);
  else sendEvent("projects", { projects: projectList() });
  return { id, name: doc.name };
}

async function renameProject(id, name, source = "api") {
  const meta = metaOf(id);
  meta.name = cleanName(name, meta.name);
  meta.updatedAt = new Date().toISOString();
  if (state.id === id) {
    state.name = meta.name;
    persist();
    broadcast(source);
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
  doc.name = cleanName(name, `${metaOf(id).name} copy`);
  const now = new Date().toISOString();
  const initCp = makeCheckpointEntry("Project created", { auto: true, kind: "init", doc, historyId: null });
  await queueDisk(async () => {
    await writeAtomic(projectFile(copyId), JSON.stringify(doc));
    await writeAtomic(checkpointFile(copyId), JSON.stringify([initCp]));
    await writeAtomic(sessionsFile(copyId), JSON.stringify([]));
  });
  const accentColor = PROJECT_COLORS[workspace.projects.length % PROJECT_COLORS.length];
  workspace.projects.push({ id: copyId, name: doc.name, accentColor, createdAt: now, updatedAt: now, ...projectSummary(doc) });
  await saveWorkspace();
  sendEvent("projects", { projects: projectList() });
  return { id: copyId, name: doc.name };
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
  await queueDisk(async () => {
    await fs.rm(projectFile(id), { force: true });
    await fs.rm(checkpointFile(id), { force: true });
    await fs.rm(sessionsFile(id), { force: true });
  });
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
const broadcast = (source) => sendEvent("state", { source, state });

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
  saveCheckpoints();
  sendHistory();
  return cp;
}

function ensureAgentStartCheckpoint(beforeState) {
  const now = Date.now();
  const isNewRun = lastMcpWriteAt === 0 || (now - lastMcpWriteAt >= SESSION_GAP_MS);
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
  saveCheckpoints();
  return cp.id;
}

function diffNodeIds(before, after) {
  const changed = [];
  const beforeIds = new Set(Object.keys(before.nodes));
  const afterIds = new Set(Object.keys(after.nodes));
  for (const id of afterIds) {
    if (after.pages.includes(id)) continue;
    if (!beforeIds.has(id)) {
      changed.push(id);
      continue;
    }
    const a = before.nodes[id], b = after.nodes[id];
    if (
      a.name !== b.name ||
      a.tag !== b.tag ||
      a.text !== b.text ||
      a.parentId !== b.parentId ||
      JSON.stringify(a.styles) !== JSON.stringify(b.styles) ||
      JSON.stringify(a.attrs) !== JSON.stringify(b.attrs) ||
      JSON.stringify(a.classes) !== JSON.stringify(b.classes) ||
      JSON.stringify(a.children) !== JSON.stringify(b.children)
    ) {
      changed.push(id);
    }
  }
  for (const id of beforeIds) {
    if (!afterIds.has(id) && !before.pages.includes(id)) changed.push(id);
  }
  return changed.slice(0, 60);
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
  const last = projectSessions[projectSessions.length - 1];
  const canAppend =
    last &&
    !last.reverted &&
    last.source === histSource &&
    last.projectId === state.id &&
    (nowMs - Date.parse(last.updatedAt)) < SESSION_GAP_MS;

  if (canAppend) {
    last.updatedAt = at;
    last.editCount += 1;
    last.toolCounts[tool] = (last.toolCounts[tool] || 0) + 1;
    if (artboard) last.artboard = artboard;
    if (histSource === "mcp") {
      last.live = true;
      last.agentName = agentName;
      if (pendingSessionTitle && !last.title) {
        last.title = pendingSessionTitle;
        pendingSessionTitle = null;
      }
    }
  } else {
    projectSessions.push({
      id: newId(),
      projectId: state.id,
      projectName: state.name,
      source: histSource,
      agentName,
      title: histSource === "mcp" ? (pendingSessionTitle || null) : null,
      artboard: artboard || "Page 1",
      startedAt: at,
      updatedAt: at,
      editCount: 1,
      toolCounts: { [tool]: 1 },
      checkpointId: checkpointId || null,
      live: histSource === "mcp",
      reverted: false,
    });
    if (histSource === "mcp") pendingSessionTitle = null;
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
    const list = p.id === state?.id ? projectSessions : await readJsonSafe(sessionsFile(p.id), []);
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
  const before = docSnapshot(state);
  const startCpId = histSource === "mcp" ? ensureAgentStartCheckpoint(before) : null;
  let result;
  try {
    result = fn(state);
  } catch (err) {
    applySnapshotRaw(before);
    throw err;
  }
  commit(source, before, meta, startCpId);
  return result;
}

function batch(source, fn, meta = null) {
  if (batchDepth) return fn();
  const histSource = source === "mcp" ? "mcp" : "you";
  const before = docSnapshot(state);
  batchStartCheckpointId = histSource === "mcp" ? ensureAgentStartCheckpoint(before) : null;
  batchDepth += 1;
  let result;
  try {
    result = fn();
  } catch (err) {
    applySnapshotRaw(before); // all-or-nothing
    throw err;
  } finally {
    batchDepth -= 1;
  }
  const cpId = batchStartCheckpointId;
  batchStartCheckpointId = null;
  commit(source, before, meta, cpId);
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

function applySnapshotRaw(snap) {
  const comments = state?.comments || [];
  state = { ...structuredClone(snap), comments };
}

function commit(source, before, meta = null, startCpId = null) {
  if (historyCursor < historyTimeline.length - 1) {
    historyTimeline.length = historyCursor + 1;
  }
  state.version += 1;
  const histSource = source === "mcp" ? "mcp" : "you";
  const store = histSource === "mcp" ? mcpContextStore.getStore() : null;
  const tool = meta?.tool || store?.tool || (histSource === "mcp" ? "mcp_edit" : "Edit");
  const nodeIds = meta?.nodeIds?.length ? meta.nodeIds : diffNodeIds(before, state);
  const target = targetSummary(nodeIds, before, state, meta);
  const label = meta?.label || `${tool} · ${target}`;
  const at = new Date().toISOString();
  const entry = {
    id: newId(),
    before,
    after: docSnapshot(state),
    source: histSource,
    tool,
    target,
    label,
    nodeIds,
    layerCount: layerCountOf(state),
    at,
  };
  historyTimeline.push(entry);
  if (historyTimeline.length > HISTORY_LIMIT) historyTimeline.shift();
  historyCursor = historyTimeline.length - 1;
  const commentsChanged = syncCommentsWithState(historyCursor + 1);

  if (histSource === "mcp") lastMcpWriteAt = Date.now();
  const artboard = meta?.artboard || artboardNameForNodes(nodeIds, state, before);
  recordSessionActivity({ histSource, tool, artboard, checkpointId: startCpId, at });

  persist();
  broadcast(source);
  sendHistory();
  if (commentsChanged) sendEvent("comments", { comments: state.comments });
}

function applyHistoryEntry(snap) {
  const { version, rootId, comments } = state;
  const cloned = structuredClone(snap);
  state = {
    ...cloned,
    version: version + 1,
    rootId: cloned.pages.includes(rootId) ? rootId : cloned.pages[0],
    comments: comments || [],
  };
}

function stepHistory(source, direction) {
  if (direction === "undo") {
    if (historyCursor < 0) return false;
    const entry = historyTimeline[historyCursor];
    historyCursor -= 1;
    applyHistoryEntry(entry.before);
  } else {
    if (historyCursor >= historyTimeline.length - 1) return false;
    historyCursor += 1;
    const entry = historyTimeline[historyCursor];
    applyHistoryEntry(entry.after);
  }
  const commentsChanged = syncCommentsWithState(Math.max(1, historyCursor + 1));
  persist();
  broadcast(source);
  sendHistory();
  if (commentsChanged) sendEvent("comments", { comments: state.comments });
  return true;
}

function jumpHistory(source, targetIndex) {
  if (!Number.isInteger(targetIndex) || targetIndex < -1 || targetIndex >= historyTimeline.length) {
    throw new HttpError(400, "Invalid history index");
  }
  if (targetIndex === historyCursor) return { cursor: historyCursor, moved: 0 };
  const moved = Math.abs(targetIndex - historyCursor);
  if (targetIndex < historyCursor) {
    historyCursor = targetIndex;
    const snap = targetIndex >= 0 ? historyTimeline[targetIndex].after : historyTimeline[0].before;
    applyHistoryEntry(snap);
  } else {
    historyCursor = targetIndex;
    applyHistoryEntry(historyTimeline[targetIndex].after);
  }
  const commentsChanged = syncCommentsWithState(Math.max(1, historyCursor + 1));
  persist();
  broadcast(source);
  sendHistory();
  if (commentsChanged) sendEvent("comments", { comments: state.comments });
  return { cursor: historyCursor, moved };
}

function undoLastAgentRun(source) {
  let lastMcp = -1;
  for (let i = historyCursor; i >= 0; i--) {
    if (historyTimeline[i].source === "mcp") { lastMcp = i; break; }
  }
  if (lastMcp === -1) return { ok: false, undone: 0, cursor: historyCursor };
  let firstMcp = lastMcp;
  while (firstMcp > 0 && historyTimeline[firstMcp - 1].source === "mcp") firstMcp -= 1;
  const res = jumpHistory(source, firstMcp - 1);
  return { ok: true, undone: res.moved, cursor: res.cursor };
}

function restoreCheckpointById(id, source = "api") {
  const cp = projectCheckpoints.find((c) => c.id === id);
  if (!cp) throw new HttpError(404, `Checkpoint "${id}" not found`);
  mutate(source, (s) => {
    const snap = structuredClone(cp.snapshot);
    s.pages = snap.pages;
    s.rootId = snap.pages.includes(s.rootId) ? s.rootId : snap.rootId;
    s.nodes = snap.nodes;
    return cp;
  }, { tool: "Restore checkpoint", target: cp.name, label: `Restore checkpoint · ${cp.name}` });
  return { id: cp.id, name: cp.name };
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

function agentFromRequest(req, initClientName = null) {
  const key = req.get("x-weft-client") || req.get("mcp-session-id") || req.get("user-agent") || "mcp-default";
  let sess = agentSessions.get(key);
  if (!sess) {
    const idx = agentSessions.size;
    sess = {
      id: newId(),
      name: friendlyAgentName(initClientName),
      color: AGENT_COLORS[idx % AGENT_COLORS.length],
    };
    agentSessions.set(key, sess);
  } else if (initClientName) {
    sess.name = friendlyAgentName(initClientName);
  }
  return sess;
}

function presenceList() {
  const now = Date.now();
  for (const [id, p] of presence) if (now - p.at > PRESENCE_TTL || !state?.nodes[id]) presence.delete(id);
  return [...presence].map(([id, p]) => ({ id, label: p.label }));
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
  const wasEmpty = presenceList().length === 0;
  const now = Date.now();
  for (const id of nodeIds) if (state.nodes[id] && !isPage(id)) presence.set(id, { label, at: now });
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
  if (!nodeIds?.length) {
    presence.clear();
    if (store?.agent?.id) agentCursors.delete(store.agent.id);
    else agentCursors.clear();
  } else {
    nodeIds.forEach((id) => presence.delete(id));
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
  if (!isPage(id)) throw new HttpError(404, `Page "${id}" not found`);
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
    broadcast(source);
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
  if (!n) throw new HttpError(404, `Node "${id}" not found`);
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
  const toolFallback = isPage(parent.id) ? "Draw Frame" : (tag === "p" && input.text !== undefined ? "Create Text" : "Draw Rect");
  return mutate(source, (s) => {
    const id = newId();
    s.nodes[id] = { id, name: nodeName, tag, parentId: parent.id, children: [], text: String(input.text ?? ""), styles, attrs };
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
  if (patch.text !== undefined) next.text = String(patch.text);
  if (patch.styles !== undefined) next.styles = mergeStyles(patch.replaceStyles ? {} : node.styles, patch.styles);
  if (patch.attrs !== undefined) next.attrs = mergeAttrs(node.attrs, patch.attrs, next.tag ?? node.tag);
  if (patch.classes !== undefined) next.classes = definedClasses(cleanClassList(patch.classes ?? []));
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
  else if (patch.classes !== undefined) uiTool = "Edit classes";
  else if (patch.tag !== undefined) uiTool = "Change tag";
  return mutate(source, (s) => {
    const n = s.nodes[id];
    Object.assign(n, next);
    if (n.classes && !n.classes.length) delete n.classes;
    if (moving) {
      const oldParent = s.nodes[n.parentId];
      oldParent.children = oldParent.children.filter((c) => c !== id);
      n.parentId = patch.parentId ?? n.parentId;
      insertChild(s.nodes[n.parentId], id, patch.index);
      // Anything moved onto a page becomes an artboard and needs a world position.
      if (isPage(n.parentId) && n.styles.position !== "absolute") n.styles = mergeStyles(n.styles, { position: "absolute", left: 0, top: 0 });
    }
    return n;
  }, meta || (source === "mcp" ? null : { tool: uiTool, target: next.name || node.name, nodeIds: [id] }));
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
    const copy = (srcId, parentId) => {
      const src = s.nodes[srcId];
      const nid = newId();
      s.nodes[nid] = { ...structuredClone(src), id: nid, parentId, children: [] };
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

// Next free spot for a new artboard on a page: right of the existing ones on the top row.
function nextArtboardPosition(pageId = state.rootId) {
  const boards = state.nodes[pageId].children.map((id) => state.nodes[id].styles);
  if (!boards.length) return { x: 0, y: 0 };
  const top = Math.min(...boards.map((st) => parseFloat(st.top) || 0));
  const right = Math.max(...boards.map((st) => (parseFloat(st.left) || 0) + (parseFloat(st.width) || 390)));
  return { x: Math.round(right + 80), y: Math.round(top) };
}

function createArtboard({ name = "Frame", width = 390, height = 844, x, y, styles = {}, pageId }, source = "mcp") {
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

function getRootCss(doc = state) {
  const root = doc.rootCss || emptyRootCss();
  const usage = {};
  for (const n of Object.values(doc.nodes)) for (const c of n.classes || []) usage[c] = (usage[c] || 0) + 1;
  // classes: the plain `.name { }` rules; rules: everything else (states, @media, nested, element selectors).
  return { vars: root.vars, classes: rootBaseClasses(root), rules: root.rules.filter((r) => !isBaseRule(r)), definedClasses: definedRootClasses(root), css: rootCssText(root), usage };
}

// Patch the root CSS. `css` text is parsed and merged like vars/classes; replace: true starts from empty.
// Removing a class also removes it from every layer that used it, in the same undo step.
function updateRootCss({ vars, classes, css, replace = false } = {}, source = "api") {
  const before = state.rootCss || emptyRootCss();
  const next = mergeRootCss(before, { css, vars, classes }, { replace });
  // Changed variables and rules, by name (a rule is named by its selector and @media).
  const ruleKey = (r) => (r.media ? `@media ${r.media} { ${r.selector} }` : r.selector);
  const ruleMap = (root) => {
    const m = new Map();
    for (const r of root.rules) m.set(ruleKey(r), JSON.stringify([m.get(ruleKey(r)), r.styles]));
    return m;
  };
  const rb = ruleMap(before), rn = ruleMap(next);
  const changed = [
    ...Object.keys({ ...before.vars, ...next.vars }).filter((k) => before.vars[k] !== next.vars[k]),
    ...[...new Set([...rb.keys(), ...rn.keys()])].filter((k) => rb.get(k) !== rn.get(k)),
  ];
  const stillDefined = new Set(definedRootClasses(next));
  const dropped = definedRootClasses(before).filter((c) => !stillDefined.has(c));
  const touchedIds = [];
  mutate(source, (s) => {
    s.rootCss = next;
    if (dropped.length) {
      for (const n of Object.values(s.nodes)) {
        if (!n.classes?.some((c) => dropped.includes(c))) continue;
        n.classes = n.classes.filter((c) => !dropped.includes(c));
        if (!n.classes.length) delete n.classes;
        touchedIds.push(n.id);
      }
    }
  }, { tool: source === "mcp" ? "update_root_css" : "Edit root CSS", target: changed.length ? `Root CSS · ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? "…" : ""}` : "Root CSS", nodeIds: touchedIds });
  return { ...getRootCss(), changed, removedFromLayers: touchedIds.length || undefined };
}

// Nudges for agents: hard-coded values that already exist as a root variable, and var() names that don't exist.
function rootCssHints(nodeIds, doc = state) {
  const root = doc.rootCss || emptyRootCss();
  // Several variables can share a value (--space-3 and --radius both 12px); name them all.
  const byValue = new Map();
  for (const [k, v] of Object.entries(root.vars)) byValue.set(String(v).toLowerCase(), [...(byValue.get(String(v).toLowerCase()) || []), k]);
  const hints = new Set();
  for (const id of nodeIds) {
    const n = doc.nodes[id];
    if (!n) continue;
    for (const [k, v] of Object.entries(n.styles)) {
      if (doc.pages.includes(n.parentId) && (k === "left" || k === "top" || k === "position")) continue;
      const known = byValue.get(String(v).toLowerCase());
      if (known) hints.add(`${k}: ${v} is the root variable ${known.join(" / ")}; use ${known.map((x) => `var(${x})`).join(" or ")} so it stays shared`);
      for (const ref of varsIn(v)) if (!(ref in root.vars)) hints.add(`${n.name}: var(${ref}) isn't defined in the root CSS (add it with update_root_css)`);
    }
    if (hints.size >= 20) break;
  }
  return [...hints].slice(0, 20);
}

// Insert a parsed HTML spec tree (lenient: bad tags/styles/attrs are dropped with warnings). Call inside mutate/batch.
function addSubtree(spec, parentId, index, warnings) {
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
  const noText = SVG_TAGS.has(tag) || VOID_TAGS.has(tag);
  const text = String(spec.text ?? "");
  if (noText && text.trim()) warnings.push(`${label}: <${tag}> can't hold text; dropped "${text.length > 40 ? `${text.slice(0, 37)}…` : text}"`);
  state.nodes[id] = { id, name: label, tag, parentId: parent.id, children: [], text: noText ? "" : text, styles, attrs };
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

function writeHtml({ html, parentId, targetNodeId, mode = "insert-children", index }, source = "mcp") {
  const { specs, warnings } = htmlToSpecs(html);
  if (!specs.length) throw new HttpError(400, "No elements found in html");
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
  warnings.push(...rootCssHints(created.flatMap(subtree)));
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

function replyComment(id, { text, author = "you", linkStep = false, agentsCanSee } = {}) {
  const thread = (state.comments || []).find((c) => c.id === id);
  if (!thread) throw new HttpError(404, `Comment "${id}" not found`);
  const cleanText = String(text ?? "").trim().slice(0, 4000);
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
  thread.status = isAgent ? "replied" : "open";
  persist({ touchUpdatedAt: false });
  sendEvent("comments", {
    comments: state.comments,
    ...(isAgent ? { replyNotification: { commentId: thread.id, nodeId: thread.nodeId, author: cleanName(author, "Claude"), text: cleanText } } : {}),
  });
  return thread;
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
    css(fontCss = "") {
      const l = cssLayers(doc.rootCss || emptyRootCss(), rules.join("\n\n"));
      return [
        fontCss,
        l.vars || l.base ? `/* Root CSS: shared variables and classes */\n${[l.vars, l.base].filter(Boolean).join("\n\n")}` : "",
        `${RESET_CSS}\nbody { margin: 0; }`,
        l.own && `/* Layer overrides */\n${l.own}`,
        l.contextual && `/* Root CSS: states, breakpoints and nested rules (they apply over layer overrides) */\n${l.contextual}`,
      ].filter(Boolean).join("\n\n") + "\n";
    },
  };
}

// With a shared sheet the markup carries class names only; otherwise it's a self-contained snippet.
// markIds tags every element with data-layer="<id>" so the renderer can find layers that have no class of their own.
function toHtml(nodeId, { fontBase = PUBLIC_URL, filesBase, doc = state, sheet, markIds = false } = {}) {
  const roots = exportRoots(nodeId, doc);
  const css = [];
  const ownClass = sheet ? (n) => sheet.classFor(n) : (n, id) => {
    const decl = Object.entries(exportStyles(n, doc)).map(([k, v]) => `  ${kebab(k)}: ${v};`).join("\n");
    // Unstyled layers get neither an empty rule nor a class nothing targets.
    // Layer names are free text: drop "*/" and angle brackets so a name can't end the comment or the <style> element.
    if (!decl) return null;
    css.push(`/* ${n.name.replace(/\*\//g, "").replace(/[<>]/g, "")} */\n.layer-${id} {\n${decl}\n}`);
    return `layer-${id}`;
  };
  const markup = (id, depth) => {
    const n = doc.nodes[id];
    const pad = "  ".repeat(depth);
    const cls = [...layerClasses(n, doc), ownClass(n, id)].filter(Boolean).join(" ");
    const attrs = Object.entries(n.attrs || {}).map(([k, v]) => ` ${k}="${escHtml(v)}"`).join("");
    const open = `${pad}<${n.tag}${cls ? ` class="${cls}"` : ""}${markIds ? ` data-layer="${id}"` : ""}${attrs}>`;
    if (VOID_TAGS.has(n.tag)) return open;
    const kids = n.children.map((c) => markup(c, depth + 1));
    if (!kids.length) return `${open}${escHtml(n.text)}</${n.tag}>`;
    const text = n.text ? [`${pad}  ${escHtml(n.text)}`] : [];
    return [open, ...text, ...kids, `${pad}</${n.tag}>`].join("\n");
  };
  const body = roots.map((id) => markup(id, 0)).join("\n\n");
  if (sheet) return `${body}\n`;
  const fam = usedFonts(roots, doc);
  const fontCss = fam.length ? `${fonts.css({ families: fam, baseUrl: fontBase, filesBase })}\n\n` : "";
  const l = cssLayers(usedRootCss(roots, doc), css.join("\n\n"));
  const styleText = [l.vars, l.base, RESET_CSS, l.own, l.contextual].filter(Boolean).join("\n\n");
  return `<style>\n${fontCss}${styleText}\n</style>\n\n${body}\n`;
}

function componentName(name) {
  const base = String(name).replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return /^[A-Z]/.test(base) ? base : `Layer${base}`;
}

function toJsx(nodeId, { filesBase, doc = state, sheet, cssHref = "../styles.css" } = {}) {
  const roots = exportRoots(nodeId, doc);
  const jsxText = (t) => `{${JSON.stringify(t)}}`;
  const jsxName = (k) => (k.startsWith("aria-") ? k : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  const markup = (id, depth) => {
    const n = doc.nodes[id];
    const pad = "  ".repeat(depth);
    const styles = exportStyles(n, doc);
    const cls = [...layerClasses(n, doc), sheet && sheet.classFor(n)].filter(Boolean).join(" ");
    const classProp = cls ? ` className="${cls}"` : "";
    const styleProp = !sheet && Object.keys(styles).length ? ` style={{ ${Object.entries(styles).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }}` : "";
    const attrs = Object.entries(n.attrs || {}).map(([k, v]) => ` ${jsxName(k)}=${JSON.stringify(v)}`).join("");
    const open = `${pad}<${n.tag}${classProp}${attrs}${styleProp}`;
    if (VOID_TAGS.has(n.tag)) return `${open} />`;
    if (!n.children.length) return n.text ? `${open}>${jsxText(n.text)}</${n.tag}>` : `${open} />`;
    const text = n.text ? [`${pad}  ${jsxText(n.text)}`] : [];
    return [`${open}>`, ...text, ...n.children.map((c) => markup(c, depth + 1)), `${pad}</${n.tag}>`].join("\n");
  };
  let header = "";
  if (sheet) header = `import "${cssHref}";\n\n`;
  else {
    const fam = usedFonts(roots, doc);
    // "*/" inside a value would end the comment early.
    const root = rootCssText(usedRootCss(roots, doc)).replace(/\*\//g, "* /");
    if (root) header += `/* Root CSS used by these components; put it in your global stylesheet:\n${root}\n*/\n\n`;
    if (fam.length) header += `/* Fonts used: ${fam.join(", ")}. Load them with:\n${fonts.css({ families: fam, baseUrl: PUBLIC_URL, filesBase })}\n*/\n\n`;
  }
  return header + roots.map((id) => `export function ${componentName(doc.nodes[id].name)}() {\n  return (\n${markup(id, 2)}\n  );\n}`).join("\n\n") + "\n";
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
  const usedPageDirs = new Set(["fonts"]);
  // Every screen links one root stylesheet instead of carrying its own copy of the CSS.
  const sheet = sharedSheet(doc);
  const allFamilies = new Set();
  const manifest = [];

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
        const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escHtml(ab.name)} · ${escHtml(doc.name)}</title>\n<link rel="stylesheet" href="../styles.css">\n</head>\n<body>\n${body}</body>\n</html>\n`;
        entries.push({ name: `${pageDir}/${slug}.html`, data: html });
      }
      if (wantJsx) {
        entries.push({ name: `${pageDir}/${slug}.jsx`, data: toJsx(abId, { doc, sheet }) });
      }
      items.push({ name: ab.name, fileBase: `${pageDir}/${slug}`, width: ab.styles.width || "auto", height: ab.styles.height || "auto" });
    }
    manifest.push({ name: page.name, dir: pageDir, items });
  }

  const fontCss = allFamilies.size ? fonts.css({ families: [...allFamilies], filesBase: "fonts" }) : "";
  entries.push({ name: "styles.css", data: sheet.css(fontCss) });

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
function outline(nodeId = state.rootId, depth = 4) {
  const lines = [];
  const walk = (id, lvl) => {
    const n = state.nodes[id];
    const size = n.styles.width || n.styles.height ? ` [${n.styles.width || "auto"} x ${n.styles.height || "auto"}]` : "";
    const txt = n.text ? ` "${n.text.length > 40 ? `${n.text.slice(0, 37)}...` : n.text}"` : "";
    lines.push(`${"  ".repeat(lvl)}${id} <${isPage(id) ? "page" : n.tag}> ${n.name}${size}${txt}`);
    if (lvl < depth) n.children.forEach((c) => walk(c, lvl + 1));
  };
  walk(getNode(nodeId).id, 0);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------
const fontsChanged = () => sendEvent("fonts", { fonts: fonts.list(), v: Date.now() });
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
  const last = projectSessions[projectSessions.length - 1];
  const now = Date.now();
  if (last && last.source === "mcp" && !last.reverted && (last.live || now - Date.parse(last.updatedAt) < SESSION_GAP_MS * 2)) {
    last.title = title;
    saveSessions();
    sendActivity();
    return { title, sessionId: last.id };
  }
  pendingSessionTitle = title;
  return { title, pending: true };
}

// ---------------------------------------------------------------------------
// MCP (tools live in mcp-tools.js)
// ---------------------------------------------------------------------------
const renderer = new Renderer(`http://127.0.0.1:${PORT}`);
const mcpContext = {
  state: () => state,
  urls: { ui: PUBLIC_URL, mcp: `${PUBLIC_URL}/mcp` },
  getNode, isPage, pageOf, artboardOf, artboardSize, outline, exportCode, renderer,
  createNode, updateNode, deleteNode, duplicateNode, createArtboard, writeHtml,
  rootCss: { get: () => getRootCss(), update: (patch) => updateRootCss(patch, "mcp"), hints: (ids) => rootCssHints(ids) },
  batch: (source, fn, meta) => batch(source, fn, meta),
  undo: (source) => stepHistory(source, "undo"),
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
    restore: (id) => restoreCheckpointById(id, "mcp"),
  },
  comments: {
    openCount: openCommentCount,
    list: mcpGetComments,
    reply: (id, text, linkStep = true) => {
      agentVisibleComment(id);
      const store = mcpContextStore.getStore();
      return replyComment(id, { text, author: store?.agent?.name || "Claude", linkStep });
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
app.use(express.static(path.join(ROOT, "public")));

const who = (req) => req.get("x-client-id") || "api";
const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!err.status) console.error("[weft]", err);
    res.status(err.status || 500).json({ error: err.message });
  }
};

app.get("/events", async (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`event: state\ndata: ${JSON.stringify({ source: "init", state })}\n\n`);
  res.write(`event: projects\ndata: ${JSON.stringify({ projects: projectList() })}\n\n`);
  res.write(`event: fonts\ndata: ${JSON.stringify({ fonts: fonts.list(), v: 0 })}\n\n`);
  res.write(`event: presence\ndata: ${JSON.stringify(presencePayload())}\n\n`);
  res.write(`event: history\ndata: ${JSON.stringify(historyPayload())}\n\n`);
  res.write(`event: comments\ndata: ${JSON.stringify({ comments: state.comments || [] })}\n\n`);
  const sessions = await allActivitySessions().catch(() => []);
  if (!res.destroyed && !res.closed) {
    res.write(`event: activity\ndata: ${JSON.stringify({ sessions })}\n\n`);
  }
  sseClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

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
app.post("/api/nodes", wrap((req) => createNode(req.body || {}, who(req))));
app.patch("/api/nodes/:id", wrap((req) => updateNode(req.params.id, req.body || {}, who(req))));
app.delete("/api/nodes/:id", wrap((req) => deleteNode(req.params.id, who(req))));
app.post("/api/nodes/:id/duplicate", wrap((req) => duplicateNode(req.params.id, who(req))));
app.post("/api/undo", wrap((req) => ({ ok: stepHistory(who(req), "undo") })));
app.post("/api/redo", wrap((req) => ({ ok: stepHistory(who(req), "redo") })));
app.post("/api/selection", wrap((req) => {
  const list = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === "string" && state.nodes[id]).slice(0, 200) : [];
  uiSelection = { ids: list, at: Date.now() };
  return { ok: true };
}));

// History (§1) & Checkpoints (§2)
app.get("/api/history", wrap(() => historyPayload()));
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

// Activity (§5)
app.get("/api/activity", wrap(async () => ({ sessions: await allActivitySessions() })));
app.post("/api/activity/:id/revert", wrap(async (req) => {
  const sid = req.params.id;
  let targetProject = null;
  let targetSession = null;
  for (const p of workspace.projects) {
    const list = p.id === state.id ? projectSessions : await readJsonSafe(sessionsFile(p.id), []);
    const found = list.find((s) => s.id === sid);
    if (found) { targetProject = p.id; targetSession = found; break; }
  }
  if (!targetSession) throw new HttpError(404, `Session "${sid}" not found`);
  if (!targetSession.checkpointId) throw new HttpError(400, "No checkpoint recorded for this session");
  if (state.id !== targetProject) await openProject(targetProject, who(req));
  const restored = restoreCheckpointById(targetSession.checkpointId, who(req));
  const activeSession = projectSessions.find((s) => s.id === sid);
  if (activeSession) {
    activeSession.reverted = true;
    activeSession.live = false;
    saveSessions();
    sendActivity();
  }
  return { ok: true, restored };
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
es.addEventListener("state", (ev) => {
  const { state } = JSON.parse(ev.data);
  const key = state.nodes && state.nodes[AB] ? screenKey(state) : "";
  if (!key) { gone = true; main.innerHTML = '<p class="gone">This screen is no longer in the open project.</p>'; return; }
  if (gone) return location.reload(); // it came back (undo, or its project was reopened)
  if (key === lastKey) return;
  const first = !lastKey;
  lastKey = key;
  if (first) return;
  clearTimeout(timer);
  timer = setTimeout(reload, 120);
});
// The first fonts event is the snapshot sent on connect; later ones mean the library changed.
es.addEventListener("fonts", () => { if (!fontsSeen) { fontsSeen = true; return; } if (lastKey && !gone) { clearTimeout(timer); timer = setTimeout(reload, 120); } });
</script>
</body></html>`);
}));
app.get("/render/:id", wrap((req, res) => {
  const ab = artboardOf(req.params.id);
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fonts.css">
<style>html,body{margin:0;background:transparent}</style></head><body>${toHtml(ab, { fontBase: "", markIds: true })}</body></html>`);
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

// Stateless Streamable HTTP MCP (/mcp + legacy /paper-lite/mcp alias): fresh server/transport per request, sharing workspace & session context.
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
  if (toolName === "get_jsx" && args.format) return String(args.format);
  return "";
}

app.post(["/mcp", "/paper-lite/mcp"], async (req, res) => {
  const msgs = Array.isArray(req.body) ? req.body : [req.body];
  const initMsg = msgs.find((m) => m?.method === "initialize");
  const agent = agentFromRequest(req, initMsg?.params?.clientInfo?.name || null);
  const callMsg = msgs.find((m) => m?.method === "tools/call");
  const tool = callMsg?.params?.name || "";
  const detail = tool ? mcpToolDetail(tool, callMsg?.params?.arguments) : "";

  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
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
app.delete(["/mcp", "/paper-lite/mcp"], methodNotAllowed);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { renderer.stop(); setTimeout(() => process.exit(0), 1200); });

await fonts.load();
await loadWorkspace();
app.listen(PORT, HOST, () => {
  console.log(`weft UI   ${PUBLIC_URL}`);
  console.log(`weft MCP  ${PUBLIC_URL}/mcp`);
});
