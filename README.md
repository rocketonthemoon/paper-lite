# weft

A self-hosted HTML/CSS design canvas with a built-in MCP server. AI agents build designs out of real HTML and CSS while you watch, comment, review history, and edit live in the browser.

## Features

- **Real HTML layers.** Artboards are plain DOM elements (`div`, `section`, `button`, `svg`, …) styled by the shared root CSS plus their own camelCase styles, not a proprietary vector format.
- **One root CSS per project.** Variables, classes, states (`:hover`, `:focus-visible`, …), `@media` and nesting (`&:hover`, `& .title`, `&--primary`) live in one shared stylesheet. Layers use `class="card"` and `var(--color-primary)` and keep only their own overrides. On the canvas, width `@media` queries follow each artboard's width; the ZIP export links every screen to `tokens.css` (fonts and variables) and `components.css` (classes and layer styles), and adds `icons.svg`, a sprite with every icon in the project.
- **Live collaboration.** Agent edits, live cursors, selections, comments, checkpoints, and labelled undo history sync to the browser over SSE.
- **Screenshots.** Headless Chrome renders artboards for `get_screenshot` and `get_computed_styles`.
- **Export.** Export to React JSX, standalone HTML, or a ZIP bundle (comments are excluded from all exports). Exports stay compact: identical styles share one rule, repeated icons are one SVG `<symbol>`, and in JSX repeated parts (a sidebar on every screen) become one component, in `components/` in the ZIP.
- **Plain files on disk.** Projects and activity sessions are JSON files in `DATA_DIR`; each project's checkpoints are commits in its own git repo (`projects/<id>.git`), one file per layer, so unchanged layers are stored once.
- **No build step.** The UI is a single vanilla HTML file.

## Quickstart

**Docker / Podman** (includes Node 22 and headless Chrome):

```bash
docker compose up -d --build    # or: podman compose up -d --build
```

**Node.js 20+:**

```bash
npm ci
npm start      # builds the editor UI into public/ first if needed
```

