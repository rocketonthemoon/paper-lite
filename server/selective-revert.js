// Selective revert: take back what some history steps did (one agent's undo, one session) while keeping every
// change anyone else made since, like `git revert`. Each step is a patch { before, after } holding only the nodes it
// changed (node | null) and, when they changed, the document meta (pages, rootCss, icons, components).
//
// Per field, three-way: a value goes back to `before` only while it still equals the step's `after` (nobody changed
// it since). A value someone else changed is left alone and reported as skipped. Children and page order are not
// merged as values; they are rebuilt from each node's parentId at the end, keeping the step's original order where
// it can, so moves, creations and deletions stay consistent.

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const OBJECT_FIELDS = new Set(["styles", "attrs", "componentOverrides"]);
const SKIP_FIELDS = new Set(["id", "children"]);

/**
 * @param {object} doc      the live document ({ nodes, pages, rootId, rootCss, icons, components }); mutated in place
 * @param {Array<{ before: object, after: object }>} patches  oldest first
 * @returns {{ reverted: string[], skipped: Array<{ id: string, name: string, fields: string[] }>, metaSkipped: string[] }}
 */
export function revertPatches(doc, patches) {
  const reverted = new Set();
  const skipped = new Map(); // id -> { id, name, fields:Set }
  const metaSkipped = new Set();
  const skip = (id, name, field) => {
    if (!skipped.has(id)) skipped.set(id, { id, name, fields: new Set() });
    skipped.get(id).fields.add(field);
  };

  for (const patch of [...patches].reverse()) {
    const { before, after } = patch;
    const parents = new Set(); // parents whose child lists need rebuilding
    const beforeOrder = new Map(); // parentId -> children order before the step
    const restore = []; // [id, node] deleted by the step, to bring back

    // Layers the step created that must stay: someone edited them since or put their own layers inside. Whatever
    // the step created inside those stays too, so a kept layer doesn't lose its contents.
    const keptCreated = new Set();
    for (const [id, b] of Object.entries(before.nodes)) {
      const a = after.nodes[id], cur = doc.nodes[id];
      if (b || !a || !cur) continue;
      const othersInside = cur.children.some((c) => !(a.children || []).includes(c) && doc.nodes[c]);
      if (!same({ ...cur, children: [] }, { ...a, children: [] }) || othersInside) {
        keptCreated.add(id);
        skip(id, cur.name, "created layer was edited since");
      }
    }
    const insideKept = (id) => {
      for (let p = doc.nodes[id]?.parentId; p; p = doc.nodes[p]?.parentId) if (keptCreated.has(p)) return true;
      return false;
    };

    for (const [id, b] of Object.entries(before.nodes)) {
      const a = after.nodes[id] ?? null;
      const cur = doc.nodes[id] ?? null;
      if (b?.children) beforeOrder.set(id, b.children);
      for (const n of [b, a, cur]) if (n?.parentId) parents.add(n.parentId);
      if (isPageNode(doc, id, b, a) || !same(b?.children, a?.children)) parents.add(id); // its own child list changed

      if (!b) {
        // Created by the step: remove it, unless someone changed it since or put their own layers inside it.
        if (!cur || keptCreated.has(id) || insideKept(id)) continue;
        delete doc.nodes[id];
        reverted.add(id);
        continue;
      }
      if (!a) {
        // Deleted by the step: bring it back (parents are checked below, once all restorable nodes are known).
        if (!cur) restore.push([id, b]);
        continue;
      }
      if (!cur) { skip(id, b.name, "deleted since"); continue; }

      // Changed by the step: field by field.
      const keys = new Set([...Object.keys(b), ...Object.keys(a), ...Object.keys(cur)]);
      let changed = false;
      for (const k of keys) {
        if (SKIP_FIELDS.has(k)) continue;
        if (OBJECT_FIELDS.has(k)) {
          const bo = b[k] || {}, ao = a[k] || {}, co = { ...(cur[k] || {}) };
          for (const p of new Set([...Object.keys(bo), ...Object.keys(ao)])) {
            if (same(bo[p], ao[p])) continue;
            if (!same(co[p], ao[p])) { skip(id, cur.name, `${k}.${p}`); continue; }
            if (bo[p] === undefined) delete co[p]; else co[p] = structuredClone(bo[p]);
            changed = true;
          }
          if (Object.keys(co).length || b[k] !== undefined) cur[k] = co; else delete cur[k];
          continue;
        }
        if (same(b[k], a[k])) continue;
        if (!same(cur[k], a[k])) { skip(id, cur.name, k); continue; }
        if (b[k] === undefined) delete cur[k]; else cur[k] = structuredClone(b[k]);
        changed = true;
      }
      // A pure reorder of children by the step goes back too, when nobody reordered them since.
      if (!same(b.children, a.children) && same(cur.children, a.children)) changed = true;
      if (changed) reverted.add(id);
    }

    // Restore deleted nodes whose parent exists (or is restored in this pass); repeat for nested ones.
    let pending = restore;
    for (let progress = true; pending.length && progress;) {
      progress = false;
      const next = [];
      for (const [id, node] of pending) {
        const parentOk = !node.parentId || doc.nodes[node.parentId] || doc.pages.includes(id);
        if (parentOk) {
          doc.nodes[id] = structuredClone(node);
          reverted.add(id);
          progress = true;
        } else next.push([id, node]);
      }
      pending = next;
    }
    for (const [id, node] of pending) skip(id, node.name, "its parent was deleted since");

    // Document meta.
    if (before.meta && after.meta) revertMeta(doc, before.meta, after.meta, metaSkipped, reverted);

    // Rebuild the child lists of every parent involved from parentId, in the step's original order.
    for (const pid of parents) rebuildChildren(doc, pid, beforeOrder.get(pid), after.nodes[pid]?.children);
  }

  if (!doc.pages.includes(doc.rootId)) doc.rootId = doc.pages[0];
  return {
    reverted: [...reverted],
    skipped: [...skipped.values()].map((s) => ({ ...s, fields: [...s.fields] })),
    metaSkipped: [...metaSkipped],
  };
}

