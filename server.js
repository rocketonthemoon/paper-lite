// Paper-Lite: Paper-inspired HTML/CSS design canvas with an MCP-first API.
// One process: static UI, projects/pages/fonts on disk, SSE live sync, Streamable HTTP MCP at /mcp.
import express from "express";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  HttpError, ID_RE, SVG_TAGS, VOID_TAGS, cleanName, cleanTag, emptyPage, emptyProject, lenientMerge, mergeAttrs, mergeStyles,
  newId, normalizeProject,
} from "./model.js";
import { FontLibrary, familiesIn } from "./fonts.js";
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
const PKG_VERSION = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")).version;

// ---------------------------------------------------------------------------
// Workspace: projects on disk, one open project in memory (`state`)
// ---------------------------------------------------------------------------
let workspace = { activeProjectId: null, projects: [] }; // projects: [{ id, name, createdAt, updatedAt }]
let state; // { version, id, name, pages: [pageRootId], rootId: activePageId, nodes }
const undoStack = [];
const redoStack = [];
const sseClients = new Set();
const fonts = new FontLibrary(path.join(DATA_DIR, "fonts"));
let diskQueue = Promise.resolve();

const projectFile = (id) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "Invalid project id");
  return path.join(PROJECTS_DIR, `${id}.json`);
};
const metaOf = (id) => {
  const m = workspace.projects.find((p) => p.id === id);
  if (!m) throw new HttpError(404, `Project "${id}" not found`);
  return m;
};

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, file);
}

// All disk writes are serialized so files are never written concurrently.
function queueDisk(job) {
  diskQueue = diskQueue.then(job).catch((err) => console.error("[paper-lite] write failed:", err.message));
  return diskQueue;
}
const saveWorkspace = () => {
  const text = JSON.stringify(workspace, null, 2);
  return queueDisk(() => writeAtomic(WORKSPACE_FILE, text));
};

const previewCache = new Map(); // id -> { key, data }

