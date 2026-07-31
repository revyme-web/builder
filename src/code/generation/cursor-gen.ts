// cursor-gen.ts — Generate, update, and remove component-cursor code.
//
// Three concerns, all pure (code, args) → code:
//   1. Per-page: ensure `import { withCursor } from '@revyme/runtime'`
//      and `import <Name> from '@/components/<Name>'`. Insert/update/remove
//      the `{...withCursor(<Name>, { ... })}` spread on the target element.
//   2. Layout: ensure `<CursorPortal />` is mounted exactly once in
//      `app/layout.tsx`. Idempotent — adds on first cursor in the project,
//      leaves alone afterwards. Removal is a no-op (portal is harmless when
//      the global store is empty, and other pages may still need it).
//   3. Cleanup: when the last cursor for a given component file is removed
//      from a page, prune the component import.
//
// Pairs with src/code/parsing/cursor-parser.ts.

import type { CursorMode, CursorSide, CursorAlign, CursorTransition } from '@/code/parsing/cursor-parser';
import { insertAfterLastImportLine } from './generator-utils';
import { escapeRegExp } from '@/shared/regex-utils';
import { parseComponentCursorCalls, getComponentCursorForNode } from '@/code/parsing/cursor-parser';
import { trace } from '@/shared/debug-trace';

export interface AddComponentCursorOpts {
  /** Local identifier name for the imported component, e.g. "Pointer". */
  componentName: string;
  /** Source path for the import, e.g. "@/components/Pointer".
   *  When omitted, no import is generated — used when `componentName` refers
   *  to an in-scope identifier (e.g. a destructured page-variable prop on a
   *  component-master file). The runtime sees `withCursor(myCursor, opts)`
   *  where `myCursor` is a React component received as a prop. */
  componentImportPath?: string;
  /** Variant name if the component has variants. */
  variant?: string;
  mode?: CursorMode;
  /** Anchor side relative to the mouse (Follow only — Replace auto-centers). */
  side?: CursorSide;
  /** Alignment along the perpendicular axis (Follow only). */
  align?: CursorAlign;
  offsetX?: number;
  offsetY?: number;
  transition?: CursorTransition;
  /** Wrapper width/height. Numbers serialize as numbers (px at runtime); strings are quoted. */
  width?: number | string;
  height?: number | string;
  /** When true, fade/scale on mount/unmount via AnimatePresence. */
  enterExit?: boolean;
}

export interface UpdateComponentCursorOpts {
  variant?: string;
  mode?: CursorMode;
  side?: CursorSide;
  align?: CursorAlign;
  offsetX?: number;
  offsetY?: number;
  transition?: CursorTransition;
  width?: number | string;
  height?: number | string;
  enterExit?: boolean;
}

const RUNTIME_IMPORT_PATH = '@revyme/runtime';

// ─── Page file: add / update / remove the spread call ───────────────────────

/**
 * Add a component cursor to the element with `data-id="<nodeId>"` in `code`.
 * Adds the runtime + component imports as needed and inserts the spread call
 * inside the element's opening tag. If a cursor already exists for the node,
 * delegates to update.
 */
export function addComponentCursorInCode(
  code: string,
  nodeId: string,
  opts: AddComponentCursorOpts,
): string {
  trace.fn('cursor-gen:add', { nodeId, componentName: opts.componentName });

  // If a cursor is already on this node, just update it instead of stacking.
  const existing = getComponentCursorForNode(code, nodeId);
  if (existing) {
    return updateComponentCursorInCode(code, nodeId, opts);
  }

  let next = ensureRuntimeImport(code);
  // Skip the import when no source path was given — the identifier is expected
  // to already be in scope (e.g. a destructured prop on a component master).
  if (opts.componentImportPath) {
    next = ensureComponentImport(next, opts.componentName, opts.componentImportPath);
  }
  next = insertSpreadOnElement(next, nodeId, formatCallSrc(opts));
  return next;
}

/**
 * Replace the options object on an existing cursor call. If no cursor is
 * present, this is a no-op (caller should use add instead).
 */
