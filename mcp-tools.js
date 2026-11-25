// Paper-Lite MCP tool set. Modelled on Paper's own MCP so agents can drive the canvas end to end:
// read (info / tree / nodes / computed styles / screenshots / code) → write (HTML, styles, text, structure)
// → review (screenshot) → finish_working_on_nodes. Every write is one undoable step and shows live in the UI.
import * as z from "zod";

export const SERVER_INSTRUCTIONS = `Paper-Lite is a live HTML/CSS design canvas (Paper-style). Layers are real DOM nodes with camelCase inline styles.
Start every session with get_guide (once) and get_basic_info (open project, pages, artboards, fonts). Use get_selection to see what the user is focused on.
Write designs with write_html (inline style="" only, one visual group per call), then get_screenshot to review, and
call finish_working_on_nodes when done so the user's canvas stops showing you as working. All writes are undoable (undo).`;

const GUIDE = `# Paper-Lite MCP guide

## Workspace
- Projects (files) hold pages; pages hold artboards; artboards hold layers. One project is open at a time and the user's UI
  shows the same project and page you work on. list_projects / create_project / open_project / rename_project /
  duplicate_project / delete_project manage files; create_page / switch_page / update_page / delete_page manage pages.
- Tools act on the open project and the current page unless you pass ids from elsewhere.
- Fonts: list_fonts shows the font library (Geist + Geist Mono built in, plus user-uploaded files and Google Fonts).
  Use the returned cssFamily as fontFamily. add_font adds a Google family or a local .woff2/.woff/.ttf/.otf file.

## Workflow
1. get_basic_info: project, pages, artboards on the current page (id, name, position, size), fonts, the user's selection.
2. get_selection / get_tree_summary / find_nodes / get_node_info: read before you write. Ids are short hex strings.
3. Create:
   - create_artboard for a new screen (default 390×844; use height "fit-content" to grow with content).
   - write_html({ parentId, html }) to add content. Each call should be roughly one visual group (a header, a card, a form).
   - write_html({ targetNodeId, mode: "replace", html }) to rebuild a layer in place.
4. Edit: update_styles (batch), set_text_content, rename_nodes, move_nodes, duplicate_nodes, delete_nodes.
5. Review: get_screenshot({ nodeId }) after meaningful changes; get_computed_styles for exact values and boxes.
6. Finish: finish_working_on_nodes. Use set_selection to point the user at the result.
7. Code: get_jsx({ nodeId, format: "jsx" | "html" }).

## HTML rules (write_html)
- Inline styles only: <div style="display:flex; gap:12px">. class / id / <style> / scripts are ignored.
- Allowed tags: div section header footer nav main article aside h1–h6 p span strong em small label a button img ul ol li
  figure figcaption hr br, plus svg g path circle rect ellipse line polyline polygon. Others are mapped (b→strong, i→em,
  table/form/input→div) with a warning.
- Name layers with data-name="Card". Text-only elements become text layers; mixed text becomes span layers.
- SVG: presentation attributes only (viewBox, d, fill, stroke, stroke-width, cx, cy, r, …). No url() or href.
- Images: <img src="https://…" alt="…">.

## Styling
- Prefer flexbox (display:flex; flexDirection; gap; padding) over absolute positioning, as Paper does.
- Numbers in update_styles become px (except opacity, zIndex, fontWeight, lineHeight, flexGrow…). null removes a property.
- Fonts: only families from list_fonts (or system-ui / serif / monospace) render. Use px for font sizes, em for letter-spacing.
- Artboards are top-level frames placed with left/top in world space. Exported code starts them at 0,0.
- Long text: give the text layer a width (or a flex parent) so it wraps.

## Quality
- One idea per write_html call keeps diffs reviewable and undo granular.
- Repeated rows (lists, nav): give icon and trailing-action slots fixed widths (flexShrink: 0) so columns align.
- If content clips, set the artboard height to "fit-content" instead of guessing a fixed height.
`;

