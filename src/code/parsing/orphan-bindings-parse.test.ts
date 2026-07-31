import { describe, test, expect } from 'vitest';
import { parseJSXToNodes } from './parser';

// `data-cms-orphan="prop:field,…"` is written by cms-detach-gen when a CMS-bound
// component instance is dragged out of a collection list. The panel reads it back
// (node.orphanBindings) to show "Missing" pills. The parser has TWO element walkers
// — the main page tree AND the `const canvasNodes = (<>…</>)` fragment — and a
// detached instance usually lands in canvasNodes, so BOTH must parse the stash.

describe('parser: data-cms-orphan → node.orphanBindings', () => {
  test('parses on a normal page-tree element', () => {
    const code = `
      export default function Page() {
        return (
          <div data-id="root" data-name="Root">
            <HuQiBi data-id="inst-1" data-name="Card" data-cms-orphan="content:title,ergerg:untitled" style={{ width: '300px' }} />
          </div>
        );
      }`;
    const node = parseJSXToNodes(code).get('inst-1');
    expect(node?.orphanBindings).toEqual([
      { prop: 'content', field: 'title' },
      { prop: 'ergerg', field: 'untitled' },
    ]);
  });

  test('parses inside the canvasNodes fragment (the detach lands here)', () => {
    const code = `
      export default function Page() {
        return <div data-id="root" data-name="Root" />;
      }
      const canvasNodes = (
        <>
          <div data-id="frame-1" data-name="Frame" style={{ width: '400px', height: '300px' }}>
            <HuQiBi data-id="inst-1" data-name="Card" data-cms-orphan="content:title,ergerg:untitled,ergergerg:image" style={{ width: '300px' }} />
          </div>
        </>
      );`;
    const node = parseJSXToNodes(code).get('inst-1');
    expect(node?.orphanBindings).toEqual([
      { prop: 'content', field: 'title' },
      { prop: 'ergerg', field: 'untitled' },
      { prop: 'ergergerg', field: 'image' },
    ]);
  });

  test('no attr → no orphanBindings', () => {
    const code = `export default function Page() { return <div data-id="root"><HuQiBi data-id="i2" /></div>; }`;
    expect(parseJSXToNodes(code).get('i2')?.orphanBindings).toBeUndefined();
  });
});