function isPageNode(doc, id, b, a) {
  return doc.pages.includes(id) || (b && !b.parentId) || (a && !a.parentId);
}

function rebuildChildren(doc, pid, beforeList, afterList) {
  const parent = doc.nodes[pid];
  if (!parent) return;
  const belongs = (c) => doc.nodes[c] && doc.nodes[c].parentId === pid;
  // When nobody reordered since the step, start from the order before it; otherwise keep today's order.
  const base = beforeList && same(parent.children, afterList) ? beforeList : parent.children;
  const list = [...new Set(base)].filter(belongs);
  // Children that now point here but aren't listed (restored, or moved back): place them after the sibling they
  // followed before the step.
  const order = beforeList || [];
  for (const [id, n] of Object.entries(doc.nodes)) {
    if (n.parentId !== pid || list.includes(id)) continue;
    const i = order.indexOf(id);
    let at = list.length;
    if (i > 0) {
      for (let j = i - 1; j >= 0; j--) { const k = list.indexOf(order[j]); if (k !== -1) { at = k + 1; break; } }
    } else if (i === 0) at = 0;
    list.splice(at, 0, id);
  }
  parent.children = list;
}

function revertMeta(doc, b, a, metaSkipped, reverted) {
  // Pages: like child lists, keep the ones that still exist; restored pages go back to their old position.
  if (!same(b.pages, a.pages)) {
    const base = same(doc.pages, a.pages) ? b.pages : doc.pages;
    const list = [...new Set(base)].filter((id) => doc.nodes[id]);
    b.pages.forEach((id, i) => { if (doc.nodes[id] && !list.includes(id)) list.splice(Math.min(i, list.length), 0, id); });
    doc.pages = list;
  }
  // Root CSS variables one by one; rules as a whole.
  const bc = b.rootCss || {}, ac = a.rootCss || {}, cc = doc.rootCss;
  cc.vars ||= {};
  for (const v of new Set([...Object.keys(bc.vars || {}), ...Object.keys(ac.vars || {})])) {
    if (same(bc.vars?.[v], ac.vars?.[v])) continue;
    if (!same(cc.vars?.[v], ac.vars?.[v])) { metaSkipped.add(`root CSS ${v}`); continue; }
    if (bc.vars?.[v] === undefined) delete cc.vars[v]; else cc.vars[v] = bc.vars[v];
    reverted.add(`rootCss:${v}`);
  }
  if (!same(bc.rules, ac.rules)) {
    if (same(cc.rules, ac.rules)) { cc.rules = structuredClone(bc.rules || []); reverted.add("rootCss:rules"); } else metaSkipped.add("root CSS rules");
  }
  // Icons and components one by one.
  for (const key of ["icons", "components"]) {
    const bo = b[key] || {}, ao = a[key] || {};
    doc[key] ||= {};
    for (const k of new Set([...Object.keys(bo), ...Object.keys(ao)])) {
      if (same(bo[k], ao[k])) continue;
      if (!same(doc[key][k], ao[k])) { metaSkipped.add(`${key === "icons" ? "icon" : "component"} ${k}`); continue; }
      if (bo[k] === undefined) delete doc[key][k]; else doc[key][k] = structuredClone(bo[k]);
      reverted.add(`${key}:${k}`);
    }
  }
}
