# Bugs Found During Testing & Live MCP Usage (`weft` / `paper-lite`)

Observed after merging PRs `#32`–`#38` into `main` (`cff4bd3`), across both the automated test suite (`npm test`) and live MCP design workflows (`Netflix — Director's Cut`, `Weft — Logo Design`).

## Status (2026-11-28)

All six are fixed in the working tree (not committed yet). `npm test`: 136 / 136 pass on Windows (was 123 / 126). `npm run lint` passes. Not yet run on Linux.

| # | Status | Fix |
|---|--------|-----|
| 1 | Fixed | `server/components.js` expands `<icon>` in `create_component`, `update_component({ html })` and `({ appendHtml })` |
| 2 | Fixed | `server/design-tokens.js`: suggestions only from the property's token category; `lint: false` silences all suggestions (undefined `var()` still reported) |
| 3 | Fixed | `server/index.js`: graceful `shutdown()` awaits pending checkpoint commits + writes; IPC `"shutdown"` message; `test/helpers.js` uses it for `stop("SIGTERM")` |
| 4 | Fixed | `server/model.js` `mergeAttrs`: `title`, `role`, `aria-*`, `tabindex` (-999…999), `type` on `<button>`, `target` / `rel` on `<a>`, all value-checked (`title` / `aria-*`: plain text, no `< >`, max 200 chars). `server/html-import.js`: `aria-label` stays an attribute and also names the layer (markup stripped from the name) when there's no `data-name`; dropped `on*` handlers now warn. JSX export writes `tabIndex`; the canvas keeps layers unfocusable |
| 5 | Already fixed | Regression tests in `test/tools-coverage.test.js` over the HTTP transport and the stdio relay (`server/mcp-stdio.js`) |
| 6 | Fixed | History panel shows dates for older steps; persistent `<id>.history.jsonl` edit log; `GET /api/history/search?nodeId=&after=&before=&source=&limit=`; README explains undo history vs. edit log (audit only) vs. checkpoints (restore) |

---

## 1. `<icon name="..." />` is not expanded in `create_component` or `update_component`
- **Severity**: Medium
- **Where**:
  - `components.js:431-435` (`createComponent` with `html`)
  - `components.js:487-490` (`updateComponent` with `html`)
  - `components.js:511-520` (`updateComponent` with `appendHtml`)
  - Compare with `server.js:1892` (`writeHtml`), which calls `expandIconSpecs(rawSpecs, state.icons, warnings)`
- **Observed**:
  Calling `register_icons` followed by `create_component({ name: "feature-card", html: '...<icon name="shield-check" />...' })` produces:
  - Warning: `icon: Tag "icon" is not allowed; using div`
  - Result: The component tree stores a `<div>` named `icon` instead of the registered SVG subtree.
- **Root Cause**: `createComponentEngine` does not receive or call `expandIconSpecs` before passing `htmlToSpecs` output to `specToComponentTree`.
- **Suggested Fix**: Pass `expandIconSpecs` (and `getIcons`) into `createComponentEngine`, and call `expandIconSpecs(parsed.specs, getState().icons, warnings)` in `createComponent`, `updateComponent({ html })`, and `updateComponent({ appendHtml })`.

---

## 2. Design linter emits cross-category token false positives & ignores `lint: false` on exact value matches
- **Severity**: Medium
- **Where**: `design-tokens.js:314-336` (`analyzeDesignLint`)
- **Observed**:
  1. **Cross-category value collisions**: Because `byValue` and `byNormPx` index all `:root` variables regardless of token category, unrelated tokens are suggested across CSS properties during `write_html` / `update_styles`:
     - `fontSize: "18px"` suggests `var(--radius-lg)` (`18px`)
     - `gap: "12px"` suggests `var(--radius-md)` / `var(--fs-xs)` (`12px`)
     - `fontSize: "12px"` suggests `var(--space-3)` / `var(--radius-md)` (`12px`)
     - `padding: "16px"` suggests `var(--fs-md)` (`16px`)
  2. **`lint: false` still emits exact-match warnings**: Passing `write_html({ ..., lint: false })` still emits `rootCss` variable duplication warnings because step 2 (`byValue.get(...)`) runs before `if (!lint) continue;` (`design-tokens.js:315-321`). Even when intended to preserve legacy exact-match nudges, callers passing `lint: false` explicitly expect lint hints suppressed (and cross-category suggestions like `fontSize` → `--radius-lg` are always noise).
- **Suggested Fix**:
  - Restrict dimension/color matches in `byValue` and `byNormPx` to variables whose `classifyVar(k, rawV)` category matches `propCategory(k)` (or is uncategorized).
  - Either move `if (!lint) continue;` above step 2 or clarify/separate `lint` from unknown-`var(--...)` errors.

---

## 3. Windows `SIGTERM` kills child server immediately without flushing writes (3 failing tests in `npm test`)
- **Severity**: Medium (Windows compatibility)
- **Where**:
  - `server.js:3324` (`for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { flushWrites(); ... })`)
  - `test/helpers.js:39-43` (`stop(signal = "SIGKILL")` calls `child.kill("SIGTERM")`)
  - Failing tests on Windows:
    - `test/checkpoints.test.js:13` (`checkpoints are git commits that survive restarts and restore exactly`)
    - `test/checkpoints.test.js:62` (`old JSON checkpoint files migrate into git once`)
    - `test/history.test.js:77` (`throttled saves reach disk, and pending saves are flushed on shutdown`)
