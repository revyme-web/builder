// Banded @media head format + :lang cascade-order rules.
import { describe, it, expect } from 'vitest';
import { checkFile } from '../check-file';

const CANVAS = `/** @canvas {
  "viewports": [
    { "id": "desktop", "label": "Desktop", "width": 1440, "isPrimary": true, "order": 0 },
    { "id": "tablet", "label": "Tablet", "width": 768, "isPrimary": false, "order": 1 },
    { "id": "mobile", "label": "Mobile", "width": 375, "isPrimary": false, "order": 2 }
  ],
  "positions": { "desktop": { "x": 0, "y": 0 }, "tablet": { "x": 1560, "y": 0 }, "mobile": { "x": 2450, "y": 0 } }
} */`;

const page = (css: string) => `${CANVAS}
'use client';
export default function Page() {
  return (<div data-id="root" style={{ width: '100%', position: 'relative' }}>
    <style>{\`${css}\`}</style>
  </div>);
}
`;

const codes = (code: string) => checkFile(code, { kind: 'page', path: 'app/page.client.tsx' }).map(x => x.code);
const find = (code: string, c: string) => checkFile(code, { kind: 'page', path: 'app/page.client.tsx' }).find(x => x.code === c);

describe('MEDIA_BAND_LOWER_BOUND', () => {
  it('fractional lower bounds pass', () => {
    expect(codes(page(`
@media (max-width: 768px) and (min-width: 375.02px) { [data-id="root"] { padding: 8px !important; } }
@media (max-width: 375px) { [data-id="root"] { padding: 4px !important; } }
`))).not.toContain('MEDIA_BAND_LOWER_BOUND');
  });

  it('integer INCLUSIVE lower bound is flagged with the exact fix', () => {
    const viol = find(page(`
@media (max-width: 768px) and (min-width: 375px) { [data-id="root"] { padding: 8px !important; } }
`), 'MEDIA_BAND_LOWER_BOUND');
    expect(viol).toBeTruthy();
    expect(viol!.message).toContain('375.02px');
  });

  it('the legacy +1 lower bound is flagged too', () => {
    const viol = find(page(`
@media (max-width: 768px) and (min-width: 376px) { [data-id="root"] { padding: 8px !important; } }
`), 'MEDIA_BAND_LOWER_BOUND');
    expect(viol).toBeTruthy();
    expect(viol!.message).toContain('375.02px');
  });

  it('bare max-width (mobile/cascade) heads are untouched', () => {
    expect(codes(page(`
@media (max-width: 768px) { [data-id="root"] { padding: 8px !important; } }
`))).not.toContain('MEDIA_BAND_LOWER_BOUND');
  });
});

describe('MEDIA_TOP_BAND_CAPPED', () => {
  it('bands below the widest breakpoint pass', () => {
    expect(codes(page(`
@media (max-width: 768px) and (min-width: 375.02px) { [data-id="root"] { padding: 8px !important; } }
@media (max-width: 375px) { [data-id="root"] { padding: 4px !important; } }
`))).not.toContain('MEDIA_TOP_BAND_CAPPED');
  });

  it('a band capping the widest breakpoint is flagged (the >cap leak)', () => {
    const viol = find(page(`
@media (max-width: 1440px) and (min-width: 768.02px) { [data-id="root"] { display: none !important; } }
`), 'MEDIA_TOP_BAND_CAPPED');
    expect(viol).toBeTruthy();
    expect(viol!.message).toContain('1440');
    expect(viol!.message).toContain('BASE styles');
  });

  it('a bare max-width band at the widest breakpoint is flagged too', () => {
    expect(codes(page(`
@media (max-width: 1440px) { [data-id="root"] { padding: 0 !important; } }
`))).toContain('MEDIA_TOP_BAND_CAPPED');
  });

  it('a cap above every breakpoint is flagged as well', () => {
    expect(codes(page(`
@media (max-width: 1600px) { [data-id="root"] { padding: 0 !important; } }
`))).toContain('MEDIA_TOP_BAND_CAPPED');
  });
});

describe('DUPLICATE_BREAKPOINT_SECTION', () => {
  const dupPage = (sectionStyle: string, css: string) => `${CANVAS}
'use client';
export default function Page() {
  return (<div data-id="root" style={{ width: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
    <style>{\`${css}\`}</style>
    <div data-id="hero-tablet" data-name="Hero/T" style={{ ${sectionStyle} }}>
      <p data-id="t1">Hi</p>
    </div>
  </div>);
}
`;

  it('fixed viewport-width root section display-toggled in bands is flagged', () => {
    const viol = find(dupPage(
      `width: '768px', display: 'flex', position: 'relative'`,
      `@media (max-width: 768px) and (min-width: 375.02px) { [data-id="hero-tablet"] { display: flex !important; } }`,
    ), 'DUPLICATE_BREAKPOINT_SECTION');
    expect(viol).toBeTruthy();
    expect(viol!.message).toContain('Hero/T');
    expect(viol!.message).toContain('768px');
  });

  it('fluid root section with display toggles passes', () => {
    expect(codes(dupPage(
      `width: '100%', display: 'flex', position: 'relative'`,
      `@media (max-width: 768px) and (min-width: 375.02px) { [data-id="hero-tablet"] { display: none !important; } }`,
    ))).not.toContain('DUPLICATE_BREAKPOINT_SECTION');
  });

  it('fixed viewport-width section WITHOUT display toggles passes', () => {
    expect(codes(dupPage(
      `width: '768px', display: 'flex', position: 'relative'`,
      `@media (max-width: 768px) and (min-width: 375.02px) { [data-id="hero-tablet"] { padding: 4px !important; } }`,
    ))).not.toContain('DUPLICATE_BREAKPOINT_SECTION');
  });

  it('non-root descendants with viewport widths are not flagged', () => {
    expect(codes(`${CANVAS}
'use client';
export default function Page() {
  return (<div data-id="root" style={{ width: '100%', position: 'relative', display: 'flex' }}>
    <style>{\`@media (max-width: 768px) { [data-id="inner"] { display: none !important; } }\`}</style>
    <div data-id="wrap" data-name="Wrap" style={{ width: '100%', display: 'flex', position: 'relative' }}>
      <div data-id="inner" data-name="Inner" style={{ width: '768px', display: 'flex', position: 'relative' }}>
        <p data-id="t2">Hi</p>
      </div>
    </div>
  </div>);
}
`)).not.toContain('DUPLICATE_BREAKPOINT_SECTION');
  });
});

describe('LANG_RULE_ORDER', () => {
  it('global :lang before bands passes', () => {
    expect(codes(page(`
:lang(fr) [data-id="root"] { background-color: #111 !important; }
@media (max-width: 768px) and (min-width: 375.02px) { :lang(fr) [data-id="root"] { background-color: #222 !important; } }
`))).not.toContain('LANG_RULE_ORDER');
  });

  it('global :lang AFTER a band is flagged', () => {
    expect(codes(page(`
@media (max-width: 768px) and (min-width: 375.02px) { :lang(fr) [data-id="root"] { background-color: #222 !important; } }
:lang(fr) [data-id="root"] { background-color: #111 !important; }
`))).toContain('LANG_RULE_ORDER');
  });

  it(':lang nested inside a band does not count as global', () => {
    expect(codes(page(`
@media (max-width: 375px) { :lang(fr) [data-id="root"] { color: #fff !important; } }
`))).not.toContain('LANG_RULE_ORDER');
  });
});
