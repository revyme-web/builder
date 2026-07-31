// cms-detach-gen.ts — Detach / rehydrate CMS prop bindings when a component
// instance is dragged OUT OF or BACK INTO a collection-list `.map()`.
//
// Why this exists (source = deploy reality):
//   A live `prop={item.field}` cannot survive outside its `.map((item) => …)`
//   callback — `item` becomes an undefined identifier and the oracle blocks the
//   move ("References undefined identifier: item — would crash at runtime").
//   So on EXIT we strip the literal binding and stash the intent in a
//   `data-cms-orphan="prop:field,…"` attr — editor-only metadata that renders
//   the prop's default (no crash, no dangling ref). The panel reads it back and
//   shows a "Missing" pill (design-tool parity). On ENTRY back into a collection list
//   we re-bind each remembered prop to the NEW iterator.
//
// This mirrors the dormantize/rehydrate round-trip already used for
// scroll-variant / instance-fx / overlays in mutation-queue's `move` case.

import { findJSXDataIdIndex, findTagClose, findMatchingCloseTagIndex } from './generator-utils';
import { getEnclosingMapIteratorForNode } from './map-gen';
import { trace } from '@/shared/debug-trace';

const CMS_ORPHAN_ATTR = 'data-cms-orphan';

/** `"content:title,ergerg:untitled"` → `[{prop:'content',field:'title'}, …]`.
 *  A `:url` third segment marks a WHOLE-VALUE image binding (the instance wraps
 *  the plain-URL field in url() — `prop={`url(${item.field})`}`) so re-entry
 *  re-wraps: `"coverImage:coverImage:url"` → `{…, urlWrap: true}`. */
export function parseOrphanBindings(value: string): Array<{ prop: string; field: string; urlWrap?: boolean }> {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const parts = pair.split(':');
      if (parts.length < 2) return null;
      const entry: { prop: string; field: string; urlWrap?: boolean } = { prop: parts[0], field: parts[1] };
      if (parts[2] === 'url') entry.urlWrap = true;
      return entry;
    })
    .filter(Boolean) as Array<{ prop: string; field: string; urlWrap?: boolean }>;
}

function serializeOrphanBindings(entries: Array<{ prop: string; field: string; urlWrap?: boolean }>): string {
  return entries.map((e) => `${e.prop}:${e.field}${e.urlWrap ? ':url' : ''}`).join(',');
}

/** Locate `[tagStart, tagEnd]` (the `<` and `>`) of nodeId's opening tag. */
function findOpeningTag(code: string, nodeId: string): { tagStart: number; tagEnd: number } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = code.indexOf('>', idIdx);
  if (tagStart === -1 || tagEnd === -1) return null;
  return { tagStart, tagEnd };
}

/**
 * EXIT: the node has left `iterVar`'s `.map()`. Strip every
 * `prop={iterVar.field}` off its opening tag (those `iterVar` refs are now
 * out of scope → would crash) and remember them in `data-cms-orphan`.
 * Merges with any pre-existing orphan stash (a node detached, never
 * re-entered, then detached again keeps the union — last write wins per prop).
 * No-op when the tag carries no `iterVar.*` bindings.
 */
/**
 * Strip JSX attrs off an opening-tag string that would DANGLE at module scope
 * once the node leaves the `.map()`:
 *   • `key={…}`  — the map index var (`idx`), undefined outside the callback.
 *   • any attr whose `{…}` value still interpolates `iterVar` in a
 *     template/expression we don't field-stash — e.g. a per-row slug link
 *     `linkHref={`/coll/${item._slug}`}`. Removing the attr falls the prop back
 *     to the component master DEFAULT (the reference keeps such a link as a static
 *     value, not "Missing"); the simple `prop={item.field}` data bindings are
 *     stashed as "Missing" separately, BEFORE this runs.
 * Brace-aware — a value may contain nested `${…}`. Returns the cleaned tag.
 */
