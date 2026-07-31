import { describe, it, expect } from 'vitest';
import { bindCmsFieldOnDropInCode } from './map-gen';

const CODE_INSIDE_MAP = `
function Page() {
  const cardData = [{ title: 'a' }, { title: 'b' }];
  return (
    <div data-id="root">
      {cardData.map((item, idx) => (
        <div data-id="card" key={idx}>
          <p data-id="cms-title-1" data-cms-field="articles:title" style={{fontSize: '16px'}}>title</p>
        </div>
      ))}
    </div>
  );
}
`;

const CODE_OUTSIDE_MAP = `
function Page() {
  return (
    <div data-id="root">
      <p data-id="cms-title-1" data-cms-field="articles:title" style={{fontSize: '16px'}}>title</p>
    </div>
  );
}
`;

const CODE_CUSTOM_ITERATOR = `
function Page() {
  const articles = [{ headline: 'x' }];
  return (
    <div data-id="root">
      {articles.map((post, i) => (
        <div data-id="card" key={i}>
          <p data-id="cms-h-1" data-cms-field="articles:headline" style={{}}>headline</p>
        </div>
      ))}
    </div>
  );
}
`;

describe('bindCmsFieldOnDropInCode', () => {
  it('rewrites text to iterator binding when inside a .map()', () => {
    const out = bindCmsFieldOnDropInCode(CODE_INSIDE_MAP, 'cms-title-1');
    expect(out).toContain('{item.title}');
    expect(out).not.toContain('data-cms-field');
    // Original placeholder text is gone
    expect(out).not.toMatch(/>\s*title\s*</);
  });

  it('uses the custom iterator variable name (not always "item")', () => {
    const out = bindCmsFieldOnDropInCode(CODE_CUSTOM_ITERATOR, 'cms-h-1');
    expect(out).toContain('{post.headline}');
    expect(out).not.toContain('{item.headline}');
  });

  it('is a no-op when there is no enclosing .map() ancestor', () => {
    const out = bindCmsFieldOnDropInCode(CODE_OUTSIDE_MAP, 'cms-title-1');
    expect(out).toBe(CODE_OUTSIDE_MAP);
    expect(out).toContain('data-cms-field');
  });

  it('is a no-op when the node id does not exist', () => {
    const out = bindCmsFieldOnDropInCode(CODE_INSIDE_MAP, 'nope');
    expect(out).toBe(CODE_INSIDE_MAP);
  });

  it('is a no-op when the node has no data-cms-field attr', () => {
    const code = CODE_INSIDE_MAP.replace(/\s*data-cms-field="[^"]+"/, '');
    const out = bindCmsFieldOnDropInCode(code, 'cms-title-1');
    expect(out).toBe(code);
  });

  it('does not bind to a sibling map (only the enclosing one)', () => {
    const code = `
function Page() {
  const a = [{}], b = [{}];
  return (
    <div data-id="root">
      {a.map((aItem, i) => (<div data-id="ax" key={i}><span>x</span></div>))}
      <p data-id="cms-y" data-cms-field="b:label" data-cms-bind-target="text" style={{}}>label</p>
    </div>
  );
}
`;
    // The dropped <p> sits OUTSIDE the a.map(), so no binding should fire
    // even though there's a `.map()` earlier in the source.
    const out = bindCmsFieldOnDropInCode(code, 'cms-y');
    expect(out).toBe(code);
  });

  it('binds an image field to the src attribute (data-cms-bind-target="src")', () => {
    const code = `
function Page() {
  const a = [{cover: 'x.jpg'}];
  return (
    <div data-id="root">
      {a.map((item, i) => (
        <div data-id="card" key={i}>
          <img data-id="img-1" data-cms-field="articles:cover" data-cms-bind-target="src" src="" alt="" style={{width:'200px'}} />
        </div>
      ))}
    </div>
  );
}`;
    const out = bindCmsFieldOnDropInCode(code, 'img-1');
    expect(out).toContain('src={item.cover}');
    expect(out).not.toContain('data-cms-field');
    expect(out).not.toContain('data-cms-bind-target');
    // Original src="" placeholder is gone
    expect(out).not.toMatch(/src=""/);
  });

  it('binds a link field to the href attribute (data-cms-bind-target="href")', () => {
    const code = `
function Page() {
  const a = [{url: '/x'}];
  return (
    <div data-id="root">
      {a.map((item, i) => (
        <div data-id="card" key={i}>
          <a data-id="lnk-1" data-cms-field="articles:url" data-cms-bind-target="href" href="#" style={{color:'#3b82f6'}}>Link</a>
        </div>
      ))}
    </div>
  );
}`;
    const out = bindCmsFieldOnDropInCode(code, 'lnk-1');
    expect(out).toContain('href={item.url}');
    expect(out).not.toMatch(/href="#"/);
    expect(out).not.toContain('data-cms-bind-target');
    // The visible text content is unchanged for href targets — we only
    // bound the attribute.
    expect(out).toContain('>Link</a>');
  });

  it('binds to top-level `item` on a CMS detail page when no .map() ancestor exists', () => {
    // Detail-page template — `const item = blog.find(…)` at function
    // scope, no .map() in sight. Drops still bind because the page
    // already has `item` available as the per-page record.
    const code = `
import blog from '@/cms/blog.json';
function Page() {
  const params = useParams();
  const item = blog.find((i) => i._slug === params?.slug) ?? blog[0];
  return (
    <div data-id="root">
      <p data-id="cms-t-1" data-cms-field="blog:title" data-cms-bind-target="text" style={{}}>title</p>
    </div>
  );
}`;
    const out = bindCmsFieldOnDropInCode(code, 'cms-t-1');
    expect(out).toContain('{item.title}');
    expect(out).not.toContain('data-cms-field');
    expect(out).not.toMatch(/>\s*title\s*</);
  });

  it('binds a color field to a style property (data-cms-bind-target="style:backgroundColor")', () => {
    const code = `
function Page() {
  const a = [{accent: '#ff0'}];
  return (
    <div data-id="root">
      {a.map((item, i) => (
        <div data-id="card" key={i}>
          <div data-id="sw-1" data-cms-field="articles:accent" data-cms-bind-target="style:backgroundColor" style={{width:'48px',height:'48px',backgroundColor:'#ccc'}} />
        </div>
      ))}
    </div>
  );
}`;
    const out = bindCmsFieldOnDropInCode(code, 'sw-1');
    expect(out).toMatch(/backgroundColor:\s*item\.accent/);
    expect(out).not.toMatch(/backgroundColor:\s*'#ccc'/);
    expect(out).not.toContain('data-cms-bind-target');
  });
});
