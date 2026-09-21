// The Icons grid requested one SVG per cell AND prefetched a second per cell on
// mount, for every cell in the pack at once — thousands of requests, answered
// with 429. These cover the pure halves of the bulk replacement.

import { describe, it, expect } from 'vitest';
import { chunkIconNames, parseIconifyJson, iconDataUri } from './icon-bulk-loader';

describe('chunkIconNames', () => {
  it('keeps every chunk under the URL cap and loses nothing', () => {
    const names = Array.from({ length: 300 }, (_, i) => `arrow-right-from-bracket-${i}`);
    const chunks = chunkIconNames(names, 400);
    expect(chunks.flat()).toEqual(names);
    for (const c of chunks) expect(c.join(',').length).toBeLessThanOrEqual(400);
    // 1,402 icons must NOT become 1,402 requests.
    expect(chunks.length).toBeLessThan(names.length / 5);
  });

  it('puts a single over-long name in its own chunk rather than dropping it', () => {
    const long = 'x'.repeat(500);
    expect(chunkIconNames(['a', long, 'b'], 400)).toEqual([['a'], [long], ['b']]);
  });

  it('handles the empty list', () => {
    expect(chunkIconNames([])).toEqual([]);
  });
});

describe('parseIconifyJson', () => {
  // Shape taken from a real `fa6-solid.json?icons=house,anchor` response.
  const json = {
    prefix: 'fa6-solid', width: 512, height: 512,
    icons: { house: { body: '<path d="M1"/>', width: 576 }, anchor: { body: '<path d="M2"/>' } },
    aliases: { home: { parent: 'house' }, 'house-flipped': { parent: 'house', hFlip: true } },
  };

  it('applies the set defaults, with per-icon overrides winning', () => {
    const out = parseIconifyJson(['house', 'anchor'], json);
    expect(out.get('house')).toMatchObject({ width: 576, height: 512, left: 0, top: 0 });
    expect(out.get('anchor')).toMatchObject({ width: 512, height: 512 });
  });

  it('follows a plain alias to its parent', () => {
    expect(parseIconifyJson(['home'], json).get('home')?.body).toBe('<path d="M1"/>');
  });

  // A flat body can't express a flip/rotation — those fall back to the
  // per-icon endpoint instead of rendering the wrong way round.
  it('refuses a TRANSFORMED alias', () => {
    expect(parseIconifyJson(['house-flipped'], json).get('house-flipped')).toBeNull();
  });

  it('reports an unknown icon as null', () => {
    expect(parseIconifyJson(['nope'], json).get('nope')).toBeNull();
  });

  it('defaults to a 16px box when the set declares none', () => {
    const out = parseIconifyJson(['a'], { icons: { a: { body: '<g/>' } } });
    expect(out.get('a')).toMatchObject({ width: 16, height: 16 });
  });

  it('survives an alias cycle', () => {
    const cyc = { icons: {}, aliases: { a: { parent: 'b' }, b: { parent: 'a' } } };
    expect(parseIconifyJson(['a'], cyc).get('a')).toBeNull();
  });
});

describe('iconDataUri', () => {
  it('builds a self-contained svg data URI with the right viewBox', () => {
    const uri = iconDataUri({ body: '<path d="M0 0"/>', left: 0, top: 0, width: 576, height: 512 });
    expect(uri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    const svg = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
    expect(svg).toContain('viewBox="0 0 576 512"');
    expect(svg).toContain('<path d="M0 0"/>');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
});
