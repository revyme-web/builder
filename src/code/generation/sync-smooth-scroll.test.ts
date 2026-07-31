import { describe, test, expect } from 'vitest';
import { syncLinkHandlerInCode } from './generator-styles';

describe('syncLinkHandlerInCode', () => {
  test('variable href + variable smooth → smooth/auto per the flag', () => {
    const code = `<MotionLink data-id="lnk" href={linkHref} data-smooth-scroll={smooth ? "true" : undefined}></MotionLink>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).toMatch(/onClick=\{/);
    expect(r).toContain("String((linkHref) ?? '')");
    // Always scrolls when there's a hash; behavior reads the RESOLVED `data-smooth-scroll` at runtime
    // (value-independent → honours per-viewport overrides on the attr).
    expect(r).toContain('if (_id)');
    expect(r).toContain("behavior: (e.currentTarget.dataset.smoothScroll === 'true') ? 'smooth' : 'auto'");
  });

  test('literal anchor href with NO smooth → instant scroll (behavior auto)', () => {
    const code = `<MotionLink data-id="lnk" href="/#fffff"></MotionLink>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).toMatch(/onClick=\{/);
    expect(r).toContain('String(("/#fffff") ?? \'\')');
    // No smooth flag → guard is `false` → behavior 'auto' (instant), but it
    // STILL scrolls (the native hash nav is unreliable).
    expect(r).toContain("behavior: (e.currentTarget.dataset.smoothScroll === 'true') ? 'smooth' : 'auto'");
  });

  test('literal anchor href + literal smooth "true" → smooth', () => {
    const code = `<a data-id="lnk" href="/#x" data-smooth-scroll="true"></a>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).toMatch(/onClick=\{/);
    expect(r).toContain("behavior: (e.currentTarget.dataset.smoothScroll === 'true') ? 'smooth' : 'auto'");
  });

  test('does NOT inject for a non-anchor literal href (plain navigation)', () => {
    const code = `<MotionLink data-id="lnk" href="/about"></MotionLink>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).not.toMatch(/onClick=\{/);
  });

  test('variable href with no smooth → still injects (may be an anchor at runtime)', () => {
    const code = `<MotionLink data-id="lnk" href={linkHref}></MotionLink>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).toMatch(/onClick=\{/);
    expect(r).toContain("behavior: (e.currentTarget.dataset.smoothScroll === 'true') ? 'smooth' : 'auto'");
  });

  test('does NOT inject when there is no href', () => {
    const code = `<MotionLink data-id="lnk"></MotionLink>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).not.toMatch(/onClick=\{/);
  });

  test('idempotent — re-sync does not stack multiple onClick handlers', () => {
    const code = `<MotionLink data-id="lnk" href={linkHref} data-smooth-scroll={smooth ? "true" : undefined}></MotionLink>`;
    const once = syncLinkHandlerInCode(code, 'lnk');
    const twice = syncLinkHandlerInCode(once, 'lnk');
    expect((twice.match(/onClick=\{/g) || []).length).toBe(1);
    expect(once).toBe(twice);
  });

  test('keep-params (literal) → forwards the current query via location.assign', () => {
    const code = `<a data-id="lnk" href="/next" data-keep-params="true"></a>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).toMatch(/onClick=\{/);
    expect(r).toContain('window.location.search');
    expect(r).toContain('window.location.assign');
    expect(r).toContain('if ((true) &&');
  });

  test('keep-params variable → uses the prop as the guard', () => {
    const code = `<MotionLink data-id="lnk" href={linkHref} data-keep-params={keepParams ? "true" : undefined}></MotionLink>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).toMatch(/onClick=\{/);
    expect(r).toContain('if ((keepParams ? "true" : undefined) &&');
  });

  test('non-anchor href + no keep-params → no handler', () => {
    const code = `<a data-id="lnk" href="/next"></a>`;
    expect(syncLinkHandlerInCode(code, 'lnk')).not.toMatch(/onClick=\{/);
  });

  test('removes the handler when the href stops being an anchor', () => {
    const withHandler = syncLinkHandlerInCode(
      `<a data-id="lnk" href="/#x"></a>`,
      'lnk',
    );
    expect(withHandler).toMatch(/onClick=\{/);
    // href changed to a non-anchor literal → handler removed.
    const plain = withHandler.replace('href="/#x"', 'href="/about"');
    const r = syncLinkHandlerInCode(plain, 'lnk');
    expect(r).not.toMatch(/onClick=\{/);
  });

  // ─── user-authored onClick must survive an href edit (the wiped-event bug) ──
  test('PRESERVES a user onClick={event2} when setting a plain (non-anchor) href', () => {
    const code = `<MotionLink data-id="find-btn" href="jjjoj" onClick={event2}>Find an advisor</MotionLink>`;
    const r = syncLinkHandlerInCode(code, 'find-btn');
    expect(r).toContain('onClick={event2}');   // user handler kept
    expect(r).not.toContain('scrollIntoView');  // no managed handler injected
    expect(r).toBe(code);                        // nothing changed at all
  });

  test('PRESERVES a user inline-arrow onClick on a plain link', () => {
    const code = `<a data-id="lnk" href="/about" onClick={() => setOpen(false)}></a>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).toContain('onClick={() => setOpen(false)}');
    expect(r).not.toContain('scrollIntoView');
  });

  test('MERGES a user onClick into the managed handler for an anchor link (one onClick, user runs first)', () => {
    const code = `<a data-id="lnk" href="/#x" onClick={event2}></a>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect((r.match(/onClick=\{/g) || []).length).toBe(1); // a link carries one onClick
    expect(r).toContain('(event2)?.(e);');                  // user handler called first
    expect(r).toContain('scrollIntoView');                  // managed anchor logic present
  });

  test('COMPOSES a forwarded {...rest} onClick on a component-root link (instance Tap/Close-Overlay)', () => {
    const code = `<MotionLink data-id="lnk" {...rest} href={linkHref} data-name="Frame">x</MotionLink>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect((r.match(/onClick=\{/g) || []).length).toBe(1); // one onClick on the element
    expect(r).toContain('(rest.onClick)?.(e);');            // forwarded instance onClick composed
    expect(r).toContain('scrollIntoView');                  // managed link logic still present
  });

  test('forwarded-onClick composition is idempotent (re-sync keeps ONE rest.onClick call)', () => {
    const code = `<MotionLink data-id="lnk" {...rest} href={linkHref}>x</MotionLink>`;
    const once = syncLinkHandlerInCode(code, 'lnk');
    const twice = syncLinkHandlerInCode(once, 'lnk');
    expect(twice).toBe(once);
    expect((twice.match(/rest\.onClick/g) || []).length).toBe(1);
  });

  test('does NOT compose a forwarded onClick when the tag has no spread (plain page link)', () => {
    const code = `<a data-id="lnk" href={to}>x</a>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect(r).toContain('scrollIntoView');       // managed handler injected (variable href)
    expect(r).not.toContain('.onClick)?.(e)');   // but nothing forwarded to compose
  });

  test('composes BOTH a source onClick and a forwarded {...rest} onClick', () => {
    const code = `<MotionLink data-id="lnk" {...rest} href={linkHref} onClick={event2}>x</MotionLink>`;
    const r = syncLinkHandlerInCode(code, 'lnk');
    expect((r.match(/onClick=\{/g) || []).length).toBe(1);
    expect(r).toContain('(event2)?.(e);');       // source handler
    expect(r).toContain('(rest.onClick)?.(e);'); // forwarded instance handler
  });
});

// Cross-page hash links: the managed handler must hijack ONLY when the
// anchor element exists on this page. From another route (/blog → /#features)
// the old unconditional preventDefault + `getElementById(...)?.` swallowed
// the click and the nav link appeared dead (the SiteHeader report).
import { describe as _d2, test as _t2, expect as _e2 } from 'vitest';
import { setSmoothScrollInCode as _sss, syncLinkHandlerInCode as _slh } from './generator-styles';

_d2('managed link handler cross-page fallthrough', () => {
  const BASE = `export default function C() {
  return <MotionLink data-id="nav-feat" href="/#features" style={{ color: '#fff' }}>Features</MotionLink>;
}`;
  _t2('guards preventDefault behind an element-exists check', () => {
    const out = _slh(_sss(BASE, 'nav-feat', true), 'nav-feat');
    const handler = out.slice(out.indexOf('onClick={'));
    expect(handler).toContain("const _el = document.getElementById(_id)");
    expect(handler).toContain('if (_el) { e.preventDefault(); _el.scrollIntoView(');
    // no unconditional optional-chained scroll that eats the click on a miss
    expect(handler).not.toContain('?.scrollIntoView');
    // cross-page: SPA routers do no native hash scrolling — the handler
    // polls for the destination section to mount, then scrolls to it
    expect(handler).toContain('setInterval');
    expect(handler).toContain("_el2.scrollIntoView({ behavior: 'smooth' })");
  });

  _t2('re-sync recognises and replaces the new-form handler (isManaged)', () => {
    const once = _slh(_sss(BASE, 'nav-feat', true), 'nav-feat');
    const twice = _slh(once, 'nav-feat');
    expect((twice.match(/onClick=\{/g) || []).length).toBe(1);
  });
});
