import { describe, it, expect } from 'vitest';
import {
  isComponentFilePath,
  isTemplateFilePath,
  isComponentLikeFilePath,
  isIconSetFilePath,
} from './file-path-kind';

// Two real classifications of the same paths:
//  • NARROW `isComponentFilePath` (components/ only) — the RENDERER
//    (useActiveViewports) draws these as variant-artboard MASTERS; a TEMPLATE
//    (LayoutClient) falls through to the page-like layout.
//  • WIDE `isComponentLikeFilePath` (components/ + templates) — the SELECTION +
//    HOVER color (via isComponentFileAtom) and the component VARIABLE system.
//    Both a component master AND a template paint PURPLE (accent-secondary):
//    shared content the user is editing. So a template is "component-LIKE"
//    (purple selection) but not a component "master" (page-like layout).
// These tests pin that split.
describe('file-path-kind predicates — narrow vs wide component classification', () => {
  const PAGE = 'app/(Site)/page.client.tsx';
  const COMPONENT = 'components/GaBiTa.tsx';
  const TEMPLATE = 'app/(Site)/LayoutClient.tsx';
  const ROOT_TEMPLATE = 'LayoutClient.tsx';
  const ICON = 'icons/ArrowSet.tsx';

  it('a page is neither component nor template nor component-like', () => {
    expect(isComponentFilePath(PAGE)).toBe(false);
    expect(isTemplateFilePath(PAGE)).toBe(false);
    expect(isComponentLikeFilePath(PAGE)).toBe(false);
  });

  it('a real component master is component + component-like (→ purple selection)', () => {
    expect(isComponentFilePath(COMPONENT)).toBe(true);
    expect(isComponentLikeFilePath(COMPONENT)).toBe(true);
  });

  it('a TEMPLATE is component-LIKE (wide → purple selection) but NOT a component master (narrow → page-like layout)', () => {
    // narrow = false (renderer draws it page-like); wide = true (selection/hover
    // paint purple, + the component variable system).
    expect(isTemplateFilePath(TEMPLATE)).toBe(true);
    expect(isTemplateFilePath(ROOT_TEMPLATE)).toBe(true);
    expect(isComponentFilePath(TEMPLATE)).toBe(false);
    expect(isComponentLikeFilePath(TEMPLATE)).toBe(true);
  });

  it('an icon-set master is not a component master (purple reserved for real components)', () => {
    expect(isIconSetFilePath(ICON)).toBe(true);
    expect(isComponentFilePath(ICON)).toBe(false);
    expect(isComponentLikeFilePath(ICON)).toBe(false);
  });
});
