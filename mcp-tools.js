// weft MCP tool set (49 tools). Modelled on Paper's MCP so agents can drive the canvas end to end:
// read (info / tree / nodes / comments / computed styles / screenshots / code) → write (HTML, styles, text, structure)
// → review (screenshot) → reply_to_comment / finish_working_on_nodes. Every write is one undoable step and shows live in the UI.
import * as z from "zod";

export const SERVER_INSTRUCTIONS = `weft is a live HTML/CSS design canvas. Layers are real DOM nodes styled by the project's shared root CSS (variables + classes) plus camelCase inline overrides.
Start every session with get_guide (once) and get_basic_info (open project, pages, artboards, fonts, openComments). Use get_selection to see what the user is focused on, and get_comments to check reviewer notes.
Style through the project's root CSS: get_root_css shows the shared variables, classes, states, @media and nested rules; update_root_css adds them (real CSS with nesting). Layers use class="card" and var(--color-primary); inline style="" only holds what differs.
Work in few, large calls: every tool call costs a full round trip. Write a whole section or screen per write_html call, batch all style tweaks into one update_styles call and all text into one set_text_content call, and get_screenshot once a section is built, not after every small edit. save_checkpoint before major rewrites, set_session_title to label your run, reply_to_comment if responding to feedback, and call finish_working_on_nodes when done. All writes are undoable (undo).`;

