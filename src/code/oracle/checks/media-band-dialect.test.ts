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
