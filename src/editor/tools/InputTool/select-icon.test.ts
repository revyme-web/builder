// select-icon.test.ts — the select caret bake (Input tool "Icon" row).

import { describe, test, expect } from 'vitest';
import { parseSelectIconSpec, bakeSelectIconStyles, clearSelectIconStyles, SELECT_ICON_ATTR } from './select-icon';
import { updateHtmlAttrsInCode } from '@/code/generation/generator-attrs';
import { parseJSXToNodes } from '@/code/parsing/parser';

describe('parseSelectIconSpec', () => {
  test('round-trips a valid spec', () => {
    const raw = JSON.stringify({ icon: 'lucide:chevron-down', color: '#FA2323' });
    expect(parseSelectIconSpec(raw)).toEqual({ icon: 'lucide:chevron-down', color: '#FA2323' });
  });

  test('null for absent / malformed / incomplete attrs', () => {
    expect(parseSelectIconSpec(undefined)).toBeNull();
    expect(parseSelectIconSpec('')).toBeNull();
    expect(parseSelectIconSpec('not json {')).toBeNull();
    expect(parseSelectIconSpec(JSON.stringify({ icon: 'x' }))).toBeNull();
    expect(parseSelectIconSpec(JSON.stringify({ color: '#fff' }))).toBeNull();
  });
});

describe('bakeSelectIconStyles', () => {
  const RAW = '<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="m6 9l6 6l6-6"/></svg>';

  test('bakes the color and produces a self-contained data URI', () => {
    const styles = bakeSelectIconStyles(RAW, '#FA2323');
    expect(styles.appearance).toBe('none');
    expect(styles.WebkitAppearance).toBe('none');
    expect(styles.backgroundImage.startsWith('url("data:image/svg+xml,')).toBe(true);
    // The URI is fully encoded — no raw quotes that would break the url("…") wrapper.
    const uri = styles.backgroundImage.slice('url("'.length, -'")'.length);
    expect(uri).not.toContain('"');
    const decoded = decodeURIComponent(uri.slice('data:image/svg+xml,'.length));
    expect(decoded).toContain('stroke="#FA2323"');
    expect(decoded).not.toContain('currentColor');
    expect(styles.backgroundRepeat).toBe('no-repeat');
    // content-box origin → the caret tracks the select's own paddingRight.
    expect(styles.backgroundOrigin).toBe('content-box');
    expect(styles.backgroundPosition).toBe('right center');
    expect(styles.backgroundSize).toBe('16px 16px');
  });

  test('clearSelectIconStyles empties exactly the keys the bake sets', () => {
    const baked = bakeSelectIconStyles(RAW, '#fff');
    const cleared = clearSelectIconStyles();
    expect(Object.keys(cleared).sort()).toEqual(Object.keys(baked).sort());
    expect(Object.values(cleared).every((v) => v === '')).toBe(true);
  });

  test('black-ink and fill-less packs get the color too (not just currentColor)', () => {
    // Explicit #000 ink (some packs hard-code it).
    const black = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" d="M0 0h24v24z"/></svg>';
    const bakedBlack = decodeURIComponent(bakeSelectIconStyles(black, '#FA2323').backgroundImage);
    expect(bakedBlack).toContain('fill="#FA2323"');
    expect(bakedBlack).not.toContain('fill="#000"');
    // NO fill anywhere — renders black; the root svg gets the ink stamped so
    // it cascades to fill-less paths.
    const bare = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24z"/></svg>';
    const bakedBare = decodeURIComponent(bakeSelectIconStyles(bare, '#FA2323').backgroundImage);
    expect(bakedBare).toContain('<svg fill="#FA2323"');
  });
});

describe('data-select-icon attr round-trip (write → parse)', () => {
  test('the spec survives the generator + parser — the panel can read it back', () => {
    // The parser's `attrs` is an ALLOWLIST (PARSED_HTML_ATTRS): the first
    // ship forgot to register data-select-icon, so the Icon row showed
    // "Add…" right after applying and the Color control was dead (its
    // handler gates on the read-back spec) — user report 2026-08-12.
    const CODE = `export default function Page() {
  return <div data-id="root" style={{ position: 'relative' }}>
    <select data-id="sel-1" name="email" style={{ position: 'relative', width: '100%' }}></select>
  </div>;
}`;
    const spec = JSON.stringify({ icon: 'pixel:chevron-down-solid', color: '#ABABAB' });
    const out = updateHtmlAttrsInCode(CODE, 'sel-1', { [SELECT_ICON_ATTR]: spec });
    const readBack = parseJSXToNodes(out).get('sel-1')?.attrs?.[SELECT_ICON_ATTR];
    expect(readBack).toBe(spec);
    expect(parseSelectIconSpec(readBack)).toEqual({ icon: 'pixel:chevron-down-solid', color: '#ABABAB' });
  });
});
