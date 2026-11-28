# Fix later

Issues found while exercising the MCP tools (rounds behind #51–#53) that were left unfixed, with the reason.

## Can't be fixed in a sandbox without network

### `add_font` accepts any Google Fonts family name
- **What happens:** `add_font({ family: "Definitely Not A Font 123" })` succeeds and the family is added to the library.
  Layers using it fall back to the system font.
- **Why it's still open:** checking the name needs a request to Google Fonts, and the test environment has no network.
  Today the mistake only shows up later, as a `missingFonts` finding in `audit_artboard` / screenshot diagnostics.
- **Possible fix:** when the server has network access, fetch
  `https://fonts.googleapis.com/css2?family=<family>` in `fonts.addGoogle` and refuse the family on a 400. Keep
  accepting it, with a warning, when the request can't be made at all, so offline installs still work.

## Product decisions

### Replying to a resolved comment reopens it
- **What happens:** `reply_to_comment` on a resolved thread sets its status to `replied`, so it shows as open again.
- **Why it's still open:** this is probably intended, so the user sees the new reply. It's a judgment call.
- **Options:** keep the current behaviour, keep the thread resolved and only add the message, or refuse with a hint
  to reopen first.

### A layer moved onto a page becomes an artboard without artboard defaults
- **What happens:** `move_nodes` to a page root now places the layer at a free spot (fixed in #51). It still doesn't
  get the white background and `overflow: hidden` that new artboards get.
- **Why it's still open:** adding them would change how the moved layer looks, for example a transparent text layer
  would gain a white box.
- **Options:** add the defaults only when the layer has no background of its own, or leave it as is.

## Noticed, not yet looked into

### `update_nodes_matching` lists node ids in id order
- **What happens:** `nodeIds` in the result comes back sorted by id, not in document order, unlike `find_nodes` since
  #52.
- **Impact:** cosmetic. When the list is capped at 50, the ids shown aren't the first 50 layers on the page.

### Duplicating a layer inside a component instance
- **What happens:** `duplicate_nodes` on a layer inside an instance (not the instance root) gives the copy the same
  `componentKey` and `componentRootId` as the original.
- **Possible impact:** two layers in one instance then claim the same slot key, and the next `update_component` may
  rebuild or drop one of them. Needs a test to confirm. A likely fix is to detach the copy from the component, or give
  it a fresh key.

### `shared/css-properties.js` goes stale
- **What happens:** the list of CSS properties behind the "isn't a CSS property" hint (#52) was generated once from
  Chromium.
- **Impact:** a property Chrome adds later would get a false hint.
- **Possible fix:** a small script (for example `scripts/gen-css-properties.mjs`) that regenerates the list with the
  pre-installed Playwright, run when the browser is upgraded.
