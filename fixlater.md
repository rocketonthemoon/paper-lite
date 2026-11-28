# Fix later

Issues found while exercising the MCP tools that are still open, with the reason. Fixed items are removed; see the PRs
for what changed.

## Can't be fixed in a sandbox without network

### `add_font` accepts any Google Fonts family name
- **What happens:** `add_font({ family: "Definitely Not A Font 123" })` succeeds and the family is added to the library.
  Layers using it fall back to the system font.
- **Why it's still open:** checking the name needs a request to Google Fonts, and the test environment has no network.
  Today the mistake only shows up later, as a `missingFonts` finding in `audit_artboard` / screenshot diagnostics.
- **Possible fix:** when the server has network access, fetch
  `https://fonts.googleapis.com/css2?family=<family>` in `fonts.addGoogle` and refuse the family on a 400. Keep
  accepting it, with a warning, when the request can't be made at all, so offline installs still work.

## Maintenance

### `shared/css-properties.js` needs regenerating after a Chrome upgrade
- **What happens:** the list behind the "isn't a CSS property" hint is a snapshot of one Chrome version.
- **Impact:** a property a later Chrome adds would get a false hint until the list is regenerated.
- **To do:** run `npm run gen:css-properties` after upgrading Chrome and commit the result.
