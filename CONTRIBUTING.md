# Contributing to Revyme

Thanks for your interest in improving Revyme! This document covers the ground rules
and the review checklist every change should pass.

## Getting set up

```bash
npm ci
npm run dev     # starts three Vite dev servers:
                #   :3333 editor · :5174 canvas sandbox · :5175 preview sandbox
```

Open http://localhost:3333. The canvas renders inside a sandboxed iframe served
from :5174 — all three servers need to be running for the editor to work.

## Before you open a PR

Every PR must pass the same gates CI runs:

```bash
npx tsc --noEmit    # 0 errors
npx vitest run      # 0 failures
npm run build && npm run build:sandbox && npm run build:preview
```

For changes that touch the canvas (drag, resize, selection, rendering), also run
the Playwright suite against the dev servers:

```bash
VITE_REVYME_CLOUD= npx playwright test
```

> The env var must be **empty**, not `'false'` — `'false'` is a truthy string and
> flips the app into cloud mode.

New modules need tests. Changed behavior needs its tests updated — never weaken an
assertion to force green.

`npm run lint` must report **0 errors** (it gates dead imports and real
mistakes; `any`-typing and hook-dependency notes surface as advisory
warnings — don't add new ones without reason).

## Architecture ground rules

The full architecture reference lives in [CLAUDE.md](./CLAUDE.md). The rules that
catch most review comments:

1. **The JSX source is the document.** Every edit ultimately lands in the page's
   JSX via the mutation queue (`queueMutation` → generator functions). Never
   mutate state that the parser can't round-trip.
2. **All canvas DOM access goes through the bridge.** The canvas lives in a
   cross-origin iframe. Use `findNodeRect()`, `findNodeComputedStyle()`,
   `patchNodeStyles()` and friends from `src/canvas/node-ops.ts` — never
   `document.querySelector` or `getBoundingClientRect` for canvas elements from
   the parent frame.
3. **Read-modify-write goes through `modifyProjectFile()`.** Raw
   `projectFS.readFile → transform → writeFile` silently drops pending mutation
   queue changes.
4. **Use the shared helpers.** Before writing a utility, grep for it. The big
   ones: `css-utils` (kebab/camel, style parsing), `canvas-math` (coordinate
   spaces), `ast-utils` (JSX AST), `dom-utils` (drag listeners, element
   creation), `generator-utils` (codegen string surgery), `regex-utils`
   (`escapeRegExp`), `id-utils` (`nodeIdToVarName`).
5. **Empty string means "remove this property"** across the whole style
   pipeline (generator, node cache, DOM application).
6. **Multi-select:** write to `selectedIdsAtom`; `selectedNodeAtom` is read-only
   derived. Operations iterate all selected ids.
7. **Control rows** in the properties panel and popups use the shared grid
   primitive (`ToolRow` / unified `ControlRow`,
   `grid-template-columns: var(--tool-label-col) minmax(0,1fr)`) — don't
   hand-roll `flex justify-between` rows.
8. **Debug traces stay.** `trace.action`/`trace.fn`/`trace.error` calls are the
   product's diagnostic system. Add traces to new code paths; never remove
   existing ones.
9. **Structural writes from a panel/control must force a render — the right way.**
   See ["Forcing a render after a structural write"](#forcing-a-render-after-a-structural-write)
   below. TL;DR: canvas-initiated writes call `markCanvasUpdate()` so the reactive
   re-render is *skipped* (a 60fps perf optimization — the DOM was already patched
   in place). A write that changes the JSX *structure* the in-place patch can't
   express (wrapping a node in `<AnimatePresence>`, adding/removing a tag, a
   reparent) therefore never repaints until the next unrelated render. Force it
   with `flushAndForceStructuralRender()` **at the caller, after the write** — never
   on every write.

## Forcing a render after a structural write

**The perf model.** The canvas renders inside a cross-origin iframe. Panel/control
edits (sliders, color, size) write through `updateNodeStyles`, which patches the DOM
element *in place* via the bridge and calls `markCanvasUpdate()`. That flag makes the
next mutation-queue flush **skip** the React re-render (`CanvasRenderer.render` bails
on `canvasUpdating`). This is deliberate: re-parsing the file and rebuilding the tree
on every slider tick would drop the canvas to single-digit fps on a big page and
remount every code component. The in-place patch already made the change visible, so
the rebuild is pure waste — skip it.

**The exception.** Some writes change the JSX *structure*, not just a property:

- `display:none` on a component node → `setVariantVisibility` wraps it in
  `<AnimatePresence>{cond && …}` (the visibility source of truth is `hiddenOnVariants`,
  not an inline `display`).
- a per-variant `display` ternary on a CMS `.map()` row.
- tag changes, reparents, wrap/unwrap.

The in-place DOM patch *cannot express* these (you can't patch a wrapper onto a live
element), so they only take effect on a full Renderer rebuild — which the skipped
reactive render never runs. Symptom: "I click the control, the code updates, but
nothing happens on the canvas until I switch pages." Force the rebuild:

```ts
import { flushAndForceStructuralRender } from '@/canvas/node-ops';

// AFTER the write helper has returned (all its mutations are queued):
flushAndForceStructuralRender();  // flushNow() → rAF(forceCanvasRender())
```

**Four rules that make it correct *and* fast:**

1. **Force at the caller, after the write returns — never mid-write.** The write helper
   often queues *more than one* mutation (a hide strips `display` **and** the following
   unhide queues a `display:''` clear). `flushNow()` mid-helper splits them into two
   flushes → two `setCode`s → **two undo steps**. Let the helper finish queuing, then
   flush once: one atomic commit = one history entry.
2. **Keep the `flushNow()` → `rAF(forceCanvasRender())` frame gap.** `flushNow` commits
   the code *this* tick; `nodesAtom` re-parses, but the imperative `forceCanvasRender`
   reads a render pipeline that hasn't settled the commit yet — a *same-tick* force
   no-ops and the DOM stays stale. Deferring the force one `rAF` is load-bearing, not
   cosmetic. (Both were collapsed into one tick once — that was the regression.)
3. **Don't force on ordinary writes.** Gate tightly on "did this write actually become
   structural?" e.g. `property === 'display' && activeComponentVariant && value is
   none/''`. A page-file `display` write patches the DOM live and must **not** trigger a
   full rebuild.
4. **One helper, every caller.** `flushAndForceStructuralRender()` (node-ops) is shared
   by the Styles Hide control (ControlProvider) and the Layers eye (LayersPanel). Don't
   re-inline `flushNow` + `rAF(forceCanvasRender)`, and don't try to centralize the force
   *inside* `updateNodeStyles` — that broke atomicity (rule 1) and the frame gap (rule 2).

## Review checklist for your own change

- Did you use the shared helper instead of re-rolling a pattern? (`grep` first.)
- New mutation type → is the `Mutation` union updated, `applyMutation` handling
  it, and the generator function tested?
- New node property → does the parser extract it, the generator emit it, and the
  node cache carry it?
- Does the feature work on every viewport (primary + replicas) and inside
  component masters (variants)?
- Does undo/redo round-trip it? (One user action = one history entry.)
- Do the tests you added fail if your fix is reverted?

## Line endings

The repository is normalized to LF (see `.gitattributes`). Don't commit CRLF.

## License and contribution terms

Revyme is licensed under the [GNU AGPL-3.0](./LICENSE) with the additional
notice-preservation term described in [NOTICE](./NOTICE). The project is
dual-licensed: the copyright holder also offers it under commercial terms
(see NOTICE), which requires keeping the licensing rights of the whole
codebase in one place.

By submitting a contribution (pull request, patch, or otherwise) you agree
that:

1. The contribution is your own original work, and you have the right to
   submit it under these terms.
2. You grant Nikita Kofman a perpetual, worldwide, non-exclusive,
   royalty-free, irrevocable copyright license to use, reproduce, modify,
   distribute, sublicense, and relicense your contribution as part of this
   project — including under license terms other than the AGPL. This is
   what keeps the project's dual licensing possible.
3. Your contribution is made available to everyone else as part of the
   project under the AGPL-3.0, like the rest of the codebase.

If you're contributing on behalf of an employer, make sure you're
authorized to agree to the above. Substantial contributions may require
signing a standalone contributor license agreement — we'll ask in the PR
if so.