function projectSummary(doc) {
  const pages = doc.pages.length;
  const artboards = doc.pages.reduce((a, pid) => a + (doc.nodes[pid]?.children?.length || 0), 0);
  const layers = Math.max(0, Object.keys(doc.nodes).length - pages);
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
  return { bg, rootIds, nodes };
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

function persist() {
  const doc = JSON.stringify(state);
  const id = state.id;
  const meta = workspace.projects.find((p) => p.id === id);
  if (meta) {
    meta.updatedAt = new Date().toISOString();
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
  return [...workspace.projects]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((p) => ({ ...p, active: p.id === state?.id }));
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
      workspace.projects.push({ id, name: doc.name, createdAt: now, updatedAt: now, ...projectSummary(doc) });
      workspace.activeProjectId = id;
      await fs.rename(LEGACY_FILE, `${LEGACY_FILE}.migrated`);
    }
  }
  workspace.projects = workspace.projects.filter((p) => ID_RE.test(p.id) && existsSync(projectFile(p.id)));
  let backfilled = false;
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
      console.error(`[paper-lite] could not open project "${p.name}" (${p.id}): ${err.message}`);
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

async function openProject(id, source = "api") {
  metaOf(id);
  if (state?.id === id) return state;
  const doc = await readProject(id);
  state = doc;
  undoStack.length = 0;
  redoStack.length = 0;
  presence.clear();
  uiSelection = { ids: [], at: 0 };
  workspace.activeProjectId = id;
  await saveWorkspace();
  broadcast(source);
  sendEvent("projects", { projects: projectList() });
  sendEvent("presence", { nodes: [] });
  return state;
}

async function createProject(name, { open = true, source = "api" } = {}) {
  const id = newId();
  const doc = emptyProject(id, cleanName(name, "Untitled"));
  const now = new Date().toISOString();
  await queueDisk(() => writeAtomic(projectFile(id), JSON.stringify(doc)));
  workspace.projects.push({ id, name: doc.name, createdAt: now, updatedAt: now, ...projectSummary(doc) });
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
  return { id, name: meta.name };
}

async function duplicateProject(id, name) {
  const doc = await readProject(id);
  const copyId = newId();
  doc.id = copyId;
  doc.name = cleanName(name, `${metaOf(id).name} copy`);
  const now = new Date().toISOString();
  await queueDisk(() => writeAtomic(projectFile(copyId), JSON.stringify(doc)));
  workspace.projects.push({ id: copyId, name: doc.name, createdAt: now, updatedAt: now, ...projectSummary(doc) });
  await saveWorkspace();
  sendEvent("projects", { projects: projectList() });
  return { id: copyId, name: doc.name };
}

async function deleteProject(id, source = "api") {
  metaOf(id);
  if (workspace.projects.length === 1) throw new HttpError(400, "Cannot delete the only project");
  workspace.projects = workspace.projects.filter((p) => p.id !== id);
  previewCache.delete(id);
  await queueDisk(() => fs.rm(projectFile(id), { force: true }));
  if (state.id === id) {
    state = null;
    await openProject(projectList()[0].id, source);
  } else {
    await saveWorkspace();
    sendEvent("projects", { projects: projectList() });
  }
  return { deleted: id };
}

// ---------------------------------------------------------------------------
// Live sync, undo and batching
// ---------------------------------------------------------------------------
function sendEvent(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}
const broadcast = (source) => sendEvent("state", { source, state });

// Every edit goes through here: snapshot for undo, apply, bump version, save, push to browsers.
// Inside batch() edits apply directly and the batch records a single undo step.
let batchDepth = 0;
function mutate(source, fn) {
  if (batchDepth) return fn(state);
  const before = structuredClone(state);
  const result = fn(state);
  commit(source, before);
  return result;
}

function batch(source, fn) {
  if (batchDepth) return fn();
  const before = structuredClone(state);
  batchDepth += 1;
  let result;
  try {
    result = fn();
  } catch (err) {
    state = before; // all-or-nothing
    throw err;
  } finally {
    batchDepth -= 1;
  }
  commit(source, before);
  return result;
}

function commit(source, before) {
  undoStack.push(before);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  state.version += 1;
  persist();
  broadcast(source);
}

function stepHistory(source, from, to) {
  if (!from.length) return false;
  to.push(structuredClone(state));
  const { version, rootId } = state;
  state = from.pop();
  state.version = version + 1;
  if (state.pages.includes(rootId)) state.rootId = rootId; // undo never flips the page you're looking at
  persist();
  broadcast(source);
  return true;
}

// ---------------------------------------------------------------------------
// Agent presence + UI selection (agents and the user see each other)
// ---------------------------------------------------------------------------
const PRESENCE_TTL = 90_000;
const presence = new Map(); // nodeId -> { label, at }
let uiSelection = { ids: [], at: 0 };

function presenceList() {
  const now = Date.now();
  for (const [id, p] of presence) if (now - p.at > PRESENCE_TTL || !state.nodes[id]) presence.delete(id);
  return [...presence].map(([id, p]) => ({ id, label: p.label }));
}
function touch(nodeIds, label = "Agent") {
  const now = Date.now();
  for (const id of nodeIds) if (state.nodes[id] && !isPage(id)) presence.set(id, { label, at: now });
  sendEvent("presence", { nodes: presenceList() });
}
function finishWorking(nodeIds) {
  if (!nodeIds?.length) presence.clear();
  else nodeIds.forEach((id) => presence.delete(id));
  sendEvent("presence", { nodes: presenceList() });
}
setInterval(() => {
  const before = presence.size;
  if (presenceList().length !== before) sendEvent("presence", { nodes: presenceList() });
}, 10_000).unref();

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
  return mutate(source, (s) => {
    const page = emptyPage(cleanName(name, `Page ${s.pages.length + 1}`));
    s.nodes[page.id] = page;
    s.pages.push(page.id);
    s.rootId = page.id;
    return page;
  });
}

