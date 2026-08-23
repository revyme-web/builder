# Revyme - Architecture & Contribution Guide

Written for AI coding agents, and equally useful as a human orientation doc. Read this before
your first change; it explains the shape of the system and the rules that hold everywhere.

Roughly 1,100 source files and 500 test files. You will not read them all - but almost
everything follows the one loop described below, so understanding it once generalises.

---

## What Revyme is

A visual website builder whose document format is **real Next.js/React source code**. There is
no scene graph, no proprietary save file. When you drag a box on the canvas, the app rewrites
the project's `.tsx` file; when the file changes, the canvas re-renders from it.

That single decision explains most of the architecture. The source is the truth, so every
feature has to survive a round trip: something must be able to *write* it into JSX, *parse* it
back out, and *render* it faithfully - three times, in three different places.

---

## The core loop

Everything is one cycle. Learn it and the codebase stops being surprising.

```
                 ┌──────────────────────────────────────────┐
                 │   ProjectFS - the project's .tsx files   │
                 └──────────────────────────────────────────┘
                        │                          ▲
              parse     │                          │  generate
    code/parsing/       ▼                          │  code/generation/
              ┌───────────────────┐        ┌──────────────────────┐
              │  CanvasNode tree  │        │   mutation queue     │
              │  (id → node map)  │        │  code/mutation/      │
              └───────────────────┘        └──────────────────────┘
                        │                          ▲
               render   │                          │  queueMutation()
      canvas/Renderer   ▼                          │
              ┌──────────────────────────────────────────────┐
              │   canvas iframe - real DOM, real CSS         │
              │   editor/ panels read + write through it     │
              └──────────────────────────────────────────────┘
```

**Read path.** `code/parsing/parser.ts` walks the JSX with Babel and produces a flat
`Map<id, CanvasNode>`. `canvas/Renderer.ts` turns that into DOM inside a sandboxed iframe.
Nodes are identified by a `data-id` attribute that lives in the user's source.

**Write path.** UI never edits the DOM as the source of truth. It calls
`queueMutation({ type, nodeId, … })`; the queue batches, then runs a **generator** - a pure
`(code, …args) => code` string/AST transform in `code/generation/` - and writes the result back
to ProjectFS. The file change re-triggers the read path.

**The rule that follows:** if you find yourself mutating canvas DOM to make a feature work, you
are working against the grain. Write the code change; let the loop render it.

---

## The subsystems

| Area | Files | Owns |
|---|---|---|
| `src/editor/` | 363 | Every panel, tool and control in the UI chrome |
| `src/code/` | 286 | Parse, generate, mutate, and validate source code |
| `src/canvas/` | 228 | Rendering, selection, drag, resize, the iframe bridge |
| `src/shared/` | 45 | Pure utilities usable from any bundle |
| `src/plugins/` | 38 | Third-party plugin SDK + sandboxed host |
| `src/canvas-sandbox/` | 28 | The code that runs *inside* the canvas iframe |
| `src/ai/` | 17 | AI page/component agents and the MCP server bridge |

Within `src/code/`, the parts you will touch most:

- **`generation/`** (57) - one module per feature area, all pure `(code) => code`
- **`project/`** (92) - ProjectFS, pages, CMS, templates, deployment metadata
- **`stores/`** (37) - Jotai atoms; cross-layer UI state
- **`oracle/`** (16) - the rule engine that gates AI-written files (see below)
- **`parsing/`** (14) - JSX → `CanvasNode`

Within `src/canvas/`: `drag/` (87) and `selection/` (35) are the two heavyweights.

---

## Five invariants

These hold across the whole codebase. Breaking one produces bugs that look like something else
entirely, which is why they are worth memorising.

### 1. The canvas is an iframe - never touch its DOM directly

Canvas content renders in a sandboxed iframe. The parent frame must not call
`getBoundingClientRect()` or `getComputedStyle()` on canvas elements. Go through the bridge:

```ts
findNodeRect(nodeId, vpId)              // reads from a synced rect cache
findNodeComputedStyle(nodeId, vpId, p)  // reads from a prefetched style cache
patchNodeStyles(contentEl, nodeId, vpPrefix, styles)
```

`canvas/node-ops.ts` is the front door; `canvas/canvas-bridge.ts` is the transport. The caches
(`rectCache`, `computedCache`, `cornersCache`) exist so drag and resize can run at 60fps without
a round trip per frame.

### 2. Never write ProjectFS directly

`modifyProjectFile(path, code => next)` flushes pending mutations, reads fresh, writes, re-syncs.
A raw `readFile → modify → writeFile` silently discards anything still queued. Read-only
`readFile` for parsing or display is fine.

### 3. Empty string means *delete this property*

Passing `''` as a style value removes the property everywhere - generator, node cache and DOM.
`{ border: '1px solid red', borderTopWidth: '' }` means "set border, remove borderTopWidth".
This is load-bearing; several systems rely on it to clear inherited values.

### 4. One node, many viewports

A page renders once per breakpoint. Responsive overrides live as `@media` rules in the source and
are transformed to `@container` at canvas render time. Most write paths therefore need to know
*which* viewport they are writing for - that is what the `vpId` / `vpPrefix` arguments are.

### 5. Anything the published site needs lives in `@revyme/runtime`

Codegen does not run at publish time; the user's `.tsx` ships verbatim. So a feature that must
*do* something in the browser (cursors, split-text animations, responsive props) ships as a
component in the separate `@revyme/runtime` npm package, and the generator emits an import for
it. Adding an export there has a checklist - see the package's own README.

---

## The oracle

`src/code/oracle/` gates every file written by an AI agent or the MCP server before it reaches
the project. Each rule encodes something the builder cannot resolve: an element without a
`data-id`, a computed text expression the text tool can't edit, an animation shape the panel
can't read back.

Rules are tiered - tier 3 blocks (the file would crash or fail to parse), tiers 1-2 are
correctness and dialect violations. When you add a codegen feature, ask whether a *hand-written*
version of it could be malformed; if so, it needs a rule, or AI-authored pages will drift from
what the editor can edit.

---

## Contributing rules

**Tests.** Every module needs tests. `npx vitest run`. Note that vitest does not typecheck -
`npx tsc --noEmit` catches a whole class of error the suite structurally cannot.

**Debug traces.** Every file includes `trace.action` / `trace.fn` / `trace.dom` / `trace.error`
for significant operations - state changes, DOM updates, lifecycle events, atom updates. Add
traces; do not remove them. Diagnosing a canvas bug usually means reading a trace, not a stack.

**Don't reinvent shared helpers.** Before writing a utility, grep `src/shared/` and
`src/canvas/node-ops.ts`. Common ones: `css-utils` (camelCase↔kebab, style parsing),
`position-utils` (pin/inset conversion, px resolution), `flex-helpers`, `gradient-utils`,
`id-utils` (`generateNodeId`), `ast-utils` (`parseJSX`, `findFirstElementByDataId`). In the UI:
`ControlActionRow`, `RemoveButton`, `ColorSwatch`, `ToolPopup`, `Modal`.

**Match the file you are in.** Comment density, naming and idiom vary by area; follow the
surrounding code rather than importing a house style.

---

## Where to start reading

| To understand… | Read |
|---|---|
| how source becomes a canvas | `code/parsing/parser.ts` → `canvas/Renderer.ts` |
| how an edit becomes source | `code/mutation/mutation-queue.ts` → any `code/generation/generator-*.ts` |
| how a panel writes a style | `editor/controls/ControlProvider.tsx` |
| how the iframe boundary works | `canvas/canvas-bridge.ts` + `canvas-sandbox/protocol.ts` |
| how AI output is validated | `code/oracle/check-file.ts` |

The most instructive single file is `code/generation/generator-crud.ts` - it is the smallest
complete example of the write path, and every other generator follows its shape.