const GUIDE = `# weft MCP guide

## Workspace
- Projects (files) hold pages; pages hold artboards; artboards hold layers. One project is open at a time and the user's UI
  shows the same project and page you work on. list_projects / create_project / open_project / rename_project /
  duplicate_project / delete_project manage files; create_page / switch_page / update_page / delete_page manage pages.
- Tools act on the open project and the current page unless you pass ids from elsewhere.
- Fonts: list_fonts shows the font library (Geist + Geist Mono built in, plus user-uploaded files and Google Fonts).
  Use the returned cssFamily as fontFamily. add_font adds a Google family or a local .woff2/.woff/.ttf/.otf file.

## Root CSS (shared styles)
- Every project has one root CSS: variables in :root and shared classes. It is the single source of truth for
  colours, type, spacing, radii and repeated components. get_root_css reads it (vars, classes, css text, usage).
- Before building screens, set up the tokens and components you need with update_root_css, e.g.
  update_root_css({ css: ":root { --color-primary: #0000ff; --space-4: 16px; --radius-md: 12px; } .card { padding: var(--space-4); border-radius: var(--radius-md); }" })
  or { vars: { "--color-primary": "#0000ff" }, classes: { card: { padding: "var(--space-4)" } } }. null removes one.
- Layers share it: <div class="card" style="gap: 8px">. Use var(--name) for every colour, font, size and spacing that
  has a variable, never the raw value.
- It is real CSS with nesting: states, breakpoints and descendants belong in the root CSS, not on layers:
    .card { padding: var(--space-4);
      &:hover { box-shadow: var(--shadow-1); }        /* :hover :focus-visible :active :disabled :first-child … */
      & .card-title { font-size: 20px; }              /* also > + ~, :not() :is() :has() :nth-child() */
      &--featured { border-color: var(--color-primary); }   /* & concatenates, like Sass: .card--featured */
      @media (max-width: 640px) { padding: var(--space-2); & .card-title { font-size: 16px; } }
    }
    @media (prefers-color-scheme: dark) { :root { --color-bg: #0a0b0d; } }
  Selectors may use classes, canvas tags and * (no ids or [attributes]). Only @media at-rules are supported.
- Cascade everywhere (canvas, screenshots, exports): :root variables → plain .class rules → the layer's own styles →
  states, @media and nested rules. So a layer's own style beats its base class, and :hover / breakpoints still apply.
- Breakpoints: screenshots render at the artboard's width; on the canvas, width queries follow each artboard's width.
  Design the mobile artboard (390px) and desktop artboard (1280px+) from the same classes.
- Inline styles are for layout and one-off overrides only. If two layers repeat the same styles, make a class.
- Changing a variable or class restyles every layer that uses it, on every screen. Removing a class removes it from
  the layers that use it. write_html and update_styles warn when a raw value duplicates a variable.
- update_root_css({ css }) merges each rule into the rule with the same selector and @media (or appends it);
  replace: true makes the text the whole root CSS, in order. get_root_css returns the nested text as css.

## Work in few, large calls
Each tool call waits for a full model round trip, so the number of calls, not their size, sets how long a design
takes. Aim for 2–4 calls per screen, not 10–15:
- write_html: write a complete section (header + hero + cards) or a whole screen in one call. One write_html is
  one undo step, so a big call is still easy to take back.
- update_styles / set_text_content / rename_nodes / move_nodes / delete_nodes take lists: collect every change you
  want and send one call, not one per layer.
- Set up all the root CSS a screen needs in one update_root_css call before writing it.
- get_screenshot when a section or screen is done, not after each tweak. get_computed_styles for several layers at once.
- Read once, then act: get_tree_summary or get_basic_info gives the ids you need for a batch of edits.

## Workflow
1. get_basic_info: project, pages, artboards on the current page (id, name, position, size), fonts, root CSS names, the user's selection, openComments count.
1b. get_root_css: the variables and classes to build with; add missing ones with update_root_css before writing layers.
2. get_selection / get_tree_summary / find_nodes / get_node_info / get_comments: read before you write. Ids are short hex strings.
3. Safety & runs: save_checkpoint before big rewrites; set_session_title("Short run summary") to name your activity session.
4. Create:
   - create_artboard for a new screen (default 390×844; use height "fit-content" to grow with content).
   - write_html({ parentId, html }) to add content: a complete section or whole screen per call (see above).
   - write_html({ targetNodeId, mode: "replace", html }) to rebuild a layer in place.
5. Edit: update_styles, set_text_content, rename_nodes, move_nodes, duplicate_nodes, delete_nodes: one call each with every change in its list.
6. Review & collaborate: get_screenshot({ nodeId }) once a section or screen is done; get_computed_styles for exact values; reply_to_comment / resolve_comment on user notes.
7. Finish: finish_working_on_nodes. Use set_selection to point the user at the result.
8. Code: get_jsx({ nodeId, format: "jsx" | "html" }).

## HTML rules (write_html)
- class="card primary" applies shared classes from the root CSS (undefined ones are dropped with a warning).
  style="" holds the layer's own styles. id / <style> / scripts are ignored; put shared CSS in update_root_css.
- Allowed tags: div section header footer nav main article aside h1–h6 p span strong em small label a button img ul ol li
  figure figcaption hr br, plus svg g path circle rect ellipse line polyline polygon. Others are mapped: b→strong, i→em
  quietly; table/form/input→div with a warning.
- Nesting: SVG shapes only inside <svg>/<g>; no HTML inside SVG; nothing inside <img>/<hr>/<br>; artboards stay at
  the top level. A misplaced top-level element fails the call; a misplaced nested one is skipped with a warning.
- Name layers with data-name="Card". Text-only elements become text layers; mixed text becomes span layers.
- SVG: presentation attributes only (viewBox, d, fill, stroke, stroke-width, cx, cy, r, …). No url() or href.
- Images: <img src="https://…" alt="…">.

## Styling
- Colours, fonts and spacing come from root CSS variables: color: var(--color-text).
- Prefer flexbox (display:flex; flexDirection; gap; padding) over absolute positioning.
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
const classesSchema = z.array(z.string()).max(12).describe('Shared classes from the root CSS, applied in order, e.g. ["card", "card-elevated"]');
const styleSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.null()]))
  .describe('camelCase CSS, e.g. {"backgroundColor":"#4c7dff","width":320}. Numbers become px; null removes.');

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
    description: "weft MCP usage guide: workflow, write_html rules, comments, checkpoints, styling and quality tips. Call once per session before other tools.",
    inputSchema: {},
    annotations: READ,
  }, async () => text(GUIDE));

  server.registerTool("get_basic_info", {
    description: "Overview: open project, its pages (current one marked), artboards on the current page (id, name, x, y, size, child count), layer count, font library, root CSS variable and class names, the user's selection, openComments count, and nodes agents are working on.",
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const s = S();
    const root = s.nodes[s.rootId];
    return text({
      canvas: ctx.urls.ui,
      project: { id: s.id, name: s.name },
      pages: s.pages.map((id) => ({ id, name: s.nodes[id].name, artboards: s.nodes[id].children.length, current: id === s.rootId || undefined })),
      page: { id: s.rootId, name: root.name, fill: root.styles.backgroundColor || "#eef2f6" },
      artboards: root.children.map((id) => {
        const n = s.nodes[id];
        return { id, name: n.name, x: parseFloat(n.styles.left) || 0, y: parseFloat(n.styles.top) || 0, width: n.styles.width, height: n.styles.height, children: n.children.length };
      }),
      layers: Object.keys(s.nodes).length - s.pages.length,
      fonts: ctx.fonts.list().map((f) => f.cssFamily).filter((v, i, a) => a.indexOf(v) === i),
      rootCss: (({ vars, definedClasses }) => ({ vars: Object.keys(vars), classes: definedClasses }))(ctx.rootCss.get()),
      selection: ctx.selection().ids,
      openComments: ctx.comments.openCount(),
      agentWorkingOn: ctx.presence().map((p) => p.id),
      screenshots: ctx.renderer.available ? "available" : "unavailable (no Chrome/Chromium found; set CHROME_PATH, or build weft-render and set RENDERER=blitz)",
    });
  });

  server.registerTool("get_selection", {
    description: "The layers the user currently has selected in the weft UI (with their artboard). Empty when nothing is selected.",
    inputSchema: {},
    annotations: READ,
  }, async () => {
    const sel = ctx.selection();
    return text({
      updatedAt: sel.at ? new Date(sel.at).toISOString() : null,
      nodes: sel.ids.map((id) => { const sum = summary(id); return sum && !ctx.isPage(id) ? { ...sum, artboard: summary(ctx.artboardOf(id))?.name } : null; }).filter(Boolean),
    });
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
    description: "Everything about one layer: name, tag, text, shared classes, its own camelCase styles, attributes, parent, artboard, ancestor path and child summaries.",
    inputSchema: { nodeId: z.string() },
    annotations: READ,
  }, async ({ nodeId }) => {
    const n = ctx.getNode(nodeId);
    if (!ctx.isPage(n.id)) ctx.look([n.id], "get_node_info", n.name);
    const path = [];
    for (let p = S().nodes[n.parentId]; p && !ctx.isPage(p.id); p = S().nodes[p.parentId]) path.unshift(p.name);
    return text({
      id: n.id, name: n.name, tag: n.tag, text: n.text || undefined, classes: n.classes?.length ? n.classes : undefined, styles: n.styles, attrs: Object.keys(n.attrs || {}).length ? n.attrs : undefined,
      parentId: n.parentId, pageId: ctx.pageOf(n.id), artboardId: ctx.isPage(n.id) ? undefined : ctx.artboardOf(n.id),
      path: path.join(" / "), children: n.children.map(summary),
    });
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
    description: "Browser-computed CSS and layout boxes (x, y, width, height relative to the artboard) for layers, measured in the user's open editor tab when it shows the artboard, else in headless Chrome. Use for exact values when exporting or checking alignment.",
    inputSchema: { nodeIds: ids, properties: z.array(z.string()).optional().describe("kebab-case CSS properties (default: a common layout/typography set)") },
    annotations: READ,
  }, async ({ nodeIds, properties }) => {
    const props = properties?.length ? properties : ["display", "position", "flex-direction", "align-items", "justify-content", "gap", "padding", "margin",
      "width", "height", "color", "background-color", "border", "border-radius", "box-shadow", "opacity", "font-family", "font-size", "font-weight",
      "line-height", "letter-spacing", "text-align", "overflow"];
    const groups = new Map();
    for (const id of nodeIds) { ctx.getNode(id); const ab = ctx.artboardOf(id); groups.set(ab, [...(groups.get(ab) || []), id]); }
    ctx.look(nodeIds, "get_computed_styles", `${nodeIds.length} layer${nodeIds.length === 1 ? "" : "s"}`);
    const out = {};
    for (const [ab, list] of groups) {
      const fromTab = await ctx.measureInTab({ artboardId: ab, nodeIds: list, properties: props });
      Object.assign(out, fromTab || await ctx.renderer.computed({ artboardId: ab, nodeIds: list, ...ctx.artboardSize(ab), properties: props }));
    }
    return text(out);
  });

  server.registerTool("get_screenshot", {
    description: "PNG screenshot of one or more layers/artboards rendered exactly like the canvas/export (headless Chrome). Pass nodeId for one, nodeIds for batch capture, or omit for the user's selection / first artboard.",
    inputSchema: {
      nodeId: z.string().optional(),
      nodeIds: z.array(z.string()).min(1).max(12).optional().describe("Batch capture multiple layers/artboards in one call"),
      scale: z.number().min(0.1).max(3).optional().describe("Default 1; large frames are capped at 1600px on the long edge"),
    },
    annotations: READ,
  }, async ({ nodeId, nodeIds, scale = 1 }) => {
    let targets;
    if (nodeIds?.length) {
      targets = [...new Set([...(nodeId ? [nodeId] : []), ...nodeIds])];
    } else {
      const id = nodeId || ctx.selection().ids[0] || S().nodes[S().rootId].children[0];
      if (!id) throw new Error("Canvas is empty");
      targets = [id];
    }
    const items = targets.map((id) => ({ id, target: ctx.getNode(id), ab: ctx.artboardOf(id) }));
    ctx.look(targets, "get_screenshot", items.length === 1 ? items[0].target.name : `${items.length} targets`);
    const content = [];
    for (const { id, ab } of items) {
      const shot = await ctx.renderer.screenshot({ artboardId: ab, nodeId: id, ...ctx.artboardSize(ab), scale });
      content.push(
        { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
        { type: "text", text: `${S().nodes[id].name} (${id}) · ${shot.width}×${shot.height}px at scale ${shot.scale}` },
      );
    }
    return { content };
  });

  server.registerTool("get_jsx", {
    description: "Code for a layer/artboard (or the whole page when nodeId is omitted): jsx = React components (className for shared classes, inline style objects for overrides, the root CSS they use in a header comment), html = <style> with the used root CSS and .layer-<id> overrides + markup. The project .zip export links every screen to one root styles.css.",
    inputSchema: { nodeId: z.string().optional(), format: z.enum(["jsx", "html"]).optional() },
    annotations: READ,
  }, async ({ nodeId, format = "jsx" }) => {
    if (nodeId && S().nodes[nodeId] && !ctx.isPage(nodeId)) ctx.look([nodeId], "get_jsx", S().nodes[nodeId].name);
    return text(ctx.exportCode(format, nodeId));
  });

  // ---------------------------------------------------------------- root css
  server.registerTool("get_root_css", {
    description: "The project's root CSS: variables (vars), plain classes (classes), contextual rules (rules), definedClasses, nested CSS text (css), and class usage. Optionally filter by classes, select fields via include, or use format: summary | css | full.",
    inputSchema: {
      include: z.array(z.enum(["vars", "classes", "rules", "definedClasses", "css", "usage", "unused", "unusedClasses", "unusedVars"])).min(1).optional().describe("Subset of fields to return"),
      classes: z.array(z.string()).min(1).optional().describe("Scope to these classes and their referenced variables"),
      format: z.enum(["summary", "css", "full"]).optional().describe("summary = compact counts/names; css = scoped CSS string + counts; full = full object (default)"),
    },
    annotations: READ,
  }, async (args) => text(ctx.rootCss.get(args || {})));

  server.registerTool("update_root_css", {
    description: "Add or change the root CSS in one undo step. Pass css text, real CSS with nesting, states and @media (\":root { --x: 1px; } .card { padding: var(--x); &:hover { opacity: .9; } @media (max-width: 640px) { padding: 8px; } }\"), and/or vars { \"--name\": value | null } and classes { name: { camelCase: value | null } | null }. Merges into the existing root CSS unless replace: true. Every layer using a changed variable or class updates everywhere.",
    inputSchema: {
      css: z.string().optional().describe(":root { --name: value; } plus .class { prop: value; } blocks"),
      vars: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
      classes: z.record(z.string(), z.union([styleSchema, z.null()])).optional(),
      replace: z.boolean().optional().describe("Start from an empty root CSS (classes no longer defined are removed from layers)"),
    },
    annotations: WRITE,
  }, async ({ css, vars, classes, replace }) => text(ctx.rootCss.update({ css, vars, classes, replace })));

  // ---------------------------------------------------------------- write
  server.registerTool("write_html", {
    description: "Add designs by writing HTML: class=\"card\" for shared root CSS classes, inline style=\"\" for overrides (use var(--name) for root variables). Default: append the parsed elements as children of parentId (omit parentId to create top-level artboards). mode=replace swaps targetNodeId for the parsed elements. Returns created ids. Write a whole section or screen per call rather than many small calls. See get_guide for the HTML rules.",
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
    ctx.touch(res.created.map((c) => c.id), "write_html", res.created[0]?.name || "");
    return text(res);
  });

  server.registerTool("create_artboard", {
    description: "Create an empty top-level artboard (screen) on the current page (unless pageId is passed). Placed to the right of existing artboards unless x/y are given. Height may be \"fit-content\".",
    inputSchema: {
      name: z.string().optional(),
      width: z.union([z.number(), z.string()]).optional(),
      height: z.union([z.number(), z.string()]).optional(),
      x: z.number().optional(), y: z.number().optional(),
      styles: styleSchema.optional(),
      pageId: z.string().optional().describe("Default: the current page at call time"),
    },
    annotations: WRITE,
  }, async ({ name = "Frame", width = 390, height = 844, x, y, styles = {}, pageId }) => {
    const node = ctx.createArtboard({ name, width, height, x, y, styles, pageId });
    ctx.touch([node.id], "create_artboard", node.name);
    return text(summary(node.id));
  });

  server.registerTool("create_node", {
    description: "Create a single layer (prefer write_html for anything with children).",
    inputSchema: {
      parentId: z.string(), name: z.string().optional(), tag: z.string().optional(), text: z.string().optional(),
      classes: classesSchema.optional(),
      styles: styleSchema.optional(), attrs: z.record(z.string(), z.string()).optional(), index: z.number().int().optional(),
    },
    annotations: WRITE,
  }, async (args) => { const n = ctx.createNode(args, "mcp"); ctx.touch([n.id], "create_node", n.name); return text(summary(n.id)); });

  server.registerTool("update_styles", {
    description: "Batch style changes in one undo step: [{ nodeIds: [...], styles: { camelCase: value | null } }]. Put every style change you have in one call.",
    inputSchema: { updates: z.array(z.object({ nodeIds: ids, styles: styleSchema })).min(1) },
    annotations: WRITE,
  }, async ({ updates }) => {
    const keys = [...new Set(updates.flatMap((u) => Object.keys(u.styles || {})))].slice(0, 3).join(", ");
    const targetIds = updates.flatMap((u) => u.nodeIds);
    const targetName = targetIds.length === 1 ? S().nodes[targetIds[0]]?.name : `${targetIds.length} layers`;
    const touched = ctx.batch("mcp", () => updates.flatMap((u) => u.nodeIds.map((id) => ctx.updateNode(id, { styles: u.styles }, "mcp").id)), {
      tool: "update_styles",
      target: targetName,
      nodeIds: targetIds,
    });
    ctx.touch(touched, "update_styles", keys);
    const hints = ctx.rootCss.hints(touched);
    return text(hints.length ? { updated: touched.length, hints } : { updated: touched.length });
  });

  const nodePatchFields = {
    name: z.string().optional(),
    tag: z.string().optional(),
    text: z.string().optional(),
    classes: classesSchema.optional(),
    addClasses: classesSchema.optional().describe("Append shared classes without replacing existing ones"),
    removeClasses: z.array(z.string()).max(12).optional().describe("Remove shared classes from the layer"),
    styles: styleSchema.optional(),
    replaceStyles: z.boolean().optional(),
    attrs: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  };

  server.registerTool("update_node", {
    description: "Patch one layer (nodeId, ...) or many layers in one undo step (updates: [{ nodeId, ... }]). Supports name, tag, text, classes, addClasses, removeClasses, styles (merged unless replaceStyles), attrs.",
    inputSchema: {
      nodeId: z.string().optional(),
      ...nodePatchFields,
      updates: z.array(z.object({ nodeId: z.string(), ...nodePatchFields })).min(1).optional().describe("Batch multiple node updates in one undo step"),
    },
    annotations: WRITE,
  }, async ({ nodeId, updates, ...patch }) => {
    if (updates && nodeId) throw new Error("Pass either nodeId or updates, not both");
    if (updates?.length) {
      const targetIds = updates.map((u) => u.nodeId);
      const targetName = targetIds.length === 1 ? (updates[0].name || S().nodes[targetIds[0]]?.name) : `${targetIds.length} layers`;
      const updated = ctx.batch("mcp", () => updates.map(({ nodeId: id, ...p }) => ctx.updateNode(id, p, "mcp")), {
        tool: "update_node",
        target: targetName,
        nodeIds: targetIds,
      });
      ctx.touch(targetIds, "update_node", targetName);
      const hints = updates.some((u) => u.styles) ? ctx.rootCss.hints(targetIds) : [];
      return text(hints.length ? { updated: updated.length, nodes: updated.map((n) => summary(n.id)), hints } : { updated: updated.length, nodes: updated.map((n) => summary(n.id)) });
    }
    if (!nodeId) throw new Error("Provide nodeId or updates");
    const n = ctx.updateNode(nodeId, patch, "mcp", { tool: "update_node", target: patch.name || S().nodes[nodeId]?.name, nodeIds: [nodeId] });
    ctx.touch([nodeId], "update_node", patch.styles ? Object.keys(patch.styles).slice(0, 2).join(", ") : n.name);
    return text(summary(nodeId));
  });

  server.registerTool("update_nodes_matching", {
    description: "Patch every layer matching filters (artboardIds, pageId, query, tag, hasClass) in one undo step. Supports addClasses, removeClasses, classes, styles, replaceStyles, attrs.",
    inputSchema: {
      artboardIds: z.array(z.string()).min(1).optional(),
      pageId: z.string().optional(),
      query: z.string().optional(),
      tag: z.string().optional(),
      hasClass: z.string().optional(),
      classes: classesSchema.optional(),
      addClasses: classesSchema.optional(),
      removeClasses: z.array(z.string()).max(12).optional(),
      styles: styleSchema.optional(),
      replaceStyles: z.boolean().optional(),
      attrs: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
    },
    annotations: WRITE,
  }, async (args) => {
    const res = ctx.updateNodesMatching(args, "mcp");
    if (res.nodeIds.length) ctx.touch(res.nodeIds, "update_nodes_matching", `${res.updated} layers`);
    const hints = args.styles && res.nodeIds.length ? ctx.rootCss.hints(res.nodeIds) : [];
    return text(hints.length ? { ...res, hints } : res);
  });

  server.registerTool("set_text_content", {
    description: "Set the text of text layers in one undo step: [{ nodeId, text }].",
    inputSchema: { updates: z.array(z.object({ nodeId: z.string(), text: z.string() })).min(1) },
    annotations: WRITE,
  }, async ({ updates }) => {
    const targetIds = updates.map((u) => u.nodeId);
    const targetName = targetIds.length === 1 ? S().nodes[targetIds[0]]?.name : `${targetIds.length} layers`;
    ctx.batch("mcp", () => updates.forEach((u) => ctx.updateNode(u.nodeId, { text: u.text }, "mcp")), {
      tool: "set_text_content",
      target: targetName,
      nodeIds: targetIds,
    });
    ctx.touch(targetIds, "set_text_content", targetName);
    return text({ updated: updates.length });
  });

  server.registerTool("rename_nodes", {
    description: "Rename layers in one undo step: [{ nodeId, name }].",
    inputSchema: { updates: z.array(z.object({ nodeId: z.string(), name: z.string().min(1) })).min(1) },
    annotations: WRITE,
  }, async ({ updates }) => {
    const targetIds = updates.map((u) => u.nodeId);
    const targetName = updates.length === 1 ? updates[0].name : `${updates.length} layers`;
    ctx.batch("mcp", () => updates.forEach((u) => ctx.updateNode(u.nodeId, { name: u.name }, "mcp")), {
      tool: "rename_nodes",
      target: targetName,
      nodeIds: targetIds,
    });
    return text({ renamed: updates.length });
  });

  server.registerTool("duplicate_nodes", {
    description: "Duplicate layers (with children) next to the originals. Returns the new ids in the same order.",
    inputSchema: { nodeIds: ids },
    annotations: WRITE,
  }, async ({ nodeIds }) => {
    const targetName = nodeIds.length === 1 ? S().nodes[nodeIds[0]]?.name : `${nodeIds.length} layers`;
    const created = ctx.batch("mcp", () => nodeIds.map((id) => ctx.duplicateNode(id, "mcp").id), {
      tool: "duplicate_nodes",
      target: targetName,
    });
    ctx.touch(created, "duplicate_nodes", targetName);
    return text(created.map(summary));
  });

  server.registerTool("delete_nodes", {
    description: "Delete layers and their descendants (one undo step). Ids already removed with an ancestor are skipped.",
    inputSchema: { nodeIds: ids },
    annotations: { ...WRITE, destructiveHint: true },
  }, async ({ nodeIds }) => {
    const targetName = nodeIds.length === 1 ? (S().nodes[nodeIds[0]]?.name || "Layer") : `${nodeIds.length} layers`;
    // Check existence as we go: an id may already be gone because an earlier id was its ancestor (or a repeat).
    const deleted = ctx.batch("mcp", () => nodeIds.flatMap((id) => (S().nodes[id] ? ctx.deleteNode(id, "mcp").deleted : [])), {
      tool: "delete_nodes",
      target: targetName,
    });
    return text({ deleted: deleted.length });
  });

  server.registerTool("move_nodes", {
    description: "Move layers into a new parent (in order), optionally at a sibling index.",
    inputSchema: { nodeIds: ids, parentId: z.string(), index: z.number().int().optional() },
    annotations: WRITE,
  }, async ({ nodeIds, parentId, index }) => {
    const targetName = nodeIds.length === 1 ? S().nodes[nodeIds[0]]?.name : `${nodeIds.length} layers`;
    ctx.batch("mcp", () => nodeIds.forEach((id, i) => ctx.updateNode(id, { parentId, index: index === undefined ? undefined : index + i }, "mcp")), {
      tool: "move_nodes",
      target: targetName,
      nodeIds,
    });
    ctx.touch(nodeIds, "move_nodes", targetName);
    return text({ moved: nodeIds.length, parentId });
  });

  // ---------------------------------------------------------------- agent ↔ user & comments
  server.registerTool("finish_working_on_nodes", {
    description: "Tell the user you are done: clears your 'agent working' outlines and live cursor on the canvas (all, or just nodeIds). Call when you finish creating or editing.",
    inputSchema: { nodeIds: z.array(z.string()).optional() },
    annotations: WRITE,
  }, async ({ nodeIds }) => { ctx.finishWorking(nodeIds); return text({ ok: true }); });

  server.registerTool("set_selection", {
    description: "Select layers in the user's open weft UI and (by default) zoom to them, e.g. to show what you made.",
    inputSchema: { nodeIds: z.array(z.string()), zoom: z.boolean().optional() },
    annotations: WRITE,
  }, async ({ nodeIds, zoom = true }) => {
    nodeIds.forEach((id) => ctx.getNode(id));
    ctx.focusNodes(nodeIds, zoom);
    return text({ selected: nodeIds });
  });

  server.registerTool("get_comments", {
    description: "Read reviewer comment threads pinned to layers (excludes private comments marked hidden from agents). Marks unread threads as read.",
    inputSchema: { status: z.enum(["open", "read", "replied", "resolved"]).optional(), nodeId: z.string().optional() },
    annotations: WRITE,
  }, async ({ status, nodeId }) => text(ctx.comments.list({ status, nodeId })));

  server.registerTool("reply_to_comment", {
    description: "Reply to a comment thread. By default links your most recent canvas edit step so the reviewer can inspect or undo it directly.",
    inputSchema: { id: z.string(), text: z.string().min(1), linkStep: z.boolean().optional() },
    annotations: WRITE,
  }, async ({ id, text: msg, linkStep = true }) => text(ctx.comments.reply(id, msg, linkStep)));

  server.registerTool("resolve_comment", {
    description: "Mark a comment thread as resolved.",
    inputSchema: { id: z.string() },
    annotations: WRITE,
  }, async ({ id }) => text(ctx.comments.resolve(id)));

  server.registerTool("set_session_title", {
    description: "Set a short summary title for your current agent activity session on the dashboard (e.g. \"Rebuilt pricing cards\").",
    inputSchema: { text: z.string().min(1) },
    annotations: WRITE,
  }, async ({ text: title }) => text(ctx.session.setTitle(title)));

  // ---------------------------------------------------------------- checkpoints & history
  server.registerTool("save_checkpoint", {
    description: "Save a named restore point of the open project that persists across restarts.",
    inputSchema: { name: z.string().min(1) },
    annotations: WRITE,
  }, async ({ name }) => text(ctx.checkpoints.save(name)));

  server.registerTool("list_checkpoints", {
    description: "List saved checkpoints (manual and auto) for the open project.",
    inputSchema: {},
    annotations: READ,
  }, async () => text(ctx.checkpoints.list()));

  server.registerTool("restore_checkpoint", {
    description: "Restore the open project's pages, layers and root CSS to a saved checkpoint as one undoable step.",
    inputSchema: { id: z.string() },
    annotations: WRITE,
  }, async ({ id }) => text(await ctx.checkpoints.restore(id)));

  // ---------------------------------------------------------------- git remote (connected by the user in the UI)
  server.registerTool("git_status", {
    description: "Whether the open project's checkpoints are synced to a git remote (GitHub, GitLab, …): URL, auto-push, last push/pull, last error. The token is never shown.",
    inputSchema: {},
    annotations: READ,
  }, async () => text(await ctx.git.status()));

  server.registerTool("git_push", {
    description: "Push the open project's checkpoints to its connected git remote. Save a checkpoint first to include the current design. Fails if the remote has newer checkpoints: git_pull, then push again.",
    inputSchema: {},
    annotations: { ...WRITE, openWorldHint: true },
  }, async () => text(await ctx.git.push()));

  server.registerTool("git_pull", {
    description: "Fetch checkpoints from the open project's git remote into the checkpoint list. Does not change the design; use restore_checkpoint to apply one.",
    inputSchema: {},
    annotations: { ...WRITE, openWorldHint: true },
  }, async () => text(await ctx.git.pull()));

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