function switchPage(id, source = "api") {
  getPage(id);
  if (state.rootId !== id) {
    state.rootId = id;
    uiSelection = { ids: [], at: 0 };
    persist();
    broadcast(source);
  }
  return state.nodes[id];
}

function updatePage(id, { name, index }, source = "api") {
  getPage(id);
  return mutate(source, (s) => {
    if (name !== undefined) s.nodes[id].name = cleanName(name, s.nodes[id].name);
    if (Number.isInteger(index)) {
      s.pages = s.pages.filter((p) => p !== id);
      s.pages.splice(Math.max(0, Math.min(index, s.pages.length)), 0, id);
    }
    return s.nodes[id];
  });
}

function deletePage(id, source = "api") {
  getPage(id);
  if (state.pages.length === 1) throw new HttpError(400, "A project needs at least one page");
  return mutate(source, (s) => {
    const drop = (nid) => { for (const c of s.nodes[nid].children) drop(c); delete s.nodes[nid]; };
    drop(id);
    s.pages = s.pages.filter((p) => p !== id);
    if (s.rootId === id) s.rootId = s.pages[0];
    return { deleted: id };
  });
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

function insertChild(parent, id, index) {
  const i = Number.isInteger(index) ? Math.max(0, Math.min(index, parent.children.length)) : parent.children.length;
  parent.children.splice(i, 0, id);
}

const ARTBOARD_DEFAULTS = { position: "absolute", left: "0px", top: "0px", width: "390px", height: "844px", backgroundColor: "#ffffff", overflow: "hidden" };

function createNode(input, source = "api") {
  const parent = getNode(input.parentId || state.rootId);
  const tag = cleanTag(input.tag);
  let styles = mergeStyles({}, input.styles);
  // Top-level nodes on a page are artboards placed in world space, like Paper frames.
  if (isPage(parent.id)) styles = mergeStyles(ARTBOARD_DEFAULTS, styles);
  const attrs = mergeAttrs({}, input.attrs, tag);
  return mutate(source, (s) => {
    const id = newId();
    s.nodes[id] = { id, name: cleanName(input.name, tag), tag, parentId: parent.id, children: [], text: String(input.text ?? ""), styles, attrs };
    insertChild(s.nodes[parent.id], id, input.index);
    return s.nodes[id];
  });
}

function updateNode(id, patch, source = "api") {
  const node = getNode(id);
  const next = {};
  if (patch.name !== undefined) next.name = cleanName(patch.name, node.name);
  if (patch.tag !== undefined) next.tag = cleanTag(patch.tag);
  if (patch.text !== undefined) next.text = String(patch.text);
  if (patch.styles !== undefined) next.styles = mergeStyles(patch.replaceStyles ? {} : node.styles, patch.styles);
  if (patch.attrs !== undefined) next.attrs = mergeAttrs(node.attrs, patch.attrs, next.tag ?? node.tag);
  const moving = patch.parentId !== undefined || patch.index !== undefined;
  if (moving) {
    if (isPage(id)) throw new HttpError(400, "Pages are reordered with update_page");
    const target = getNode(patch.parentId ?? node.parentId);
    if (isAncestor(id, target.id)) throw new HttpError(400, "Cannot move a node inside itself");
  }
  return mutate(source, (s) => {
    const n = s.nodes[id];
    Object.assign(n, next);
    if (moving) {
      const oldParent = s.nodes[n.parentId];
      oldParent.children = oldParent.children.filter((c) => c !== id);
      n.parentId = patch.parentId ?? n.parentId;
      insertChild(s.nodes[n.parentId], id, patch.index);
      // Anything moved onto a page becomes an artboard and needs a world position.
      if (isPage(n.parentId) && n.styles.position !== "absolute") n.styles = mergeStyles(n.styles, { position: "absolute", left: 0, top: 0 });
    }
    return n;
  });
}

function deleteNode(id, source = "api") {
  if (isPage(id)) throw new HttpError(400, "Use delete_page to remove a page");
  const node = getNode(id);
  return mutate(source, (s) => {
    const removed = [];
    const drop = (nid) => {
      for (const c of s.nodes[nid].children) drop(c);
      removed.push(nid);
      delete s.nodes[nid];
    };
    s.nodes[node.parentId].children = s.nodes[node.parentId].children.filter((c) => c !== id);
    drop(id);
    return { deleted: removed };
  });
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
  });
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
  const page = pageId ? getPage(pageId).id : state.rootId;
  const pos = x === undefined || y === undefined ? nextArtboardPosition(page) : { x, y };
  return createNode({ parentId: page, tag: "div", name, styles: { ...styles, width, height, left: x ?? pos.x, top: y ?? pos.y } }, source);
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
  state.nodes[id] = { id, name: label, tag, parentId: parent.id, children: [], text: noText ? "" : String(spec.text ?? ""), styles, attrs };
  insertChild(state.nodes[parent.id], id, index);
  for (const child of spec.children || []) addSubtree(child, id, undefined, warnings);
  return id;
}