const trunc = (s, n = 60) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || undefined);
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const ids = z.array(z.string()).min(1);
const styleSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.null()]))
  .describe('camelCase CSS, e.g. {"backgroundColor":"#0000ff","width":320}. Numbers become px; null removes.');

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} ctx  canvas operations provided by server.js
 */
export function registerTools(server, ctx) {
  const S = () => ctx.state();
  const summary = (id) => {
    const n = S().nodes[id];
    if (!n) return null;
    return { id, name: n.name, tag: n.tag, text: trunc(n.text), width: n.styles.width, height: n.styles.height, children: n.children.length || undefined };
  };

  // ---------------------------------------------------------------- read
  server.registerTool("get_guide", {
    description: "Paper-Lite MCP usage guide: workflow, write_html rules, styling and quality tips. Call once per session before other tools.",
    inputSchema: {},
    annotations: READ,
  }, async () => text(GUIDE));

  server.registerTool("get_basic_info", {
    description: "Overview: open project, its pages (current one marked), artboards on the current page (id, name, x, y, size, child count), layer count, font library, the user's selection, and nodes agents are working on.",
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const s = S();
    const root = s.nodes[s.rootId];
    return text({
      canvas: ctx.urls.ui,
      project: { id: s.id, name: s.name },
      pages: s.pages.map((id) => ({ id, name: s.nodes[id].name, artboards: s.nodes[id].children.length, current: id === s.rootId || undefined })),
      page: { id: s.rootId, name: root.name, fill: root.styles.backgroundColor || "#282828" },
      artboards: root.children.map((id) => {
        const n = s.nodes[id];
        return { id, name: n.name, x: parseFloat(n.styles.left) || 0, y: parseFloat(n.styles.top) || 0, width: n.styles.width, height: n.styles.height, children: n.children.length };
      }),
      layers: Object.keys(s.nodes).length - s.pages.length,
      fonts: ctx.fonts.list().map((f) => f.cssFamily).filter((v, i, a) => a.indexOf(v) === i),
      selection: ctx.selection().ids,
      agentWorkingOn: ctx.presence().map((p) => p.id),
      screenshots: ctx.renderer.available ? "available" : "unavailable (no Chrome/Chromium found; set CHROME_PATH)",
    });
  });

  server.registerTool("get_selection", {
    description: "The layers the user currently has selected in the Paper-Lite UI (with their artboard). Empty when nothing is selected.",
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const sel = ctx.selection();
    return text({ updatedAt: sel.at ? new Date(sel.at).toISOString() : null,
      nodes: sel.ids.map((id) => ({ ...summary(id), artboard: summary(ctx.artboardOf(id))?.name })).filter((n) => n.id) });
  });

  server.registerTool("get_tree_summary", {
    description: "Compact indented outline of a subtree: `id <tag> name [w x h] \"text\"`. Default: whole page, depth 3.",
    inputSchema: { nodeId: z.string().optional(), depth: z.number().int().min(0).max(30).optional() },
    annotations: READ,
  }, async ({ nodeId, depth = 3 }) => text(ctx.outline(nodeId || S().rootId, depth)));

  server.registerTool("get_children", {
    description: "Direct children of a layer (id, name, tag, text, size, child count).",
    inputSchema: { nodeId: z.string() },
    annotations: READ,
  }, async ({ nodeId }) => text(ctx.getNode(nodeId).children.map(summary)));

  server.registerTool("get_node_info", {
    description: "Everything about one layer: name, tag, text, camelCase styles, attributes, parent, artboard, ancestor path and child summaries.",
    inputSchema: { nodeId: z.string() },
    annotations: READ,
  }, async ({ nodeId }) => {
    const n = ctx.getNode(nodeId);
    const path = [];
    for (let p = S().nodes[n.parentId]; p && !ctx.isPage(p.id); p = S().nodes[p.parentId]) path.unshift(p.name);
    return text({ id: n.id, name: n.name, tag: n.tag, text: n.text || undefined, styles: n.styles, attrs: Object.keys(n.attrs || {}).length ? n.attrs : undefined,
      parentId: n.parentId, pageId: ctx.pageOf(n.id), artboardId: ctx.isPage(n.id) ? undefined : ctx.artboardOf(n.id),
      path: path.join(" / "), children: n.children.map(summary) });
  });

  server.registerTool("find_nodes", {
    description: "Search layers in the open project (all pages) by name or text (case-insensitive), optionally filtered by tag and artboard.",
    inputSchema: { query: z.string().optional(), tag: z.string().optional(), artboardId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: READ,
  }, async ({ query = "", tag, artboardId, limit = 30 }) => {
    const q = query.toLowerCase();
    const out = [];
    for (const n of Object.values(S().nodes)) {
      if (ctx.isPage(n.id)) continue;
      if (tag && n.tag !== tag) continue;
      if (q && !n.name.toLowerCase().includes(q) && !n.text.toLowerCase().includes(q) && n.id !== query) continue;
      if (artboardId && ctx.artboardOf(n.id) !== artboardId) continue;
      out.push({ ...summary(n.id), artboard: S().nodes[ctx.artboardOf(n.id)]?.name, page: S().nodes[ctx.pageOf(n.id)]?.name });
      if (out.length >= limit) break;
    }
    return text(out);
  });

  server.registerTool("get_computed_styles", {
    description: "Browser-computed CSS and layout boxes (x, y, width, height relative to the artboard) for layers, rendered in headless Chrome. Use for exact values when exporting or checking alignment.",
    inputSchema: { nodeIds: ids, properties: z.array(z.string()).optional().describe("kebab-case CSS properties (default: a common layout/typography set)") },
    annotations: READ,
  }, async ({ nodeIds, properties }) => {
    const props = properties?.length ? properties : ["display", "position", "flex-direction", "align-items", "justify-content", "gap", "padding", "margin",
      "width", "height", "color", "background-color", "border", "border-radius", "box-shadow", "opacity", "font-family", "font-size", "font-weight",
      "line-height", "letter-spacing", "text-align", "overflow"];
    const groups = new Map();
    for (const id of nodeIds) { ctx.getNode(id); const ab = ctx.artboardOf(id); groups.set(ab, [...(groups.get(ab) || []), id]); }
    const out = {};
    for (const [ab, list] of groups) Object.assign(out, await ctx.renderer.computed({ artboardId: ab, nodeIds: list, ...ctx.artboardSize(ab), properties: props }));
    return text(out);
  });

  server.registerTool("get_screenshot", {
    description: "PNG screenshot of a layer or artboard rendered exactly like the canvas/export (headless Chrome). Default target: the user's selection, else the first artboard. Review your work with this after meaningful changes.",
    inputSchema: { nodeId: z.string().optional(), scale: z.number().min(0.1).max(3).optional().describe("Default 1; large frames are capped at 1600px on the long edge") },
    annotations: READ,
  }, async ({ nodeId, scale = 1 }) => {
    const id = nodeId || ctx.selection().ids[0] || S().nodes[S().rootId].children[0];
    if (!id) throw new Error("Canvas is empty");
    ctx.getNode(id);
    const ab = ctx.artboardOf(id);
    const shot = await ctx.renderer.screenshot({ artboardId: ab, nodeId: id, ...ctx.artboardSize(ab), scale });
    return { content: [
      { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
      { type: "text", text: `${S().nodes[id].name} (${id}) · ${shot.width}×${shot.height}px at scale ${shot.scale}` },
    ] };
  });

  server.registerTool("get_jsx", {
    description: "Code for a layer/artboard (or the whole page when nodeId is omitted): jsx = React components with inline style objects, html = <style> with .layer-<id> classes + markup.",
    inputSchema: { nodeId: z.string().optional(), format: z.enum(["jsx", "html"]).optional() },
    annotations: READ,
  }, async ({ nodeId, format = "jsx" }) => text(ctx.exportCode(format, nodeId)));

  // ---------------------------------------------------------------- write
  server.registerTool("write_html", {
    description: "Add designs by writing HTML with inline styles. Default: append the parsed elements as children of parentId (omit parentId to create top-level artboards). mode=replace swaps targetNodeId for the parsed elements. Returns created ids. See get_guide for the HTML rules.",
    inputSchema: {
      html: z.string().min(1),
      parentId: z.string().optional(),
      targetNodeId: z.string().optional(),
      mode: z.enum(["insert-children", "replace"]).optional(),
      index: z.number().int().optional().describe("Insert position among siblings (default: end)"),
    },
    annotations: WRITE,
  }, async ({ html, parentId, targetNodeId, mode = "insert-children", index }) => {
    const res = ctx.writeHtml({ html, parentId, targetNodeId, mode, index });
    ctx.touch(res.created.map((c) => c.id));
    return text(res);
  });

  server.registerTool("create_artboard", {
    description: "Create an empty top-level artboard (screen). Placed to the right of existing artboards unless x/y are given. Height may be \"fit-content\".",
    inputSchema: {
      name: z.string().optional(),
      width: z.union([z.number(), z.string()]).optional(),
      height: z.union([z.number(), z.string()]).optional(),
      x: z.number().optional(), y: z.number().optional(),
      styles: styleSchema.optional(),
      pageId: z.string().optional().describe("Default: the current page"),
    },
    annotations: WRITE,
  }, async ({ name = "Frame", width = 390, height = 844, x, y, styles = {}, pageId }) => {
    const node = ctx.createArtboard({ name, width, height, x, y, styles, pageId });
    ctx.touch([node.id]);
    return text(summary(node.id));
  });

  server.registerTool("create_node", {
    description: "Create a single layer (prefer write_html for anything with children).",
    inputSchema: { parentId: z.string(), name: z.string().optional(), tag: z.string().optional(), text: z.string().optional(),
      styles: styleSchema.optional(), attrs: z.record(z.string(), z.string()).optional(), index: z.number().int().optional() },
    annotations: WRITE,
  }, async (args) => { const n = ctx.createNode(args, "mcp"); ctx.touch([n.id]); return text(summary(n.id)); });

  server.registerTool("update_styles", {
    description: "Batch style changes in one undo step: [{ nodeIds: [...], styles: { camelCase: value | null } }].",
    inputSchema: { updates: z.array(z.object({ nodeIds: ids, styles: styleSchema })).min(1) },
    annotations: WRITE,
  }, async ({ updates }) => {
    const touched = ctx.batch("mcp", () => updates.flatMap((u) => u.nodeIds.map((id) => ctx.updateNode(id, { styles: u.styles }, "mcp").id)));
    ctx.touch(touched);
    return text({ updated: touched.length });
  });

  server.registerTool("update_node", {
    description: "Patch one layer: name, tag, text, styles (merged unless replaceStyles), attrs.",
    inputSchema: { nodeId: z.string(), name: z.string().optional(), tag: z.string().optional(), text: z.string().optional(),
      styles: styleSchema.optional(), replaceStyles: z.boolean().optional(), attrs: z.record(z.string(), z.union([z.string(), z.null()])).optional() },
    annotations: WRITE,
  }, async ({ nodeId, ...patch }) => { ctx.updateNode(nodeId, patch, "mcp"); ctx.touch([nodeId]); return text(summary(nodeId)); });

  server.registerTool("set_text_content", {
    description: "Set the text of text layers in one undo step: [{ nodeId, text }].",
    inputSchema: { updates: z.array(z.object({ nodeId: z.string(), text: z.string() })).min(1) },
    annotations: WRITE,
  }, async ({ updates }) => {
    ctx.batch("mcp", () => updates.forEach((u) => ctx.updateNode(u.nodeId, { text: u.text }, "mcp")));
    ctx.touch(updates.map((u) => u.nodeId));
    return text({ updated: updates.length });
  });

  server.registerTool("rename_nodes", {
    description: "Rename layers in one undo step: [{ nodeId, name }].",
    inputSchema: { updates: z.array(z.object({ nodeId: z.string(), name: z.string().min(1) })).min(1) },
    annotations: WRITE,
  }, async ({ updates }) => {
    ctx.batch("mcp", () => updates.forEach((u) => ctx.updateNode(u.nodeId, { name: u.name }, "mcp")));
    return text({ renamed: updates.length });
  });

  server.registerTool("duplicate_nodes", {
    description: "Duplicate layers (with children) next to the originals. Returns the new ids in the same order.",
    inputSchema: { nodeIds: ids },
    annotations: WRITE,
  }, async ({ nodeIds }) => {
    const created = ctx.batch("mcp", () => nodeIds.map((id) => ctx.duplicateNode(id, "mcp").id));
    ctx.touch(created);
    return text(created.map(summary));
  });

  server.registerTool("delete_nodes", {
    description: "Delete layers and their descendants (one undo step). Ids already removed with an ancestor are skipped.",
    inputSchema: { nodeIds: ids },
    annotations: { ...WRITE, destructiveHint: true },
  }, async ({ nodeIds }) => {
    const deleted = ctx.batch("mcp", () => nodeIds.filter((id) => S().nodes[id]).flatMap((id) => ctx.deleteNode(id, "mcp").deleted));
    return text({ deleted: deleted.length });
  });

  server.registerTool("move_nodes", {
    description: "Move layers into a new parent (in order), optionally at a sibling index.",
    inputSchema: { nodeIds: ids, parentId: z.string(), index: z.number().int().optional() },
    annotations: WRITE,
  }, async ({ nodeIds, parentId, index }) => {
    ctx.batch("mcp", () => nodeIds.forEach((id, i) => ctx.updateNode(id, { parentId, index: index === undefined ? undefined : index + i }, "mcp")));
    ctx.touch(nodeIds);
    return text({ moved: nodeIds.length, parentId });
  });

  // ---------------------------------------------------------------- agent ↔ user
  server.registerTool("finish_working_on_nodes", {
    description: "Tell the user you are done: clears your 'agent working' outlines on the canvas (all, or just nodeIds). Call when you finish creating or editing.",
    inputSchema: { nodeIds: z.array(z.string()).optional() },
    annotations: WRITE,
  }, async ({ nodeIds }) => { ctx.finishWorking(nodeIds); return text({ ok: true }); });

  server.registerTool("set_selection", {
    description: "Select layers in the user's open Paper-Lite UI and (by default) zoom to them, e.g. to show what you made.",
    inputSchema: { nodeIds: z.array(z.string()), zoom: z.boolean().optional() },
    annotations: WRITE,
  }, async ({ nodeIds, zoom = true }) => {
    nodeIds.forEach((id) => ctx.getNode(id));
    ctx.focusNodes(nodeIds, zoom);
    return text({ selected: nodeIds });
  });

  // ---------------------------------------------------------------- projects
  server.registerTool("list_projects", {
    description: "All projects (files) in the workspace, most recently edited first; the open one is marked active.",
    inputSchema: {}, annotations: READ,
  }, async () => text(ctx.projects.list()));

  server.registerTool("create_project", {
    description: "Create a new empty project (one empty page). Opens it by default, which also switches the user's UI to it.",
    inputSchema: { name: z.string().min(1), open: z.boolean().optional() }, annotations: WRITE,
  }, async ({ name, open = true }) => text(await ctx.projects.create(name, { open, source: "mcp" })));

  server.registerTool("open_project", {
    description: "Open a project. The user's UI follows. Undo history is per open session.",
    inputSchema: { projectId: z.string() }, annotations: WRITE,
  }, async ({ projectId }) => { const s = await ctx.projects.open(projectId, "mcp"); return text({ id: s.id, name: s.name, pages: s.pages.length }); });

  server.registerTool("rename_project", {
    description: "Rename a project.",
    inputSchema: { projectId: z.string(), name: z.string().min(1) }, annotations: WRITE,
  }, async ({ projectId, name }) => text(await ctx.projects.rename(projectId, name, "mcp")));

  server.registerTool("duplicate_project", {
    description: "Copy a project (all pages and layers) into a new project. Does not open it.",
    inputSchema: { projectId: z.string(), name: z.string().optional() }, annotations: WRITE,
  }, async ({ projectId, name }) => text(await ctx.projects.duplicate(projectId, name)));

  server.registerTool("delete_project", {
    description: "Permanently delete a project file (cannot be undone). The last remaining project cannot be deleted.",
    inputSchema: { projectId: z.string() }, annotations: { ...WRITE, destructiveHint: true },
  }, async ({ projectId }) => text(await ctx.projects.remove(projectId, "mcp")));

  // ---------------------------------------------------------------- pages
  server.registerTool("create_page", {
    description: "Add a page to the open project and switch to it.",
    inputSchema: { name: z.string().optional() }, annotations: WRITE,
  }, async ({ name }) => { const p = ctx.pages.create(name, "mcp"); return text({ id: p.id, name: p.name }); });

  server.registerTool("switch_page", {
    description: "Make a page current (the user's UI follows). New artboards and default reads use the current page.",
    inputSchema: { pageId: z.string() }, annotations: WRITE,
  }, async ({ pageId }) => { const p = ctx.pages.open(pageId, "mcp"); return text({ id: p.id, name: p.name }); });

  server.registerTool("update_page", {
    description: "Rename a page and/or move it to a new position in the page list.",
    inputSchema: { pageId: z.string(), name: z.string().optional(), index: z.number().int().optional() }, annotations: WRITE,
  }, async ({ pageId, name, index }) => { const p = ctx.pages.update(pageId, { name, index }, "mcp"); return text({ id: p.id, name: p.name }); });

  server.registerTool("delete_page", {
    description: "Delete a page and everything on it (undoable). A project keeps at least one page.",
    inputSchema: { pageId: z.string() }, annotations: { ...WRITE, destructiveHint: true },
  }, async ({ pageId }) => text(ctx.pages.remove(pageId, "mcp")));

  // ---------------------------------------------------------------- fonts
  server.registerTool("list_fonts", {
    description: "Font library: built-in Geist / Geist Mono, uploaded font files and Google Fonts. Use cssFamily as the fontFamily style.",
    inputSchema: {}, annotations: READ,
  }, async () => text(ctx.fonts.list()));

  server.registerTool("add_font", {
    description: "Add a font to the library (shared by all projects). Either a Google Fonts family (family, optional axes like \"wght@400;700\" or \"wght@100..900\"), a local font file (filePath to .woff2/.woff/.ttf/.otf), or file contents (fileName + dataBase64). Family, weight (or variable weight range) and style are read from the font file itself (falling back to the file name) unless given.",
    inputSchema: {
      family: z.string().optional(),
      axes: z.string().optional(),
      filePath: z.string().optional(),
      fileName: z.string().optional(),
      dataBase64: z.string().optional(),
      weight: z.number().int().min(1).max(1000).optional(),
      style: z.enum(["normal", "italic"]).optional(),
    },
    annotations: { ...WRITE, openWorldHint: true },
  }, async ({ family, axes, filePath, fileName, dataBase64, weight, style }) => {
    if (filePath) return text(await ctx.fonts.add({ filePath, family, weight, style }));
    if (dataBase64) return text(await ctx.fonts.add({ fileName: fileName || "font", data: dataBase64, family, weight, style }));
    if (family) return text(await ctx.fonts.add({ source: "google", family, axes }));
    throw new Error("Provide family (Google Fonts), filePath, or fileName + dataBase64");
  });

  server.registerTool("remove_font", {
    description: "Remove a font from the library (layers using it fall back to their fallback fonts).",
    inputSchema: { fontId: z.string() }, annotations: { ...WRITE, destructiveHint: true },
  }, async ({ fontId }) => text(await ctx.fonts.remove(fontId)));

  server.registerTool("undo", { description: "Undo the last canvas edit (from the UI or any agent).", inputSchema: {}, annotations: WRITE },
    async () => text({ undone: ctx.undo("mcp") }));
  server.registerTool("redo", { description: "Redo the last undone edit.", inputSchema: {}, annotations: WRITE },
    async () => text({ redone: ctx.redo("mcp") }));
}
