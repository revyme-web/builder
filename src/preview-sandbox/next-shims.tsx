// next-shims.tsx — Minimal client-side replacements for Next.js APIs.
//
// User code that does `import Link from 'next/link'` is rewritten by the
// in-iframe runtime to grab these shims via MODULE_MAP. The behaviour is a
// best-effort mimic of the real package's CLIENT-SIDE surface — server-only
// features (`prefetch`-on-hover via the App Router's RSC payload, image
// optimization through `next/image`'s loader, etc.) are intentionally
// omitted; preview cares about layout + interaction, not production
// performance characteristics.

import * as React from 'react';

// Mirror Next.js App Router scroll-to-top on navigation. Real `<Link>` /
// router.push|replace reset scroll to the top of the page on a FORWARD
// navigation (unless `scroll={false}`); back/forward restore scroll instead.
// The published site does this for free (real Next.js); the preview iframe's
// shimmed router must do it explicitly or page switches keep the previous
// scroll offset — the editor preview not scrolling up while the live site does.
// Deferred to the next frame so the destination page has rendered/laid out
// first (matches Next.js committing the scroll after the navigation).
function scrollPreviewToTop(): void {
  const toTop = () => {
    try {
      window.scrollTo(0, 0);
      if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      if (document.documentElement) document.documentElement.scrollTop = 0;
      if (document.body) document.body.scrollTop = 0;
    } catch { /* no-op */ }
  };
  toTop();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(toTop);
}

// ─── next/link ─────────────────────────────────────────────────────────────

export function LinkShim(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  prefetch?: boolean;
  scroll?: boolean;
  replace?: boolean;
}): React.ReactElement {
  const { href, children, prefetch: _p, scroll, replace, onClick, ...rest } = props;
  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    // Honour modifier clicks — let the browser handle Cmd/Ctrl/middle-click.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    // External links — let the browser handle them.
    if (/^https?:\/\//.test(href) || href.startsWith('//') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    e.preventDefault();
    if (replace) history.replaceState(null, '', href);
    else history.pushState(null, '', href);
    window.dispatchEvent(new PopStateEvent('popstate'));
    // Next.js scrolls to top on a forward Link navigation unless scroll={false}.
    if (scroll !== false) scrollPreviewToTop();
  };
  return React.createElement('a', { href, onClick: handleClick, ...rest }, children);
}

// ─── next/image ────────────────────────────────────────────────────────────
//
// Real next/image runs through the optimizer + automatic placeholder. The
// shim is just a styled <img>: passes width/height through, applies inset:0
// for `fill`, ignores `priority`/`loading`/`placeholder`/`blurDataURL` since
// none of them affect layout in the preview.

export function ImageShim(props: any): React.ReactElement {
  const {
    src, alt = '', width, height, fill, sizes,
    priority: _pr, loading, placeholder: _pl, blurDataURL: _bd, quality: _q, unoptimized: _u, loader: _l,
    style, ...rest
  } = props;
  const computedSrc = typeof src === 'string' ? src : (src?.src ?? src?.default?.src ?? '');
  const fillStyle: React.CSSProperties | undefined = fill
    ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }
    : undefined;
  return React.createElement('img', {
    src: computedSrc,
    alt,
    width: fill ? undefined : width,
    height: fill ? undefined : height,
    sizes,
    loading: loading ?? 'lazy',
    style: { ...fillStyle, ...style },
    ...rest,
  });
}

// ─── next/navigation ───────────────────────────────────────────────────────

interface RouterShim {
  push: (href: string) => void;
  replace: (href: string) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => void;
}

const noopRouter: RouterShim = {
  // push/replace scroll to top (Next.js default); back/forward restore the
  // browser's saved scroll position, so they must NOT force-scroll.
  push: (href) => { history.pushState(null, '', href); window.dispatchEvent(new PopStateEvent('popstate')); scrollPreviewToTop(); },
  replace: (href) => { history.replaceState(null, '', href); window.dispatchEvent(new PopStateEvent('popstate')); scrollPreviewToTop(); },
  back: () => history.back(),
  forward: () => history.forward(),
  refresh: () => location.reload(),
  prefetch: () => {},
};

export function useRouter(): RouterShim {
  return noopRouter;
}

export function usePathname(): string {
  return React.useSyncExternalStore(
    (cb) => {
      window.addEventListener('popstate', cb);
      return () => window.removeEventListener('popstate', cb);
    },
    () => location.pathname,
    () => '/',
  );
}

export function useSearchParams(): URLSearchParams {
  return React.useSyncExternalStore(
    (cb) => {
      window.addEventListener('popstate', cb);
      return () => window.removeEventListener('popstate', cb);
    },
    () => new URLSearchParams(location.search),
    () => new URLSearchParams(),
  );
}

// ─── useParams ─────────────────────────────────────────────────────────────
//
// Real Next.js `useParams()` returns the resolved dynamic route params for
// the current route, e.g. `{ slug: 'alice-johnson' }` for `/team/[slug]`.
// Our router resolves params per render and pushes them here via
// `setCurrentParams` so client components can read them via the standard
// hook (rather than relying on prop-passed `params={...}` everywhere).
//
// We keep params in a module-level slot + a tiny pub-sub so the hook can
// subscribe and re-render when the route changes (e.g. a Link click that
// navigates from /team/alice to /team/bob shouldn't keep showing alice).

let currentParams: Record<string, string | string[]> = {};
const paramsListeners = new Set<() => void>();

export function setCurrentParams(p: Record<string, string | string[]>): void {
  // Skip notify when the params haven't actually changed — a shallow check
  // is enough since routes are flat string maps. Avoids a stampede of
  // re-renders on every parent render that just touched the same slug.
  const prevKeys = Object.keys(currentParams);
  const nextKeys = Object.keys(p);
  if (prevKeys.length === nextKeys.length && prevKeys.every(k => currentParams[k] === p[k])) return;
  currentParams = p;
  paramsListeners.forEach(fn => fn());
}

export function useParams<T = Record<string, string | string[]>>(): T {
  return React.useSyncExternalStore(
    (cb) => {
      paramsListeners.add(cb);
      return () => paramsListeners.delete(cb);
    },
    () => currentParams as T,
    () => ({} as T),
  );
}
