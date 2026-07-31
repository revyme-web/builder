import { describe, test, expect } from 'vitest';
import { parseJSXToNodes } from './parser';

// Regression: a `.map()` collection-list wrapped in TRANSPARENT motion/Glide
// wrappers (<LayoutGroup>, <motion.div data-glide>, <AnimatePresence>) must
// still attach `collectionList` to the REAL container node. The `.map()` parent
// walk used to `break` at the FIRST JSXElement — which, with Glide on, is the
// wrapperless <LayoutGroup> — so collectionList never reached the grid and the
// canvas rendered only item 0 with empty ghost copies (live site was fine).

const ITEMS = `const items = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];`;

function gridNode(code: string) {
  return parseJSXToNodes(code).get('grid');
}

describe('collectionList survives transparent wrappers around the .map()', () => {
  test('plain container (no wrapper) — baseline', () => {
    const code = `${ITEMS}
      export default function Page() {
        return <div data-id="root" data-name="Root">
          <div data-id="grid" data-name="Grid" style={{ display: 'grid' }}>
            {items.map((item, idx) => <p data-id="tpl" data-name="Item" key={idx}>{item.name}</p>)}
          </div>
        </div>;
      }`;
    const grid = gridNode(code);
    expect(grid?.collectionList?.templateIds?.default).toBe('tpl');
    expect(grid?.inlineMapData?.length).toBe(3);
  });

  test('Glide: <motion.div data-glide> + <LayoutGroup> wrapper around the map', () => {
    const code = `${ITEMS}
      export default function Page() {
        return <div data-id="root" data-name="Root">
          <motion.div layout transition={{ type: 'spring' }} data-glide='{"transition":{}}' data-id="grid" data-name="Grid" style={{ display: 'grid' }}>
            <LayoutGroup>
              {items.map((item, idx) => <p data-id="tpl" data-name="Item" key={idx}>{item.name}</p>)}
            </LayoutGroup>
          </motion.div>
        </div>;
      }`;
    const grid = gridNode(code);
    // Was undefined before the fix (break bailed on LayoutGroup).
    expect(grid?.collectionList?.templateIds?.default).toBe('tpl');
    expect(grid?.inlineMapData?.length).toBe(3);
  });

  test('AnimatePresence wrapper around the map also passes through', () => {
    const code = `${ITEMS}
      export default function Page() {
        return <div data-id="root" data-name="Root">
          <div data-id="grid" data-name="Grid" style={{ display: 'grid' }}>
            <AnimatePresence>
              {items.map((item, idx) => <p data-id="tpl" data-name="Item" key={idx}>{item.name}</p>)}
            </AnimatePresence>
          </div>
        </div>;
      }`;
    const grid = gridNode(code);
    expect(grid?.collectionList?.templateIds?.default).toBe('tpl');
    expect(grid?.inlineMapData?.length).toBe(3);
  });
});
