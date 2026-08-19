import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from '@babel/parser';
import {
  autoSizeInstanceDimInCode, migrateInstanceDimPropToStyle, parseDimBranches,
  parseDimBranchesFull, getInstanceDimAttrExpr, setInstanceDimStyleWriteInCode,
  readInstanceDimBranches, ensureInstanceHugMarkerInCode,
} from './instance-auto-size';
import { parseProjectFile } from '@/code/parsing/project-parser';
import { InMemoryProjectFS } from '@/code/project/project-fs';
import { checkFile } from '@/code/oracle/check-file';

// The anonymized minimal pair, checked in under __fixtures__ (as `.tsx.txt`
// so tsc/vitest never try to compile them — they import project-relative
// modules that don't exist here). DUMP = pre-press (style ternary
// '79%'/'419px', `variant` ident — GoJoNe has connections); BROKEN = the
// retired PROP dialect (`height={variant === 'variant-1' ? undefined :
// '419px'}` + style '100%' pin + hoisted master).
const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', `${name}.tsx.txt`), 'utf8');
const GOJONE = fixture('gojone-dump');
const FEGAXI = fixture('fegaxi-plain');
const GOJONE_BROKEN = fixture('gojone-broken');
const FEGAXI_BROKEN = fixture('fegaxi-broken');
const INST = 'frame-msu8oque-2';
const parses = (c: string) => { parse(c, { sourceType: 'module', plugins: ['jsx', 'typescript'] }); return true; };
const instTag = (c: string) => c.slice(c.indexOf('<FeGaXi'), c.indexOf('/>', c.indexOf('<FeGaXi')));

describe('parseDimBranchesFull', () => {
  test('literals, chains, both idents, legacy undefined sentinel', () => {
    expect(parseDimBranches("'100%'")).toEqual([{ variant: null, value: '100%' }]);
    expect(parseDimBranchesFull("variant === 'variant-1' ? 'auto' : '419px'")).toEqual({
      branches: [{ variant: 'variant-1', value: 'auto' }, { variant: null, value: '419px' }],
      ident: 'variant',
    });
    expect(parseDimBranchesFull("initialVariant === 'v1' ? undefined : '10px'")?.branches[0].value).toBe('auto');
    expect(parseDimBranches('someMotionValue')).toBeNull();
  });
});

