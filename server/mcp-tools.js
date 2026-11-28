// weft MCP tool set (62 tools). Modelled on Paper's MCP so agents can drive the canvas end to end:
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
- Cross-project design systems: import_root_css imports variables, classes and @media rules from another project;
  export_design_tokens / import_design_tokens convert between :root CSS variables and W3C Design Tokens (tokens.json).

## Work in few, large calls
Each tool call waits for a full model round trip, so the number of calls, not their size, sets how long a design
takes. Aim for 2–4 calls per screen, not 10–15:
- write_html: write a complete section (header + hero + cards) or a whole screen in one call. One write_html is
  one undo step, so a big call is still easy to take back. undo reports the step it took back and refuses to undo
  an edit the user made in the UI meanwhile (pass includeUserEdits: true only when the user asks for that).
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
6. Review & collaborate: get_screenshot({ nodeId }) or audit_artboard({ nodeIds }) once a section or screen is done (broken images, overflows, missing fonts, tap targets, contrast); get_computed_styles for exact values; reply_to_comment / resolve_comment on user notes.
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
- Reusable components: create_component({ name, html|nodeId }), instantiate_component / <div data-component="nf-card"> with data-slot="..." overrides, and update_component to propagate changes across every artboard.
- SVG: presentation attributes only (viewBox, d, fill, stroke, stroke-width, cx, cy, r, …). No url() or href.
  For repeated icons, register them once with register_icons and reference <icon name="nf-n" /> in write_html (exported HTML deduplicates repeated icons with <symbol>/<use>).
- Images: <img src="https://…" alt="…">.
- Attributes: src / href / alt, title, role, aria-* (plain text, no < >, max 200 chars), tabindex (-999…999), type on <button> (button | submit | reset), target (_blank | _self) and rel on <a>. aria-label also names the layer when there is no data-name. Event handlers (on*) are dropped with a warning; id, style and data-* are dropped.

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
// Compact JSON: indentation costs agents ~40% more tokens for the same data.
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
// Long id lists in write results: the first few are enough to act on; the count says how many there were.
const MAX_LISTED = 50;
const capList = (list, key) => (list.length > MAX_LISTED ? { [key]: list.slice(0, MAX_LISTED), [`${key}Total`]: list.length } : { [key]: list });
const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
// Unknown arguments are refused instead of silently dropped: a typo such as `style` for `styles` would otherwise
// "succeed" and change nothing. The error names the closest known key.
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
function strictShape(shape) {
  const known = Object.keys(shape);
  return z.strictObject(shape, {
    error: (iss) => {
      if (iss.code !== "unrecognized_keys") return undefined;
      return iss.keys.map((k) => {
        const close = known
          .map((n) => ({ n, d: editDistance(k.toLowerCase(), n.toLowerCase()) }))
          .filter(({ n, d }) => d <= Math.max(2, Math.floor(n.length / 3)) || n.toLowerCase().startsWith(k.toLowerCase()) || k.toLowerCase().startsWith(n.toLowerCase()))
          .sort((x, y) => x.d - y.d)[0];
        return `Unknown argument "${k}"${close ? ` (did you mean "${close.n}"?)` : ""}; expected one of: ${known.join(", ") || "(none)"}`;
      }).join("; ");
    },
  });
}

const ids = z.array(z.string()).min(1);
const classesSchema = z.array(z.string()).max(12).describe('Shared classes from the root CSS, applied in order, e.g. ["card", "card-elevated"]');
const styleSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.null()]))
  .describe('camelCase CSS, e.g. {"backgroundColor":"#4c7dff","width":320}. Numbers become px; null removes.');

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {object} ctx  canvas operations provided by server.js
 */
