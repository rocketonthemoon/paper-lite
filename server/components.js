// Reusable Components / Symbol Instances engine for weft.
// Components live in `state.components[id] = { id, name, tree }`, where `tree` stores keys and optional slots
// (`data-slot="..."`). Instances materialize as real layers in `state.nodes` with `componentId`, `componentKey`,
// `componentRootId` (on descendants) and `componentOverrides`, so canvas rendering, chrome screenshots, CSS cascade,
// HTML/JSX exports and single-step undo all work automatically.
import {
  HttpError, COMPONENT_NAME_RE, SLOT_NAME_RE, SVG_TAGS, VOID_TAGS,
  cleanClassList, cleanName, cleanText, cleanTag, definedRootClasses, lenientMerge, mergeAttrs, mergeStyles,
  newId, normalizeComponentTree,
} from "./model.js";
import { htmlToSpecs } from "./html-import.js";
import { expandIconSpecs } from "./icons.js";

export function validateComponentId(raw) {
  const id = String(raw ?? "").trim();
  if (!COMPONENT_NAME_RE.test(id)) {
    throw new HttpError(400, `Component names start with a letter and use letters, digits, - or _: "${id}"`);
  }
  return id;
}

export function collectComponentSlots(tree, out = []) {
  if (!tree) return out;
  out.push({ key: tree.key, ...(tree.slot ? { slot: tree.slot } : {}), tag: tree.tag, name: tree.name });
  for (const c of tree.children || []) collectComponentSlots(c, out);
  return out;
}

function collectTreeKeys(tree, set = new Set()) {
  if (!tree) return set;
  if (tree.key) set.add(tree.key);
  for (const c of tree.children || []) collectTreeKeys(c, set);
  return set;
}

function findTreeNode(tree, slotOrKey) {
  if (!tree) return null;
  const target = String(slotOrKey || "root");
  if (tree.slot === target || tree.key === target || tree.name === target) return tree;
  for (const c of tree.children || []) {
    const hit = findTreeNode(c, target);
    if (hit) return hit;
  }
  return null;
}

export function extractComponentOverridesFromSpec(spec) {
  const overrides = {};
  const rootOv = {};
  if (spec.text && String(spec.text).trim()) rootOv.text = spec.text;
  if (spec.styles && Object.keys(spec.styles).length) rootOv.styles = spec.styles;
  if (spec.attrs && Object.keys(spec.attrs).length) rootOv.attrs = spec.attrs;
  if (spec.classes && spec.classes.length) rootOv.classes = spec.classes;
  if (Object.keys(rootOv).length) overrides.root = rootOv;
  const walk = (children) => {
    for (const c of children || []) {
      if (c.slot) {
        const cov = {};
        if (c.text !== undefined && c.text !== "") cov.text = c.text;
        if (c.styles && Object.keys(c.styles).length) cov.styles = c.styles;
        if (c.attrs && Object.keys(c.attrs).length) cov.attrs = c.attrs;
        if (c.classes && c.classes.length) cov.classes = c.classes;
        if (Object.keys(cov).length) overrides[c.slot] = cov;
      }
      if (c.children?.length) walk(c.children);
    }
  };
  walk(spec.children);
  return overrides;
}

export function trackNodeOverrides(node, patch, next) {
  const ov = {
    ...(node.componentOverrides || {}),
    ...(node.componentOverrides?.styles ? { styles: [...node.componentOverrides.styles] } : {}),
    ...(node.componentOverrides?.attrs ? { attrs: [...node.componentOverrides.attrs] } : {}),
  };
  if (patch.name !== undefined) ov.name = true;
  if (patch.tag !== undefined) ov.tag = true;
  if (patch.text !== undefined) ov.text = true;
  if (patch.classes !== undefined) ov.classes = true;
  if (patch.styles !== undefined) {
    const sKeys = new Set(ov.styles || []);
    if (patch.replaceStyles) Object.keys(next.styles || {}).forEach((k) => sKeys.add(k));
    Object.keys(patch.styles || {}).forEach((k) => sKeys.add(k));
    if (sKeys.size) ov.styles = [...sKeys];
  }
  if (patch.attrs !== undefined) {
    const aKeys = new Set(ov.attrs || []);
    Object.keys(patch.attrs || {}).forEach((k) => aKeys.add(k));
    if (aKeys.size) ov.attrs = [...aKeys];
  }
  return Object.keys(ov).length ? ov : undefined;
}