describe('autoSizeInstanceDimInCode — style channel (v4)', () => {
  test('replica press turns the branch into auto and marks the tag', () => {
    const out = autoSizeInstanceDimInCode(GOJONE, INST, 'height', 'variant-1');
    expect(parses(out)).toBe(true);
    const tag = instTag(out);
    expect(tag).toContain("height: variant === 'variant-1' ? 'auto' : '419px'");
    expect(tag).toContain('data-size-hug="height"');
    expect(tag).not.toMatch(/height=\{/);
    expect(tag).toContain("width: '719px'");
  });

  test('primary press on a plain value removes the entry — absence hugs everywhere', () => {
    const plain = GOJONE.replace("height: variant === 'variant-1' ? '79%' : '419px'", "height: '419px'");
    const out = autoSizeInstanceDimInCode(plain, INST, 'height', null);
    expect(parses(out)).toBe(true);
    const tag = instTag(out);
    expect(tag).not.toMatch(/height\s*:/);
    expect(tag).not.toContain('data-size-hug');
  });

  test('pressing auto on every variant collapses to full removal', () => {
    const one = autoSizeInstanceDimInCode(GOJONE, INST, 'height', 'variant-1');
    const both = autoSizeInstanceDimInCode(one, INST, 'height', null);
    expect(parses(both)).toBe(true);
    const tag = instTag(both);
    expect(tag).not.toMatch(/height\s*:/);
    expect(tag).not.toContain('data-size-hug');
  });

  test('never touches a motion-value entry', () => {
    const mv = GOJONE.replace("height: variant === 'variant-1' ? '79%' : '419px'", 'height: someMv');
    const out = autoSizeInstanceDimInCode(mv, INST, 'height', 'variant-1');
    expect(out).toBe(mv);
  });
});

describe('migrateInstanceDimPropToStyle — retiring the prop dialect', () => {
  test("the user's real broken pair converts to the style ternary", () => {
    const out = migrateInstanceDimPropToStyle(GOJONE_BROKEN, INST, 'height');
    expect(parses(out)).toBe(true);
    const tag = instTag(out);
    expect(getInstanceDimAttrExpr(out, INST, 'height')).toBeNull();
    expect(tag).toContain("height: variant === 'variant-1' ? 'auto' : '419px'");
    expect(tag).not.toContain("height: '100%'");
    expect(tag).toContain('data-size-hug="height"');
  });

  test('idempotent — second run is a byte no-op', () => {
    const once = migrateInstanceDimPropToStyle(GOJONE_BROKEN, INST, 'height');
    expect(migrateInstanceDimPropToStyle(once, INST, 'height')).toBe(once);
  });

  test('an auto press on the broken file migrates AND applies', () => {
    const out = autoSizeInstanceDimInCode(GOJONE_BROKEN, INST, 'height', 'variant-1');
    expect(parses(out)).toBe(true);
    const tag = instTag(out);
    expect(tag).not.toMatch(/height=\{/);
    expect(tag).toContain("height: variant === 'variant-1' ? 'auto' : '419px'");
  });
});

describe('expansion hug bake — the canvas model never sees auto', () => {
  const expand = (gojone: string, fegaxi: string) => {
    const fs = new InMemoryProjectFS(new Map<string, string>());
    fs.writeFile('components/FeGaXi.tsx', fegaxi);
    fs.writeFile('components/GoJoNe.tsx', gojone);
    return parseProjectFile('components/GoJoNe.tsx', fs);
  };

  test('hug branch bakes to the master root height and stamps hugDims', () => {
    const healed = autoSizeInstanceDimInCode(GOJONE, INST, 'height', 'variant-1');
    const nodes = expand(healed, FEGAXI);
    const wrapper = nodes.get(INST) as any;
    expect(wrapper).toBeTruthy();
    expect(wrapper.styles?.height).toBe('419px');                          // primary keeps its pin
    expect(wrapper.conditionalStyles?.height?.['variant-1']).toBe('219px'); // hug TRACKS the master
    expect(wrapper.hugDims?.height).toEqual(['variant-1']);
    const root = nodes.get(`${INST}:${INST}`) as any;
    expect(root.styles?.height).toBe('419px');                             // base merge unchanged
    expect(root.conditionalStyles?.height?.['variant-1']).toBeUndefined(); // no auto leaks to the root
  });

  test('master edit re-bakes — the hug value follows the master', () => {
    const healed = autoSizeInstanceDimInCode(GOJONE, INST, 'height', 'variant-1');
    const grown = FEGAXI.replace("height: '219px'", "height: '300px'");
    const nodes = expand(healed, grown);
    expect((nodes.get(INST) as any).conditionalStyles?.height?.['variant-1']).toBe('300px');
  });

  test('capstone: px primary, hug replica, % replica coexist per tile', () => {
    const three = GOJONE
      .replace("{ name: 'variant-1', label: 'Frame', x: 1944, y: 0 },", "{ name: 'variant-1', label: 'Frame', x: 1944, y: 0 },\n  { name: 'variant-2', label: 'Frame', x: 3888, y: 0 },")
      .replace(
        "height: variant === 'variant-1' ? '79%' : '419px'",
        "height: variant === 'variant-1' ? 'auto' : variant === 'variant-2' ? '50%' : '419px'",
      );
    const nodes = expand(three, FEGAXI);
    const wrapper = nodes.get(INST) as any;
    expect(wrapper.styles?.height).toBe('419px');
    expect(wrapper.conditionalStyles?.height?.['variant-1']).toBe('219px');
    expect(wrapper.conditionalStyles?.height?.['variant-2']).toBe('50%');
    expect(wrapper.hugDims?.height).toEqual(['variant-1']);
  });

  test('all-hug absence: wrapper has no height, root keeps the master value', () => {
    const none = GOJONE.replace(", height: variant === 'variant-1' ? '79%' : '419px'", '');
    const nodes = expand(none, FEGAXI);
    expect((nodes.get(INST) as any).styles?.height).toBeUndefined();
    expect((nodes.get(`${INST}:${INST}`) as any).styles?.height).toBe('219px');
    expect((nodes.get(INST) as any).hugDims).toBeUndefined();
  });

  test('legacy prop-dialect files still resolve until healed (read tolerance)', () => {
    const nodes = expand(GOJONE_BROKEN, FEGAXI_BROKEN);
    const wrapper = nodes.get(INST) as any;
    // the prop channel keeps the style '100%' pin off the root
    expect(wrapper.styles?.height).toBe('100%');
    const root = nodes.get(`${INST}:${INST}`) as any;
    expect(root.styles?.height).not.toBe('100%');
  });
});

describe('setInstanceDimStyleWriteInCode — the routed dim write', () => {
  const ALL_HUG = GOJONE.replace(", height: variant === 'variant-1' ? '79%' : '419px'", '');
  // The exact shape the legacy variant writer produced on an all-hug
  // instance — the '' else deleted the master dim through the root merge
  // (primary collapse, user report 2026-08-15).
  const POISONED = GOJONE.replace(
    "height: variant === 'variant-1' ? '79%' : '419px'",
    "height: variant === 'variant-1' ? '219px' : ''",
  );

  test('variant write on an all-hug instance writes an auto else, never an empty string', () => {
    const out = setInstanceDimStyleWriteInCode(ALL_HUG, INST, 'height', 'variant-1', '219px');
    expect(parses(out)).toBe(true);
    const tag = instTag(out);
    expect(tag).toContain("height: variant === 'variant-1' ? '219px' : 'auto'");
    expect(tag).not.toContain(": ''");
    expect(tag).toContain('data-size-hug="height"');
  });

  test("normalizes a poisoned '' else on the next write", () => {
    const out = setInstanceDimStyleWriteInCode(POISONED, INST, 'height', 'variant-1', '250px');
    expect(parses(out)).toBe(true);
    const tag = instTag(out);
    expect(tag).toContain("height: variant === 'variant-1' ? '250px' : 'auto'");
    expect(tag).not.toContain(": ''");
  });

  test('base write on a mixed entry replaces the else and keeps branches', () => {
    const healed = autoSizeInstanceDimInCode(GOJONE, INST, 'height', 'variant-1');
    const out = setInstanceDimStyleWriteInCode(healed, INST, 'height', null, '500px');
    expect(instTag(out)).toContain("height: variant === 'variant-1' ? 'auto' : '500px'");
  });

  test("base delete ('') with a pinned replica leaves the base hugging", () => {
    const out = setInstanceDimStyleWriteInCode(GOJONE, INST, 'height', null, '');
    expect(parses(out)).toBe(true);
    expect(instTag(out)).toContain("height: variant === 'variant-1' ? '79%' : 'auto'");
  });

  test("variant delete ('') removes the branch; all-hug collapses to removal", () => {
    const healed = autoSizeInstanceDimInCode(GOJONE, INST, 'height', 'variant-1');
    const out = setInstanceDimStyleWriteInCode(healed, INST, 'height', 'variant-1', '');
    expect(instTag(out)).toContain("height: '419px'");
    const gone = setInstanceDimStyleWriteInCode(ALL_HUG, INST, 'height', 'variant-1', '');
    expect(instTag(gone)).not.toMatch(/height\s*:/);
  });

  test('plain element-like writes stay plain (no ternary, no marker)', () => {
    const plain = GOJONE.replace("height: variant === 'variant-1' ? '79%' : '419px'", "height: '419px'");
    const out = setInstanceDimStyleWriteInCode(plain, INST, 'height', null, '600px');
    const tag = instTag(out);
    expect(tag).toContain("height: '600px'");
    expect(tag).not.toContain('variant ===');
    expect(tag).not.toContain('data-size-hug');
  });

  test("expansion bake heals a poisoned '' else: primary hugs the master", () => {
    const fs = new InMemoryProjectFS(new Map<string, string>());
    fs.writeFile('components/FeGaXi.tsx', FEGAXI);
    fs.writeFile('components/GoJoNe.tsx', POISONED);
    const nodes = parseProjectFile('components/GoJoNe.tsx', fs);
    const wrapper = nodes.get(INST) as any;
    expect(wrapper.styles?.height).toBeUndefined();                        // '' base deleted → adopt-root path
    expect(wrapper.conditionalStyles?.height?.['variant-1']).toBe('219px'); // pinned replica untouched
    expect(wrapper.hugDims?.height).toEqual(['default']);
    const root = nodes.get(`${INST}:${INST}`) as any;
    expect(root.styles?.height).toBe('219px');                             // master value intact, no '' merge
  });
});

describe('mid-object entries — the separating comma survives', () => {
  // The real images-grid instance: motion values + per-variant position/left/
  // top ternaries, `height` MID-OBJECT with a `flex` entry after it. The
  // writer used to eat the absorbed trailing comma (`'100%'  flex:` — the
  // production parse-gate bounce, 2026-08-15).
  const IMAGES = fixture('bidama-images');
  const IMG_INST = 'div-msp237ef-k';

  test('auto press keeps the following entry attached with a comma', () => {
    for (const variant of [null, 'variant-1', 'variant-2']) {
      const out = autoSizeInstanceDimInCode(IMAGES, IMG_INST, 'height', variant);
      expect(parses(out)).toBe(true);
      expect(out).toMatch(/'auto'[^,]*,\s*flex: initialVariant/);
      expect(out).toContain('data-size-hug="height"');
    }
  });

  test('routed dim write on the same shape parses too', () => {
    const out = setInstanceDimStyleWriteInCode(IMAGES, IMG_INST, 'height', 'variant-2', '300px');
    expect(parses(out)).toBe(true);
    expect(out).toContain("height: initialVariant === 'variant-2' ? '300px' : '100%'");
  });

  test('width (leading-comma side) still round-trips', () => {
    const out = setInstanceDimStyleWriteInCode(IMAGES, IMG_INST, 'width', 'variant-2', '250px');
    expect(parses(out)).toBe(true);
    expect(out).toContain("width: initialVariant === 'variant-2' ? '250px' : '100%'");
  });
});

describe('page files — the style-block first-occurrence trap', () => {
  // The real Adore page: the instance's data-id appears in @media band CSS
  // (`[data-id="X"] { width: 100% !important }`) thousands of chars BEFORE
  // the JSX tag. Backtracking from the FIRST occurrence landed on the
  // <style> tag → channel 'none' → the auto press silently no-oped (the
  // page-instance regression, 2026-08-15).
  const PAGE = fixture('adore-page-now');
  const PAGE_INST = 'BiDaMa-msq5wbqc-1';

  test('the reader finds the JSX tag, not the band CSS', () => {
    const state = readInstanceDimBranches(PAGE, PAGE_INST, 'width');
    expect(state.channel).toBe('style');
    expect(state.branches).toEqual([{ variant: null, value: '100%' }]);
  });

  test('primary auto press removes the width entry on the page instance', () => {
    const out = autoSizeInstanceDimInCode(PAGE, PAGE_INST, 'width', null);
    expect(parses(out)).toBe(true);
    const tag = out.slice(out.indexOf('<BiDaMa'), out.indexOf('</BiDaMa>'));
    expect(tag).not.toMatch(/width\s*:/);
    // the band CSS is untouched
    expect(out).toContain('[data-id="BiDaMa-msq5wbqc-1"] { flex: 0 0 auto !important; width: 100% !important; }');
  });

  test('band-hug marker: ensure is additive + a later write keeps it', () => {
    // simulate the viewport-replica press: band rule flips to auto + marker
    const banded = PAGE.replace(
      '[data-id="BiDaMa-msq5wbqc-1"] { flex: 0 0 auto !important; width: 100% !important; }',
      '[data-id="BiDaMa-msq5wbqc-1"] { flex: 0 0 auto !important; width: auto !important; }',
    );
    const marked = ensureInstanceHugMarkerInCode(banded, PAGE_INST, 'width');
    expect(parses(marked)).toBe(true);
    expect(marked).toContain('data-size-hug="width"');
    expect(ensureInstanceHugMarkerInCode(marked, PAGE_INST, 'width')).toBe(marked); // idempotent
    // an unrelated dim write re-derives the marker — the band auto keeps it alive
    const later = setInstanceDimStyleWriteInCode(marked, PAGE_INST, 'height', null, '500px');
    expect(parses(later)).toBe(true);
    expect(later).toContain('data-size-hug="width"');
    expect(later).toContain("height: '500px'");
  });
});

describe('oracle', () => {
  test('the healed file adds no new violations (data-size-hug is dialect-legal)', () => {
    const healed = autoSizeInstanceDimInCode(GOJONE, INST, 'height', 'variant-1');
    const before = checkFile(GOJONE, { kind: 'component', path: 'components/GoJoNe.tsx' }).map((x: any) => x.code);
    const after = checkFile(healed, { kind: 'component', path: 'components/GoJoNe.tsx' }).map((x: any) => x.code);
    expect(after.filter((c: string) => !before.includes(c))).toEqual([]);
  });

  test('the migrated broken file adds no new violations either', () => {
    const migrated = migrateInstanceDimPropToStyle(GOJONE_BROKEN, INST, 'height');
    const before = checkFile(GOJONE_BROKEN, { kind: 'component', path: 'components/GoJoNe.tsx' }).map((x: any) => x.code);
    const after = checkFile(migrated, { kind: 'component', path: 'components/GoJoNe.tsx' }).map((x: any) => x.code);
    expect(after.filter((c: string) => !before.includes(c))).toEqual([]);
  });
});