function writeHtml({ html, parentId, targetNodeId, mode = "insert-children", index }, source = "mcp") {
  const { specs, warnings } = htmlToSpecs(html);
  if (!specs.length) throw new HttpError(400, "No elements found in html");
  let parent = parentId || state.rootId;
  let at = index;
  if (mode === "replace") {
    if (!targetNodeId) throw new HttpError(400, "targetNodeId is required for mode=replace");
    const target = getNode(targetNodeId);
    if (isPage(target.id)) throw new HttpError(400, "A page cannot be replaced");
    parent = target.parentId;
    at = state.nodes[parent].children.indexOf(target.id);
    if (isPage(parent)) for (const sp of specs) sp.styles = { left: target.styles.left, top: target.styles.top, ...sp.styles };
  }
  getNode(parent);
  const created = batch(source, () => {
    if (mode === "replace") deleteNode(targetNodeId, source);
    return specs.map((sp, i) => addSubtree(sp, parent, at === undefined ? undefined : at + i, warnings));
  });
  const countAll = (id) => 1 + state.nodes[id].children.reduce((a, c) => a + countAll(c), 0);
  return {
    created: created.map((id) => ({ id, name: state.nodes[id].name, tag: state.nodes[id].tag })),
    layers: created.reduce((a, id) => a + countAll(id), 0),
    parentId: parent,
    warnings,
  };
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

function toHtml(nodeId, { fontBase = PUBLIC_URL, filesBase, doc = state } = {}) {
  const roots = exportRoots(nodeId, doc);
  const css = [];
  const markup = (id, depth) => {
    const n = doc.nodes[id];
    const pad = "  ".repeat(depth);
    const decl = Object.entries(exportStyles(n, doc)).map(([k, v]) => `  ${kebab(k)}: ${v};`).join("\n");
    // Layer names are free text: drop "*/" and angle brackets so a name can't end the comment or the <style> element.
    css.push(`/* ${n.name.replace(/\*\//g, "").replace(/[<>]/g, "")} */\n.layer-${id} {\n${decl}\n}`);
    const attrs = Object.entries(n.attrs || {}).map(([k, v]) => ` ${k}="${escHtml(v)}"`).join("");
    const open = `${pad}<${n.tag} class="layer-${id}"${attrs}>`;
    if (VOID_TAGS.has(n.tag)) return open;
    const kids = n.children.map((c) => markup(c, depth + 1));
    if (!kids.length) return `${open}${escHtml(n.text)}</${n.tag}>`;
    const text = n.text ? [`${pad}  ${escHtml(n.text)}`] : [];
    return [open, ...text, ...kids, `${pad}</${n.tag}>`].join("\n");
  };
  const body = roots.map((id) => markup(id, 0)).join("\n\n");
  const fam = usedFonts(roots, doc);
  const fontCss = fam.length ? `${fonts.css({ families: fam, baseUrl: fontBase, filesBase })}\n\n` : "";
  return `<style>\n${fontCss}*, *::before, *::after { box-sizing: border-box; }\nbutton { font: inherit; color: inherit; }\n\n${css.join("\n\n")}\n</style>\n\n${body}\n`;
}

function componentName(name) {
  const base = String(name).replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  return /^[A-Z]/.test(base) ? base : `Layer${base}`;
}

function toJsx(nodeId, { filesBase, doc = state } = {}) {
  const roots = exportRoots(nodeId, doc);
  const jsxText = (t) => `{${JSON.stringify(t)}}`;
  const jsxName = (k) => (k.startsWith("aria-") ? k : k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  const markup = (id, depth) => {
    const n = doc.nodes[id];
    const pad = "  ".repeat(depth);
    const styles = exportStyles(n, doc);
    const styleProp = Object.keys(styles).length ? ` style={{ ${Object.entries(styles).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }}` : "";
    const attrs = Object.entries(n.attrs || {}).map(([k, v]) => ` ${jsxName(k)}=${JSON.stringify(v)}`).join("");
    const open = `${pad}<${n.tag}${attrs}${styleProp}`;
    if (VOID_TAGS.has(n.tag)) return `${open} />`;
    if (!n.children.length) return n.text ? `${open}>${jsxText(n.text)}</${n.tag}>` : `${open} />`;
    const text = n.text ? [`${pad}  ${jsxText(n.text)}`] : [];
    return [`${open}>`, ...text, ...n.children.map((c) => markup(c, depth + 1)), `${pad}</${n.tag}>`].join("\n");
  };
  const fam = usedFonts(roots, doc);
  const header = fam.length ? `/* Fonts used: ${fam.join(", ")}. Load them with:\n${fonts.css({ families: fam, baseUrl: PUBLIC_URL, filesBase })}\n*/\n\n` : "";
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
        const body = toHtml(abId, { filesBase: "../fonts", doc });
        const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${escHtml(ab.name)} · ${escHtml(doc.name)}</title>\n</head>\n<body style="margin:0">\n${body}</body>\n</html>\n`;
        entries.push({ name: `${pageDir}/${slug}.html`, data: html });
      }
      if (wantJsx) {
        entries.push({ name: `${pageDir}/${slug}.jsx`, data: toJsx(abId, { filesBase: "../fonts", doc }) });
      }
      items.push({ name: ab.name, fileBase: `${pageDir}/${slug}`, width: ab.styles.width || "auto", height: ab.styles.height || "auto" });
    }
    manifest.push({ name: page.name, dir: pageDir, items });
  }

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
    data: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${escHtml(doc.name)} — Export</title>\n<style>body{font:14px/1.5 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#0a0b0d;background:#fff}h1{margin:0 0 6px;font-size:24px}h2{margin:28px 0 10px;font-size:16px;border-bottom:1px solid #dde3e9;padding-bottom:6px}h2 small{color:#787878;font-weight:400;font-family:ui-monospace,monospace;font-size:12px}ul{list-style:none;padding:0;margin:0;display:grid;gap:6px}li{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid #dde3e9;border-radius:8px}a{color:#0000ff;text-decoration:none;font-weight:500}a:hover{text-decoration:underline}a.jsx{font-family:ui-monospace,monospace;font-size:12px;background:#f4f6f8;padding:2px 6px;border-radius:4px}li span{margin-left:auto;color:#787878;font-family:ui-monospace,monospace;font-size:12px}.empty{color:#787878}</style>\n</head>\n<body>\n<h1>${escHtml(doc.name)}</h1>\n<p style="color:#787878;margin:0">${manifest.length} page${manifest.length === 1 ? "" : "s"} exported</p>\n${indexSections}\n</body>\n</html>\n`,
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

// ---------------------------------------------------------------------------
// MCP (tools live in mcp-tools.js)
// ---------------------------------------------------------------------------
const renderer = new Renderer(`http://127.0.0.1:${PORT}`);
const mcpContext = {
  state: () => state,
  urls: { ui: PUBLIC_URL, mcp: `${PUBLIC_URL}/mcp` },
  getNode, isPage, pageOf, artboardOf, artboardSize, outline, exportCode, renderer,
  createNode, updateNode, deleteNode, duplicateNode, createArtboard, writeHtml,
  batch: (source, fn) => batch(source, fn),
  undo: (source) => stepHistory(source, undoStack, redoStack),
  redo: (source) => stepHistory(source, redoStack, undoStack),
  selection: () => ({ ...uiSelection, ids: uiSelection.ids.filter((id) => state.nodes[id]) }),
  presence: presenceList, touch, finishWorking,
  focusNodes: (ids, zoom) => {
    if (!ids?.length) { sendEvent("focus", { ids: [], zoom: false }); return; }
    const page = pageOf(ids[0]);
    if (page !== state.rootId) switchPage(page, "mcp");
    sendEvent("focus", { ids, zoom });
  },
  projects: { list: projectList, create: createProject, open: openProject, rename: renameProject, duplicate: duplicateProject, remove: deleteProject },
  pages: { create: createPage, open: switchPage, update: updatePage, remove: deletePage },
  fonts: { list: () => fonts.list().map((f) => ({ ...f, cssFamily: fonts.stack(f.family) })), add: addFont, remove: removeFont },
};

function buildMcpServer() {
  const server = new McpServer({ name: "paper-lite", version: PKG_VERSION }, { instructions: SERVER_INSTRUCTIONS });
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
    if (!err.status) console.error("[paper-lite]", err);
    res.status(err.status || 500).json({ error: err.message });
  }
};

app.get("/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`event: state\ndata: ${JSON.stringify({ source: "init", state })}\n\n`);
  res.write(`event: projects\ndata: ${JSON.stringify({ projects: projectList() })}\n\n`);
  res.write(`event: fonts\ndata: ${JSON.stringify({ fonts: fonts.list(), v: 0 })}\n\n`);
  res.write(`event: presence\ndata: ${JSON.stringify({ nodes: presenceList() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
});

// Open project document
app.get("/api/state", wrap(() => state));
app.post("/api/state", wrap((req) => {
  const next = normalizeProject(req.body, { id: state.id, name: state.name, warnings: [] });
  mutate(who(req), (s) => { s.pages = next.pages; s.rootId = next.rootId; s.nodes = next.nodes; });
  return state;
}));

// Nodes
app.post("/api/nodes", wrap((req) => createNode(req.body || {}, who(req))));
app.patch("/api/nodes/:id", wrap((req) => updateNode(req.params.id, req.body || {}, who(req))));
app.delete("/api/nodes/:id", wrap((req) => deleteNode(req.params.id, who(req))));
app.post("/api/nodes/:id/duplicate", wrap((req) => duplicateNode(req.params.id, who(req))));
app.post("/api/undo", wrap((req) => ({ ok: stepHistory(who(req), undoStack, redoStack) })));
app.post("/api/redo", wrap((req) => ({ ok: stepHistory(who(req), redoStack, undoStack) })));
app.post("/api/selection", wrap((req) => {
  const list = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === "string" && state.nodes[id]).slice(0, 200) : [];
  uiSelection = { ids: list, at: Date.now() };
  return { ok: true };
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
app.get("/render/:id", wrap((req, res) => {
  const ab = artboardOf(req.params.id);
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fonts.css">
<style>html,body{margin:0;background:transparent}</style></head><body>${toHtml(ab, { fontBase: "" })}</body></html>`);
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

// Stateless Streamable HTTP MCP: a fresh server/transport per request, sharing the same workspace.
app.post("/mcp", async (req, res) => {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[paper-lite] MCP error:", err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});
const methodNotAllowed = (req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { renderer.stop(); setTimeout(() => process.exit(0), 1200); });

await fonts.load();
await loadWorkspace();
app.listen(PORT, HOST, () => {
  console.log(`Paper-Lite UI   ${PUBLIC_URL}`);
  console.log(`Paper-Lite MCP  ${PUBLIC_URL}/mcp`);
});
