# VENDOR — external code vendored into recon-graph

## Policy
- Engine files (`graph-view.js`, `shims.js`, `sim.js`, `pixi.min.js`) are byte-for-byte copies of their `/home/erema/obsidian-graph` originals. sha256 must match. Never reformat, never "improve".
- Exactly one engine edit is permitted in the whole project: appending `Renderer.prototype.setEmphasis = function (ids) { ... }` to `web/vendor/graph-view.js` (spec §6.2), applied at stage 8. Original hash, patched hash and the exact anchor line are recorded under **Applied edits**. Future edits need a new entry (and are not permitted by this policy).
- `graph.css` is verbatim (Obsidian palette + graph colour rules).
- `panel.css` is a fork of the Obsidian settings panel. It is NOT vendored at stage 0; it is imported and forked at stage 9.

## Vendored files
| file | source | source sha256 | original vendored sha256 | original bytes | patched sha256 | patched bytes | mode |
|------|--------|---------------|--------------------------|----------------|----------------|---------------|------|
| `web/vendor/graph-view.js` | `/home/erema/obsidian-graph/src/graph-view.js` | `53f22b6a827f7bdd503efdefd1b06ea03a5d2298d733a4d94624aa113315b51f` | `53f22b6a827f7bdd503efdefd1b06ea03a5d2298d733a4d94624aa113315b51f` | 49819 | `7aae1bab53f0c75ad785f537d6afb17f33dd68ebe279fe1229648ed34a3b84d7` | 51836 | verbatim + append-only setEmphasis (approved edit) |
| `web/vendor/shims.js` | `/home/erema/obsidian-graph/src/shims.js` | `8064f536183d6122c6febde2a63d1d7beebdeaf0cf8b4356b42c2ab58fa746dc` | `8064f536183d6122c6febde2a63d1d7beebdeaf0cf8b4356b42c2ab58fa746dc` | 19916 | — | — | verbatim |
| `web/vendor/sim.js` | `/home/erema/obsidian-graph/sim.js` | `549be2f69710af360d521c92b80c83718f673594d3dc2255a65e251199eee25d` | `549be2f69710af360d521c92b80c83718f673594d3dc2255a65e251199eee25d` | 17693 | — | — | verbatim |
| `web/vendor/pixi.min.js` | `/home/erema/obsidian-graph/lib/pixi.min.js` | `842814b22c348dcdab381ffb79da3763ff0672271f60f09dababa52656fd31b8` | `842814b22c348dcdab381ffb79da3763ff0672271f60f09dababa52656fd31b8` | 487134 | — | — | verbatim |
| `web/vendor/graph.css` | `/home/erema/obsidian-graph/css/graph.css` | `3ea9502e219d2a396cfba69a92073b80a9264f194517b7f6ed5be516a48f62d3` | `3ea9502e219d2a396cfba69a92073b80a9264f194517b7f6ed5be516a48f62d3` | 5536 | — | — | verbatim |

## Forks
Forked files are **not** verbatim. They derive from Obsidian-side sources but are rewritten for the recon-graph page: selectors are namespaced, recon-only rows are added, Obsidian-only controls are dropped. They are not engine files and are not covered by the verbatim-hash policy.

| file | source | sha256 (source) | mode | what changed |
|------|--------|-----------------|------|--------------|
| `web/panel.css` | `/home/erema/obsidian-graph/src/clean/panel.css` | `9c8b0f9aa90dd16095e455dd5112bedb9ba6a62357262dbdde2cadea30b5e087` | fork | palette + control styling kept; selectors namespaced under `#panel`; recon filter rows added |
| `web/panel.js` | settings panel in `/home/erema/obsidian-graph/index.html` (`GraphSettings`) | n/a (page code, not a standalone file) | fork (reimplementation) | Display/Forces/Groups kept; Filters section added (types/status/origin); no Obsidian-only controls |

Notes:
- `web/panel.js` is a **reimplementation** of page-level settings code (`GraphSettings.createPanel` and its state helpers live inline in the reference `index.html`), not a byte copy — there is no standalone source file to hash.
- Engine files (`graph-view.js`, `shims.js`, `sim.js`, `pixi.min.js`, `graph.css`) remain untouched apart from the single `setEmphasis` append already documented under **Applied edits**.

## Applied edits
- **File**: `web/vendor/graph-view.js` — the only permitted engine edit.
- **Spec**: §6.2 (`setEmphasis`), §9 row 8.
- **Date**: 2026-11-02.
- **Edit kind**: **append-only**. The original 49819 bytes are byte-identical to the source (`cmp` reports only `EOF on source after byte 49819`; `diff -u` emits 0 `-` lines). The original line 159 is untouched; the earlier in-place `Node.prototype.render` hook has been removed.
- **Appended hunk**: lines 848–903 (one blank separator line at 847, then a 56-line IIFE). `diff -u` hunk header: `@@ -844,3 +844,60 @@` — 0 removed lines, 57 added lines in diff terms (blank + 56).
- **Appended function**: an IIFE that (a) saves `Node.prototype.render` and replaces it with a wrapper which calls the original first, then applies emphasis (matching nodes: `circle.tint = colors.fillHighlight.rgb`, `circle.alpha = colors.fillHighlight.a`; non-matching: `circle.alpha *= 0.25` and `text.alpha *= 0.25`), and (b) defines `Renderer.prototype.setEmphasis` / `Renderer.prototype.clearEmphasis`, each ending with `queueRender()`.
- **Behavioural equivalence**: with `_emphasisIds` unset the wrapper delegates unchanged (no branch taken); the engine render body itself is original source.
- **Original hash**: `53f22b6a827f7bdd503efdefd1b06ea03a5d2298d733a4d94624aa113315b51f` (49819 bytes).
- **Patched hash**: `7aae1bab53f0c75ad785f537d6afb17f33dd68ebe279fe1229648ed34a3b84d7` (51836 bytes).
- **Justification**: highlight search matches without changing engine bytes. Earlier stage-8 revision modified line 159; the repair restores the prefix and proves append-only with `diff -u | grep -c '^-[^-]'` = 0.

## Page-level code (not engine)
`web/index.html` reproduces the reference page's guard for the PIXI/shim `Tl` global collision. That is page code, not engine code, and is not vendored.

## Verify
```bash
cd /home/erema/recon-graph
sha256sum web/vendor/graph-view.js  /home/erema/obsidian-graph/src/graph-view.js
sha256sum web/vendor/shims.js       /home/erema/obsidian-graph/src/shims.js
sha256sum web/vendor/sim.js         /home/erema/obsidian-graph/sim.js
sha256sum web/vendor/pixi.min.js    /home/erema/obsidian-graph/lib/pixi.min.js
sha256sum web/vendor/graph.css      /home/erema/obsidian-graph/css/graph.css
```
