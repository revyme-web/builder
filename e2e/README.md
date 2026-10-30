# E2E suite

Real Chromium driving the real editor: real mouse and keyboard on the canvas,
the real sandbox iframe, real ProjectFS commits. Each test checks what the
builder wrote, what the tiles paint, and that one undo restores the source.

```
e2e/
  fixtures/test.ts     test + expect (fixtures, matchers) — import from here
  fixtures/project.ts  project() seed builder, TILE/TILES
  helpers/editor.ts    Editor page object (extends src/canvas/drag/e2e/helpers/editor-page.ts)
  helpers/code.ts      Babel-backed source readers (parseSource, bandDecl, duplicateIds)
  specs/NN-area/       one folder per area of the test plan
```

## Running

```
npm run e2e                                  # everything (boots its own servers)
npx playwright test e2e/specs/02-dnd         # one area
npx playwright test --grep DND-014           # one test by ID
npx playwright test --grep @p0               # the smoke set
```

Playwright boots the editor on :4333 in LOCAL mode, the canvas sandbox on
:5174 and the preview on :5175, or reuses them when they are already up.
The editor's AI-service URL points at a dead port, so no test tab ever joins
the MCP bridge on :8082.

## Writing a test

```ts
import { test, expect, project, TILES, TILES_VIEWPORT } from '../../fixtures/test';

const SEED = project().page(`<div data-id="root" …>…</div>`).build();

test('DND-001 reorder a flex column child', { tag: ['@p0', '@dnd'] }, async ({ editor }) => {
  await editor.load(SEED);
  const before = await editor.code();
  await editor.dragNodeAsserted('features', await editor.at('hero', 0.5, 0.05));
  await expect(editor).toHaveStyle('features', 'order', '0');
  await expect(editor).toUndoInOneStep(before);
});
```

- **Title** starts with the catalog ID; tags carry priority (`@p0`/`@p1`/`@p2`), area (`@dnd`, `@cmp`, …) and needs (`@tiles`, `@preview`).
- **Fixtures run automatically**:
  - errors: an uncaught page error or an unlisted `console.error` fails the test (`editor.allowErrors(/…/)` for one you expect);
  - network: the bridge and AI hosts are blocked;
  - oracle: every `.tsx` file the test changed is run through the builder's oracle at teardown, and a violation that wasn't there after `load()` fails the test.
- **Matchers** poll (a commit can land in two flushes ~30ms apart) and honour `.not`:
  - `toHaveJsxOrder(parentId, ids, {path})`
  - `toHaveStyle(id, prop, value | null, {path})`, inline style in the source
  - `toHaveBandStyle(width, id, prop, value | null, {important, path})`, the `@media (max-width: Wpx)` band
  - `toUndoInOneStep(before, {path})`: one undo is byte-identical and one redo re-applies
  - `toHaveNoDuplicateIds({path})`
  - `toPassOracle()`
- **Editor reads**: `code(path?)` (default: the open file), `source()`, `childIds`, `parentOf`, `style`, `attr`, `bandStyle`, `exists`, `listFiles`, `snapshotFiles`, `activeFile`, `selection`, `oracle(path)`.
- **Editor actions**:
  - `load(seed, {fit})`, `settled()`, `undo()`, `redo()`, `click(id, {vpId, modifiers})`, `at(id, fx, fy, vpId?)`;
  - inherited from EditorPage: `dragNodeAsserted`, `duringDrag`, `dragFromTo`, `pumpDrag`, `nodeBox`, `nodeBoxIn`, `nodeIn`, `fitCamera`, `select`, `openFile`, `readFile`, `getRootChildrenVisualOrder`, `dragToolbarItemTo`.
- **Hooks** (`window.__e2e`, DEV only, see `src/ProjectLoader.tsx`): `settled`, `checkFile`, `activeFile`, `readFile`, `listFiles`, `select`, `selection`, `openFile`, `openOverlay`, `traceEntries`, `nodesSnapshot`, `addConnection`, ….

## Rules

1. **Real input for the behavior under test.** `__e2e.select`/`openFile` may set up state, but never perform the behavior being tested.
2. **Every drag proves it engaged:** use `dragNodeAsserted`/`duringDrag`, never a bare `dragFromTo` for the gesture under test.
3. **Check the source, then the tiles, then undo** (`toUndoInOneStep`).
4. **Regression tests name the failure:** assert the broken outcome is absent.
5. **No sleeps for commits:** poll with the matchers or `expect.poll`, or `await editor.settled()`.
6. **Fresh seed per test:** no test depends on another.
7. **Multi-tile seeds:** `test.use({ viewport: TILES_VIEWPORT })` (1720×1000) and `load(seed, { fit: true })`. At 1600px a replica can't be hit.
8. **Known product bugs:** keep the test asserting the right behavior and mark it `test.fail(true, 'BUG: …')`, so it turns red the day the bug is fixed. Never delete it or skip it silently.
9. **Selectors:**
   - `data-id` for canvas nodes; `nodeIn(vpId, id)` for a tile, which uses the prefixed `data-node-id`;
   - role and label for editor UI;
   - add a `data-testid` only where a control has no accessible name.

## Gotchas learned the hard way

- **Don't prime a drag on the primary tile.** `prime: true` clicks then presses 150 ms later, which reads as a double-click and the drag never starts. Prime only where it is needed: a drag that starts in a replica tile.
- **Replica tiles reuse the same `data-id`.** The tile identity is `data-node-id`: bare on the primary (`chip`), prefixed on replicas (`tablet-chip`). An unscoped `[data-id=…]` grabs whichever copy comes first.
- **Replicas boot off-camera and are culled** (no box at all). Fit the camera with `load(seed, { fit: true })` or `fitCamera()` first. Click inside the tile's clipped area: a child wider than the tile has its box center outside the clip.
- **A flow reorder writes inline `order`, not a JSX move.** A reorder on a replica tile writes `order: N !important` into that tile's band.
- **An insert into an ordered parent commits in two flushes** about 30 ms apart. Poll; don't read once.
- **A `height: auto` node with no children** is 0 px, and Playwright treats it as hidden.
- **Synthetic corner/edge-handle drags at low zoom often miss the resize handles.** Zoom in, or target the handle element.
- **A watched file change makes the dev servers push `full-reload` to every tab,** for example when a spec is saved while the suite runs. The fixture drops those frames. HMR for real module edits still passes, so never edit `src/` while tests run.
- **`pumpDrag` wiggles both axes.** A reorder reads the flow-axis delta as the drag direction, so wiggle the cross axis only (see `DragSession.pump({axis})` in `helpers/d1.ts`).
- **A same-parent flow reorder draws no drop line;** the placeholder hole is the indicator. Read `[data-placeholder-id]` in the sandbox (`placeholders()` in `helpers/d1.ts`).
- **Diagnose with traces:** `await page.evaluate(() => __e2e.traceEntries('drag'))` shows which strategy and write path a gesture took.
- **Component masters:** open with `editor.openFile('components/X.tsx')`; the tiles then become its variants. For the source dialect (variantConfig, `withResponsiveProps`, motion.*), see `COMPONENT_MASTER` in `src/canvas/drag/e2e/fixtures/seeds.ts` and the generators in `src/code/generation/`.
