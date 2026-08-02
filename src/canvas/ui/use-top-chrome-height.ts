// use-top-chrome-height.ts — how far down the rulers have to start.
//
// MEASURED rather than derived from the active file path. Two different
// components can put a bar in that band and their conditions don't agree:
//
//   ComponentBreadcrumb  →  isMasterFilePath(f) || isTemplateFilePath(f)
//   SlugPageBreadcrumb   →  path has [slug] AND CMS meta.kind === 'detail'
//                           AND the collection has items
//
// The rulers used to keep a THIRD copy — `isMasterFilePath(f) ? 52 : 0` — which
// silently disagreed with both. On a template (LayoutClient.tsx) the breadcrumb
// rendered and the top ruler stayed at y=0 behind it; the slug-detail case was
// wrong the same way and can't be evaluated from the path at all, since it
// depends on CMS content.
//
// Both bars tag themselves `data-dynamic-toolbar`, so reading the DOM is the
// only source that can't drift — and it picks up any future bar for free.

import { useEffect, useState } from 'react';

export function useTopChromeHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const measure = () => {
      const el = document.querySelector<HTMLElement>('[data-dynamic-toolbar="true"]');
      // Round: a fractional height would push the ruler onto a half pixel and
      // blur every tick.
      setHeight(el ? Math.round(el.getBoundingClientRect().height) : 0);
    };
    measure();

    // Both bars are portaled as DIRECT children of <body>, so `childList`
    // without `subtree` is enough — and avoids firing on every canvas mutation.
    const mo = new MutationObserver(measure);
    mo.observe(document.body, { childList: true });
    return () => mo.disconnect();
  }, []);

  return height;
}
