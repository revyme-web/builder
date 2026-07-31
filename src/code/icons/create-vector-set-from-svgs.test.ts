// Tests for the dropped-SVG → icon-set pipeline: the security/JSX sanitize
// pass, the preflight guardrails, and the end-to-end builder.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shared/debug-trace', () => ({
  trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() },
}));

import {
  wrapSvgForIconCard,
  preflightSvgFiles,
  createVectorSetFromSvgs,
  looksLikeSvg,
  svgIntrinsicSize,
  MAX_ICONS_PER_SET,
} from './create-vector-set-from-svgs';
import { isIconSetCode } from './icon-set-template';
import { projectFS, resetProjectFS } from '@/code/project/project-fs';
import { parseJSX } from '@/code/parsing/ast-utils';
import { parseJSXToNodes } from '@/code/parsing/parser';

const svgFile = (name: string, content: string) =>
  new File([content], name, { type: 'image/svg+xml' });

describe('wrapSvgForIconCard — security + JSX safety', () => {
  it('strips script blocks, event handlers, and javascript: hrefs', () => {
    const dirty = `<svg viewBox="0 0 24 24">
      <script>alert('pwn')</script>
      <path d="M0 0h24v24z" onclick="steal()" onmouseover='x()' />
      <a href="javascript:alert(1)"><circle r="4" /></a>
    </svg>`;
    const out = wrapSvgForIconCard(dirty, 'icon-1', 'Dirty');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('onmouseover');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('<path d="M0 0h24v24z"');
  });

  it('strips foreignObject (arbitrary HTML) blocks', () => {
    const dirty = `<svg viewBox="0 0 24 24"><foreignObject><body onload="x()">hi</body></foreignObject><rect width="4" height="4" /></svg>`;
    const out = wrapSvgForIconCard(dirty, 'icon-1', 'FO');
    expect(out).not.toContain('foreignObject');
    expect(out).not.toContain('onload');
    expect(out).toContain('<rect width="4" height="4"');
  });

  it('strips HTML comments and CDATA markers (JSX parse errors)', () => {
    const dirty = `<svg viewBox="0 0 24 24"><!-- Generator: Adobe Illustrator --><path d="M1 1" /></svg>`;
    const out = wrapSvgForIconCard(dirty, 'icon-1', 'C');
    expect(out).not.toContain('<!--');
    expect(out).toContain('<path d="M1 1"');
  });

  it('converts bare style="a:b" string attrs into JSX style objects', () => {
    const dirty = `<svg viewBox="0 0 24 24"><path d="M1 1" style="fill:#ff0000;stroke-width:2" /></svg>`;
    const out = wrapSvgForIconCard(dirty, 'icon-1', 'S');
    expect(out).not.toMatch(/style="/);
    expect(out).toContain("fill: '#ff0000'");
    expect(out).toContain("strokeWidth: '2'");
  });

  it('keeps the source viewBox and wraps with the card frame', () => {
    const out = wrapSvgForIconCard('<svg viewBox="0 0 16 16"><path d="M2 2" /></svg>', 'icon-3', 'Arrow');
    expect(out).toContain('viewBox="0 0 16 16"');
    expect(out).toContain('data-id="shape-icon-3-default"');
    expect(out).toContain('data-name="Arrow"');
  });

  it('marks the wrapper as an opaque graphic and sizes it to the card', () => {
    const out = wrapSvgForIconCard('<svg viewBox="0 0 96 96"><g><path d="M2 2" /></g></svg>', 'icon-1', 'G', 240, 154);
    expect(out).toContain('data-graphic="true"');
    expect(out).toContain('width: "240px"');
    expect(out).toContain('height: "154px"');
  });
});

describe('svgIntrinsicSize', () => {
  it('reads the viewBox aspect', () => {
    expect(svgIntrinsicSize('<svg viewBox="0 0 780 500"><path d="M1 1"/></svg>')).toEqual({ w: 780, h: 500 });
  });
  it('falls back to width/height attrs, then to a square card', () => {
    expect(svgIntrinsicSize('<svg width="32" height="16"><path d="M1 1"/></svg>')).toEqual({ w: 32, h: 16 });
    expect(svgIntrinsicSize('<svg><path d="M1 1"/></svg>')).toEqual({ w: 240, h: 240 });
  });
});

describe('preflightSvgFiles — guardrails', () => {
  it('accepts real SVGs and skips mislabeled/oversized/unreadable files', async () => {
    const big = svgFile('huge.svg', '<svg>' + 'x'.repeat(600 * 1024) + '</svg>');
    const fake = svgFile('fake.svg', 'this is actually a text file');
    const good = svgFile('arrow-left.svg', '<svg viewBox="0 0 24 24"><path d="M1 1" /></svg>');
    const res = await preflightSvgFiles([good, fake, big]);
    expect(res.valid).toHaveLength(1);
    expect(res.valid[0].label).toBe('arrow left');
    expect(res.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining(['not valid SVG', 'too large (max 512KB)']),
    );
  });

  it('caps a drop at the per-set icon limit', async () => {
    const files = Array.from({ length: MAX_ICONS_PER_SET + 5 }, (_, i) =>
      svgFile(`i${i}.svg`, '<svg viewBox="0 0 24 24"><path d="M1 1" /></svg>'));
    const res = await preflightSvgFiles(files);
    expect(res.valid).toHaveLength(MAX_ICONS_PER_SET);
    expect(res.skipped).toHaveLength(5);
    expect(res.skipped[0].reason).toContain('limit');
  });

  it('content-sniffs regardless of extension', () => {
    expect(looksLikeSvg('<svg viewBox="0 0 1 1"></svg>')).toBe(true);
    expect(looksLikeSvg('%PDF-1.4 not an svg')).toBe(false);
  });
});

describe('createVectorSetFromSvgs — end to end', () => {
  beforeEach(() => {
    resetProjectFS(new Map());
  });

  it('builds a parseable @iconSet file from preflighted entries', async () => {
    const res = await createVectorSetFromSvgs('Arrows', [
      { label: 'arrow left', text: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6" /></svg>' },
      { label: 'arrow right', text: '<svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6" style="fill:none;stroke:#111" /></svg>' },
    ]);
    expect(res).not.toBeNull();
    expect(res!.iconCount).toBe(2);
    const code = projectFS.readFile(res!.iconSetFilePath)!;
    expect(isIconSetCode(code)).toBe(true);
    expect(code).toContain('@name "Arrows"');
    // the generated file must parse as JSX — the whole point of sanitizing
    expect(parseJSX(code)).not.toBeNull();
    // plain-path icons convert to NATIVE editable shapes — the style="…"
    // string resolves into real presentation attrs on the emitted path
    expect(code).toContain('stroke="#111"');
    expect(code).not.toContain('data-graphic');
  });

  it('converts plain icons to native editable shapes (double-click = shape edit)', async () => {
    // A pinwheel-style icon: rotated arc petals inside a <g> — the worst case
    // (transforms + arcs + primitives). Must land as an editor GROUP whose
    // children are plain path shapes with 1:1 viewBoxes and no transforms.
    const pinwheel = `<svg viewBox="0 0 96 96"><g fill="#D92D20">
      <path d="M52 44L52 12A32 32 0 0 1 84 44Z" transform="rotate(0 48 48)"/>
      <path d="M52 44L52 12A32 32 0 0 1 84 44Z" transform="rotate(90 48 48)"/>
      <rect x="40" y="40" width="16" height="16" rx="4"/>
    </g></svg>`;
    const res = await createVectorSetFromSvgs('Pin', [{ label: 'pinwheel', text: pinwheel }]);
    const code = projectFS.readFile(res!.iconSetFilePath)!;
    expect(parseJSX(code)).not.toBeNull();
    expect(code).not.toContain('data-graphic');
    expect(code).not.toContain('transform=');
    const nodes = parseJSXToNodes(code);
    // The card's child is a GROUP svg with svg children → the canvas's
    // double-click routes it to group-edit isolation, and each child (plain
    // path wrapper, no svg children) routes to shape edit.
    const card = nodes.get('icon-1')!;
    const groupId = card.children.find(cid => nodes.get(cid)?.type === 'svg')!;
    const group = nodes.get(groupId)!;
    const svgKids = group.children.filter(cid => nodes.get(cid)?.type === 'svg');
    expect(svgKids.length).toBe(3);
    for (const cid of svgKids) {
      const child = nodes.get(cid)!;
      const grandSvgs = child.children.filter(g => nodes.get(g)?.type === 'svg');
      expect(grandSvgs).toHaveLength(0); // leaf shape → shape-edit target
      const pathChild = child.children.map(g => nodes.get(g)!).find(n => n?.type === 'path');
      expect(pathChild).toBeDefined();
      expect(pathChild!.attrs.d).toBeTruthy();
      expect(pathChild!.attrs.transform).toBeUndefined();
    }
  });

  it('returns null when nothing valid is provided', async () => {
    expect(await createVectorSetFromSvgs('Empty', [])).toBeNull();
  });

  it('lays cards out as a grid with gaps — never a pile at x:0', async () => {
    // Regression: `leftPx: 0` passed through `??` in buildIconSetFile, so
    // EVERY card landed at x:0 y:0 and the dropped set rendered as one
    // overlapping pile.
    const icon = (d: string) => ({ label: d, text: `<svg viewBox="0 0 24 24"><path d="M1 1" /></svg>` });
    const res = await createVectorSetFromSvgs('Grid', Array.from({ length: 8 }, (_, i) => icon(`i${i}`)));
    const code = projectFS.readFile(res!.iconSetFilePath)!;
    // 8 icons → 3 columns (square-ish wrap): icon-2 sits one card+gap right,
    // icon-4 wraps to the second row.
    expect(code).toMatch(/name: 'icon-2', label: 'i1', x: 280, y: 0/);
    expect(code).toMatch(/name: 'icon-4', label: 'i3', x: 0, y: 280/);
    // ≤6 icons stay on one row
    const row = await createVectorSetFromSvgs('Row', [icon('a'), icon('b'), icon('c')]);
    const rowCode = projectFS.readFile(row!.iconSetFilePath)!;
    expect(rowCode).toMatch(/name: 'icon-3', label: 'c', x: 560, y: 0/);
  });

  it('sizes each card to the vector aspect so the icon fits its frame', async () => {
    const res = await createVectorSetFromSvgs('Badges', [
      { label: 'badge', text: '<svg viewBox="0 0 780 500"><rect width="780" height="500" /></svg>' },
    ]);
    const code = projectFS.readFile(res!.iconSetFilePath)!;
    expect(code).toMatch(/name: 'icon-1', label: 'badge', x: 0, y: 0, width: 240, height: 154/);
    expect(code).toContain('width: "240px"');
    expect(code).toContain('height: "154px"');
  });

  it('parses dropped icons as opaque graphics — defs survive, no child nodes', async () => {
    // Regression: clipPath/defs/mask aren't renderable node types (clipPath
    // became a <div>, so clipped shapes painted UNCLIPPED and spilled far
    // outside their cards). Graphic svgs keep children as raw markup.
    const clipped = `<svg viewBox="0 0 96 96"><g fill="#D92D20"><clipPath id="c"><circle cx="48" cy="48" r="42"/></clipPath><g clip-path="url(#c)"><rect x="-24" y="2" width="144" height="15"/></g></g></svg>`;
    const res = await createVectorSetFromSvgs('Clips', [{ label: 'striped circle', text: clipped }]);
    const code = projectFS.readFile(res!.iconSetFilePath)!;
    const nodes = parseJSXToNodes(code);
    const svgNode = nodes.get('shape-icon-1-default')!;
    expect(svgNode).toBeDefined();
    expect(svgNode.children).toHaveLength(0);
    expect(svgNode.graphicMarkup).toContain('<clipPath id="c">');
    expect(svgNode.graphicMarkup).toContain('clip-path="url(#c)"');
    expect(svgNode.graphicMarkup).toContain('<rect x="-24"');
    // no clipPath NODE was created
    expect([...nodes.values()].some(n => n.type === 'clipPath')).toBe(false);
  });

  it('round-trips JSX style objects and camel attrs back to real SVG markup', async () => {
    // The sanitizer turns `style="…"` into JSX objects (React needs that on
    // the live site); the parser's graphic serializer must convert them BACK
    // to css text for canvas innerHTML injection, and map React-renamed
    // attrs (strokeWidth) to their SVG names — while leaving natively-camel
    // SVG attrs (gradientUnits) untouched.
    const fancy = `<svg viewBox="0 0 24 24"><defs><linearGradient id="g" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M1 1" fill="url(#g)" style="stroke:#111;stroke-width:2" stroke-linecap="round"/></svg>`;
    const res = await createVectorSetFromSvgs('Fancy', [{ label: 'grad', text: fancy }]);
    const code = projectFS.readFile(res!.iconSetFilePath)!;
    expect(parseJSX(code)).not.toBeNull();
    const svgNode = parseJSXToNodes(code).get('shape-icon-1-default')!;
    expect(svgNode.graphicMarkup).toContain('gradientUnits="userSpaceOnUse"');
    expect(svgNode.graphicMarkup).toContain('stop-color="#fff"');
    expect(svgNode.graphicMarkup).toContain('style="stroke: #111; stroke-width: 2"');
    expect(svgNode.graphicMarkup).toContain('stroke-linecap="round"');
    expect(svgNode.graphicMarkup).toContain('fill="url(#g)"');
  });
});