- **Observed**:
  Running `npm test` on Windows passes `123 / 126` active tests (`2` Blitz tests skipped), failing exclusively on the 3 tests that call `await srv.stop("SIGTERM")`.
- **Root Cause**: On Windows, `child.kill("SIGTERM")` terminates the child process immediately via `TerminateProcess` without running Node.js `SIGTERM` event handlers, so `flushWrites()` never executes before exit.
- **Suggested Fix**: Add a graceful shutdown hook usable cross-platform (e.g. an optional test-only or localhost `/api/shutdown` endpoint, or closing an IPC channel via `stdio: [..., "ipc"]` on Windows) and use it from `srv.stop("SIGTERM")` on `process.platform === "win32"`.

---

## 4. `update_nodes_matching` / `mergeAttrs` rejects common safe HTML attributes (`type`, `aria-*`, `role`)
- **Severity**: Low
- **Where**: `model.js:76` (`mergeAttrs`)
- **Observed**:
  Calling `update_nodes_matching({ artboardIds: ["b813fc19"], tag: "button", attrs: { type: "button" } })` fails with `Attribute "type" is not supported`.
- **Root Cause**: `mergeAttrs` whitelists only `["src", "href", "alt"]` for all non-SVG HTML elements.
- **Suggested Fix**: Consider safely allowing `type` (`"button" | "submit" | "reset"` on `<button>`), `role`, and `aria-*` / `target` / `rel` (with strict value validation) so accessibility and button semantics round-trip cleanly.

---

## 5. MCP `write_html`, `register_icons`, and other string-param tools fail when the string value contains quote characters
- **Severity**: High
- **Where**: MCP server transport layer — affects all tools that accept a `string` parameter whose value contains `"` or `'` characters:
  - `write_html` (`html` param)
  - `register_icons` (`svg` param)
  - `update_root_css` (`css` param)
  - Any tool whose string arg contains HTML/SVG attribute syntax (e.g. `stroke-width="4"`, `viewBox="0 0 48 48"`)
- **Observed**:
  Calling `write_html({ parentId, html: '<svg viewBox="0 0 48 48">...</svg>' })` returns:
  ```
  Invalid input: expected record, received string
  ```
  at `params.arguments`. The same call with plain text (`html: "<p>hello</p>"`) succeeds. The failure threshold correlates exactly with the presence of quoted SVG/HTML attributes inside the string value.
  - Reproduced consistently during the `Weft — Logo Design` session (project `fdaa6b4a`), across `write_html`, `register_icons`, and `update_root_css({ css: "..." })`.
  - `update_root_css({ vars: {...} })` and `update_root_css({ classes: {...} })` (object params) are unaffected.
- **Root Cause** (suspected): The MCP JSON argument deserializer double-decodes string values that contain `"` — interpreting a JSON-encoded string whose content itself looks like a JSON object/value as the object directly, rather than as a raw string. This is consistent with a missing or double-applied `JSON.parse` step in the argument schema validator for `string`-typed fields.
- **Suggested Fix**: Audit the MCP tool argument deserialization pipeline (the step that converts the raw `arguments` object from the MCP transport into Zod-validated inputs). Ensure `string`-typed fields are **not** JSON-parsed a second time — they should be accepted as-is if `typeof value === "string"`, regardless of whether the string content looks like a JSON value.

---

## 6. Undo history has no long-term timestamp record for "when did this change?"
- **Severity**: Low (UX gap, not a crash)
- **Where**:
  - `server.js:41` (`const HISTORY_LIMIT = 60`)
  - `server.js:383` (`historyTimeline = []` on project switch)
  - `ui/src/editor/core.js:18` (`clock` formats ISO timestamps as `HH:MM` only — no date)
- **Observed**:
  The Undo History panel shows each edit step with a time-of-day clock (`HH:MM`), but:
  1. The timeline is **capped at 60 steps** and **reset on every project switch or server restart** — there is no persistent edit log. If a user wants to know "when did this layer change to X?", the answer only exists if that change is within the last 60 steps of the current session.
  2. The `clock()` helper formats timestamps as `HH:MM` with no date, so older steps from the same day are indistinguishable from steps that happened earlier in the same minute.
  3. There is **no server-side query** to find which history step touched a given layer by node ID or time range.
- **Root Cause**: The undo history is intentionally in-memory and ephemeral (by design — it only tracks the current session for Ctrl+Z/Redo purposes). Git checkpoints are the intended long-term record, but they only exist when explicitly saved (manually or by auto agent-start logic) — not for every individual edit step.
- **Impact**: Users who want to audit "my design changed between Tuesday and Wednesday" have no granular mechanism unless they saved named checkpoints at those points in time. The only automatic protection is the `"Before agent run"` auto-checkpoint.
- **Suggested Fix**: Consider one or more of:
  - Persisting the last N history entries (with timestamps and layer IDs touched) to disk alongside the project file, surviving restarts.
  - Adding a `date` to `clock()` output when the timestamp is not today.
  - Exposing a lightweight `/api/history/search?nodeId=&after=&before=` endpoint that searches within the in-memory timeline.