export function updateComponentCursorInCode(
  code: string,
  nodeId: string,
  opts: UpdateComponentCursorOpts & Partial<AddComponentCursorOpts>,
): string {
  trace.fn('cursor-gen:update', { nodeId });
  const existing = getComponentCursorForNode(code, nodeId);
  if (!existing) return code;

  const merged: AddComponentCursorOpts = {
    componentName: opts.componentName ?? existing.componentName,
    componentImportPath:
      opts.componentImportPath ?? `@/components/${existing.componentName}`,
    variant: opts.variant ?? existing.variant,
    mode: opts.mode ?? existing.mode,
    side: opts.side ?? existing.side,
    align: opts.align ?? existing.align,
    offsetX: opts.offsetX ?? existing.offsetX,
    offsetY: opts.offsetY ?? existing.offsetY,
    transition: opts.transition ?? existing.transition,
    width: opts.width ?? existing.width,
    height: opts.height ?? existing.height,
    enterExit: opts.enterExit ?? existing.enterExit,
  };

  // Replace the entire `{...withCursor(...)}` slice.
  const newCall = formatCallSrc(merged);
  let next = code.slice(0, existing.callStart) + newCall + code.slice(existing.callEnd);

  // If the component identifier changed, ensure the new import is present.
  // When `merged.componentImportPath` is absent the identifier is an
  // in-scope variable (a destructured prop on the master), so we skip
  // import management — same rationale as the add-path.
  if (opts.componentName && opts.componentName !== existing.componentName) {
    if (merged.componentImportPath) {
      next = ensureComponentImport(next, merged.componentName, merged.componentImportPath);
    }
    // The old component might still be referenced elsewhere — let
    // pruneUnusedComponentImports handle cleanup.
    next = pruneUnusedComponentImports(next);
  }
  return next;
}

/**
 * Remove the cursor from the element. Strips the spread, prunes the
 * component import if it's no longer referenced, leaves the runtime import
 * alone (harmless when no calls remain).
 */
export function removeComponentCursorInCode(code: string, nodeId: string): string {
  trace.fn('cursor-gen:remove', { nodeId });
  const existing = getComponentCursorForNode(code, nodeId);
  if (!existing) return code;

  // Drop the spread and any single trailing space we'd otherwise leave behind.
  let next = code.slice(0, existing.callStart) + code.slice(existing.callEnd);
  next = next.replace(/  +/g, ' ').replace(/\s+>/g, '>').replace(/\s+\/>/g, ' />');

  // If no other cursor calls remain, drop the runtime import too.
  if (parseComponentCursorCalls(next).length === 0) {
    next = removeRuntimeImport(next);
  }
  next = pruneUnusedComponentImports(next);
  return next;
}

// ─── Layout file: ensure <CursorPortal /> exists once ───────────────────────

/**
 * Idempotently mount `<CursorPortal />` inside `<body>` of `app/layout.tsx`.
 * Adds the import too. If already present, returns the layout code unchanged.
 *
 * Pass the current contents of `app/layout.tsx` and write back the result.
 */
export function ensureCursorPortalInLayout(layoutCode: string): string {
  if (layoutCode.includes('<CursorPortal')) return layoutCode;
  trace.fn('cursor-gen:ensureCursorPortalInLayout');

  let next = layoutCode;

  // 1. Add the import after the last existing import line. If none exist,
  //    insert at top of file (after any 'use client' directive). Detects
  //    either the new `@revyme/runtime` path OR the legacy `@/lib/cursor-runtime`
  //    so files already migrated by hand don't get a duplicate import.
  if (!/from\s+['"]@revyme\/runtime['"]/.test(next) && !/from\s+['"]@\/lib\/cursor-runtime['"]/.test(next)) {
    const importLine = `import { CursorPortal } from '${RUNTIME_IMPORT_PATH}';`;
    next = insertAfterLastImportLine(next, importLine) ?? (importLine + '\n\n' + next);
  }

  // 2. Mount `<CursorPortal />` as the last child of `<body>`. Matches both
  //    self-closing and full body tags. We insert before `</body>`.
  const bodyCloseIdx = next.indexOf('</body>');
  if (bodyCloseIdx >= 0) {
    // Compute leading whitespace of the </body> line so the insert is indented.
    const lineStart = next.lastIndexOf('\n', bodyCloseIdx) + 1;
    const indent = next.slice(lineStart, bodyCloseIdx).match(/^\s*/)![0];
    const insert = `${indent}  <CursorPortal />\n${indent}`;
    next = next.slice(0, bodyCloseIdx) + insert + next.slice(bodyCloseIdx);
  }

  return next;
}

// ─── Imports ────────────────────────────────────────────────────────────────

function ensureRuntimeImport(code: string): string {
  // Already imported with withCursor named?
  if (
    new RegExp(
      `import\\s*\\{[^}]*\\bwithCursor\\b[^}]*\\}\\s*from\\s*['"]${escapeRegExp(RUNTIME_IMPORT_PATH)}['"]`,
    ).test(code)
  ) {
    return code;
  }

  // Existing import from @revyme/runtime without withCursor? Add the
  // identifier to the existing list to avoid duplicate import lines.
  const existing = code.match(
    new RegExp(
      `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(RUNTIME_IMPORT_PATH)}['"];?`,
    ),
  );
  if (existing) {
    const names = existing[1].split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.includes('withCursor')) names.push('withCursor');
    const replacement = `import { ${names.join(', ')} } from '${RUNTIME_IMPORT_PATH}';`;
    return code.replace(existing[0], replacement);
  }

  return insertImportLine(code, `import { withCursor } from '${RUNTIME_IMPORT_PATH}';`);
}