Open [http://localhost:3000](http://localhost:3000). When running with Node, install Chrome, Chromium, or Edge for screenshots, or set `CHROME_PATH`.

## Connect an MCP client

Add this with Claude Code CLI:

```bash
claude mcp add --transport http weft http://localhost:3000/mcp
```

Or add this to your client config (Claude Code, Cursor, Windsurf, …):

```json
{
  "mcpServers": {
    "weft": { "url": "http://localhost:3000/mcp" }
  }
}
```

(`/paper-lite/mcp` is kept as an alias for one release.)

If your client only supports stdio, start the server first, then use the relay:

```json
{
  "mcpServers": {
    "weft": {
      "command": "node",
      "args": ["/absolute/path/to/weft/mcp-stdio.js"],
      "env": { "WEFT_URL": "http://localhost:3000/mcp" }
    }
  }
}
```

## MCP tools (49)

| Category | Tools |
| --- | --- |
| Projects & pages | `list_projects`, `create_project`, `open_project`, `rename_project`, `duplicate_project`, `delete_project`, `create_page`, `switch_page`, `update_page`, `delete_page` |
| Authoring | `create_artboard`, `write_html`, `create_node`, `update_styles`, `update_node`, `set_text_content`, `rename_nodes`, `duplicate_nodes`, `move_nodes`, `delete_nodes` |
| Inspection & selection | `get_guide`, `get_basic_info`, `get_selection`, `set_selection`, `get_tree_summary`, `get_children`, `get_node_info`, `find_nodes`, `get_computed_styles`, `get_screenshot` |
| Comments & collaboration | `get_comments`, `reply_to_comment`, `resolve_comment`, `finish_working_on_nodes`, `set_session_title` |
| Checkpoints & history | `save_checkpoint`, `list_checkpoints`, `restore_checkpoint`, `undo`, `redo` |
| Git remote | `git_status`, `git_push`, `git_pull` |
| Root CSS (shared styles) | `get_root_css`, `update_root_css` |
| Fonts & export | `list_fonts`, `add_font`, `remove_font`, `get_jsx` |

## Project structure

| File | Role |
| --- | --- |
| [`server.js`](server.js) | Express 5 server: REST API, SSE (`/events`), JSON persistence, history/checkpoints/comments/activity, export, and `/mcp` |
| [`mcp-tools.js`](mcp-tools.js) | Zod schemas and handlers for all 49 MCP tools |
| [`mcp-stdio.js`](mcp-stdio.js) | stdio ↔ HTTP relay for stdio-only clients |
| [`model.js`](model.js) | Project/node/comment normalization, CSS and attribute validation |
| [`html-import.js`](html-import.js) | `parse5`-based HTML → node converter used by `write_html` |
| [`renderer.js`](renderer.js) | Chrome DevTools Protocol client for screenshots and computed styles |
| [`renderer-blitz.js`](renderer-blitz.js), [`weft-render/`](weft-render/) | Experimental Blitz renderer (Rust sidecar) with headless Chrome as fallback (`RENDERER=blitz`) |
| [`checkpoint-store.js`](checkpoint-store.js) | Checkpoints as commits in a per-project bare git repo ([isomorphic-git](https://isomorphic-git.org)) |
| [`fonts.js`](fonts.js) | Uploaded fonts (WOFF2/WOFF/TTF/OTF), Google Fonts, and `/fonts.css` |
| [`ui/`](ui/) | Browser canvas UI source (Vite + Svelte 5; `npm run build` writes `public/`). [`ui/index.html`](ui/index.html) is the page (markup and CSS); [`ui/src/editor/`](ui/src/editor/) is the canvas engine and editor state, and panels and menus are Svelte components in [`ui/src/components/`](ui/src/components/) |
| [`shared/root-css.js`](shared/root-css.js) | Root CSS parser/serialiser used by both the server and the editor (served at `/root-css.js`) |

## HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP (JSON-RPC 2.0); `POST /paper-lite/mcp` alias |
| `GET /events` | SSE stream: `state` (full document on connect / project switch), `patch` (changed nodes after each edit), `projects`, `selection`, `presence`, `fonts`, `history`, `comments`, `activity` |
| `/api/projects` | List/create projects; `:id/open`, `:id/preview`, `:id/duplicate` |
| `/api/state`, `/api/nodes`, `/api/pages` | Active project, node and page CRUD |
| `/api/history` | Undo timeline (`GET /api/history`, `POST /api/history/jump`, `POST /api/history/undo-agent-run`) |
| `/api/checkpoints` | Named checkpoints (`GET`, `POST`, `POST :id/restore`) |
| `/api/git` | Git remote for the open project's checkpoints (`GET`, `PUT /remote`, `DELETE /remote`, `POST /push`, `POST /pull`) |
| `/api/comments` | Layer comments (`GET`, `POST`, `POST :id/reply`, `PATCH :id`, `DELETE :id`) |
| `/api/activity` | Dashboard activity sessions (`GET`, `POST :id/revert`) |
| `POST /api/undo`, `POST /api/redo` | History step |
| `GET /api/export`, `GET /api/export/zip` | Node HTML/JSX export, full-project ZIP |
| `GET /api/fonts`, `GET /fonts.css` | Font library and stylesheet |
| `GET /render/:id` | Clean page that headless Chrome renders |

Requests are restricted by `Host`/`Origin` checks (see `ALLOWED_HOSTS`).

## Syncing checkpoints to a git host

Each project's checkpoints are commits in a git repo (`DATA_DIR/projects/<id>.git`). To back them up or share them, open **History → Git remote → Connect**, paste an HTTPS repository URL and an access token, and use **Push** / **Pull**. Turn on **Push after each checkpoint** to sync automatically.

- Works with any host that serves git over HTTPS: GitHub, GitLab, Bitbucket, Gitea, self-hosted. The username sent with the token defaults per host (`x-access-token` for GitHub, `oauth2` for GitLab, `x-token-auth` for Bitbucket, `git` otherwise) and can be changed.
- The token needs read and write access to the repository contents (on GitHub, a fine-grained token with *Contents: Read and write* on that one repo).
- The token is stored on the server only, in `projects/<id>.remote.json` (mode 600, outside the repo), and is never sent to the browser or to agents.
- **Pull never changes your design.** It adds the remote's checkpoints to the list; restore one to apply it. If both sides have new checkpoints, a merge commit keeps both sets, so nothing is lost.
- Agents can call `git_status`, `git_push` and `git_pull`; only a person can connect a remote.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Stores `workspace.json`, `projects/*.json`, `projects/*.git`, `fonts/` |
| `PUBLIC_URL` | `http://localhost:<PORT>` | URL reported by `get_basic_info` |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Extra allowed `Host`/`Origin` hostnames, comma-separated (e.g. `host.docker.internal`) |
| `CHROME_PATH` | auto-detected | Chrome/Chromium/`chrome-headless-shell` binary |
| `RENDER_IDLE_MS` | `900000` (15 min) | How long headless Chrome stays running after the last screenshot / computed-styles call; starting it again takes ~0.5–1 s |
| `RENDERER` | `chrome` | `blitz` renders screenshots and computed styles with the Blitz sidecar (`weft-render`, experimental) and uses headless Chrome only for what it can't do. See [Blitz renderer](#blitz-renderer-experimental) |
| `WEFT_RENDER_PATH` | `weft-render/target/release/weft-render` | The `weft-render` binary, for `RENDERER=blitz` |
| `CHROME_FLAGS` | empty (`--no-sandbox --disable-dev-shm-usage --disable-gpu` in Docker) | Extra Chrome flags, space-separated |
| `TAB_MEASURE_MS` | `500` | `get_computed_styles` first asks open editor tabs, which already have the artboard laid out (a few ms, and no headless Chrome start). A tab answers only if it shows that artboard at the current version; otherwise, or after this long, headless Chrome measures. `0` always uses headless Chrome |
| `PERSIST_THROTTLE_MS` | `300` | Edits apply in memory at once; disk writes are coalesced to at most one per this interval (`0` writes immediately). Pending writes are flushed on shutdown |
| `WEFT_URL` (or `PAPER_LITE_URL`) | `http://localhost:3000/mcp` | Server URL used by `mcp-stdio.js` |

## Blitz renderer (experimental)

`get_screenshot` and `get_computed_styles` render artboards in headless Chrome. [`weft-render/`](weft-render/) is a small
Rust sidecar that renders them with [Blitz](https://github.com/DioxusLabs/blitz), an HTML/CSS engine without a browser or
JavaScript, instead. To try it, install Rust (and on Linux the fontconfig headers, e.g. `libfontconfig1-dev` and
`pkg-config`), then:

```bash
npm run build:blitz          # cargo build --release in weft-render/ (a few minutes the first time)
RENDERER=blitz npm start
```

- **Fallback:** headless Chrome still answers anything Blitz can't:
  - artboards whose layers or root CSS use CSS Blitz doesn't draw yet: `filter`, `backdrop-filter`, `clip-path`,
    multi-column layout, `writing-mode`, `text-overflow`, `line-clamp`;
  - calls where the sidecar is missing or fails.

  Chrome only starts if one of these happens.
- **Measured against headless Chrome** on four 800×520 test artboards with 8–33 layers each:

  | | Blitz | Headless Chrome |
  | --- | --- | --- |
  | Memory | ~30 MB | ~460 MB |
  | Screenshot, warm | 30–45 ms | 60–80 ms |
  | Computed styles, warm | 20–30 ms | 26–32 ms |
  | First call | ~20 ms (+ one fetch of web fonts) | ~0.5–1 s to start Chrome |
- **Known differences:**
  - Layout, text, gradients, shadows, borders, outlines, transforms, blend modes, masks and CSS variables match closely.
  - Generic font names (`serif`, `sans-serif`) can resolve to a different system font than Chrome's, so text that doesn't
    set a font may wrap differently.
  - Computed values are formatted slightly differently in places: Chrome writes `0px none rgb(0, 0, 0)` for an unset
    border, Blitz `0px rgb(0, 0, 0)`; lengths can differ below 1/64 px.

The CI job "Blitz Renderer (weft-render) vs Headless Chrome" builds the sidecar and checks layer boxes, styles and
screenshots against Chrome (`test/renderer-blitz.test.js`).

## Development

```bash
npm run build  # build the editor UI: ui/ -> public/ (not committed)
npm run dev:ui # editor with hot reload on :5173; run `npm start` alongside for the API on :3000
npm run lint   # syntax, CSS/DOM checks, ESLint
npm test       # builds the UI, then unit, MCP tool coverage, integration, stdio relay, browser E2E
```

Browser tests need Chrome or Chromium installed and are skipped if none is found.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `npm audit`, lint, and tests on Node 22, then builds the Docker image, smoke-tests a screenshot over MCP, and runs Trivy scans.

## License

[Apache 2.0](LICENSE)
