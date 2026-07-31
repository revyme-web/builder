// freeform/turn-guards.ts — the gate's STATEFUL guards.
//
// checkFile (the oracle) judges one file in isolation; these guards judge a
// submission against the rest of the world: where it is allowed to land (path
// discipline), what it must not destroy in the file it overwrites
// (preservation), and what other files still depend on (cross-file
// compatibility). Pure functions — projectFS state is passed IN, never read
// here — so every guard is unit-testable without the editor.
//
// Called only from gateTurnFiles (freeform-client.ts). Never add a guard to
// the bridge or the MCP server instead — one gatekeeper.

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import { trace } from '@/shared/debug-trace';
import { parseCanvasConfig } from '@/code/project/canvas-config';
import { parseVariantConfig } from '@/code/variants/variant-config';
import { isPageClientFile } from '@/code/project/active-file-store';
import type { OracleViolation } from '@/code/oracle/check-file';

const traverse = (typeof _traverse === 'function' ? _traverse : (_traverse as any).default) as typeof _traverse;

/** A page-ish surface (page or LayoutClient) the compat guard scans for instances. */
export interface SurfaceFile { path: string; code: string }

// ─── path discipline ──────────────────────────────────────────────────────────
//
// The submit protocol writes whole files to arbitrary paths — the PATH is the
// first thing to judge. Without this, kind:"component" could land on
// app/(x)/LayoutClient.tsx (clobbering a template while dodging the slot
// check, since kind derivation only templates the PAGE branch), on
// app/layout.tsx (the server shell), or on lib/, icons/, styles/ — all
// builder-owned surfaces.

const COMPONENT_PATH_RE = /^components\/[A-Z][A-Za-z0-9]*\.tsx$/;

export function checkSubmitPath(path: string, kind: 'page' | 'component'): OracleViolation[] {
  if (kind === 'component') {
    if (!COMPONENT_PATH_RE.test(path)) {
      return [{
        code: 'COMPONENT_PATH_SHAPE', tier: 2,
        message: `"${path}" is not a valid component path. Components (and code components) live ONLY at components/<PascalCase>.tsx — every other area (app/, lib/, icons/, plugins/, styles/, cms/, i18n/, _meta/) is builder-owned and cannot be written through submit.`,
      }];
    }
    return [];
  }
  // page kind: only real page surfaces. This blocks the server app/layout.tsx
  // shell (metadata/html/body — isLayoutFile would otherwise route it through
  // the template checks and let it commit), and any other existing file.
  const isLayoutClient = path.endsWith('/LayoutClient.tsx') || path === 'LayoutClient.tsx';
  if (!isPageClientFile(path) && !isLayoutClient) {
    return [{
      code: 'PROTECTED_PATH', tier: 2,
      message: `"${path}" is not a writable page surface. Page submissions may only target an existing app/**/page.client.tsx or a template's LayoutClient.tsx — server layout.tsx files, lib/, styles/ and data files are builder-owned. Read the project context for the exact page paths.`,
    }];
  }
  return [];
}

// ─── preservation ─────────────────────────────────────────────────────────────
//
// The oracle is stateless; these checks compare the submission against the
// file it overwrites. Builder-owned constructs must survive an AI edit:
// the @canvas viewport config, the @pageVariables block, and every
// tool-authored animation spec (data-scroll-fx & co. — the PRESERVE_COMPOSED_FX
// rule, promoted from prompt-only to a hard guard).

/** Tool-owned attributes: authored by editor panels, regenerated from JSON
 *  specs. A model must preserve them verbatim — never strip, never rewrite. */
const TOOL_OWNED_ATTRS = [
  'data-scroll-fx', 'data-instance-fx', 'data-scroll-variant',
  'data-loop', 'data-text-anim', 'data-overlay', 'data-overlay-trigger',
] as const;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** data-ids whose tag carries `attr` — both attribute orders, tag-bound
 *  ([^<>] per the lazy-regex lesson; JSX attr values cannot contain <>). */
function idsWithAttr(code: string, attr: string): Set<string> {
  const out = new Set<string>();
  for (const m of code.matchAll(new RegExp(`data-id="([^"]+)"[^<>]*?${attr}=`, 'g'))) out.add(m[1]);
  for (const m of code.matchAll(new RegExp(`${attr}=[^<>]*?data-id="([^"]+)"`, 'g'))) out.add(m[1]);
  return out;
}

/** Is the element still present as a JSX tag? Whitespace-preceded match so the
 *  CSS selector form `[data-id="x"]` in <style> blocks never false-positives. */
function elementRetained(code: string, id: string): boolean {
  return new RegExp(`\\sdata-id="${escapeRe(id)}"`).test(code);
}