export function registerTools(mcpServer, ctx) {
  const server = { registerTool: (name, config, cb) => mcpServer.registerTool(name, { ...config, inputSchema: strictShape(config.inputSchema ?? {}) }, cb) };
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
      ...(() => {
        const ids = ctx.presence().map((p) => p.id);
        return ids.length > 20 ? { agentWorkingOn: ids.slice(0, 20), agentWorkingOnTotal: ids.length } : { agentWorkingOn: ids };
      })(),
      screenshots: ctx.renderer.available ? "available" : "unavailable (no Chrome/Chromium found; set CHROME_PATH)",
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
    description: "Direct children of a layer (id, name, tag, text, size, child count). Returns a list; when there are more than `limit` (default 100) it returns { children, total, nextOffset } — call again with offset: nextOffset for the rest.",
    inputSchema: { nodeId: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: READ,
  }, async ({ nodeId, offset = 0, limit = 100 }) => {
    const all = ctx.getNode(nodeId).children;
    const page = all.slice(offset, offset + limit).map(summary);
    if (offset === 0 && all.length <= limit) return text(page);
    return text({ children: page, total: all.length, offset, ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}) });
  });

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
      ...(n.componentId ? { component: { id: n.componentId, key: n.componentKey, rootId: n.componentRootId, overrides: n.componentOverrides } } : {}),
      path: path.join(" / "),
      children: n.children.slice(0, 50).map(summary),
      ...(n.children.length > 50 ? { childrenTotal: n.children.length, more: `get_children({ nodeId: "${n.id}", offset: 50 }) for the rest` } : {}),
    });
  });

  server.registerTool("find_nodes", {
    description: "Search layers in the open project (all pages, in document order) by name or text (case-insensitive), optionally filtered by tag and artboard. Returns a list; when more than `limit` (default 30) match it returns { nodes, more: true } — narrow the query or raise limit.",
    inputSchema: { query: z.string().optional(), tag: z.string().optional(), artboardId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: READ,
  }, async ({ query = "", tag, artboardId, limit = 30 }) => {
    const q = query.toLowerCase();
    const s = S();
    const out = [];
    let more = false;
    // Document order (pages, then each tree depth-first), so results read top to bottom like the layers panel.
    const order = [];
    const walk = (id) => { order.push(id); for (const c of s.nodes[id]?.children || []) walk(c); };
    for (const pid of s.pages) walk(pid);
    for (const id of order) {
      const n = s.nodes[id];
      if (!n || ctx.isPage(n.id)) continue;
      if (tag && n.tag !== tag) continue;
      if (q && !n.name.toLowerCase().includes(q) && !n.text.toLowerCase().includes(q) && n.id !== query) continue;
      if (artboardId && ctx.artboardOf(n.id) !== artboardId) continue;
      if (out.length >= limit) { more = true; break; }
      out.push({ ...summary(n.id), artboard: s.nodes[ctx.artboardOf(n.id)]?.name, page: s.nodes[ctx.pageOf(n.id)]?.name });
    }
    return text(more ? { nodes: out, more: true } : out);
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
    description: "PNG screenshot of one or more layers/artboards rendered exactly like the canvas/export (headless Chrome). Pass nodeId for one, nodeIds for batch capture, or omit for the user's selection / first artboard. Pass width or widths ([390, 834, 1440]) to test @media breakpoints at multiple viewports without duplicating layers, and diagnostics: true to also run DOM/layout/font/image health checks.",
    inputSchema: {
      nodeId: z.string().optional(),
      nodeIds: z.array(z.string()).min(1).max(12).optional().describe("Batch capture multiple layers/artboards in one call"),
      scale: z.number().min(0.1).max(3).optional().describe("Default 1; large frames are capped at 1600px on the long edge"),
      width: z.number().int().min(200).max(4096).optional().describe("Viewport/artboard width override in px"),
      widths: z.array(z.number().int().min(200).max(4096)).min(1).max(6).optional().describe("Capture each target across multiple widths, e.g. [390, 834, 1440]"),
      diagnostics: z.boolean().optional().describe("Attach DOM & rendering health diagnostics (broken images, overflows, missing fonts, tap targets)"),
      checkContrast: z.boolean().optional().describe("When diagnostics is true, also check WCAG text contrast ratios"),
      checkTapTargets: z.boolean().optional().describe("When diagnostics is true, override mobile (<44px) tap-target checking"),
    },
    annotations: READ,
  }, async ({ nodeId, nodeIds, scale = 1, width, widths, diagnostics = false, checkContrast = false, checkTapTargets }) => {
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
    const widthList = widths?.length ? [...new Set(widths)] : (width !== undefined ? [width] : [null]);
    const content = [];
    for (const { id, ab } of items) {
      const baseSize = ctx.artboardSize(ab);
      for (const w of widthList) {
        const size = w ? { width: w, height: baseSize.height, widthOverride: w } : baseSize;
        const shot = await ctx.renderer.screenshot({ artboardId: ab, nodeId: id, ...size, scale, diagnostics, checkContrast, checkTapTargets });
        const vpLabel = w ? ` @ ${w}px` : "";
        content.push(
          { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: `${S().nodes[id].name} (${id})${vpLabel} · ${shot.width}×${shot.height}px at scale ${shot.scale}` },
        );
        if (shot.diagnostics) {
          ctx.explainAudit(shot.diagnostics);
          content.push({ type: "text", text: JSON.stringify({ diagnostics: shot.diagnostics }, null, 2) });
        }
      }
    }
    return { content };
  });

  server.registerTool("audit_artboard", {
    description: "Run automated DOM & rendering diagnostics on one or more artboards (headless Chrome): broken images (naturalWidth === 0), horizontal overflow or clipped containers, unloaded custom webfonts, mobile (<44px) tap targets, and optional WCAG contrast checks. Defaults to the selection or all artboards on the current page.",
    inputSchema: {
      nodeIds: z.array(z.string()).min(1).optional().describe("Artboard or layer IDs to audit (resolved to unique artboards)"),
      nodeId: z.string().optional().describe("Single artboard or layer ID to audit"),
      width: z.number().int().min(200).max(4096).optional().describe("Optional viewport width override (e.g. 390, 834, 1440)"),
      checkContrast: z.boolean().optional().describe("Check WCAG contrast ratios on text layers (4.5:1 normal, 3:1 large)"),
      checkTapTargets: z.boolean().optional().describe("Check interactive controls <44px (default: enabled when width <= 480px)"),
    },
    annotations: READ,
  }, async ({ nodeIds, nodeId, width, checkContrast = false, checkTapTargets }) =>
    text(await ctx.auditArtboards({ nodeIds, nodeId, width, checkContrast, checkTapTargets })));

  server.registerTool("get_jsx", {
    description: "Code for a layer/artboard (or the whole page when nodeId is omitted): jsx = React components (declared components from create_component become <Name title=\"…\" /> with a prop per text slot; className for shared classes, inline style objects for overrides, the root CSS they use in a header comment), html = <style> with the used root CSS and .layer-<id> overrides + markup. The project .zip export links every screen to the root tokens.css (fonts, variables) and components.css (classes, layer styles), with every icon in icons.svg.",
    inputSchema: { nodeId: z.string().optional(), format: z.enum(["jsx", "html"]).optional() },
    annotations: READ,
  }, async ({ nodeId, format = "jsx" }) => {
    if (nodeId && S().nodes[nodeId] && !ctx.isPage(nodeId)) ctx.look([nodeId], "get_jsx", S().nodes[nodeId].name);
    return text(ctx.exportCode(format, nodeId));
  });

  // ---------------------------------------------------------------- root css
  server.registerTool("get_root_css", {
    description: "The project's root CSS: variables (vars), plain classes (classes), contextual rules (rules), definedClasses, nested CSS text (css), class usage counts (usage), and unreferenced unusedClasses / unusedVars. Optionally filter by classes, select fields via include, or use format: summary | css | full.",
    inputSchema: {
      include: z.array(z.enum(["vars", "classes", "rules", "definedClasses", "css", "usage", "unused", "unusedClasses", "unusedVars"])).min(1).optional().describe("Subset of fields to return"),
      classes: z.array(z.string()).min(1).optional().describe("Scope to these classes and their referenced variables"),
      format: z.enum(["summary", "css", "full"]).optional().describe("summary = compact counts/names; css = scoped CSS string + counts; full = full object (default)"),
    },
    annotations: READ,
  }, async (args) => text(ctx.rootCss.get(args || {})));

  server.registerTool("update_root_css", {
    description: "Add or change the root CSS in one undo step. Pass css text, real CSS with nesting, states and @media (\":root { --x: 1px; } .card { padding: var(--x); &:hover { opacity: .9; } @media (max-width: 640px) { padding: 8px; } }\"), and/or vars { \"--name\": value | null } and classes { name: { camelCase: value | null } | null }. Merges into the existing root CSS unless replace: true. Pass pruneUnused: true to remove unreferenced classes and variables. Returns a concise confirmation summary (addedClasses, updatedClasses, removedClasses, warnings).",
    inputSchema: {
      css: z.string().optional().describe(":root { --name: value; } plus .class { prop: value; } blocks"),
      vars: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).optional(),
      classes: z.record(z.string(), z.union([styleSchema, z.null()])).optional(),
      replace: z.boolean().optional().describe("Start from an empty root CSS (classes no longer defined are removed from layers)"),
      pruneUnused: z.boolean().optional().describe("Remove unreferenced classes and variables in one undo step"),
    },
    annotations: WRITE,
  }, async ({ css, vars, classes, replace, pruneUnused }) => text(await ctx.rootCss.update({ css, vars, classes, replace, pruneUnused })));

  server.registerTool("import_root_css", {
    description: "Import root CSS variables, shared classes, states and @media rules from another project into the open project (one undo step). Optionally pass varsOnly: true or classes: [...] to scope the import.",
    inputSchema: {
      sourceProjectId: z.string().describe("Id of the source project (e.g. a Design System / UI Kit project)"),
      mode: z.enum(["merge", "replace"]).optional().describe("merge (default) preserves existing vars/rules not overwritten; replace starts from empty"),
      varsOnly: z.boolean().optional().describe("Import :root variables only (skip classes and rules)"),
      classes: z.array(z.string()).optional().describe("Import only these class names (plus any rules and :root variables they reference)"),
    },
    annotations: WRITE,
  }, async ({ sourceProjectId, mode = "merge", varsOnly = false, classes }) =>
    text(await ctx.rootCss.import({ sourceProjectId, mode, varsOnly, classes })));

  server.registerTool("export_design_tokens", {
    description: "Export the open project's :root CSS variables as a W3C Design Tokens (DTCG) JSON object ($value, $type, {group.token} references). Also included as tokens.json in the project .zip export.",
    inputSchema: {},
    annotations: READ,
  }, async () => text(ctx.tokens.export()));

  server.registerTool("import_design_tokens", {
    description: "Import W3C Design Tokens (DTCG JSON object or JSON string with $value / $type / {token.ref}) into the open project's :root CSS variables in one undo step.",
    inputSchema: {
      tokens: z.union([z.string(), z.record(z.string(), z.any())]).describe("W3C Design Tokens JSON object or serialized JSON string"),
      mode: z.enum(["merge", "replace"]).optional().describe("merge (default) adds/updates variables; replace removes existing :root variables not in the imported tokens while keeping classes"),
    },
    annotations: WRITE,
  }, async ({ tokens, mode = "merge" }) => text(await ctx.tokens.import({ tokens, mode })));

  // ---------------------------------------------------------------- write
  server.registerTool("write_html", {
    description: "Add designs by writing HTML: class=\"card\" for shared root CSS classes, inline style=\"\" for overrides (use var(--name) for root variables). Default: append the parsed elements as children of parentId (omit parentId to create top-level artboards). mode=replace swaps targetNodeId for the parsed elements. Returns created ids. Write a whole section or screen per call rather than many small calls. See get_guide for the HTML rules.",
    inputSchema: {
      html: z.string().min(1),
      parentId: z.string().optional(),
      targetNodeId: z.string().optional(),
      mode: z.enum(["insert-children", "replace"]).optional(),
      index: z.number().int().optional().describe("Insert position among siblings (default: end)"),
      lint: z.boolean().optional().describe("Design system lint hints for un-tokenized spacing, radii, font sizes and colors (default: true)"),
    },
    annotations: WRITE,
  }, async ({ html, parentId, targetNodeId, mode = "insert-children", index, lint = true }) => {
    const res = ctx.writeHtml({ html, parentId, targetNodeId, mode, index, lint });
    ctx.touch(res.created.map((c) => c.id), "write_html", res.created[0]?.name || "");
    return text({ ...res, ...capList(res.created, "created") });
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
  }, async (args) => {
    const n = ctx.createNode(args, "mcp");
    ctx.touch([n.id], "create_node", n.name);
    const hints = args.styles ? ctx.rootCss.hints([n.id], { props: Object.keys(args.styles) }) : [];
    return text(hints.length ? { ...summary(n.id), hints } : summary(n.id));
  });

  server.registerTool("update_styles", {
    description: "Batch style changes in one undo step: [{ nodeIds: [...], styles: { camelCase: value | null } }]. Put every style change you have in one call.",
    inputSchema: {
      updates: z.array(strictShape({ nodeIds: ids, styles: styleSchema })).min(1),
      lint: z.boolean().optional().describe("Design system lint hints for un-tokenized spacing, radii, font sizes and colors (default: true)"),
    },
    annotations: WRITE,
  }, async ({ updates, lint = true }) => {
    const keys = [...new Set(updates.flatMap((u) => Object.keys(u.styles || {})))].slice(0, 3).join(", ");
    const targetIds = updates.flatMap((u) => u.nodeIds);
    const targetName = targetIds.length === 1 ? S().nodes[targetIds[0]]?.name : `${targetIds.length} layers`;
    const touched = ctx.batch("mcp", () => updates.flatMap((u) => u.nodeIds.map((id) => ctx.updateNode(id, { styles: u.styles }, "mcp").id)), {
      tool: "update_styles",
      target: targetName,
      nodeIds: targetIds,
    });
    ctx.touch(touched, "update_styles", keys);
    const hints = ctx.rootCss.hints(touched, { lint, props: updates.flatMap((u) => Object.keys(u.styles || {})) });
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
    detachComponent: z.boolean().optional().describe("Detach this layer's component instance link so master updates no longer affect it"),
  };

  server.registerTool("update_node", {
    description: "Patch one layer (nodeId, ...) or many layers in one undo step (updates: [{ nodeId, ... }]). Supports name, tag, text, classes, addClasses, removeClasses, styles (merged unless replaceStyles), attrs, detachComponent.",
    inputSchema: {
      nodeId: z.string().optional(),
      ...nodePatchFields,
      updates: z.array(strictShape({ nodeId: z.string(), ...nodePatchFields })).min(1).optional().describe("Batch multiple node updates in one undo step"),
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
      const hints = updates.some((u) => u.styles) ? ctx.rootCss.hints(targetIds, { props: updates.flatMap((u) => Object.keys(u.styles || {})) }) : [];
      return text(hints.length ? { updated: updated.length, nodes: updated.map((n) => summary(n.id)), hints } : { updated: updated.length, nodes: updated.map((n) => summary(n.id)) });
    }
    if (!nodeId) throw new Error("Provide nodeId or updates");
    if (!Object.values(patch).some((v) => v !== undefined)) throw new Error("Nothing to update: pass name, tag, text, classes, addClasses, removeClasses, styles, attrs or detachComponent");
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
    const hints = args.styles && res.nodeIds.length ? ctx.rootCss.hints(res.nodeIds, { props: Object.keys(args.styles) }) : [];
    const out = { ...res, ...capList(res.nodeIds, "nodeIds") };
    return text(hints.length ? { ...out, hints } : out);
  });

  server.registerTool("set_text_content", {
    description: "Set the text of text layers in one undo step: [{ nodeId, text }].",
    inputSchema: { updates: z.array(strictShape({ nodeId: z.string(), text: z.string() })).min(1) },
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
    inputSchema: { updates: z.array(strictShape({ nodeId: z.string(), name: z.string().min(1) })).min(1) },
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
    // Every id must exist up front, like every other tool (a mistyped id used to be skipped without a word).
    const missing = nodeIds.filter((id) => !S().nodes[id]);
    if (missing.length) throw new Error(`Node${missing.length > 1 ? "s" : ""} ${missing.map((id) => `"${id}"`).join(", ")} not found; nothing was deleted`);
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
  }, async ({ nodeIds: given, parentId, index }) => {
    const nodeIds = [...new Set(given)]; // the same id twice is one move, not two
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
    description: "Reply to a comment thread. By default links your most recent canvas edit step so the reviewer can inspect or undo it directly. A thread the user resolved stays resolved unless you pass reopen: true.",
    inputSchema: { id: z.string(), text: z.string().min(1), linkStep: z.boolean().optional(), reopen: z.boolean().optional().describe("Reopen a resolved thread (default false)") },
    annotations: WRITE,
  }, async ({ id, text: msg, linkStep = true, reopen = false }) => text(ctx.comments.reply(id, msg, linkStep, reopen)));

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

  // ---------------------------------------------------------------- icons
  server.registerTool("register_icons", {
    description: "Register reusable SVG icons for the open project (one undo step). Once registered, write_html can use <icon name=\"icon-name\" /> anywhere (repeating cards, nav items) without repeating inline <svg> markup. Icons are strictly sanitised (SVG shapes + presentation attrs only; no scripts, href, or url()).",
    inputSchema: {
      icons: z.array(strictShape({ name: z.string().min(1), svg: z.string().min(1) })).min(1).optional().describe("Batch list of { name, svg } icons to register"),
      name: z.string().optional().describe("Single icon name (alternative to icons array)"),
      svg: z.string().optional().describe("Single <svg>...</svg> markup (alternative to icons array)"),
      replace: z.boolean().optional().describe("Replace the entire project icon registry instead of merging"),
    },
    annotations: WRITE,
  }, async ({ icons, name, svg, replace }) => text(ctx.icons.register({ icons, name, svg, replace })));

  server.registerTool("list_icons", {
    description: "List registered SVG icons in the open project (name, viewBox, shape count).",
    inputSchema: {},
    annotations: READ,
  }, async () => text(ctx.icons.list()));

  server.registerTool("delete_icon", {
    description: "Remove a registered SVG icon from the project's icon registry (one undo step).",
    inputSchema: { name: z.string().min(1) },
    annotations: { ...WRITE, destructiveHint: true },
  }, async ({ name }) => text(ctx.icons.remove(name)));

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

  // ---------------------------------------------------------------- components (linked symbols)
  server.registerTool("list_components", {
    description: "List reusable components in the open project (id, name, rootTag, classes, slots, instanceCount).",
    inputSchema: {},
    annotations: READ,
  }, async () => text(ctx.components.list()));

  server.registerTool("create_component", {
    description: "Define a reusable component from an existing nodeId or from single-root html (use data-slot=\"...\" for overridable slots). When nodeId is passed, linkSource (default true) turns that subtree into the first linked instance.",
    inputSchema: {
      name: z.string().min(1).describe("Component identifier, e.g. \"nf-card\""),
      nodeId: z.string().optional(),
      html: z.string().optional(),
      linkSource: z.boolean().optional(),
      overwrite: z.boolean().optional(),
    },
    annotations: WRITE,
  }, async (args) => {
    const res = ctx.components.create(args, "mcp");
    if (args.nodeId) ctx.touch([args.nodeId], "create_component", res.id);
    return text(res);
  });

  server.registerTool("instantiate_component", {
    description: "Place a linked instance of a component into parentId (default: current page), optionally overriding slots (by data-slot, key, or layer name) with { text, styles, attrs, classes, tag, name } or a string shorthand for text.",
    inputSchema: {
      component: z.string().min(1),
      parentId: z.string().optional(),
      index: z.number().int().optional(),
      name: z.string().optional(),
      overrides: z.record(z.string(), z.union([
        z.string(),
        strictShape({
          name: z.string().optional(),
          tag: z.string().optional(),
          text: z.string().optional(),
          classes: classesSchema.optional(),
          styles: styleSchema.optional(),
          attrs: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
        }),
      ])).optional(),
    },
    annotations: WRITE,
  }, async (args) => {
    const res = ctx.components.instantiate(args, "mcp");
    ctx.touch([res.id], "instantiate_component", res.component);
    return text(res);
  });

  server.registerTool("update_component", {
    description: "Update a master component (via new html, or slot + patch / appendHtml / removeSlot) and propagate changes to every linked instance across all pages/artboards in one undo step, preserving per-instance text, style and attribute overrides.",
    inputSchema: {
      component: z.string().min(1),
      html: z.string().optional(),
      slot: z.string().optional().describe("Target slot, key, or layer name in master (default: \"root\")"),
      patch: strictShape({
        name: z.string().optional(),
        tag: z.string().optional(),
        text: z.string().optional(),
        classes: classesSchema.optional(),
        addClasses: classesSchema.optional(),
        removeClasses: classesSchema.optional(),
        styles: styleSchema.optional(),
        replaceStyles: z.boolean().optional(),
        attrs: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
      }).optional().describe("Changes for the layer named by slot. Unknown keys are refused (a patch keyed by slot name is a mistake: pass slot instead)"),
      appendHtml: strictShape({
        html: z.string().min(1),
        parentSlot: z.string().optional(),
        index: z.number().int().optional(),
      }).optional(),
      removeSlot: z.string().optional(),
    },
    annotations: WRITE,
  }, async (args) => text(ctx.components.update(args, "mcp")));

  server.registerTool("delete_component", {
    description: "Delete a component definition (by default detaches existing instances so their layers remain on the canvas).",
    inputSchema: {
      component: z.string().min(1),
      detach: z.boolean().optional(),
    },
    annotations: { ...WRITE, destructiveHint: true },
  }, async (args) => text(ctx.components.remove(args, "mcp")));

  const includeUserEdits = z.boolean().optional().describe("Also undo/redo a step the user made in the UI. Default false: such a step is refused, so the user's work is never discarded by accident");
  const includeOtherAgentsEdits = z.boolean().optional().describe("Also undo/redo a step another agent made. Default false: such a step is refused, so two agents working at once can't undo each other");
  server.registerTool("undo", {
    description: "Undo the last canvas edit (one tool call is one step) and say which step it was. Refuses when the last step is the user's edit or another agent's, unless includeUserEdits / includeOtherAgentsEdits is true.",
    inputSchema: { includeUserEdits, includeOtherAgentsEdits }, annotations: WRITE,
  }, async (args) => text(ctx.agentStep("undo", args)));
  server.registerTool("redo", {
    description: "Redo the last undone edit and say which step it was. Refuses a step the user or another agent made, unless includeUserEdits / includeOtherAgentsEdits is true.",
    inputSchema: { includeUserEdits, includeOtherAgentsEdits }, annotations: WRITE,
  }, async (args) => text(ctx.agentStep("redo", args)));
}
