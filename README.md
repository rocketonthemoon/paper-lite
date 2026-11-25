# Paper-Lite

Lightweight, self-hosted HTML/CSS design canvas with a live Model Context Protocol (MCP) server.

Agents author real DOM elements and camelCase inline styles over MCP while humans inspect, select, and edit layers side-by-side in the browser over Server-Sent Events (SSE) with a shared 60-step undo/redo stack.

---

## Features

- **DOM-native canvas**: Artboards and layers are real HTML tags (`div`, `section`, `header`, `button`, `svg`, etc.) styled with flexbox and camelCase inline CSS — no proprietary vector format.
- **Live agent + human loop**: Streamable HTTP MCP endpoint (`/mcp`) and stdio relay ([`mcp-stdio.js`](mcp-stdio.js)) broadcast edits, selection, and presence badges live to connected browsers via `/events` (SSE).
- **Bundled headless Chromium**: CDP renderer ([`renderer.js`](renderer.js)) drives `get_screenshot` and `get_computed_styles` using `chrome-headless-shell` inside the container (or local Chrome/Chromium/Edge).
- **Zero-bundler frontend**: Single-file vanilla UI ([`public/index.html`](public/index.html)) with Light Precision theme, `Cmd+K` command palette, raw JSON inspector, and built-in `Geist` + `Geist Mono` fonts.
- **Plain JSON persistence & clean export**: Workspaces live on disk under `DATA_DIR` (`projects/*.json`, `workspace.json`, `fonts/`) and export to React JSX, standalone HTML, or a static ZIP bundle (`GET /api/export/zip`).
- **Hardened local server**: `Host` header & `Origin` CSRF guard, non-root container user (`node`), `npm audit --omit=dev` clean, ESLint v9 linted, and Trivy scanned in CI.

---

## Quickstart

### Option 1: Docker or Podman Compose (Recommended)

Includes Node.js 22 and `chrome-headless-shell` preconfigured out of the box:

```bash
docker compose up -d --build
# or
podman compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000). Data persists in `./data/`.

### Option 2: Local Node.js (`>=20`)

```bash
npm ci
npm start
```

> **Note:** For `get_screenshot` and `get_computed_styles` when running locally, have Chrome, Chromium, or Edge installed (or set `CHROME_PATH`).

---

## Connecting an MCP Client

### Streamable HTTP (`POST /mcp`)

Add to your MCP client configuration (Claude Code, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "paper-lite": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

### Stdio Relay (Clients without HTTP MCP support)

Start the Paper-Lite server first, then configure [`mcp-stdio.js`](mcp-stdio.js):

```json
{
  "mcpServers": {
    "paper-lite": {
      "command": "node",
      "args": ["/absolute/path/to/paper-lite/mcp-stdio.js"],
      "env": {
        "PAPER_LITE_URL": "http://localhost:3000/mcp"
      }
    }
  }
}
```

---

## 37 MCP Tools

Registered in [`mcp-tools.js`](mcp-tools.js):

| Category | Tools |
| --- | --- |
| **Projects & Pages (10)** | `list_projects`, `create_project`, `open_project`, `rename_project`, `duplicate_project`, `delete_project`, `create_page`, `switch_page`, `update_page`, `delete_page` |
| **Canvas Authoring (10)** | `create_artboard`, `write_html`, `create_node`, `update_styles`, `update_node`, `set_text_content`, `rename_nodes`, `duplicate_nodes`, `move_nodes`, `delete_nodes` |
| **Inspection & Selection (10)** | `get_guide`, `get_basic_info`, `get_selection`, `set_selection`, `get_tree_summary`, `get_children`, `get_node_info`, `find_nodes`, `get_computed_styles`, `get_screenshot` |
| **Fonts (3)** | `list_fonts`, `add_font`, `remove_font` |
| **History, Handoff & Export (4)** | `undo`, `redo`, `finish_working_on_nodes`, `get_jsx` |

---

## Architecture & HTTP Endpoints

| File | Role |
| --- | --- |
| [`server.js`](server.js) | Express 5 HTTP server, SSE event bus (`/events`), atomic JSON persistence, ZIP/HTML/JSX export, and `/mcp` Streamable HTTP transport |
| [`mcp-tools.js`](mcp-tools.js) | Zod schemas and handlers for all 37 MCP tools |
| [`mcp-stdio.js`](mcp-stdio.js) | Stdio ↔ Streamable HTTP relay |
| [`model.js`](model.js) | Node/project normalization, CSS & attribute validation |
| [`html-import.js`](html-import.js) | `parse5`-based HTML-to-canvas-node compiler for `write_html` |
| [`renderer.js`](renderer.js) | Direct WebSocket CDP client for `chrome-headless-shell` / Chromium |
| [`fonts.js`](fonts.js) | Local font storage (`WOFF2`/`WOFF`/`TTF`/`OTF`), Google Fonts, and `/fonts.css` |
| [`public/index.html`](public/index.html) | Browser canvas UI |

Key HTTP endpoints served alongside the UI:

- `POST /mcp` — Streamable HTTP JSON-RPC 2.0 MCP endpoint (`GET`/`DELETE` return `405`)
- `GET /events` — Server-Sent Events stream (`state`, `projects`, `selection`, `presence`, `fonts`)
- `GET /api/projects` / `POST /api/projects` — Workspace project lifecycle (`:id/open`, `:id/preview`, `:id/duplicate`)
- `GET /api/state` / `POST /api/state` — Active project snapshot, node CRUD (`/api/nodes`), pages (`/api/pages`), `/api/undo`, `/api/redo`
- `GET /api/export` & `GET /api/export/zip` — Single-node HTML/JSX and full-project ZIP bundle
- `GET /api/fonts` & `GET /fonts.css` — Font library and stylesheet
- `GET /render/:id` — Clean DOM target rendered by headless Chromium

---

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` (`0.0.0.0` in container) | Bind address |
| `PORT` | `3000` | HTTP server port |
| `DATA_DIR` | `./data` (`/app/data` in container) | Directory for `workspace.json`, `projects/*.json`, and `fonts/` |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Canonical URL reported by `get_basic_info` |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Comma-separated extra allowed `Host` / `Origin` hostnames (e.g. `host.docker.internal`) |
| `CHROME_PATH` | Auto-detected | Path to Chromium / `chrome-headless-shell` binary |
| `CHROME_FLAGS` | *(empty locally; `--no-sandbox --disable-dev-shm-usage --disable-gpu` in container)* | Space-separated flags passed to Chromium |
| `PAPER_LITE_URL` | `http://localhost:3000/mcp` | Target MCP URL used by `mcp-stdio.js` |

---

## Development, Testing & CI

```bash
# Syntax, CSS/DOM invariants, and ESLint v9 check
npm run lint

# Unit, MCP/HTTP integration, and browser E2E tests (15 tests)
npm test
```

The GitHub Actions workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs:
1. `npm audit --omit=dev --audit-level=high`, `npm run lint`, and `npm test` on Node 22 with headless Chromium.
2. Production container build, runtime MCP `get_screenshot` smoke test, and **Trivy** scans (`fs`, `config` on `Dockerfile`, and `image` vulnerability scan).

---

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