function removeRuntimeImport(code: string): string {
  // Strip just the `withCursor` identifier; if it was the only one, drop the
  // whole line.
  const existing = code.match(
    new RegExp(
      `import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${escapeRegExp(RUNTIME_IMPORT_PATH)}['"];?\\n?`,
    ),
  );
  if (!existing) return code;
  const names = existing[1].split(',').map((s) => s.trim()).filter((n) => n && n !== 'withCursor');
  if (names.length === 0) return code.replace(existing[0], '');
  const replacement = `import { ${names.join(', ')} } from '${RUNTIME_IMPORT_PATH}';\n`;
  return code.replace(existing[0], replacement);
}

function ensureComponentImport(code: string, name: string, path: string): string {
  // Default-import: `import Pointer from '@/components/Pointer';`
  const re = new RegExp(`import\\s+${name}\\s+from\\s+['"][^'"]+['"];?`);
  if (re.test(code)) return code;
  return insertImportLine(code, `import ${name} from '${path}';`);
}

/**
 * Public wrapper for the internal default-import helper. Used by callers
 * outside cursor-gen that need to drop a `import X from '...';` line at
 * the top of a file — e.g. the page-instance editor wiring a cursor
 * component into a `<Card myCursor={Pointer} />` prop has to add the
 * Pointer import before it can write the expression.
 */
export function ensureDefaultImportInCode(code: string, name: string, path: string): string {
  trace.fn('cursor-gen:ensureDefaultImport', { name, path });
  return ensureComponentImport(code, name, path);
}

function pruneUnusedComponentImports(code: string): string {
  // Find every `import <Name> from '@/components/<Name>'` and check if
  // <Name> appears anywhere else in the code body. If not, drop the import.
  // The import line itself naturally contains the name twice (default + path),
  // so we count usage *outside* that line.
  const importLines = [...code.matchAll(/^import\s+(\w+)\s+from\s+['"]@\/components\/([^'"]+)['"];?\s*$/gm)];
  let next = code;
  for (const m of importLines) {
    const name = m[1];
    const lineText = m[0];
    const codeWithoutImportLine = next.replace(lineText, '');
    const usageRe = new RegExp(`\\b${name}\\b`, 'g');
    const matches = codeWithoutImportLine.match(usageRe);
    if (!matches || matches.length === 0) {
      next = next.replace(lineText + '\n', '').replace(lineText, '');
    }
  }
  return next;
}