export function checkPreservation(oldCode: string, newCode: string): OracleViolation[] {
  const v: OracleViolation[] = [];

  // @canvas — viewport config + canvas positions. ADDITIVE edits are the one
  // legitimate change (the seed teaches adding tablet/mobile breakpoints):
  // new viewport entries + their positions may APPEAR, but every EXISTING
  // viewport must survive byte-equal (id/width/label/primary) with its
  // position untouched. Anything else (removed/renamed viewports, moved
  // primary, repositioned existing tiles) silently resets the user's canvas.
  const oldCanvas = parseCanvasConfig(oldCode);
  if (oldCanvas) {
    const newCanvas = parseCanvasConfig(newCode);
    if (!newCanvas) {
      v.push({
        code: 'CANVAS_CONFIG_DESTROYED', tier: 2,
        message: `The /** @canvas { … } */ block was removed or mangled. It is builder-owned viewport configuration — copy it back from the current file (it must parse; you may only ADD viewports, never remove or change existing ones).`,
      });
    } else {
      const newById = new Map(newCanvas.viewports.map((vp) => [vp.id, vp]));
      const problems: string[] = [];
      for (const oldVp of oldCanvas.viewports) {
        const nv = newById.get(oldVp.id);
        if (!nv) { problems.push(`viewport "${oldVp.id}" was removed`); continue; }
        // Compare PROTECTED fields only — id/label/width/isPrimary/order are
        // builder-owned. `height` is content-driven (a page grows past its
        // starter height; locking it clips content), so the AI/editor MAY
        // change it freely, including switching a fixed px height to "auto".
        const proj = (vp: { id?: string; label?: string; width?: number; isPrimary?: boolean; order?: number }) =>
          JSON.stringify({ id: vp.id, label: vp.label, width: vp.width, isPrimary: vp.isPrimary || false, order: vp.order ?? 0 });
        if (proj(nv) !== proj(oldVp)) problems.push(`viewport "${oldVp.id}" was modified (id/width/label/primary/order must stay as-is — height may change to "auto")`);
        const op = JSON.stringify(oldCanvas.positions[oldVp.id] ?? null);
        const np = JSON.stringify(newCanvas.positions[oldVp.id] ?? null);
        if (op !== np) problems.push(`positions["${oldVp.id}"] was moved`);
      }
      if (problems.length > 0) {
        v.push({
          code: 'CANVAS_CONFIG_DESTROYED', tier: 2,
          message: `The /** @canvas { … } */ block lost builder-owned state:\n- ${problems.join('\n- ')}\nYou may only ADD new viewports (with their own positions entries); every existing entry must be copied verbatim.`,
        });
      }
    }
  }

  // @pageVariables — the page-variables feature's metadata block.
  if (/@pageVariables/.test(oldCode) && !/@pageVariables/.test(newCode)) {
    v.push({
      code: 'PAGE_VARIABLES_DESTROYED', tier: 2,
      message: `The /** @pageVariables { … } */ block was removed. It is builder-owned metadata for the page-variables feature — copy it back VERBATIM from the current file.`,
    });
  }

  // @cmsPage — marks builder-scaffolded CMS index/detail pages; the editor
  // keys detail-page UI (preview-slug navigator etc.) off it.
  if (/@cmsPage/.test(oldCode) && !/@cmsPage/.test(newCode)) {
    v.push({
      code: 'CMS_PAGE_META_DESTROYED', tier: 2,
      message: `The /** @cmsPage { … } */ annotation was removed. It marks this file as a CMS index/detail page (the editor's CMS UI keys off it) — copy it back VERBATIM from the current file.`,
    });
  }

  // Tool-owned animation attributes — element kept, spec stripped.
  for (const attr of TOOL_OWNED_ATTRS) {
    for (const id of idsWithAttr(oldCode, attr)) {
      if (!elementRetained(newCode, id)) continue; // element deleted entirely — allowed
      if (idsWithAttr(newCode, attr).has(id)) continue;
      v.push({
        code: 'TOOL_OWNED_FX_REMOVED', tier: 2, elementId: id,
        message: `<${id}> lost its ${attr} attribute. That attribute (and its generated hooks) is TOOL-OWNED — the editor's animation panels regenerate code from it. Preserve it verbatim when editing the element; animations are removed through the editor, not by stripping the attribute.`,
      });
    }
  }

  if (v.length > 0) {
    trace.action('turn-guards:preservation-violations', { codes: v.map((x) => x.code) });
  }
  return v;
}

// ─── design tokens ────────────────────────────────────────────────────────────
//
// Presets live in app/globals.css (:root custom properties). A var(--x)
// referencing a token that doesn't exist renders as UNSET — silently — and the
// panel shows a dead preset pill. Known tokens are passed IN (the gate reads
// getPresetTokens()); a custom property DECLARED in the same file (the
// border-overlay variable pattern: '--cardBorder': cardBorder inline) is legal.

