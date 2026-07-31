// STATIC_TEMPLATE_STYLE — a backtick style value with no ${} interpolation is
// a static string the CANVAS skips (treated as a dynamic binding) while the
// live site renders it: images blank in the editor, fine deployed (the Grace
// Walker rebuild live-find). The gate must bounce it.
import { describe, it, expect } from 'vitest';
import { checkFile } from './check-file';

const wrap = (styleLine: string) => `export default function Page() {
  return <div data-id="root" style={{ width: '100%' }}>
    <div data-id="card" style={{
      position: 'relative', width: '100%', height: '200px',
      ${styleLine}
    }} />
  </div>;
}`;

describe('STATIC_TEMPLATE_STYLE', () => {
  it('bounces a static backtick backgroundImage', () => {
    const v = checkFile(wrap('backgroundImage: `url(https://assets.revyme.app/x.webp)`,'), { kind: 'page' });
    expect(v.some((x) => x.code === 'STATIC_TEMPLATE_STYLE')).toBe(true);
  });

  it('bounces any static backtick value, not just images', () => {
    const v = checkFile(wrap('boxShadow: `0 4px 12px rgba(0,0,0,0.2)`,'), { kind: 'page' });
    expect(v.some((x) => x.code === 'STATIC_TEMPLATE_STYLE')).toBe(true);
  });

  it('allows a genuinely dynamic template literal (CMS binding)', () => {
    const code = `import blog from '@/cms/blog.json';
export default function Page() {
  return <div data-id="root" style={{ width: '100%' }}>
    {blog.map((item, idx) => (
      <div data-id="row" key={idx} style={{
        position: 'relative', width: '100%', height: '200px',
        backgroundImage: \`url(\${item.image})\`
      }} />
    ))}
  </div>;
}`;
    const v = checkFile(code, { kind: 'page' });
    expect(v.some((x) => x.code === 'STATIC_TEMPLATE_STYLE')).toBe(false);
  });

  it('quoted static strings stay clean', () => {
    const v = checkFile(wrap("backgroundImage: 'url(https://assets.revyme.app/x.webp)',"), { kind: 'page' });
    expect(v.some((x) => x.code === 'STATIC_TEMPLATE_STYLE')).toBe(false);
  });
});
