import { describe, test, expect } from 'vitest';
import { parseJSXToNodes } from './parser';

// WHOLE-VALUE image binding: `coverImage={`url(${item.coverImage})`}` — written by
// Make Component on CMS cards + the panel's image bind. The master binds the prop
// BARE (`backgroundImage: coverImage`, values carry the url() wrap), the CMS field
// holds a PLAIN url, so the instance wraps at the binding site. The parser must
// record it as a propBinding (blue pill via getBindingForProperty + ghost
// substitution via expandComponent/CodeComponentHost) with `urlWrap` so consumers
// that pass the RAW field value re-apply the wrap.
describe('parser: whole-value url-wrapped instance prop → propBindings', () => {
  const CODE = `export default function Page() {
  const works = [
    {"coverImage":"https://pic/1.jpg","title2":"Neon"},
    {"coverImage":"https://pic/2.jpg","title2":"Dusk"},
  ];
  return (
    <div data-id="root">
      {works.map((item, index) => (
        <CoKaGo key={index} data-id="col-a-card" coverImage={\`url(\${item.coverImage})\`} title2={item.title2} />
      ))}
    </div>
  );
}`;

  test('records the wrapped binding with urlWrap, alongside plain bindings', () => {
    const node = parseJSXToNodes(CODE).get('col-a-card');
    expect(node?.propBindings).toEqual(expect.arrayContaining([
      { prop: 'coverImage', field: 'coverImage', urlWrap: true },
      { prop: 'title2', field: 'title2' },
    ]));
  });

  test('a non-url template (slug link) is NOT recorded as a binding', () => {
    const code = CODE.replace('coverImage={`url(${item.coverImage})`}', 'linkHref={`/works/${item._slug}`}');
    const node = parseJSXToNodes(code).get('col-a-card');
    expect(node?.propBindings?.some((b) => b.prop === 'linkHref')).toBeFalsy();
  });

  test('a template over a NON-iterator identifier is NOT recorded', () => {
    const code = CODE.replace('coverImage={`url(${item.coverImage})`}', 'coverImage={`url(${other.coverImage})`}');
    const node = parseJSXToNodes(code).get('col-a-card');
    expect(node?.propBindings?.some((b) => b.prop === 'coverImage')).toBeFalsy();
  });
});