function stripDanglingMapAttrs(openTag: string, iterVar: string): string {
  // `iterVar` as a standalone identifier (not part of a longer name).
  const iterRe = new RegExp(`(^|[^\\w$])${iterVar}([^\\w$]|$)`);
  let result = '';
  let i = 0;
  while (i < openTag.length) {
    const rest = openTag.slice(i);
    const attr = /\s([a-zA-Z_$][\w$-]*)=\{/.exec(rest);
    if (!attr) { result += rest; break; }
    const attrStart = i + attr.index;            // the leading whitespace
    const braceStart = attrStart + attr[0].length - 1; // the opening `{`
    // Brace-scan the value (handles nested `${…}` in a template literal).
    let depth = 0, j = braceStart;
    for (; j < openTag.length; j++) {
      if (openTag[j] === '{') depth++;
      else if (openTag[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    const valueExpr = openTag.slice(braceStart + 1, j - 1);
    const drop = attr[1] === 'key' || iterRe.test(valueExpr);
    result += openTag.slice(i, attrStart);       // text before the attr
    if (!drop) result += openTag.slice(attrStart, j); // keep the attr
    i = j;
  }
  return result;
}

export function dormantizeCmsBindings(code: string, nodeId: string, iterVar: string): string {
  const tag = findOpeningTag(code, nodeId);
  if (!tag) return code;
  let openTag = code.slice(tag.tagStart, tag.tagEnd + 1);
  const before = openTag;

  // 1) Stash + strip simple CMS DATA bindings `prop={iterVar.field}` (image,
  //    name, …) → "Missing" pills (generator writes no inner spaces; tolerate them).
  const bindRe = new RegExp(`\\s([a-zA-Z_$][\\w$]*)=\\{\\s*${iterVar}\\.([a-zA-Z_$][\\w$]*)\\s*\\}`, 'g');
  const found: Array<{ prop: string; field: string; urlWrap?: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = bindRe.exec(openTag)) !== null) found.push({ prop: m[1], field: m[2] });
  openTag = openTag.replace(bindRe, '');

  // WHOLE-VALUE image bindings `prop={`url(${iterVar.field})`}` — stash with the
  // urlWrap marker (`:url`) so re-entry re-wraps. Without this pass,
  // stripDanglingMapAttrs below silently DROPS them (no "Missing" pill, binding
  // intent lost on the detach → re-enter round-trip).
  const wrapRe = new RegExp(`\\s([a-zA-Z_$][\\w$]*)=\\{\`url\\(\\$\\{\\s*${iterVar}\\.([a-zA-Z_$][\\w$]*)\\s*\\}\\)\`\\}`, 'g');
  while ((m = wrapRe.exec(openTag)) !== null) found.push({ prop: m[1], field: m[2], urlWrap: true });
  openTag = openTag.replace(wrapRe, '');
  if (found.length > 0) {
    // Merge into any existing orphan stash (detach → re-enter → detach keeps the union).
    const existing = openTag.match(new RegExp(`\\s${CMS_ORPHAN_ATTR}="([^"]*)"`));
    const merged = existing ? parseOrphanBindings(existing[1]) : [];
    for (const f of found) {
      const i = merged.findIndex((e) => e.prop === f.prop);
      if (i >= 0) merged[i] = f;
      else merged.push(f);
    }
    const stash = ` ${CMS_ORPHAN_ATTR}="${serializeOrphanBindings(merged)}"`;
    openTag = existing
      ? openTag.replace(existing[0], stash)
      : openTag.replace(/(data-id="[^"]*")/, `$1${stash}`);
  }

  // 2) Strip `key={idx}` + any attr still interpolating `iterVar` (the slug
  //    link template) — those would crash at module scope. Runs AFTER the
  //    field stash so the simple binds are already gone.
  openTag = stripDanglingMapAttrs(openTag, iterVar);

  let result = (openTag === before)
    ? code
    : code.slice(0, tag.tagStart) + openTag + code.slice(tag.tagEnd + 1);

  // 3) TEXT-CONTENT binding `>{iterVar.field}</tag>` (a bound TEXT node dragged
  //    out — e.g. `<h3>{item.title}</h3>`). The child `{item.title}` is NOT on
  //    the opening tag, so the steps above miss it → it dangles at module scope
  //    and the oracle blocks the move. Replace it with a static placeholder (the
  //    humanized field) + stash `__text:field` so the Content shows "Missing" and
  //    a re-entry restores the binding.
  result = dormantizeCmsTextBinding(result, nodeId, iterVar);

  trace.action('cms-detach:dormantize', { nodeId, iterVar, fieldCount: found.length });
  return result;
}

/** `title` → `Title`, `_createdAt` → `Created At`. A readable placeholder for a
 *  dormantized text binding (the reference shows the field name when content is missing). */
function humanizeField(field: string): string {
  const s = field.replace(/^_/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : field;
}

/** Clone-path (drag-to-canvas descriptor) twin of {@link dormantizeCmsTextBinding}:
 *  if `textContent` is a sole `{iter.field}` binding, return the humanized field as
 *  the text + a `data-cms-orphan="__text:field"` attr so the canvas clone doesn't
 *  reference an out-of-scope iterator (crash) and can re-bind on re-entry. Used by
 *  BOTH drag-to-canvas clone strategies (LayoutLifted + AbsoluteInFrame). */
export function dormantizeCloneTextBinding(
  textContent: string | undefined,
  attrs: Record<string, string> | undefined,
  /** Structured CMS text binding field (`node.binding.field` when `property==='text'`).
   *  The parser turns `<h3>{item.name}</h3>` into a STRUCTURED `node.binding`, leaving
   *  `textContent` EMPTY — so a CMS row dragged OUT of a replica/variant (clone path,
   *  which reads the model node, not the live code) cloned with empty text and NO
   *  Missing pill. Used when textContent doesn't already carry a raw `{iter.field}`. */
  bindingField?: string,
): { textContent: string | undefined; attrs: Record<string, string> | undefined } {
  const m = textContent ? /^\s*\{\s*([a-zA-Z_$][\w$]*)\.([a-zA-Z_$][\w$]*)\s*\}\s*$/.exec(textContent) : null;
  const field = m ? m[2] : (!textContent && bindingField ? bindingField : undefined);
  if (!field) return { textContent, attrs };
  const next = { ...(attrs ?? {}) };
  const existing = next[CMS_ORPHAN_ATTR];
  const list = (existing ? existing.split(',').map((s) => s.trim()).filter(Boolean) : []).filter((s) => !s.startsWith('__text:'));
  list.push(`__text:${field}`);
  next[CMS_ORPHAN_ATTR] = list.join(',');
  return { textContent: humanizeField(field), attrs: next };
}

/** Clone-path STYLE dormantize: neutralize any style value that interpolates an
 *  iterator (`backgroundImage: \`url(${item.image})\`` → `url()`, bare → '') so the
 *  canvas clone has no out-of-scope ref, and stash each known CMS style binding as
 *  `__style.<prop>:<field>` (Fill shows "Missing" + re-entry rebinds). The text twin
 *  is {@link dormantizeCloneTextBinding}; both run in buildCanvasCloneDescriptor. */
export function dormantizeCloneStyleBindings(
  styleBindings: Array<{ styleProp: string; field: string }> | undefined,
  styles: Record<string, string>,
  attrs: Record<string, string> | undefined,
): { styles: Record<string, string>; attrs: Record<string, string> | undefined } {
  const nextStyles = { ...styles };
  const orphans: string[] = [];
  for (const sb of styleBindings ?? []) {
    if (nextStyles[sb.styleProp] !== undefined) orphans.push(`__style.${sb.styleProp}:${sb.field}`);
  }
  // Strip ANY `${…}` interpolation from style values (covers url(${item.image}) +
  // bare ${item.field}) so nothing references the out-of-scope iterator.
  let changed = false;
  for (const k of Object.keys(nextStyles)) {
    const v = nextStyles[k];
    if (typeof v === 'string' && v.includes('${')) { nextStyles[k] = v.replace(/\$\{[^}]*\}/g, ''); changed = true; }
  }
  if (!orphans.length && !changed) return { styles, attrs };
  const existing = attrs?.[CMS_ORPHAN_ATTR] ? attrs[CMS_ORPHAN_ATTR].split(',').map((s) => s.trim()).filter(Boolean) : [];
  for (const o of orphans) {
    const prefix = o.slice(0, o.indexOf(':') + 1);
    const i = existing.findIndex((e) => e.startsWith(prefix));
    if (i >= 0) existing[i] = o; else existing.push(o);
  }
  const nextAttrs = existing.length ? { ...(attrs ?? {}), [CMS_ORPHAN_ATTR]: existing.join(',') } : attrs;
  return { styles: nextStyles, attrs: nextAttrs };
}

/** Clone-path ATTR/PROP dormantize: stash `src`/`href`/`alt` bindings
 *  (`src={item.image}`) and component-prop bindings (`endValue={item.count}`)
 *  as plain `prop:field` orphan entries — the form `rehydrateCmsBindings`
 *  re-emits verbatim on re-entry.
 *
 *  The bound attribute itself is DELETED. The parser records the binding but
 *  may also carry a resolved preview value in `attrs`, and rehydrate skips any
 *  prop already present on the tag — a leftover literal would permanently block
 *  the re-bind. */
export function dormantizeCloneAttrBindings(
  attrBindings: Array<{ property: string; field: string }> | undefined,
  propBindings: Array<{ prop: string; field: string; urlWrap?: boolean }> | undefined,
  attrs: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const entries: Array<{ prop: string; field: string; urlWrap?: boolean }> = [
    ...(attrBindings ?? []).map((b) => ({ prop: b.property, field: b.field })),
    ...(propBindings ?? []).map((b) => ({ prop: b.prop, field: b.field, urlWrap: b.urlWrap })),
  ];
  if (entries.length === 0) return attrs;

  const next = { ...(attrs ?? {}) };
  for (const e of entries) delete next[e.prop];

  const existing = parseOrphanBindings(next[CMS_ORPHAN_ATTR] ?? '');
  for (const e of entries) {
    const i = existing.findIndex((x) => x.prop === e.prop);
    if (i >= 0) existing[i] = e; else existing.push(e);
  }
  next[CMS_ORPHAN_ATTR] = serializeOrphanBindings(existing);
  return next;
}

/**
 * Every clone-path CMS dormantize in one call — text, styles, attrs/props.
 *
 * Used by BOTH detached-copy paths, which must agree: `buildCanvasCloneDescriptor`
 * (drag a bound node out of a collection list) and the clipboard's
 * `toClipboardNode` (copy one). A `{item.field}` reference can't survive outside
 * its `.map()` callback, so both stash the intent in `data-cms-orphan` — the
 * panel shows a "Missing" pill, and `rehydrateCmsBindings` re-binds to whatever
 * iterator the node lands in. Copy used to capture NONE of this: the clipboard
 * node carried only `textContent` (empty for a bound node, since the binding is
 * a JSX expression child, not text), so duplicating a bound `<h3>` produced an
 * empty text node and pasting one outside the list lost the pill
 * (user report 2026-07-25).
 *
 * `textField` overrides the text binding's field — the clone path resolves a
 * per-VARIANT binding first, which `textContent` alone can't express.
 */
export function dormantizeCloneBindings(input: {
  textContent: string | undefined;
  styles: Record<string, string>;
  attrs: Record<string, string> | undefined;
  textField?: string;
  attrBindings?: Array<{ property: string; field: string }>;
  styleBindings?: Array<{ styleProp: string; field: string }>;
  propBindings?: Array<{ prop: string; field: string; urlWrap?: boolean }>;
}): { textContent: string | undefined; styles: Record<string, string>; attrs: Record<string, string> | undefined } {
  const t = dormantizeCloneTextBinding(input.textContent, input.attrs, input.textField);
  const s = dormantizeCloneStyleBindings(input.styleBindings, input.styles, t.attrs);
  const attrs = dormantizeCloneAttrBindings(input.attrBindings, input.propBindings, s.attrs);
  return { textContent: t.textContent, styles: s.styles, attrs };
}

/**
 * Bake the RESOLVED CMS values onto a dormantized clone, keeping the stash.
 *
 * Dormantizing alone leaves a placeholder — the humanized field name for text,
 * `url()` for an image style, nothing for a bound attr. That's right for the
 * "Missing" pill but wrong for the node itself: a heading copied out of a
 * collection list should still SAY what it said (user report 2026-07-25).
 * So copy resolves each bound field against the row it came from and bakes the
 * literal here. The `data-cms-orphan` stash stays, so the panel still shows
 * Missing and a paste back INTO a list re-binds over the literal.
 *
 * `values` is keyed by orphan prop: `__text`, `__style.<cssProp>`, `<attr>`.
 */
export function bakeCmsValuesOnClone(
  clone: { textContent: string | undefined; styles: Record<string, string>; attrs: Record<string, string> | undefined },
  values: Record<string, string>,
): { textContent: string | undefined; styles: Record<string, string>; attrs: Record<string, string> | undefined } {
  const stash = clone.attrs?.[CMS_ORPHAN_ATTR];
  if (!stash) return clone;
  let textContent = clone.textContent;
  const styles = { ...clone.styles };
  const attrs = { ...(clone.attrs ?? {}) };
  let baked = 0;

  for (const { prop } of parseOrphanBindings(stash)) {
    const value = values[prop];
    if (value == null || value === '') continue;
    if (prop === '__text') {
      textContent = value;
    } else if (prop.startsWith('__style.')) {
      const cssProp = prop.slice('__style.'.length);
      // The style dormantize neutralizes an image binding to `url()` and any
      // other to `''` — re-wrap only the one that was a url.
      styles[cssProp] = styles[cssProp] === 'url()' ? `url(${value})` : value;
    } else {
      attrs[prop] = value;
    }
    baked++;
  }
  if (baked === 0) return clone;
  trace.action('cms-detach:bake-values', { baked, props: Object.keys(values) });
  return { textContent, styles, attrs };
}

/** Same entity escape `replaceNodeTextContent` uses for static JSX text — the
 *  parser decodes these back when reading textContent. */
const escapeJsxText = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');

/**
 * Resolve `${iter.field}` chunks inside NON-style template-literal attr values
 * to the row's literals (`href={\`/coll/${item._slug}\`}` → `href="/coll/first-post"`),
 * BEFORE `stripDanglingMapAttrs` would otherwise DROP the whole attr and fall the
 * link back to the default — the reference keeps such links as static values.
 * Only attrs whose every interpolation resolves are converted; the rest are left
 * for the strip. Supports the generator's `iter.field` / `iter?.field ?? 'fb'` forms.
 */
function resolveIterTemplateAttrs(code: string, nodeId: string, iterVar: string, row: Record<string, any>): string {
  const tag = findOpeningTag(code, nodeId);
  if (!tag) return code;
  const openTag = code.slice(tag.tagStart, tag.tagEnd + 1);
  const iterRe = new RegExp(`(^|[^\\w$])${iterVar}([^\\w$]|$)`);
  const chunkRe = new RegExp(`\\$\\{\\s*${iterVar}\\??\\.([a-zA-Z_$][\\w$]*)\\s*(?:\\?\\?\\s*(?:'([^']*)'|"([^"]*)"|\`([^\`]*)\`))?\\s*\\}`, 'g');
  let result = '';
  let i = 0;
  let resolvedCount = 0;
  while (i < openTag.length) {
    const rest = openTag.slice(i);
    const attr = /\s([a-zA-Z_$][\w$-]*)=\{/.exec(rest);
    if (!attr) { result += rest; break; }
    const attrStart = i + attr.index;
    const braceStart = attrStart + attr[0].length - 1;
    let depth = 0, j = braceStart;
    for (; j < openTag.length; j++) {
      if (openTag[j] === '{') depth++;
      else if (openTag[j] === '}') { depth--; if (depth === 0) { j++; break; } }
    }
    const valueExpr = openTag.slice(braceStart + 1, j - 1).trim();
    let replaced: string | null = null;
    if (attr[1] !== 'style' && attr[1] !== 'key' && valueExpr.startsWith('`') && valueExpr.endsWith('`') && iterRe.test(valueExpr)) {
      const resolved = valueExpr.slice(1, -1).replace(chunkRe, (_f, field, s1, s2, s3) => {
        const v = row[field];
        return v != null && v !== '' ? String(v) : (s1 ?? s2 ?? s3 ?? '');
      });
      // Fully resolved (no interpolation, no iter ref left) → bake a static string attr.
      if (!resolved.includes('${') && !iterRe.test(resolved)) {
        replaced = ` ${attr[1]}="${resolved.replace(/"/g, '&quot;')}"`;
        resolvedCount++;
      }
    }
    result += openTag.slice(i, attrStart);
    result += replaced ?? openTag.slice(attrStart, j);
    i = j;
  }
  if (resolvedCount === 0) return code;
  trace.action('cms-detach:resolve-template-attrs', { nodeId, iterVar, resolvedCount });
  return code.slice(0, tag.tagStart) + result + code.slice(tag.tagEnd + 1);
}

/**
 * Bake resolved row values over a freshly DORMANTIZED node — the code-path twin
 * of {@link bakeCmsValuesOnClone}. The `data-cms-orphan` stash names each field;
 * the row supplies the value. The stash STAYS (panel keeps the "Missing" pill,
 * re-entry re-binds over the literals — `rehydrateCmsBindings` replaces baked
 * literals wholesale):
 *   • `__text:field`        → the placeholder text child becomes the row's text
 *   • `__style.<css>:field` → neutralized `\`url()\`` / `''` becomes the literal
 *   • `<attr>:field`        → the stripped attr is re-inserted as `attr="value"`
 *     (`:url`-wrapped entries bake as `url(value)` — the prop expects a CSS url).
 */
export function bakeCmsOrphanValuesInCode(code: string, nodeId: string, row: Record<string, any>): string {
  const tag = findOpeningTag(code, nodeId);
  if (!tag) return code;
  let openTag = code.slice(tag.tagStart, tag.tagEnd + 1);
  const stashM = openTag.match(new RegExp(`\\s${CMS_ORPHAN_ATTR}="([^"]*)"`));
  if (!stashM) return code;

  const styleEsc = (v: string) => v.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  let textField: string | null = null;
  let baked = 0;
  for (const e of parseOrphanBindings(stashM[1])) {
    const raw = row[e.field];
    if (raw == null || raw === '') continue;
    const val = String(raw);
    if (e.prop === '__text') { textField = e.field; continue; } // after tag write-back
    if (e.prop.startsWith('__style.')) {
      const cssProp = e.prop.slice('__style.'.length);
      const urlRe = new RegExp(`(${cssProp}\\s*:\\s*)\`url\\(\\)\``);
      const emptyRe = new RegExp(`(${cssProp}\\s*:\\s*)''`);
      if (urlRe.test(openTag)) { openTag = openTag.replace(urlRe, `$1'url(${styleEsc(val)})'`); baked++; }
      else if (emptyRe.test(openTag)) { openTag = openTag.replace(emptyRe, `$1'${styleEsc(val)}'`); baked++; }
      continue;
    }
    // Attr entry — insert the literal (skip if the prop somehow survived on the tag).
    if (new RegExp(`\\s${e.prop}=`).test(openTag)) continue;
    const lit = e.urlWrap ? `url(${val})` : val;
    openTag = openTag.replace(/(data-id="[^"]*")/, `$1 ${e.prop}="${lit.replace(/"/g, '&quot;')}"`);
    baked++;
  }

  let result = code.slice(0, tag.tagStart) + openTag + code.slice(tag.tagEnd + 1);
  if (textField != null) {
    const t = findOpeningTag(result, nodeId);
    if (t) {
      const after = result.slice(t.tagEnd + 1);
      // The sole-text region the dormantize placeholder occupies, directly before the close tag.
      const tm = /^([^<]*)<\//.exec(after);
      if (tm) {
        result = result.slice(0, t.tagEnd + 1) + escapeJsxText(String(row[textField])) + after.slice(tm[1].length);
        baked++;
      }
    }
  }
  if (baked > 0) trace.action('cms-detach:bake-values-in-code', { nodeId, baked });
  return result;
}

/**
 * EXIT with values — the move-path detach for a node dragged OUT of a collection
 * list to somewhere with no `.map()` scope (canvas, a plain frame). Dormantizes
 * EVERY node in the dragged subtree (a whole card's nested bindings used to
 * dangle — only the root was dormantized, the heal later reduced descendants to
 * placeholders) and bakes the row's resolved values over each stash, so the
 * detached node still SHOWS what it showed: real text instead of the humanized
 * field name ("Untitled" for field `untitled`, user report 2026-07-28), the row's
 * image instead of `url()`, a static slug href instead of a dropped link.
 */
export function detachCmsSubtreeWithValues(code: string, rootNodeId: string, iterVar: string, row: Record<string, any>): string {
  const idIdx = findJSXDataIdIndex(code, rootNodeId);
  if (idIdx === -1) return code;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = findTagClose(code, idIdx);
  if (tagStart === -1 || tagEnd === -1) return code;
  let subtreeEnd = tagEnd + 1;
  if (code[tagEnd - 1] !== '/') {
    const tagName = code.slice(tagStart + 1).match(/^[\w.]+/)?.[0];
    if (tagName) {
      const closeIdx = findMatchingCloseTagIndex(code, tagName, tagEnd + 1);
      if (closeIdx !== -1) subtreeEnd = closeIdx + `</${tagName}>`.length;
    }
  }
  // Capture the subtree's ids up front — bounds shift as nodes transform.
  const ids: string[] = [];
  const idRe = /data-id="([^"]+)"/g;
  const slice = code.slice(tagStart, subtreeEnd);
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(slice)) !== null) ids.push(m[1]);

  let result = code;
  for (const id of ids) {
    result = dormantizeCmsStyleBinding(result, id, iterVar);
    result = resolveIterTemplateAttrs(result, id, iterVar, row);
    result = dormantizeCmsBindings(result, id, iterVar);
    result = bakeCmsOrphanValuesInCode(result, id, row);
  }
  trace.action('cms-detach:detach-subtree-with-values', { rootNodeId, iterVar, nodeCount: ids.length });
  return result;
}

/** Replace a sole `{iterVar.field}` TEXT child with the humanized field name +
 *  stash `__text:field` in `data-cms-orphan` (merged with any existing stash). */
function dormantizeCmsTextBinding(code: string, nodeId: string, iterVar: string): string {
  const tag = findOpeningTag(code, nodeId);
  if (!tag) return code;
  const after = code.slice(tag.tagEnd + 1);
  // The binding is the element's only text child (optionally whitespace-wrapped),
  // immediately before its closing tag.
  const m = new RegExp(`^(\\s*)\\{\\s*${iterVar}\\.([a-zA-Z_$][\\w$]*)\\s*\\}(\\s*)(?=<\\/)`).exec(after);
  if (!m) return code;
  const field = m[2];

  // Merge `__text:field` into the opening tag's orphan stash.
  let openTag = code.slice(tag.tagStart, tag.tagEnd + 1);
  const existing = openTag.match(new RegExp(`\\s${CMS_ORPHAN_ATTR}="([^"]*)"`));
  const merged = existing ? parseOrphanBindings(existing[1]) : [];
  const ti = merged.findIndex((e) => e.prop === '__text');
  if (ti >= 0) merged[ti] = { prop: '__text', field };
  else merged.push({ prop: '__text', field });
  const stash = ` ${CMS_ORPHAN_ATTR}="${serializeOrphanBindings(merged)}"`;
  openTag = existing
    ? openTag.replace(existing[0], stash)
    : openTag.replace(/(data-id="[^"]*")/, `$1${stash}`);

  const newAfter = m[1] + humanizeField(field) + m[3] + after.slice(m[0].length);
  trace.action('cms-detach:dormantize-text', { nodeId, iterVar, field });
  return code.slice(0, tag.tagStart) + openTag + newAfter;
}

/** Merge a single `prop:field` entry into an opening tag's `data-cms-orphan` attr
 *  (last write per prop wins). Returns the new opening-tag string. */
function mergeOrphanIntoOpenTag(openTag: string, prop: string, field: string): string {
  const existing = openTag.match(new RegExp(`\\s${CMS_ORPHAN_ATTR}="([^"]*)"`));
  const merged = existing ? parseOrphanBindings(existing[1]) : [];
  const i = merged.findIndex((e) => e.prop === prop);
  if (i >= 0) merged[i] = { prop, field };
  else merged.push({ prop, field });
  const stash = ` ${CMS_ORPHAN_ATTR}="${serializeOrphanBindings(merged)}"`;
  return existing
    ? openTag.replace(existing[0], stash)
    : openTag.replace(/(data-id="[^"]*")/, `$1${stash}`);
}

/**
 * Dormantize STYLE bindings on a node's opening tag that reference `iterVar` (a
 * CMS image/color fed by `item.field`): stash each as `__style.<cssProp>:<field>`
 * in `data-cms-orphan` (so the Fill control shows a "Missing" pill + re-entry can
 * re-bind) and NEUTRALIZE the live value so no out-of-scope `iterVar` ref remains:
 *   • template  `backgroundImage: \`url(${item.image})\`` → `backgroundImage: \`url()\``
 *   • bare      `backgroundColor: item.brand`             → `backgroundColor: ''`
 */
function dormantizeCmsStyleBinding(code: string, nodeId: string, iterVar: string): string {
  const tag = findOpeningTag(code, nodeId);
  if (!tag) return code;
  let openTag = code.slice(tag.tagStart, tag.tagEnd + 1);
  const before = openTag;
  const stashed: Array<{ cssProp: string; field: string }> = [];

  // Template form first (strips the `${iterVar.field}` interpolation, keeps the rest).
  const tplRe = new RegExp(`([a-zA-Z_$][\\w$]*)\\s*:\\s*\`([^\`]*)\\$\\{\\s*${iterVar}\\.([a-zA-Z_$][\\w$]*)\\s*\\}([^\`]*)\``, 'g');
  openTag = openTag.replace(tplRe, (_full, cssProp, pre, field, post) => {
    stashed.push({ cssProp, field });
    return `${cssProp}: \`${pre}${post}\``;
  });
  // Bare form (`cssProp: iterVar.field`) → neutralize to ''.
  const bareRe = new RegExp(`([a-zA-Z_$][\\w$]*)\\s*:\\s*${iterVar}\\.([a-zA-Z_$][\\w$]*)`, 'g');
  openTag = openTag.replace(bareRe, (_full, cssProp, field) => {
    stashed.push({ cssProp, field });
    return `${cssProp}: ''`;
  });

  if (!stashed.length || openTag === before) return code;
  for (const s of stashed) openTag = mergeOrphanIntoOpenTag(openTag, `__style.${s.cssProp}`, s.field);
  trace.action('cms-detach:dormantize-style', { nodeId, iterVar, props: stashed.map((s) => s.cssProp) });
  return code.slice(0, tag.tagStart) + openTag + code.slice(tag.tagEnd + 1);
}

/**
 * SELF-HEAL: any `iter.field` reference that ended up in `const canvasNodes` (module
 * scope, NOT inside a `.map()`) dangles — `iter` is undefined → it crashes and the
 * oracle blocks EVERY subsequent mutation. Handles BOTH binding forms left when a
 * whole CMS row (or just one element) is dragged out:
 *   • TEXT child  `>{iter.field}</`            → humanized placeholder + `__text` stash
 *   • STYLE/template interp `${iter.field}`    → stripped (`url(${item.image})` → `url()`)
 * Repairs state created before the drag-out dormantize ran. Idempotent.
 */
export function healDanglingCanvasNodeBindings(code: string): string {
  if (code.indexOf('const canvasNodes') === -1) return code;
  let result = code;

  // 1) TEXT children → placeholder (re-scan after each; positions shift).
  for (let guard = 0; guard < 50; guard++) {
    const re = /data-id="([^"]+)"[^>]*>\s*\{\s*([a-zA-Z_$][\w$]*)\.[a-zA-Z_$][\w$]*\s*\}\s*<\//g;
    re.lastIndex = result.indexOf('const canvasNodes');
    let healed = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(result)) !== null) {
      const nodeId = m[1], iter = m[2];
      if (getEnclosingMapIteratorForNode(result, nodeId) === null) {
        const next = dormantizeCmsTextBinding(result, nodeId, iter);
        if (next !== result) { result = next; healed = true; trace.action('cms-detach:heal-dangling-text', { nodeId, iter }); break; }
      }
    }
    if (!healed) break;
  }

  // 2) STYLE bindings (`backgroundImage: \`url(${item.image})\``, `backgroundColor:
  //    item.brand`) in an element's opening tag → dormantize PER ELEMENT (stash a
  //    `__style.<cssProp>` orphan so the Fill control shows "Missing" + re-entry
  //    rebinds, and neutralize the live value). Only when NOT inside a `.map()`.
  for (let guard = 0; guard < 50; guard++) {
    const re = /data-id="([^"]+)"[^>]*?\$\{\s*([a-zA-Z_$][\w$]*)\.[a-zA-Z_$][\w$]*\s*\}/g;
    re.lastIndex = result.indexOf('const canvasNodes');
    let healed = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(result)) !== null) {
      const nodeId = m[1], iter = m[2];
      if (getEnclosingMapIteratorForNode(result, nodeId) === null) {
        const next = dormantizeCmsStyleBinding(result, nodeId, iter);
        if (next !== result) { result = next; healed = true; trace.action('cms-detach:heal-dangling-style', { nodeId, iter }); break; }
      }
    }
    if (!healed) break;
  }

  return result;
}

/**
 * ENTRY: the node is now inside a `.map()`. If it carries a `data-cms-orphan`
 * stash, re-bind each remembered prop to the NEW iterator (`prop={dstIter.field}`)
 * and drop the stash. Optimistic by design — if the destination collection
 * lacks `field`, `dstIter.field` is simply `undefined` at runtime (renders the
 * prop default, never crashes); the panel surfaces that as a "Missing" pill
 * because the field won't be in the collection's schema. No-op when the node
 * isn't inside a `.map()` (stays dormant → "Missing") or has no stash.
 */
export function rehydrateCmsBindings(code: string, nodeId: string): string {
  const dstIter = getEnclosingMapIteratorForNode(code, nodeId);
  if (!dstIter) return code; // still detached → leave it dormant ("Missing")

  const tag = findOpeningTag(code, nodeId);
  if (!tag) return code;
  let openTag = code.slice(tag.tagStart, tag.tagEnd + 1);

  const orphanMatch = openTag.match(new RegExp(`\\s${CMS_ORPHAN_ATTR}="([^"]*)"`));
  if (!orphanMatch) return code;
  const orphans = parseOrphanBindings(orphanMatch[1]);

  // Drop the stash attr first.
  openTag = openTag.replace(orphanMatch[0], '');

  // Re-bind each remembered ATTR prop (`__text` / `__style.*` handled below).
  // A prop already on the tag is REPLACED, not skipped: copy bakes the resolved
  // value onto the detached node (`src="https://…/row.png"`) so it renders
  // outside the list, and the stash is what says that prop was bound — leaving
  // the literal in place would make the re-bind permanently unreachable.
  let inserts = '';
  for (const o of orphans) {
    if (o.prop.startsWith('__')) continue; // `__text` / `__style.*` handled below (not attrs)
    // urlWrap = whole-value image binding — re-wrap the plain-URL field in url().
    const bound = o.urlWrap
      ? `${o.prop}={\`url(\${${dstIter}.${o.field}})\`}`
      : `${o.prop}={${dstIter}.${o.field}}`;
    // `prop="literal"` or `prop={expr}` — replace in place, else insert.
    const existing = new RegExp(`\\s${o.prop}=(?:"[^"]*"|\\{[^}]*\\})`);
    if (existing.test(openTag)) openTag = openTag.replace(existing, ` ${bound}`);
    else inserts += ` ${bound}`;
  }
  openTag = openTag.replace(/(data-id="[^"]*")/, `$1${inserts}`);

  // Restore dormantized STYLE bindings: swap the neutralized value back to the
  // live binding on the NEW iterator (image `url()` → `url(${dstIter.field})`;
  // bare `''` → `${dstIter.field}`). A BAKED literal (copy resolved the row's
  // value so the detached node still renders) is replaced wholesale — same
  // reason as the attr branch above.
  for (const o of orphans) {
    if (!o.prop.startsWith('__style.')) continue;
    const cssProp = o.prop.slice('__style.'.length);
    const imgRe = new RegExp(`(${cssProp}\\s*:\\s*\`url\\()\\)`);
    if (imgRe.test(openTag)) {
      openTag = openTag.replace(imgRe, `$1\${${dstIter}.${o.field}})`);
      continue;
    }
    if (new RegExp(`${cssProp}\\s*:\\s*''`).test(openTag)) {
      openTag = openTag.replace(new RegExp(`(${cssProp}\\s*:\\s*)''`), `$1${dstIter}.${o.field}`);
      continue;
    }
    // Baked literal: `backgroundImage: 'url(https://…)'` / `color: 'red'`.
    const literal = new RegExp(`(${cssProp}\\s*:\\s*)(['"\`])((?:(?!\\2).)*)\\2`);
    const m = literal.exec(openTag);
    if (!m) continue;
    openTag = openTag.replace(literal, m[3].startsWith('url(')
      ? `$1\`url(\${${dstIter}.${o.field}})\``
      : `$1${dstIter}.${o.field}`);
  }

  let result = code.slice(0, tag.tagStart) + openTag + code.slice(tag.tagEnd + 1);

  // Restore a dormantized TEXT binding: swap the placeholder child back to
  // `{dstIter.field}` (re-bind by field; an absent field → undefined at runtime,
  // which the panel surfaces as "Missing").
  const textOrphan = orphans.find((o) => o.prop === '__text');
  if (textOrphan) {
    const t = findOpeningTag(result, nodeId);
    if (t) {
      const after = result.slice(t.tagEnd + 1);
      const closeIdx = after.indexOf('</');
      if (closeIdx !== -1) {
        result = result.slice(0, t.tagEnd + 1) + `{${dstIter}.${textOrphan.field}}` + after.slice(closeIdx);
      }
    }
  }

  trace.action('cms-detach:rehydrate', { nodeId, dstIter, count: orphans.length });
  return result;
}

/**
 * Clear ONE orphaned binding (the "Missing" pill ×) → the prop reverts to the
 * component's default. Drops the whole `data-cms-orphan` attr once empty.
 */
export function clearCmsOrphanInCode(code: string, nodeId: string, propName: string): string {
  const tag = findOpeningTag(code, nodeId);
  if (!tag) return code;
  let openTag = code.slice(tag.tagStart, tag.tagEnd + 1);
  const orphanMatch = openTag.match(new RegExp(`\\s${CMS_ORPHAN_ATTR}="([^"]*)"`));
  if (!orphanMatch) return code;

  const remaining = parseOrphanBindings(orphanMatch[1]).filter((e) => e.prop !== propName);
  const replacement = remaining.length ? ` ${CMS_ORPHAN_ATTR}="${serializeOrphanBindings(remaining)}"` : '';
  openTag = openTag.replace(orphanMatch[0], replacement);

  trace.action('cms-detach:clear-orphan', { nodeId, propName, remaining: remaining.length });
  return code.slice(0, tag.tagStart) + openTag + code.slice(tag.tagEnd + 1);
}
