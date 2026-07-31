// Verifies the CMS collection-row Link ↔ div round-trip that the Link tool's
// slug/URL handlers dispatch (LinkTool/index.tsx). A CMS row is a <Link> ONLY
// while it has a navigation target; pressing X on the "This Row" slug (or
// clearing the URL) must revert it to a plain <div> — a href-less next/link
// crashes at SSR (resolveHref → formatWithValidation(undefined) → reads
// `.pathname` of undefined → deployed Worker throws Error 1101 / blank page).

import { describe, it, expect } from 'vitest';
import { setCmsNavHrefInCode } from './map-gen';
import { changeTagInCode } from './generator-attrs';

const LINK_ROW = `export default function Page() {
  return <div data-id="frame-1">
    {collection1.map((item, idx) => <Link data-cms-nav="row" href={\`/collection-1/\${item?._slug ?? ''}\`} data-id="row-1" key={idx} style={{ display: 'flex', textDecoration: "none", color: "inherit" }} data-name="FAQ"><h3 data-id="h-1">{item.title}</h3></Link>)}
  </div>;
}`;

function rowTag(code: string): string {
  const i = code.indexOf('data-id="row-1"');
  return code.slice(code.lastIndexOf('<', i), code.indexOf('>', i) + 1);
}

describe('CMS collection row Link ↔ div revert (LinkTool slug X)', () => {
  it('X on slug → setCmsNavHref(none) + changeTag(div): clean div, no href, no crash marker', () => {
    // handleSlugChange('none') dispatches setCmsNavHref('none') then (new) revert.
    let code = setCmsNavHrefInCode(LINK_ROW, 'row-1', 'none', 'collection-1', 'item');
    code = changeTagInCode(code, 'row-1', 'div');

    const tag = rowTag(code);
    expect(tag).toMatch(/^<div\b/);          // tag renamed
    expect(tag).not.toMatch(/href=/);         // no href → resolveHref can't run
    expect(tag).not.toMatch(/data-cms-nav/);  // marker stripped
    // closing tag renamed too (the map row closes with `)}` right after)
    expect(code).toContain('</div>)}');
    // the child is untouched
    expect(code).toContain('<h3 data-id="h-1">{item.title}</h3>');
  });

  it('re-add slug → changeTag(Link) + setCmsNavHref(row): back to a linked row', () => {
    // Start from the reverted div, then handleSlugChange('row').
    let code = setCmsNavHrefInCode(LINK_ROW, 'row-1', 'none', 'collection-1', 'item');
    code = changeTagInCode(code, 'row-1', 'div');
    // now re-link it
    code = changeTagInCode(code, 'row-1', 'Link');
    code = setCmsNavHrefInCode(code, 'row-1', 'row', 'collection-1', 'item');

    const tag = rowTag(code);
    expect(tag).toMatch(/^<Link\b/);
    expect(tag).toContain('data-cms-nav="row"');
    expect(tag).toMatch(/href=\{`\/collection-1\/\$\{item\?\._slug/);
  });

  it('idempotent: reverting an already-plain div is a no-op on the tag', () => {
    // revertLinkToDivMutations early-returns for a non-link; changeTag on a div→div
    // is a no-op (oldTag === newTag).
    const asDiv = changeTagInCode(
      setCmsNavHrefInCode(LINK_ROW, 'row-1', 'none', 'collection-1', 'item'),
      'row-1',
      'div',
    );
    expect(changeTagInCode(asDiv, 'row-1', 'div')).toBe(asDiv);
  });
});
