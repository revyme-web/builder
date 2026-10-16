// Generated app/providers.tsx — locale imports follow the config; route-first
// locale resolution ships in the template.
import { describe, it, expect } from 'vitest';
import { buildProvidersSource, looksGeneratedProviders, PROVIDERS_MARKER } from './providers-gen';
import { RTL_TEXT_CSS } from '@/shared/rtl-text';

const CFG = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'French' },
    { code: 'it', label: 'Italian' },
    { code: 'pt-BR', label: 'Português (BR)' },
  ],
};

describe('buildProvidersSource', () => {
  it('imports one dictionary per configured locale (the old template hardcoded en/fr/es)', () => {
    const src = buildProvidersSource(CFG);
    expect(src).toContain("import enMessages from '@/messages/en.json';");
    expect(src).toContain("import itMessages from '@/messages/it.json';");
    expect(src).toContain("import pt_BRMessages from '@/messages/pt-BR.json';");
    expect(src).toContain("'pt-BR': pt_BRMessages,");
    expect(src).not.toContain('esMessages');
  });

  it('resolves the locale route-first via usePathname', () => {
    const src = buildProvidersSource(CFG);
    expect(src).toContain("import { usePathname, useRouter } from 'next/navigation';");
    expect(src).toContain('localeFromPath');
    expect(src).toContain(PROVIDERS_MARKER);
    expect(src).toContain("const DEFAULT_LOCALE = 'en';");
    // SSR :lang() carrier
    expect(src).toContain('<div lang={locale}');
  });

  it('rejects malformed locale codes instead of interpolating them', () => {
    const src = buildProvidersSource({
      defaultLocale: 'en',
      locales: [{ code: 'en', label: 'E' }, { code: "x'; alert(1); '", label: 'evil' }],
    });
    expect(src).not.toContain('alert(1)');
  });
});

// RTL (2026-10-16): v3 set <html dir="rtl"> for every RTL locale — the whole
// site mirrored, half-broken, and only after hydration. Now the text flips
// through one rule and the layout NEVER mirrors.
describe('buildProvidersSource — right-to-left', () => {
  const AR = { defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }, { code: 'ar', label: 'Arabic' }] };

  it('an RTL language never sets dir — not on <html>, not on the wrapper', () => {
    const src = buildProvidersSource(AR);
    expect(src).not.toMatch(/\.dir\s*=|dir=\{|setAttribute\('dir'/);
    expect(src).not.toMatch(/\['ar', 'he'/);   // the old hardcoded page-flip list
    expect(src).toContain("<div lang={locale} style={{ display: 'contents' }}>");
  });

  it('even a legacy `direction: \'rtl\'` in the config does not mirror the layout', () => {
    const legacy = { ...AR, locales: [AR.locales[0], { code: 'ar', label: 'Arabic', direction: 'rtl' as const }] };
    expect(buildProvidersSource(legacy)).toBe(buildProvidersSource(AR));
  });

  it('ships the text-only rule in the server-rendered wrapper', () => {
    const src = buildProvidersSource(AR);
    expect(src).toContain(`const RTL_TEXT_CSS = ${JSON.stringify(RTL_TEXT_CSS)};`);
    expect(src).toContain('<style dangerouslySetInnerHTML={{ __html: RTL_TEXT_CSS }} />');
  });

  it('an older generated provider is still recognised, so it upgrades on load', () => {
    const v3 = buildProvidersSource(AR).replace(PROVIDERS_MARKER, '@revyme-providers v3');
    expect(looksGeneratedProviders(v3)).toBe(true);
  });
});

describe('looksGeneratedProviders', () => {
  it('detects v2 (marker), v1 (heuristic), and leaves hand-written alone', () => {
    expect(looksGeneratedProviders(buildProvidersSource(CFG))).toBe(true);
    expect(looksGeneratedProviders("const messagesByLocale = {}; window.addEventListener('locale-change', h);")).toBe(true);
    expect(looksGeneratedProviders('export function Providers({children}) { return children; }')).toBe(false);
  });
});

// The isolated COMPONENT preview (preview-sandbox/main.tsx) short-circuits
// route resolution, so it never mounts `app/layout.tsx` and never gets the
// providers that way. It compiles this file and reads `.Providers` off the
// module instead — which means the NAMED export is load-bearing for a surface
// that lives in a different bundle and cannot type-check against it.
//
// If this ever became a default export, the preview would silently fall back
// to rendering bare and every translated component would throw "the context
// from NextIntlClientProvider was not found" again (user report 2026-08-09).

describe('the Providers export contract', () => {
  it('is a NAMED export — the component preview looks it up by name', () => {
    const src = buildProvidersSource({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] });
    expect(src).toMatch(/export function Providers\b/);
  });

  it('wraps children in NextIntlClientProvider, which is the context the preview needs', () => {
    const src = buildProvidersSource({ defaultLocale: 'en', locales: [{ code: 'en', label: 'English' }] });
    expect(src).toContain('NextIntlClientProvider');
  });
});

