# Paper-Lite

A self-hosted HTML/CSS design canvas with a built-in MCP server. AI agents build designs out of real HTML and CSS while you watch, select, and edit them live in the browser.

**Website:** [paper-lite.netlify.app](https://paper-lite.netlify.app/)

## Features

- **Real HTML layers.** Artboards are plain DOM elements (`div`, `section`, `button`, `svg`, …) with camelCase inline CSS, not a proprietary vector format.
- **Live collaboration.** Agent edits, selections, and presence sync to the browser over SSE, with a shared 60-step undo/redo history.
- **Screenshots.** Headless Chrome renders artboards for `get_screenshot` and `get_computed_styles`.
- **Export.** Export to React JSX, standalone HTML, or a ZIP bundle.
- **Plain JSON storage.** Projects are saved as JSON files in `DATA_DIR`.
- **No build step.** The UI is a single vanilla HTML file.

## Quickstart

**Docker / Podman** (includes Node 22 and headless Chrome):

```bash
docker compose up -d --build    # or: podman compose up -d --build
```

**Node.js 20+:**

```bash
npm ci
npm start
```

Open [http://localhost:3000](http://localhost:3000). When running with Node, install Chrome, Chromium, or Edge for screenshots, or set `CHROME_PATH`.

## Connect an MCP client

Add this to your client config (Claude Code, Cursor, Windsurf, …):

```json
{
  "mcpServers": {
    "paper-lite": { "url": "http://localhost:3000/mcp" }
  }
}
```

If your client only supports stdio, start the server first, then use the relay:

```json
{
  "mcpServers": {
    "paper-lite": {
      "command": "node",
      "args": ["/absolute/path/to/paper-lite/mcp-stdio.js"],
      "env": { "PAPER_LITE_URL": "http://localhost:3000/mcp" }
    }
  }
}
```

## MCP tools (37)

| Category | Tools |
| --- | --- |
| Projects & pages | `list_projects`, `create_project`, `open_project`, `rename_project`, `duplicate_project`, `delete_project`, `create_page`, `switch_page`, `update_page`, `delete_page` |
| Authoring | `create_artboard`, `write_html`, `create_node`, `update_styles`, `update_node`, `set_text_content`, `rename_nodes`, `duplicate_nodes`, `move_nodes`, `delete_nodes` |
| Inspection & selection | `get_guide`, `get_basic_info`, `get_selection`, `set_selection`, `get_tree_summary`, `get_children`, `get_node_info`, `find_nodes`, `get_computed_styles`, `get_screenshot` |
| Fonts | `list_fonts`, `add_font`, `remove_font` |
| History & export | `undo`, `redo`, `finish_working_on_nodes`, `get_jsx` |

## Project structure

| File | Role |
| --- | --- |
| [`server.js`](server.js) | Express 5 server: REST API, SSE (`/events`), JSON persistence, export, and the `/mcp` endpoint |
| [`mcp-tools.js`](mcp-tools.js) | Zod schemas and handlers for all MCP tools |
| [`mcp-stdio.js`](mcp-stdio.js) | stdio ↔ HTTP relay for stdio-only clients |
| [`model.js`](model.js) | Project/node normalization, CSS and attribute validation |
| [`html-import.js`](html-import.js) | `parse5`-based HTML → node converter used by `write_html` |
| [`renderer.js`](renderer.js) | Chrome DevTools Protocol client for screenshots and computed styles |
| [`fonts.js`](fonts.js) | Uploaded fonts (WOFF2/WOFF/TTF/OTF), Google Fonts, and `/fonts.css` |
| [`public/index.html`](public/index.html) | Browser canvas UI |

## HTTP endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | MCP Streamable HTTP (JSON-RPC 2.0) |
| `GET /events` | SSE stream: `state`, `projects`, `selection`, `presence`, `fonts` |
| `/api/projects` | List/create projects; `:id/open`, `:id/preview`, `:id/duplicate` |
| `/api/state`, `/api/nodes`, `/api/pages` | Active project, node and page CRUD |
| `POST /api/undo`, `POST /api/redo` | History |
| `GET /api/export`, `GET /api/export/zip` | Node HTML/JSX export, full-project ZIP |
| `GET /api/fonts`, `GET /fonts.css` | Font library and stylesheet |
| `GET /render/:id` | Clean page that headless Chrome renders |

Requests are restricted by `Host`/`Origin` checks (see `ALLOWED_HOSTS`).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Stores `workspace.json`, `projects/*.json`, `fonts/` |
| `PUBLIC_URL` | `http://localhost:<PORT>` | URL reported by `get_basic_info` |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Extra allowed `Host`/`Origin` hostnames, comma-separated (e.g. `host.docker.internal`) |
| `CHROME_PATH` | auto-detected | Chrome/Chromium/`chrome-headless-shell` binary |
| `CHROME_FLAGS` | empty (`--no-sandbox --disable-dev-shm-usage --disable-gpu` in Docker) | Extra Chrome flags, space-separated |
| `PAPER_LITE_URL` | `http://localhost:3000/mcp` | Server URL used by `mcp-stdio.js` |

## Development

```bash
npm run lint   # syntax, CSS/DOM checks, ESLint
npm test       # unit, MCP tool coverage, integration, stdio relay, browser E2E
```

Browser tests need Chrome or Chromium installed and are skipped if none is found.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `npm audit`, lint, and tests on Node 22, then builds the Docker image, smoke-tests a screenshot over MCP, and runs Trivy scans.

## License

[Apache 2.0](LICENSE)