function insertImportLine(code: string, importLine: string): string {
  // Prefer to insert after the last existing import. Falls back to
  // inserting after any leading 'use client' / blank lines.
  const inserted = insertAfterLastImportLine(code, importLine);
  if (inserted !== null) return inserted;
  // No imports yet — insert after any 'use client' line if present.
  const useClientMatch = code.match(/^(['"]use client['"];?\s*\n)/);
  if (useClientMatch) {
    const insertAt = useClientMatch[0].length;
    return code.slice(0, insertAt) + '\n' + importLine + '\n' + code.slice(insertAt);
  }
  return importLine + '\n\n' + code;
}

// ─── Spread insertion ───────────────────────────────────────────────────────

/**
 * Insert `{...withCursor(...)}` into the opening tag of the element with the
 * given data-id. Inserts right after `data-id="<id>"` (matches the convention
 * used by other generators).
 */
function insertSpreadOnElement(code: string, nodeId: string, spreadCallSrc: string): string {
  const re = new RegExp(`data-id="${escapeRegExp(nodeId)}"`);
  const m = re.exec(code);
  if (!m) {
    trace.error('cursor-gen:insert-no-data-id', { nodeId });
    return code;
  }
  const insertAt = m.index + m[0].length;
  return code.slice(0, insertAt) + ' ' + spreadCallSrc + code.slice(insertAt);
}

/**
 * Format the full spread call source from options.
 * Output: `{...withCursor(Pointer, { mode: 'follow', transition: { type: 'spring', stiffness: 300 } })}`
 */
function formatCallSrc(opts: AddComponentCursorOpts): string {
  const fields: string[] = [];
  if (opts.variant) fields.push(`variant: '${opts.variant}'`);
  if (opts.mode) fields.push(`mode: '${opts.mode}'`);
  // side/align are only meaningful in Follow mode. Skip writing them when
  // mode is replace — runtime ignores them anyway and omitting keeps the
  // generated call clean.
  if (opts.mode !== 'replace') {
    if (opts.side && opts.side !== 'bottom') fields.push(`side: '${opts.side}'`);
    if (opts.align && opts.align !== 'center') fields.push(`align: '${opts.align}'`);
  }
  if (typeof opts.offsetX === 'number' && opts.offsetX !== 0) fields.push(`offsetX: ${opts.offsetX}`);
  if (typeof opts.offsetY === 'number' && opts.offsetY !== 0) fields.push(`offsetY: ${opts.offsetY}`);
  if (opts.transition && Object.keys(opts.transition).length > 0) {
    fields.push(`transition: ${formatTransition(opts.transition)}`);
  }
  if (opts.width !== undefined && opts.width !== '') {
    fields.push(`width: ${formatDimension(opts.width)}`);
  }
  if (opts.height !== undefined && opts.height !== '') {
    fields.push(`height: ${formatDimension(opts.height)}`);
  }
  // Only emit `enterExit: true` — false is the default in the runtime, so
  // omitting keeps the call clean.
  if (opts.enterExit === true) fields.push(`enterExit: true`);
  const objSrc = fields.length === 0 ? '{}' : `{ ${fields.join(', ')} }`;
  return `{...withCursor(${opts.componentName}, ${objSrc})}`;
}

function formatDimension(v: number | string): string {
  if (typeof v === 'number') return String(v);
  // Numeric strings serialize without quotes (so '40' → 40); other CSS
  // values like '100%' or '4rem' get quoted.
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  return `'${v}'`;
}

function formatTransition(t: CursorTransition): string {
  const parts: string[] = [];
  if (t.type) parts.push(`type: '${t.type}'`);
  if (typeof t.stiffness === 'number') parts.push(`stiffness: ${t.stiffness}`);
  if (typeof t.damping === 'number') parts.push(`damping: ${t.damping}`);
  if (typeof t.mass === 'number') parts.push(`mass: ${t.mass}`);
  if (typeof t.duration === 'number') parts.push(`duration: ${t.duration}`);
  if (t.ease) parts.push(`ease: '${t.ease}'`);
  return `{ ${parts.join(', ')} }`;
}


// ─── Per-instance behaviour overrides (`<prop>Opts`) ─────────────────────────
//
// A hoisted cursor variable stores WHICH component fills the cursor per
// instance (`<Card cursor={Pointer} />`), but the behaviour opts historically
// lived only in the master's `withCursor(cursor, { … })` call — shared by
// every instance. Editing the popup from instance A then instance B silently
// overwrote A's variant (live find 2026-07-06: Service Row cursors "Brand" →
// "Motion" leaked across rows). The fix: the master call spreads a paired
// `<prop>Opts` prop LAST — `withCursor(cursor, { …defaults, ...cursorOpts })`
// — and the instance popup writes behaviour to `<Card cursorOpts={{…}} />`.
// Master defaults still apply wherever an instance hasn't overridden. Pure
// source-level, so preview + deploy match with no runtime change.

/** The paired per-instance behaviour prop for a cursor variable. */
export function cursorOptsPropName(propName: string): string {
  return `${propName}Opts`;
}

/**
 * Ensure the MASTER forwards per-instance behaviour: adds `<prop>Opts = {}` to
 * the function signature (before `...rest`) and `...<prop>Opts` as the LAST
 * entry of the `withCursor(<prop>, { … })` opts object. Idempotent.
 */
export function ensureCursorOptsForwardInCode(code: string, propName: string): string {
  const optsName = cursorOptsPropName(propName);
  let next = code;

  // 1. Signature param — insert before `...rest` in the destructure.
  if (!new RegExp(`[{,\\s]${optsName}\\s*[=,}]`).test(next)) {
    const restIdx = next.indexOf('...rest');
    if (restIdx === -1) {
      trace.error('cursor-gen:ensure-opts-no-rest', { propName });
      return code;
    }
    next = next.slice(0, restIdx) + `${optsName} = {}, ` + next.slice(restIdx);
  }

  // 2. Spread into the withCursor opts object (brace-matched — opts nest
  //    braces via `transition: { … }`).
  const callMarker = `withCursor(${propName},`;
  const callIdx = next.indexOf(callMarker);
  if (callIdx === -1) {
    trace.error('cursor-gen:ensure-opts-no-call', { propName });
    return code;
  }
  const objStart = next.indexOf('{', callIdx + callMarker.length);
  if (objStart === -1) return code;
  let depth = 1;
  let j = objStart + 1;
  while (j < next.length && depth > 0) {
    if (next[j] === '{') depth++;
    else if (next[j] === '}') depth--;
    j++;
  }
  const objEnd = j - 1; // index of the closing '}'
  const objBody = next.slice(objStart + 1, objEnd);
  if (!objBody.includes(`...${optsName}`)) {
    const spread = objBody.trim() === '' ? ` ...${optsName} ` : `${objBody.replace(/\s*$/, '')}, ...${optsName} `;
    next = next.slice(0, objStart + 1) + spread + next.slice(objEnd);
  }
  trace.action('cursor-gen:ensure-opts-forward', { propName });
  return next;
}

/**
 * Serialize the popup's behaviour opts into the JSON object written to the
 * INSTANCE prop (`cursorOpts={{"variant":"brand", …}}`). JSON (double-quoted)
 * so the read side is a plain JSON.parse. Behaviour fields only — the
 * component identity stays in the base prop.
 */
export function serializeInstanceCursorOpts(opts: UpdateComponentCursorOpts): string {
  const o: Record<string, unknown> = {};
  if (opts.variant !== undefined && opts.variant !== '') o.variant = opts.variant;
  if (opts.mode !== undefined) o.mode = opts.mode;
  if (opts.side !== undefined) o.side = opts.side;
  if (opts.align !== undefined) o.align = opts.align;
  if (typeof opts.offsetX === 'number' && opts.offsetX !== 0) o.offsetX = opts.offsetX;
  if (typeof opts.offsetY === 'number' && opts.offsetY !== 0) o.offsetY = opts.offsetY;
  if (opts.transition !== undefined) o.transition = opts.transition;
  if (opts.width !== undefined && opts.width !== '' && opts.width !== '0' && opts.width !== 0) o.width = opts.width;
  if (opts.height !== undefined && opts.height !== '' && opts.height !== '0' && opts.height !== 0) o.height = opts.height;
  if (opts.enterExit === true) o.enterExit = true;
  return JSON.stringify(o);
}

/** Parse an instance `<prop>Opts={{…}}` expression back into opts (null when absent/invalid). */
export function parseInstanceCursorOpts(exprSrc: string | null | undefined): UpdateComponentCursorOpts | null {
  if (!exprSrc) return null;
  try {
    const parsed = JSON.parse(exprSrc);
    return parsed && typeof parsed === 'object' ? parsed as UpdateComponentCursorOpts : null;
  } catch {
    return null;
  }
}