// ─── Link attributes runtime (BUG 18: Smooth Scroll / Keep Params had no runtime) ──
// The generated function is plain JS by design (it ships inside every project);
// pull it out of the template and drive it in jsdom.
function extractNavClick(): (e: any, nav: { push: (s: string) => void }) => void {
  const src = buildProvidersSource(CFG);
  const start = src.indexOf('function revymeNavClick');
  const end = src.indexOf('/** Scroll smoothly', start);
  const body = src.slice(start, end).replace(/^function revymeNavClick/, 'return function revymeNavClick');
  return new Function(`const SMOOTH_KEY = 'revyme:smooth-target'; ${body}`)() as any;
}
function click(a: HTMLAnchorElement, extra: Partial<MouseEvent> = {}) {
  const e: any = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: a, preventDefault() { this.defaultPrevented = true; }, ...extra };
  return e;
}

describe('generated providers — link attributes runtime', () => {
  it('v3 template: document listener + arrival scroll, and v2 files are detected for regeneration', () => {
    const src = buildProvidersSource(CFG);
    expect(src).toContain("document.addEventListener('click', onClick)");
    expect(src).toContain('useEffect(() => revymeScrollOnArrival(), [pathname])');
    expect(src).toContain("import { usePathname, useRouter } from 'next/navigation';");
    expect(looksGeneratedProviders(src.replace(PROVIDERS_MARKER, '@revyme-providers v2'))).toBe(true);
  });

  it('same-page smooth link: prevents default and scrolls to the section smoothly', () => {
    window.history.replaceState(null, '', '/joijoij?x=1');
    document.body.innerHTML = '<a id="l" href="/joijoij#section" data-smooth-scroll="true">go</a><div id="section"></div>';
    const target = document.getElementById('section')!;
    const scrolled: any[] = [];
    (target as any).scrollIntoView = (o: any) => scrolled.push(o);
    const e = click(document.getElementById('l') as HTMLAnchorElement);
    extractNavClick()(e, { push: () => { throw new Error('no push'); } });
    expect(e.defaultPrevented).toBe(true);
    expect(scrolled).toEqual([{ behavior: 'smooth' }]);
    expect(window.location.hash).toBe('#section');
  });

  it('cross-page smooth link: lets the router navigate and remembers the target for arrival', () => {
    window.history.replaceState(null, '', '/eee');
    window.sessionStorage.clear();
    document.body.innerHTML = '<a id="l" href="/joijoij#section" data-smooth-scroll="true">go</a>';
    const e = click(document.getElementById('l') as HTMLAnchorElement);
    extractNavClick()(e, { push: () => { throw new Error('no push'); } });
    expect(e.defaultPrevented).toBe(false);
    expect(window.sessionStorage.getItem('revyme:smooth-target')).toBe('section');
  });

  it('keep-params link: forwards the current query through the router', () => {
    window.history.replaceState(null, '', '/eee?utm=abc&ref=1');
    document.body.innerHTML = '<a id="l" href="/pricing?ref=2" data-keep-params="true">go</a>';
    const pushed: string[] = [];
    const e = click(document.getElementById('l') as HTMLAnchorElement);
    extractNavClick()(e, { push: (s) => pushed.push(s) });
    expect(e.defaultPrevented).toBe(true);
    expect(pushed).toEqual(['/pricing?ref=2&utm=abc']);
  });

  it('leaves plain links, modified clicks, new-tab and already-handled clicks alone', () => {
    window.history.replaceState(null, '', '/eee?utm=abc');
    document.body.innerHTML = '<a id="p" href="/pricing">a</a><a id="k" href="/pricing" data-keep-params="true" target="_blank">b</a><a id="m" href="/pricing" data-keep-params="true">c</a>';
    const pushed: string[] = [];
    const nav = { push: (s: string) => pushed.push(s) };
    const fn = extractNavClick();
    const plain = click(document.getElementById('p') as HTMLAnchorElement); fn(plain, nav);
    const blank = click(document.getElementById('k') as HTMLAnchorElement); fn(blank, nav);
    const meta = click(document.getElementById('m') as HTMLAnchorElement, { metaKey: true }); fn(meta, nav);
    const handled = click(document.getElementById('m') as HTMLAnchorElement, { defaultPrevented: true }); fn(handled, nav);
    expect(pushed).toEqual([]);
    expect(plain.defaultPrevented || blank.defaultPrevented || meta.defaultPrevented).toBe(false);
  });
});
