import { describe, it, expect } from 'vitest';
import { transform } from '@babel/standalone';
import { captureCollectionForPaste, rebuildPastedCollectionInCode, duplicateCollectionListToCanvasInCode } from './cms-paste-gen';

const parses = (code: string) =>
  expect(() => transform(code, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

// A page with a paginated CMS Collection List (the .map() + LoadMore + hook + imports).
const SOURCE = `'use client';
import React, { useState } from 'react';
import advisors from '@/cms/advisors.json';
import LoadMore from '@/components/LoadMore';
export default function Page() {
  const [visFramea, setVisFramea] = useState(3);
  return <div data-id="root">
    <div data-id="frame-a" data-name="Advisors" data-pagination="loadMore:3" style={{ display: 'flex', flexDirection: 'column' }}>
      {advisors.slice(0, visFramea).map((item, idx) => <a data-cms-nav="row" data-id="item-a" key={idx} style={{ display: 'flex' }}>
        <div data-id="img-a" style={{ backgroundImage: \`url(\${item.image})\` }}></div>
        <h3 data-id="head-a">{item.name}</h3>
      </a>)}
      {visFramea < advisors.length && <LoadMore data-id="loadmore-frame-a" onLoadMore={() => setVisFramea(c => c + 3)} />}
    </div>
  </div>;
}`;

describe('captureCollectionForPaste', () => {
  const cap = captureCollectionForPaste(SOURCE, 'frame-a', 'advisors')!;

  it('captures the verbatim .map() container JSX', () => {
    expect(cap).toBeTruthy();
    expect(cap.rawJsx).toContain('advisors.slice(0, visFramea).map((item, idx)');
    expect(cap.rawJsx).toContain('{item.name}');
    expect(cap.rawJsx).toContain('url(${item.image})');
    expect(cap.rawJsx).toContain('<LoadMore data-id="loadmore-frame-a"');
  });
  it('captures the pagination hook', () => {
    expect(cap.bodyHooks).toContainEqual('const [visFramea, setVisFramea] = useState(3);');
  });
  it('captures the CMS data + LoadMore imports', () => {
    expect(cap.imports.some(i => /@\/cms\/advisors\.json/.test(i))).toBe(true);
    expect(cap.imports.some(i => /LoadMore/.test(i))).toBe(true);
  });
});

describe('rebuildPastedCollectionInCode', () => {
  const cap = captureCollectionForPaste(SOURCE, 'frame-a', 'advisors')!;

  // Destination: the engine pasted a PLAIN empty container at the new id (no imports,
  // no hook, no .map()). Cross-page paste → a different page.
  const DEST = `'use client';
import React from 'react';
export default function Other() {
  return <div data-id="dest-root">
    <div data-id="frame-b" data-name="Advisors" style={{ display: 'flex', flexDirection: 'column' }}>
    </div>
  </div>;
}`;
  // idMap: container + descendants renamed (oldId → newId).
  const idMap = new Map<string, string>([
    ['frame-a', 'frame-b'],
    ['item-a', 'item-b'],
    ['img-a', 'img-b'],
    ['head-a', 'head-b'],
    ['loadmore-frame-a', 'loadmore-frame-b'],
  ]);
  const out = rebuildPastedCollectionInCode(DEST, cap, idMap);

  it('inserts the .map() repeater into the plain pasted container', () => {
    expect(out).toContain('advisors.slice(0, visFrameb).map((item, idx)');
    expect(out).toContain('{item.name}');
  });
  it('renames all data-ids to the pasted ids', () => {
    expect(out).toContain('data-id="item-b"');
    expect(out).toContain('data-id="head-b"');
    expect(out).not.toContain('data-id="item-a"');
  });
  it('renames the pagination var from the new container id (visFrameb) + setter', () => {
    expect(out).toContain('visFrameb < advisors.length');
    expect(out).toContain('setVisFrameb(c => c + 3)');
    expect(out).not.toContain('visFramea');
  });
  it('injects the pagination useState hook into the function body', () => {
    expect(out).toContain('const [visFrameb, setVisFrameb] = useState(3);');
  });
  it('adds the CMS data import + LoadMore import (cross-page)', () => {
    expect(out).toMatch(/import\s+advisors\s+from\s+['"]@\/cms\/advisors\.json['"]/);
    expect(out).toMatch(/import\s+LoadMore\s+from/);
  });
  it('transplants the data-pagination marker onto the container', () => {
    expect(out).toContain('data-pagination="loadMore:3"');
  });
  it('produces parseable JSX', () => parses(out));
});

describe('rebuildPastedCollectionInCode — responsive list (per-variant overrides)', () => {
  // A responsive list uses `__applyListConfig(slug, listCfgX)` + a `const listCfgX =
  // useResponsiveListConfig(...)` body const + the `@responsiveList` interpreter block.
  const RESP = `'use client';
import React from 'react';
import advisors from '@/cms/advisors.json';
function Comp({ initialVariant = 'default' }) {
  const listCfgFramea = useResponsiveListConfig({}, {}, [1440], initialVariant, {"variant-1":{"filter":{"combinator":"and","filters":[]}}});
  return <div data-id="frame-a" data-name="Advisors" style={{ display: 'flex' }}>
    {__applyListConfig(advisors, listCfgFramea).map((item, idx) => <a data-id="item-a" key={idx}>{item.name}</a>)}
  </div>;
}
// @responsiveList-begin
function useResponsiveListConfig(base, vp, w, v, vo) { return base; }
function __applyListConfig(arr, cfg) { return arr; }
// @responsiveList-end
export default Comp;`;
  const cap = captureCollectionForPaste(RESP, 'frame-a', 'advisors')!;

  it('captures the listCfg const', () => {
    expect(cap.bodyHooks.some(h => /const listCfgFramea = useResponsiveListConfig\(/.test(h))).toBe(true);
  });

  it('rebuilds with renamed listCfg var + ensures the @responsiveList block', () => {
    const DEST = `'use client';
import React from 'react';
import advisors from '@/cms/advisors.json';
function Comp2({ initialVariant = 'default' }) {
  return <div data-id="frame-b" data-name="Advisors" style={{ display: 'flex' }}></div>;
}
export default Comp2;`;
    const out = rebuildPastedCollectionInCode(DEST, cap, new Map([['frame-a', 'frame-b'], ['item-a', 'item-b']]));
    expect(out).toContain('__applyListConfig(advisors, listCfgFrameb)');
    expect(out).toContain('const listCfgFrameb = useResponsiveListConfig(');
    expect(out).toContain('// @responsiveList-begin');   // interpreter block ensured
    expect(out).not.toContain('listCfgFramea');
    parses(out);
  });
});

describe('rebuildPastedCollectionInCode — component → PAGE context demotion', () => {
  // Copied from a design component: uses initialVariant, variants={…}, layout={true},
  // initial/animate variant wiring — none of which resolve on a normal page.
  const COMP = `'use client';
import advisors from '@/cms/advisors.json';
const frameaVariants = { default: {} };
function Card({ initialVariant = 'default' }) {
  const listCfgFramea = useResponsiveListConfig({}, {}, [1440], initialVariant, {"variant-1":{}});
  return <motion.div data-id="frame-a" variants={frameaVariants} initial={['default', initialVariant]} animate={['default', initialVariant]} data-name="Advisors" style={{ display: initialVariant === 'variant-1' ? 'none' : 'flex' }}>
    {__applyListConfig(advisors, listCfgFramea).map((item, idx) => <a layout={true} data-id="item-a" key={idx}>{item.name}</a>)}
  </motion.div>;
}
// @responsiveList-begin
function useResponsiveListConfig(b) { return b; }
function __applyListConfig(a) { return a; }
// @responsiveList-end
export default withResponsiveProps(Card);`;
  const cap = captureCollectionForPaste(COMP, 'frame-a', 'advisors')!;

  // Dest: a normal PAGE (export default function Page — NOT withResponsiveProps).
  const PAGE = `'use client';
import advisors from '@/cms/advisors.json';
export default function Page() {
  return <div data-id="root">
    <div data-id="frame-b" data-name="Advisors" style={{ display: 'flex' }}></div>
  </div>;
}`;
  const out = rebuildPastedCollectionInCode(PAGE, cap, new Map([['frame-a', 'frame-b'], ['item-a', 'item-b']]));

  it('replaces initialVariant with undefined (no ReferenceError on a page)', () => {
    expect(out).not.toContain('initialVariant');
    expect(out).toContain('useResponsiveListConfig({}, {}, [1440], undefined,');
  });
  it('strips component-only props: variants / layout / initial / animate', () => {
    expect(out).not.toContain('variants={frameaVariants}');
    expect(out).not.toContain('layout={true}');
    expect(out).not.toMatch(/initial=\{\['default'/);
    expect(out).not.toMatch(/animate=\{\['default'/);
  });
  it('still inserts the .map() rows + keeps the list working', () => {
    expect(out).toContain('__applyListConfig(advisors, listCfgFrameb).map');
    expect(out).toContain('{item.name}');
  });
  it('produces parseable JSX', () => parses(out));
});

// Replica drag-out clone: COPY the collection list to canvasNodes (map + bindings
// preserved), leaving the original in the page. This is the fix for the bug where a
// replica detach emitted ONE static unbound ghost.
describe('duplicateCollectionListToCanvasInCode', () => {
  const out = duplicateCollectionListToCanvasInCode(
    SOURCE, 'frame-a', 'advisors', '-cabc12',
    { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', position: 'absolute', left: '3246px', top: '1940px', width: '720px', height: '1829px' },
  );

  it('adds a data-canvas-node collection list with the canvas position + layout styles', () => {
    expect(out).toContain('const canvasNodes');
    expect(out).toContain('data-id="frame-a-cabc12"');
    expect(out).toContain('data-canvas-node="true"');
    expect(out).toContain("left: '3246px'");
    expect(out).toContain("gridTemplateColumns: 'repeat(3, 1fr)'");
  });

  it('PRESERVES the .map() + CMS item.* bindings (id-renamed descendants)', () => {
    // The literal `.map((item, idx) => …)` survives — NOT a single expanded ghost.
    expect(out).toContain('.map((item, idx)');
    expect(out).toContain('data-id="item-a-cabc12"');
    expect(out).toContain('data-id="img-a-cabc12"');
    expect(out).toContain('{item.name}');
    expect(out).toContain('url(${item.image})');
  });

  it("strips the pagination scaffold from the canvas copy (canvasNodes can't hold hooks)", () => {
    const canvasPart = out.slice(out.indexOf('const canvasNodes'));
    expect(canvasPart).not.toContain('.slice(0, visFramea');   // renders all items
    expect(canvasPart).not.toContain('data-pagination');       // no round-trip marker
    expect(canvasPart).toContain('false && <LoadMore');        // guard short-circuited (no visX/setVisX ref)
  });

  it('keeps the ORIGINAL collection list in the page (COPY, not move)', () => {
    expect(out).toContain('data-id="frame-a"');                 // original container (exact, not the -cabc12 clone)
    expect(out).toContain('advisors.slice(0, visFramea).map');  // original keeps its pagination
  });

  it('produces parseable JSX', () => parses(out));
});

// ─── Pasting a LOCALIZED collection ────────────────────────────────────────
//
// A translated list's `.map()` head is `localizeRows(<coll>, __activeLocale)`.
// That binding is a hook declaration in the SOURCE page's body — it doesn't
// travel with the capture (`bodyHooks` collects only the pagination consts,
// `imports` only the cms/LoadMore/Spinner lines). Pasting onto a fresh page
// therefore produced JSX referencing a binding that didn't exist and the page
// rendered nothing: "__activeLocale is not defined" (user report 2026-08-11,
// trace: `cms-paste:rebuild {hooks: 0, imports: 1}`).
//
// Same shape as the `__applyListConfig` → `ensureResponsiveListHooks` line
// beside it: if the pasted JSX references it, ensure it in the destination.

const LOCALIZED_SOURCE = `'use client';
import React from 'react';
import { useLocale } from 'next-intl';
import { localizeRows } from '@revyme/runtime';
import programme from '@/cms/programme.json';

export default function Page() {
  const __activeLocale = useLocale();
  return (
    <div data-id="root">
      <div data-id="prog-row" style={{ display: 'flex' }}>
        {localizeRows(programme, __activeLocale).map((row, idx) => (
          <div data-id="prog-card" key={idx} style={{ width: '424px' }}>{row.title}</div>
        ))}
      </div>
    </div>
  );
}
`;

/** Destination: the engine has already pasted a PLAIN empty container at the
 *  new id (no imports, no hook, no `.map()`) — same shape the suite's other
 *  rebuild tests use. */
const destWith = (id: string) => `'use client';
import React from 'react';
export default function Other() {
  return <div data-id="dest-root">
    <div data-id="${id}" data-name="Panels" style={{ display: 'flex' }}>
    </div>
  </div>;
}`;
const LOC_IDS = new Map([['prog-row', 'new-row'], ['prog-card', 'new-card']]);

describe('rebuildPastedCollectionInCode — localized list', () => {
  const cap = captureCollectionForPaste(LOCALIZED_SOURCE, 'prog-row', 'programme')!;

  it('captures the container', () => {
    expect(cap).toBeTruthy();
    expect(cap.rawJsx).toContain('localizeRows(programme, __activeLocale)');
  });

  it('brings the locale HOOK to the destination page', () => {
    const out = rebuildPastedCollectionInCode(destWith('new-row'), cap, LOC_IDS);
    expect(out).toContain('const __activeLocale = useLocale();');
  });

  it('brings the next-intl IMPORT too', () => {
    const out = rebuildPastedCollectionInCode(destWith('new-row'), cap, LOC_IDS);
    expect(out).toMatch(/import \{ useLocale \} from 'next-intl'/);
  });

  it('the pasted page COMPILES — the whole point', () => {
    const out = rebuildPastedCollectionInCode(destWith('new-row'), cap, LOC_IDS);
    expect(() => transform(out, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();
    // …and the hook is declared BEFORE the JSX that reads it.
    const body = out.slice(out.indexOf('export default function'));
    expect(body.indexOf('const __activeLocale')).toBeLessThan(body.indexOf('__activeLocale)'));
  });

  it('declares it exactly once when pasted TWICE', () => {
    // Two plain containers already in the destination, as the engine leaves them.
    const dest = destWith('new-row').replace(
      '</div>\n  </div>;',
      '</div>\n    <div data-id="row-2" style={{ display: \'flex\' }}></div>\n  </div>;',
    );
    let out = rebuildPastedCollectionInCode(dest, cap, LOC_IDS);
    out = rebuildPastedCollectionInCode(out, cap, new Map([['prog-row', 'row-2'], ['prog-card', 'card-2']]));
    expect(out.match(/const __activeLocale = useLocale\(\);/g)).toHaveLength(1);
  });

  it('leaves a NON-localized paste alone', () => {
    const plainCap = captureCollectionForPaste(SOURCE, 'frame-a', 'advisors')!;
    const out = rebuildPastedCollectionInCode(destWith('new-row'), plainCap,
      new Map([['frame-a', 'new-row'], ['card-a', 'new-card']]));
    expect(out).not.toContain('__activeLocale');
    expect(out).not.toContain('next-intl');
  });
});
