# MendixPrettifier (AutoPrettifier)

A Mendix Studio Pro extension that automatically arranges the shapes in a microflow or nanoflow into a clean, left-to-right grid layout — no more manually dragging activities into alignment.

## What it does

Adds an **"Auto-Format Active Microflow / Nanoflow"** command to the Studio Pro extensions menu. When run against an open microflow or nanoflow, it:

1. Reads the currently active document and its objects/flows from the App Model API.
2. Runs a layout algorithm (`src/main/layoutEngine.ts`) that:
   - Lays the happy path out left-to-right on a single row.
   - Respects the connection ports you actually drew — a flow leaving the bottom of a shape places its target directly below it; a flow leaving the top aligns both shapes in the same column; a flow leaving the right continues the row.
   - Falls back to "true" goes right / other branches go down for exclusive splits without explicit port information.
   - Detects loops (back edges) via DFS so looped activities don't distort the column order.
   - Resolves grid collisions so no two shapes ever land on the same cell.
   - Sizes columns/rows based on the widest/tallest shape in them, with extra space reserved for activity captions.
3. Applies the computed coordinates back to the document (`src/main/transaction.ts`), resetting any existing Bezier/orthogonal line geometry so old curves and bends don't linger after shapes move.
4. Saves the updated document in Studio Pro. You still need to press **Ctrl+S** to persist the changes to disk.

## Requirements

- Mendix Studio Pro with Extensions API support.
- Node.js to build the extension from source.

## Building

```bash
npm install
npm run build       # one-off build
npm run build:dev    # build in watch mode
```

The build output is written to `dist/AutoPrettifier` and can be loaded into Studio Pro as a local extension.

## Usage

1. Open a microflow or nanoflow in Studio Pro.
2. Run **Auto-Format Active Microflow / Nanoflow** from the extensions menu.
3. Review the new layout, then press **Ctrl+S** to save.

## Known issue: Nanoflow support breaks Studio Pro's "new document" UI

⚠️ Adding nanoflow support to this extension causes a regression in Studio Pro itself: once the extension is loaded, the **"Create new microflow"** and **"Create new nanoflow"** dialogs/UI in Studio Pro break. This is not limited to documents this extension touches — it affects the general document-creation flow anywhere in Studio Pro while the extension is active.

Workaround: disable/unload the extension when you need to create new microflows or nanoflows, and re-enable it when you want to use the formatter.

This is under investigation — contributions and reports of the exact failure mode are welcome.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