export function checkTokenRefs(code: string, knownTokens: Set<string>): OracleViolation[] {
  const v: OracleViolation[] = [];
  const seen = new Set<string>();
  for (const m of code.matchAll(/var\(\s*--([a-zA-Z0-9_-]+)/g)) {
    const name = m[1];
    if (seen.has(name) || knownTokens.has(name)) continue;
    if (new RegExp(`['"]?--${escapeRe(name)}['"]?\\s*:`).test(code)) continue;
    seen.add(name);
    const available = [...knownTokens].slice(0, 12).join(', ');
    v.push({
      code: 'UNKNOWN_TOKEN', tier: 2,
      message: `var(--${name}) references a design token that does not exist in app/globals.css — it renders as UNSET. Use only the tokens listed in the project context${available ? ` (${available}${knownTokens.size > 12 ? ', …' : ''})` : ' (the project has none yet)'}, declare the custom property in this file, or create the preset FIRST via revyme_manage_presets and then resubmit.`,
    });
  }
  if (v.length > 0) trace.action('turn-guards:unknown-tokens', { names: [...seen] });
  return v;
}

// ─── cross-file compatibility ─────────────────────────────────────────────────
//
// Overwriting a component must not remove variants or props that page
// instances still reference — the instances keep rendering, silently broken
// (unknown initialVariant = frozen state machine; unknown prop = dead
// attribute). The surfaces passed in are the EFFECTIVE pages: batch versions
// win over projectFS, so a batch that updates both the component and its
// consumers resolves cleanly.

/** Destructured prop names of the exported component, or null when the shape
 *  is unreadable (the oracle owns syntax errors — never double-report). */
export function extractComponentProps(code: string): Set<string> | null {
  const exported = code.match(/export\s+default\s+withResponsiveProps\(\s*(\w+)\s*\)/)?.[1];
  if (!exported) return null;
  let ast: t.File;
  try {
    ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  } catch {
    return null;
  }
  let props: Set<string> | null = null;
  traverse(ast, {
    FunctionDeclaration(path) {
      if (path.node.id?.name !== exported) return;
      const param = path.node.params[0];
      const pattern = t.isObjectPattern(param) ? param
        : t.isAssignmentPattern(param) && t.isObjectPattern(param.left) ? param.left
        : null;
      if (!pattern) { props = new Set(); return; }
      const out = new Set<string>();
      for (const p of pattern.properties) {
        if (t.isObjectProperty(p) && t.isIdentifier(p.key)) out.add(p.key.name);
        else if (t.isRestElement(p)) out.add('...rest');
      }
      props = out;
      path.stop();
    },
  });
  return props;
}

/** Attrs that are never component props on an instance tag. */
const NON_PROP_ATTRS = new Set(['style', 'key', 'ref', 'className', 'initialVariant']);

export function checkComponentCompat(
  componentPath: string,
  oldCode: string,
  newCode: string,
  surfaces: SurfaceFile[],
): OracleViolation[] {
  const base = componentPath.match(/^components\/(\w+)\.tsx$/)?.[1];
  if (!base) return [];

  const newVariantNames = new Set(parseVariantConfig(newCode).map((vc) => vc.name));
  const removedVariants = parseVariantConfig(oldCode)
    .map((vc) => vc.name)
    .filter((n) => !newVariantNames.has(n));

  const oldProps = extractComponentProps(oldCode);
  const newProps = extractComponentProps(newCode);
  const removedProps = oldProps && newProps
    ? [...oldProps].filter((p) => p !== '...rest' && !newProps.has(p) && !newProps.has('...rest'))
    : [];

  if (removedVariants.length === 0 && removedProps.length === 0) return [];

  const v: OracleViolation[] = [];
  for (const surface of surfaces) {
    const local = surface.code.match(
      new RegExp(`import\\s+(\\w+)\\s+from\\s+['"]@/components/${escapeRe(base)}['"]`),
    )?.[1];
    if (!local) continue;

    for (const tagMatch of surface.code.matchAll(new RegExp(`<${local}\\b([^<>]*?)\\/?>`, 'g'))) {
      const attrs = tagMatch[1];

      if (removedVariants.length > 0) {
        const referenced = new Set<string>();
        const iv = attrs.match(/initialVariant="([\w-]+)"/);
        if (iv) referenced.add(iv[1]);
        const responsive = attrs.match(/data-responsive='([^']*)'/);
        if (responsive) {
          try {
            for (const val of Object.values(JSON.parse(responsive[1]))) {
              if (typeof val === 'string') referenced.add(val);
            }
          } catch { /* malformed map — not this guard's problem */ }
        }
        for (const name of removedVariants) {
          if (referenced.has(name)) {
            v.push({
              code: 'VARIANT_REMOVED_IN_USE', tier: 2,
              message: `This edit removes variant '${name}' from ${componentPath}, but an instance on ${surface.path} still references it (initialVariant/data-responsive). Keep the variant, or update that page in the SAME batch to use a surviving variant.`,
            });
          }
        }
      }

      if (removedProps.length > 0) {
        for (const am of attrs.matchAll(/(?:^|\s)([A-Za-z_][\w-]*)=/g)) {
          const name = am[1];
          if (name.startsWith('data-') || NON_PROP_ATTRS.has(name)) continue;
          if (removedProps.includes(name)) {
            v.push({
              code: 'PROP_REMOVED_IN_USE', tier: 2,
              message: `This edit removes the prop '${name}' from ${componentPath}, but an instance on ${surface.path} still passes it. Keep the prop (variables are part of the component's contract), or update that page in the SAME batch.`,
            });
          }
        }
      }
    }
  }

  if (v.length > 0) {
    trace.action('turn-guards:compat-violations', { componentPath, codes: v.map((x) => x.code) });
  }
  return v;
}