export function createComponentEngine({
  getState, getNode, isPage, safePageOf, nestError, insertChild, nextArtboardPosition, definedClasses, mutate, specTag,
}) {
  // Parse component HTML like write_html does, including <icon name="..." /> expansion from the project registry.
  function parseComponentHtml(html, warnings) {
    const parsed = htmlToSpecs(html);
    warnings.push(...parsed.warnings);
    return expandIconSpecs(parsed.specs, getState().icons, warnings);
  }

  function nodeToComponentTree(nodeId, doc = getState()) {
    const usedKeys = new Set(["root"]);
    const counter = { n: 0 };
    const build = (nid, isRoot) => {
      const n = doc.nodes[nid];
      if (!n) throw new HttpError(404, `Node "${nid}" not found`);
      let key;
      const slot = !isRoot && typeof n.slot === "string" && SLOT_NAME_RE.test(n.slot) && !usedKeys.has(n.slot) ? n.slot : undefined;
      if (isRoot) key = "root";
      else if (slot) key = slot; // data-slot="…" from write_html names the slot, as it does in component html
      else if (n.componentKey && SLOT_NAME_RE.test(n.componentKey) && !usedKeys.has(n.componentKey)) key = n.componentKey;
      else {
        do { counter.n += 1; key = `k${counter.n}`; } while (usedKeys.has(key));
      }
      usedKeys.add(key);
      const styles = { ...(n.styles || {}) };
      if (isRoot && doc.pages.includes(n.parentId)) {
        delete styles.left;
        delete styles.top;
        if (styles.position === "absolute") delete styles.position;
      }
      const children = VOID_TAGS.has(n.tag) ? [] : n.children.map((cid) => build(cid, false));
      return {
        key,
        ...(slot ? { slot } : {}),
        tag: n.tag,
        name: n.name,
        text: SVG_TAGS.has(n.tag) || VOID_TAGS.has(n.tag) ? "" : String(n.text ?? ""),
        styles,
        attrs: { ...(n.attrs || {}) },
        ...(n.classes?.length ? { classes: [...n.classes] } : {}),
        children,
      };
    };
    return build(nodeId, true);
  }

  function specToComponentTree(spec, { prevTree = null, usedKeys = new Set(), counter = { n: 0 }, warnings = [], isRoot = true } = {}) {
    const s = getState();
    const label = cleanName(spec.name, spec.tag);
    let tag;
    try {
      tag = cleanTag(spec.tag);
    } catch (err) {
      warnings.push(`${label}: ${err.message}; using div`);
      tag = "div";
    }
    const slot = spec.slot && SLOT_NAME_RE.test(spec.slot) ? spec.slot : undefined;
    let key;
    if (isRoot) key = "root";
    else if (slot && !usedKeys.has(slot)) key = slot;
    else if (prevTree?.key && !usedKeys.has(prevTree.key)) key = prevTree.key;
    else {
      do { counter.n += 1; key = `k${counter.n}`; } while (usedKeys.has(key));
    }
    usedKeys.add(key);
    const styles = lenientMerge(mergeStyles, spec.styles, warnings, label);
    const attrs = lenientMerge((b, p) => mergeAttrs(b, p, tag), spec.attrs, warnings, label);
    let classes = [];
    for (const c of spec.classes || []) {
      try { classes = cleanClassList([...classes, c]); } catch (err) { warnings.push(`${label}: ${err.message}`); }
    }
    const defined = new Set(definedRootClasses(s.rootCss));
    const missing = classes.filter((c) => !defined.has(c));
    if (missing.length) warnings.push(`${label}: ${missing.map((c) => `.${c}`).join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in root CSS; dropped`);
    classes = classes.filter((c) => !missing.includes(c));
    const noText = SVG_TAGS.has(tag) || VOID_TAGS.has(tag);
    const text = String(spec.text ?? "");
    if (noText && text.trim()) warnings.push(`${label}: <${tag}> can't hold text; dropped`);
    const prevChildren = prevTree?.children || [];
    const children = [];
    if (!VOID_TAGS.has(tag)) {
      (spec.children || []).forEach((child, idx) => {
        const cTag = specTag(child);
        const why = nestError({ id: "comp", tag }, cTag);
        if (why) { warnings.push(`${cleanName(child.name, child.tag)}: ${why}; skipped`); return; }
        const matchedPrev = child.slot
          ? prevChildren.find((pc) => pc.slot === child.slot || pc.key === child.slot)
          : prevChildren[idx];
        children.push(specToComponentTree(child, { prevTree: matchedPrev, usedKeys, counter, warnings, isRoot: false }));
      });
    }
    return {
      key,
      ...(slot ? { slot } : {}),
      tag,
      name: label,
      text: noText ? "" : text,
      styles,
      attrs,
      ...(classes.length ? { classes } : {}),
      children,
    };
  }

  function linkNodeSubtreeToComponent(nodeId, comp) {
    const s = getState();
    const walk = (nid, spec, rootId) => {
      const n = s.nodes[nid];
      if (!n || !spec) return;
      n.componentId = comp.id;
      n.componentKey = spec.key;
      if (nid !== rootId) n.componentRootId = rootId;
      else delete n.componentRootId;
      for (let i = 0; i < (spec.children || []).length && i < n.children.length; i++) {
        walk(n.children[i], spec.children[i], rootId);
      }
    };
    walk(nodeId, comp.tree, nodeId);
  }

  function resolveSpecOverride(spec, overrides) {
    if (!overrides || typeof overrides !== "object") return null;
    const raw = (spec.slot && overrides[spec.slot]) || overrides[spec.key] || overrides[spec.name];
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "string") return { text: raw };
    return typeof raw === "object" ? raw : null;
  }

  function createInstanceNodeFromSpec(spec, compId, instanceRootId, parentId, index, overrides, rootNameOverride, isRoot, warnings) {
    const s = getState();
    const ovInput = resolveSpecOverride(spec, overrides);
    const label = isRoot && rootNameOverride
      ? cleanName(rootNameOverride, spec.name)
      : (ovInput?.name !== undefined ? cleanName(ovInput.name, spec.name) : spec.name);
    let tag = spec.tag;
    const ov = {};
    if (isRoot && rootNameOverride && label !== spec.name) ov.name = true;
    if (ovInput?.name !== undefined) ov.name = true;
    if (ovInput?.tag !== undefined) {
      try { tag = cleanTag(ovInput.tag); ov.tag = true; } catch (err) { warnings.push(`${label}: ${err.message}`); }
    }
    let styles = { ...(spec.styles || {}) };
    if (isRoot && isPage(parentId)) {
      const pos = nextArtboardPosition(parentId);
      styles = { left: `${pos.x}px`, top: `${pos.y}px`, width: "390px", height: "fit-content", backgroundColor: "#ffffff", overflow: "hidden", ...styles, position: "absolute" };
    }
    if (ovInput?.styles) {
      const merged = lenientMerge(mergeStyles, ovInput.styles, warnings, label);
      Object.assign(styles, merged);
      if (Object.keys(merged).length) ov.styles = Object.keys(merged);
    }
    const attrs = { ...(spec.attrs || {}) };
    if (ovInput?.attrs) {
      const merged = lenientMerge((b, p) => mergeAttrs(b, p, tag), ovInput.attrs, warnings, label);
      for (const [k, v] of Object.entries(ovInput.attrs)) {
        if (v === null || v === "") delete attrs[k];
      }
      Object.assign(attrs, merged);
      if (Object.keys(ovInput.attrs).length) ov.attrs = Object.keys(ovInput.attrs);
    }
    const defined = new Set(definedRootClasses(s.rootCss));
    let classes = (spec.classes || []).filter((c) => defined.has(c));
    if (ovInput?.classes !== undefined) {
      try {
        classes = cleanClassList(ovInput.classes).filter((c) => defined.has(c));
        ov.classes = true;
      } catch (err) {
        warnings.push(`${label}: ${err.message}`);
      }
    }
    const noText = SVG_TAGS.has(tag) || VOID_TAGS.has(tag);
    let text = noText ? "" : String(spec.text ?? "");
    if (!noText && ovInput?.text !== undefined) {
      text = cleanText(ovInput.text);
      ov.text = true;
    }
    const id = isRoot ? instanceRootId : newId();
    s.nodes[id] = {
      id,
      name: label,
      tag,
      parentId,
      children: [],
      text,
      styles,
      attrs,
      ...(classes.length ? { classes } : {}),
      componentId: compId,
      componentKey: spec.key,
      ...(!isRoot ? { componentRootId: instanceRootId } : {}),
      ...(Object.keys(ov).length ? { componentOverrides: ov } : {}),
    };
    insertChild(s.nodes[parentId], id, index);
    let createdCount = 1;
    if (!VOID_TAGS.has(tag)) {
      for (const childSpec of spec.children || []) {
        const why = nestError(s.nodes[id], childSpec.tag);
        if (why) { warnings.push(`${childSpec.name}: ${why}; skipped`); continue; }
        createdCount += createInstanceNodeFromSpec(childSpec, compId, instanceRootId, id, undefined, overrides, null, false, warnings);
      }
    }
    return createdCount;
  }

  function instantiateIntoState(comp, parentId, index, overrides = {}, rootNameOverride = null, warnings = []) {
    const rootId = newId();
    const count = createInstanceNodeFromSpec(comp.tree, comp.id, rootId, parentId, index, overrides, rootNameOverride, true, warnings);
    return { rootId, count };
  }

  function propagateComponent(comp, warnings = []) {
    const s = getState();
    const roots = Object.values(s.nodes).filter((n) => n.componentId === comp.id && (!n.componentRootId || n.componentRootId === n.id));
    const defined = new Set(definedRootClasses(s.rootCss));
    let updatedInstances = 0;
    let createdNodes = 0;
    let removedNodes = 0;

    for (const rootNode of roots) {
      updatedInstances += 1;
      const byKey = new Map();
      for (const n of Object.values(s.nodes)) {
        if (n.componentRootId === rootNode.id && n.componentKey) byKey.set(n.componentKey, n);
      }
      const visited = new Set();

      const syncSpec = (spec, parentId, isRoot) => {
        const existing = isRoot ? rootNode : byKey.get(spec.key);
        if (!existing) {
          createdNodes += createInstanceNodeFromSpec(spec, comp.id, rootNode.id, parentId, undefined, null, null, false, warnings);
          const createdId = s.nodes[parentId].children[s.nodes[parentId].children.length - 1];
          const markVisited = (nid) => {
            visited.add(nid);
            for (const c of s.nodes[nid]?.children || []) markVisited(c);
          };
          if (createdId) markVisited(createdId);
          return createdId;
        }

        visited.add(existing.id);
        existing.parentId = parentId;
        existing.componentId = comp.id;
        existing.componentKey = spec.key;
        if (isRoot) delete existing.componentRootId;
        else existing.componentRootId = rootNode.id;

        const ov = existing.componentOverrides || {};
        if (!ov.name) existing.name = spec.name;
        if (!ov.tag && existing.tag !== spec.tag) {
          const why = nestError(s.nodes[parentId], spec.tag, { artboard: isPage(parentId) });
          if (why) warnings.push(`${existing.name}: cannot switch tag to <${spec.tag}> (${why})`);
          else existing.tag = spec.tag;
        }
        const noText = SVG_TAGS.has(existing.tag) || VOID_TAGS.has(existing.tag);
        if (!ov.text) existing.text = noText ? "" : String(spec.text ?? "");
        else if (noText) existing.text = "";

        const nextStyles = { ...(spec.styles || {}) };
        if (isRoot && isPage(parentId)) {
          for (const k of ["left", "top", "position"]) {
            if (k in existing.styles) nextStyles[k] = existing.styles[k];
          }
        }
        for (const k of ov.styles || []) {
          if (k in existing.styles) nextStyles[k] = existing.styles[k];
          else delete nextStyles[k];
        }
        existing.styles = nextStyles;

        const nextAttrs = { ...(spec.attrs || {}) };
        for (const k of ov.attrs || []) {
          if (k in existing.attrs) nextAttrs[k] = existing.attrs[k];
          else delete nextAttrs[k];
        }
        existing.attrs = nextAttrs;

        if (!ov.classes) {
          const cls = (spec.classes || []).filter((c) => defined.has(c));
          if (cls.length) existing.classes = cls;
          else delete existing.classes;
        }

        const customChildren = existing.children.filter((cid) => s.nodes[cid] && s.nodes[cid].componentRootId !== rootNode.id);
        const nextChildren = [];
        if (!VOID_TAGS.has(existing.tag)) {
          for (const cSpec of spec.children || []) {
            const why = nestError(existing, cSpec.tag);
            if (why) { warnings.push(`${cSpec.name}: ${why}; skipped`); continue; }
            const cid = syncSpec(cSpec, existing.id, false);
            if (cid) nextChildren.push(cid);
          }
        }
        for (const cid of customChildren) nextChildren.push(cid);
        existing.children = nextChildren;
        return existing.id;
      };

      syncSpec(comp.tree, rootNode.parentId, true);

      const pid = safePageOf(rootNode.id);
      for (const [nid, n] of Object.entries(s.nodes)) {
        if (n.componentRootId === rootNode.id && !visited.has(nid)) {
          for (const cm of s.comments || []) {
            if (cm.nodeId === nid) {
              if (!cm.layerName) cm.layerName = n.name;
              if (!cm.pageId && pid) cm.pageId = pid;
            }
          }
          delete s.nodes[nid];
          removedNodes += 1;
        }
      }
    }
    return { updatedInstances, createdNodes, removedNodes };
  }

  function listComponents(doc = getState()) {
    const counts = {};
    for (const n of Object.values(doc.nodes)) {
      if (n.componentId && !n.componentRootId) counts[n.componentId] = (counts[n.componentId] || 0) + 1;
    }
    return Object.values(doc.components || {}).map((c) => ({
      id: c.id,
      name: c.name,
      rootTag: c.tree.tag,
      classes: c.tree.classes || [],
      slots: collectComponentSlots(c.tree),
      instanceCount: counts[c.id] || 0,
    }));
  }

  function createComponent({ name, nodeId, html, linkSource = true, overwrite = false }, source = "mcp") {
    const s0 = getState();
    const compId = validateComponentId(name);
    if (!nodeId && !html) throw new HttpError(400, "Provide either nodeId or html to create a component");
    if (s0.components?.[compId] && !overwrite) {
      throw new HttpError(409, `Component "${compId}" already exists (pass overwrite: true to replace it)`);
    }
    const warnings = [];
    let tree;
    if (nodeId) {
      const src = getNode(nodeId);
      if (isPage(src.id)) throw new HttpError(400, "Pages cannot be converted into components");
      tree = nodeToComponentTree(src.id);
    } else {
      const specs = parseComponentHtml(html, warnings);
      if (specs.length !== 1) throw new HttpError(400, "Component HTML must have a single root element");
      tree = specToComponentTree(specs[0], { prevTree: s0.components?.[compId]?.tree || null, warnings });
    }
    const comp = { id: compId, name: cleanName(name, compId), tree: normalizeComponentTree(tree, { warnings }) };
    let stats = { updatedInstances: 0, createdNodes: 0, removedNodes: 0 };
    mutate(source, (s) => {
      s.components ||= {};
      s.components[compId] = comp;
      if (nodeId && linkSource) linkNodeSubtreeToComponent(nodeId, comp);
      if (overwrite) stats = propagateComponent(comp, warnings);
      return comp;
    }, { tool: "create_component", target: compId, nodeIds: nodeId ? [nodeId] : [] });
    return {
      id: comp.id,
      name: comp.name,
      slots: collectComponentSlots(comp.tree),
      linkedSource: Boolean(nodeId && linkSource),
      ...(overwrite ? stats : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  function instantiateComponent({ component, parentId, index, name, overrides }, source = "mcp") {
    const s0 = getState();
    const comp = s0.components?.[component];
    if (!comp) throw new HttpError(404, `Component "${component}" not found`);
    const parent = getNode((typeof parentId === "string" ? parentId.trim() : "") || s0.rootId);
    assertCanNest(parent, comp.tree.tag);
    const warnings = [];
    // An override whose key names no slot, key or layer would otherwise be dropped without a word.
    const unknown = Object.keys(overrides || {}).filter((k) => !findTreeNode(comp.tree, k));
    if (unknown.length) {
      const slots = collectComponentSlots(comp.tree).map((sl) => sl.slot || sl.key);
      warnings.push(`Override${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `"${k}"`).join(", ")} match${unknown.length > 1 ? "" : "es"} no slot in "${comp.id}" and ${unknown.length > 1 ? "were" : "was"} ignored (slots: ${slots.join(", ")})`);
    }
    const res = mutate(source, () => instantiateIntoState(comp, parent.id, index, overrides || {}, name || null, warnings), {
      tool: "instantiate_component",
      target: comp.id,
    });
    return {
      id: res.rootId,
      component: comp.id,
      name: getState().nodes[res.rootId].name,
      parentId: parent.id,
      layers: res.count,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  function assertCanNest(parent, childTag, opts) {
    const why = nestError(parent, childTag, opts);
    if (why) throw new HttpError(400, why);
  }

  function updateComponent({ component, html, slot = "root", patch, appendHtml, removeSlot }, source = "mcp") {
    const prevComp = getState().components?.[component];
    if (!prevComp) throw new HttpError(404, `Component "${component}" not found`);
    if (html === undefined && !patch && !appendHtml?.html && !removeSlot) throw new HttpError(400, "Nothing to update: pass html, patch, appendHtml or removeSlot");
    const warnings = [];
    let nextTree;
    if (html !== undefined) {
      const specs = parseComponentHtml(html, warnings);
      if (specs.length !== 1) throw new HttpError(400, "Component HTML must have a single root element");
      nextTree = specToComponentTree(specs[0], { prevTree: prevComp.tree, warnings });
    } else {
      nextTree = structuredClone(prevComp.tree);
      if (removeSlot) {
        if (removeSlot === "root" || removeSlot === nextTree.key) throw new HttpError(400, "Cannot remove the component root");
        let removed = false;
        const prune = (node) => {
          const before = node.children.length;
          node.children = node.children.filter((c) => {
            const match = c.slot === removeSlot || c.key === removeSlot || c.name === removeSlot;
            if (match) removed = true;
            return !match;
          });
          if (node.children.length === before || !removed) node.children.forEach(prune);
        };
        prune(nextTree);
        if (!removed) throw new HttpError(404, `Slot "${removeSlot}" not found in component "${component}"`);
      }
      if (appendHtml?.html) {
        const target = findTreeNode(nextTree, appendHtml.parentSlot || "root");
        if (!target) throw new HttpError(404, `Parent slot "${appendHtml.parentSlot}" not found`);
        const specs = parseComponentHtml(appendHtml.html, warnings);
        if (!specs.length) throw new HttpError(400, warnings.find((w) => w.startsWith("<icon")) || "No elements found in appendHtml.html");
        const usedKeys = collectTreeKeys(nextTree);
        const counter = { n: usedKeys.size };
        const idx = Number.isInteger(appendHtml.index) ? Math.max(0, Math.min(appendHtml.index, target.children.length)) : target.children.length;
        const inserted = specs.map((sp) => {
          assertCanNest({ id: "comp", tag: target.tag }, specTag(sp));
          return specToComponentTree(sp, { usedKeys, counter, warnings, isRoot: false });
        });
        target.children.splice(idx, 0, ...inserted);
      }
      if (patch && typeof patch === "object") {
        const target = findTreeNode(nextTree, slot || "root");
        if (!target) throw new HttpError(404, `Slot "${slot}" not found in component "${component}"`);
        if (patch.name !== undefined) target.name = cleanName(patch.name, target.name);
        if (patch.tag !== undefined) {
          const nextTag = cleanTag(patch.tag);
          if (target.children.length && VOID_TAGS.has(nextTag)) throw new HttpError(400, `<${nextTag}> can't contain child layers`);
          target.tag = nextTag;
        }
        if (patch.text !== undefined) target.text = SVG_TAGS.has(target.tag) || VOID_TAGS.has(target.tag) ? "" : cleanText(patch.text);
        if (patch.styles !== undefined) target.styles = mergeStyles(patch.replaceStyles ? {} : target.styles, patch.styles);
        if (patch.attrs !== undefined) target.attrs = mergeAttrs(target.attrs, patch.attrs, target.tag);
        let nextClasses = target.classes ? [...target.classes] : [];
        if (patch.classes !== undefined) nextClasses = definedClasses(cleanClassList(patch.classes));
        if (patch.addClasses !== undefined) nextClasses = definedClasses(cleanClassList([...nextClasses, ...patch.addClasses]));
        if (patch.removeClasses !== undefined) {
          const drop = new Set(cleanClassList(patch.removeClasses));
          nextClasses = nextClasses.filter((c) => !drop.has(c));
        }
        if (nextClasses.length) target.classes = nextClasses;
        else delete target.classes;
      }
    }
    const updatedComp = { ...prevComp, tree: normalizeComponentTree(nextTree, { warnings }) };
    let stats;
    mutate(source, (s) => {
      s.components ||= {};
      s.components[updatedComp.id] = updatedComp;
      stats = propagateComponent(updatedComp, warnings);
      return updatedComp;
    }, { tool: "update_component", target: updatedComp.id });
    return {
      component: updatedComp.id,
      slots: collectComponentSlots(updatedComp.tree),
      ...stats,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  function deleteComponent({ component, detach = true }, source = "mcp") {
    const comp = getState().components?.[component];
    if (!comp) throw new HttpError(404, `Component "${component}" not found`);
    let detachedInstances = 0;
    mutate(source, (s) => {
      delete s.components[comp.id];
      if (detach) {
        for (const n of Object.values(s.nodes)) {
          if (n.componentId !== comp.id) continue;
          if (!n.componentRootId) detachedInstances += 1;
          delete n.componentId;
          delete n.componentRootId;
          delete n.componentKey;
          delete n.componentOverrides;
        }
      }
    }, { tool: "delete_component", target: comp.id });
    return { deleted: comp.id, detachedInstances };
  }

  return {
    list: listComponents,
    create: createComponent,
    instantiate: instantiateComponent,
    instantiateIntoState,
    update: updateComponent,
    remove: deleteComponent,
    propagate: propagateComponent,
  };
}
