// icon-set-ops.ts — Create / extend / delete icon-set files.
//
// Mirrors `component-ops.ts` for the icon-set domain:
//   makeIconSet(pageFilePath, nodeId, displayName)
//     1. Flush pending mutations on the page so we read latest source.
//     2. Find the selected SVG subtree by data-id; capture its JSX
//        verbatim plus its wrapper-only style props (left/top/position/
//        width/height/...) — same rationale as makeComponent.
//     3. Build a fresh `icons/{Pascal}.tsx` with one icon entry containing
//        the captured SVG JSX.
//     4. Replace the SVG on the page with `<IconSetXxx data-id="..."
//        data-name="..." name="icon-1" style={{ wrapperOnly... }} />`
//        + add the import.
//     5. Return both file paths so the caller can switchActiveFile.
//
//   addIconToSet(iconSetFilePath, displayName?, svgJSX?)
//     1. Read current file, parse the ICONS map + existing entries.
//     2. Append a new IconXxx function (default: empty 100×100 svg).
//     3. Splice it into ICONS + the master-view layout.
//     4. Write back through modifyProjectFile so the queue stays in sync.
//
//   deleteIconSet(filePath) — symmetric with deleteComponent: clean
//     instances + imports across the project, then remove the file.

import { projectFS } from '../project/project-fs';
import { syncQueueCode, flushNow, queueMutation, syncImports } from '../mutation/mutation-queue';
import { modifyProjectFile } from '../project/modify-file';
import { parseJSX, findFirstElementByDataId, findAttribute } from '../parsing/ast-utils';
import { WRAPPER_ONLY_STYLE_PROPS } from '@/shared/constants';

// For icon-set instances, the SVG's intrinsic size is its viewBox; the
// instance's width/height describe the *display* size, so they ride
// with the instance, not the master file. Extends the regular
// wrapper-only set with width/height for this op only.
const ICON_INSTANCE_WRAPPER_PROPS = new Set<string>([...WRAPPER_ONLY_STYLE_PROPS, 'width', 'height']);
import {
  generateIconSetName,
  buildIconSetFile,
  buildIconJSXBlock,
  makeIconId,
  ICON_CARD_W,
  ICON_CARD_GAP,
  stripMotionFromIconSvgMarkup,
  type IconEntryInput,
} from './icon-set-template';
import { clearIconSetCache } from './icon-set-registry';
import {
  parseIconSetConfig,
  replaceIconSetConfigInCode,
  ICON_DEFAULT_W,
  ICON_DEFAULT_H,
  ICON_DEFAULT_GAP,
  type IconConfig,
} from './icon-set-config';
import * as t from '@babel/types';
import { trace } from '@/shared/debug-trace';

// ─── makeIconSet ──────────────────────────────────────────────────────────

export interface MakeIconSetResult {
  /** Path of the newly-created icon-set file, e.g. 'icons/Naxoba.tsx'. */
  iconSetFilePath: string;
  /** Internal default-export tag name, e.g. 'Naxoba'. */
  iconSetName: string;
  /** Page code with the original SVG replaced by the instance tag. */
  updatedPageCode: string;
  /** Canonical id of the first icon entry, e.g. 'icon-1'. */
  initialIconId: string;
}

/**
 * Extract a selected SVG subtree from a page into a new icon-set file.
 * The SVG keeps its inner shape children (paths, rects, etc.) so editing
 * the icon on the master page works through the existing SVG tools.
 */
export function makeIconSet(
  pageFilePath: string,
  nodeId: string,
  displayName: string,
): MakeIconSetResult | null {
  // Single-node shortcut — one selected vector becomes a set with one variant.
  // Delegates to the multi-node path so capture/replace logic lives in one place.
  return makeIconSetFromNodes(pageFilePath, [nodeId], displayName);
}

// ── Capture: one page node → one icon-set entry ────────────────────────────

interface CapturedIconNode {
  /** The id the node was looked up by — stays as the instance's data-id when
   *  this is the primary node. */
  sourceNodeId: string;
  entry: IconEntryInput;
  nodeStart: number;
  nodeEnd: number;
  /** Wrapper-only style props (position/left/top/width/height) pulled off the
   *  source element — re-applied to the instance tag for the PRIMARY node. */
  wrapperStyleEntries: Array<{ key: string; jsx: string }>;
  originalDataName: string | null;
}

/**
 * Capture a single node — an `<svg>` shape OR an `<svg>` group with nested
 * `<svg>` children — as one icon-set entry. The whole subtree is taken
 * verbatim, so a multi-shape group bundles into ONE variant. Width/height come
 * from the node's wrapper px style so each variant card is sized to its shape.
 */
function captureIconNodeAsEntry(
  ast: ReturnType<typeof parseJSX>,
  pageCode: string,
  nodeId: string,
  iconId: string,
): CapturedIconNode | null {
  let svgJSX: string | null = null;
  let nodeStart = -1;
  let nodeEnd = -1;
  const wrapperStyleEntries: Array<{ key: string; jsx: string }> = [];
  let originalDataName: string | null = null;

  findFirstElementByDataId(ast!, nodeId, (path) => {
    const node = path.node;
    if (node.start == null || node.end == null) return;
    nodeStart = node.start;
    nodeEnd = node.end;
    svgJSX = pageCode.substring(nodeStart, nodeEnd);

    // Capture the original data-name so the variant + instance can reuse it as
    // a layers-panel label fallback if the user didn't supply one.
    const opening = node.openingElement;
    const nameAttr = findAttribute(opening, 'data-name') as t.JSXAttribute | null;
    if (nameAttr && nameAttr.value && t.isStringLiteral(nameAttr.value)) {
      originalDataName = nameAttr.value.value;
    }

    // Pull wrapper-only style props off the original `<svg style={{...}}>` —
    // same approach as makeComponent. Position/dimensions describe how the SVG
    // sat in its parent; they ride with the instance (and seed the per-variant
    // iconConfig width/height), not get baked into the master file.
    const styleAttr = findAttribute(opening, 'style') as t.JSXAttribute | null;
    if (!styleAttr || styleAttr.value?.type !== 'JSXExpressionContainer') return;
    const expr = styleAttr.value.expression;
    if (!t.isObjectExpression(expr)) return;
    for (const prop of expr.properties) {
      if (!t.isObjectProperty(prop)) continue;
      const key = t.isIdentifier(prop.key) ? prop.key.name
                : t.isStringLiteral(prop.key) ? prop.key.value
                : null;
      if (!key || !ICON_INSTANCE_WRAPPER_PROPS.has(key)) continue;
      if (prop.value.start == null || prop.value.end == null) continue;
      const valueText = pageCode.slice(prop.value.start, prop.value.end);
      wrapperStyleEntries.push({ key, jsx: `${key}: ${valueText}` });
    }
  });

  if (!svgJSX || nodeStart === -1) return null;

  // Normalise the source vector to a plain <svg> FIRST: a vector dragged into a
  // component/variant becomes `<motion.svg variants=… initial=… animate=…>` with
  // page-level bindings that crash inside an icon-set file. THEN strip the
  // wrapper position/size props (re-applied to the instance tag / iconConfig).
  const cleanedSvgJSX = stripWrapperStyleProps(stripMotionFromIconSvgMarkup(svgJSX as string));

  // Per-variant card size from the source's wrapper px width/height. Only px is
  // honored; non-px (auto, %) falls through to the 240×240 default downstream.
  const widthEntry = wrapperStyleEntries.find(e => e.key === 'width');
  const heightEntry = wrapperStyleEntries.find(e => e.key === 'height');
  const widthMatch = widthEntry?.jsx.match(/['"](\d+(?:\.\d+)?)px['"]/);
  const heightMatch = heightEntry?.jsx.match(/['"](\d+(?:\.\d+)?)px['"]/);
  const widthPx = widthMatch ? Math.round(parseFloat(widthMatch[1])) : undefined;
  const heightPx = heightMatch ? Math.round(parseFloat(heightMatch[1])) : undefined;

  // Per-variant label defaults to the shape's own name ("Triangle", "Ellipse"…),
  // falling back to the reference's generic "Vector".
  const entry: IconEntryInput = {
    id: iconId,
    displayName: originalDataName || 'Vector',
    svgJSX: cleanedSvgJSX,
    leftPx: 0, // re-assigned for cumulative layout by the caller
    widthPx,
    heightPx,
  };
  return { sourceNodeId: nodeId, entry, nodeStart, nodeEnd, wrapperStyleEntries, originalDataName };
}

/**
 * Extract one OR MORE selected nodes into a single vector set — each selected
 * node becomes its own variant, sized individually to its shape. A selected
 * node that is itself a group (an `<svg>` with nested `<svg>` children) bundles
 * into ONE variant (its whole subtree is captured verbatim).
 *
 * The FIRST node stays on the page as the set instance (showing variant
 * `icon-1`); the rest are removed from the page — their markup now lives as
 * variants in the new master file.
 */
export function makeIconSetFromNodes(
  pageFilePath: string,
  nodeIds: string[],
  displayName: string,
): MakeIconSetResult | null {
  try {
    if (nodeIds.length === 0) {
      trace.error('icon-set-ops:make-no-nodes', { pageFilePath });
      return null;
    }

    // Flush pending mutations so we read the latest code.
    const preFlushCode = projectFS.readFile(pageFilePath);
    if (preFlushCode) syncQueueCode(preFlushCode);
    flushNow();

    const pageCode = projectFS.readFile(pageFilePath);
    if (!pageCode) {
      trace.error('icon-set-ops:page-empty', { pageFilePath });
      return null;
    }

    const ast = parseJSX(pageCode);
    if (!ast) {
      trace.error('icon-set-ops:parse-failed', { pageFilePath });
      return null;
    }

    const iconSetName = generateIconSetName();
    const iconSetFilePath = `icons/${iconSetName}.tsx`;

    // Capture every selected node → one entry. A node that can't be found is
    // skipped (a single bad id shouldn't sink the whole op).
    const captured: CapturedIconNode[] = [];
    nodeIds.forEach((id, i) => {
      const cap = captureIconNodeAsEntry(ast, pageCode, id, `icon-${i + 1}`);
      if (cap) captured.push(cap);
      else trace.error('icon-set-ops:node-not-found', { nodeId: id, pageFilePath });
    });
    if (captured.length === 0) {
      trace.error('icon-set-ops:no-captures', { nodeIds, pageFilePath });
      return null;
    }

    // Re-number ids contiguously (some captures may have been skipped) and lay
    // the cards out left-to-right using each variant's OWN width, so a wide
    // variant doesn't overlap its neighbour on the master canvas.
    let cursorX = 0;
    captured.forEach((cap, i) => {
      cap.entry.id = `icon-${i + 1}`;
      cap.entry.leftPx = cursorX;
      cursorX += (cap.entry.widthPx ?? ICON_CARD_W) + ICON_CARD_GAP;
    });

    const entries = captured.map(c => c.entry);
    const iconSetCode = buildIconSetFile(iconSetName, displayName, entries);

    projectFS.writeFile(iconSetFilePath, iconSetCode);
    clearIconSetCache();
    queueMutation({ type: 'writeFile', filePath: iconSetFilePath, content: iconSetCode });

    // The first captured node becomes the on-page instance (showing icon-1);
    // every other captured node is removed from the page. data-id of the
    // primary stays the same so selection identity is preserved.
    const primary = captured[0];
    const initialIconId = primary.entry.id; // 'icon-1'
    const styleAttrFragment = primary.wrapperStyleEntries.length > 0
      ? ` style={{ ${primary.wrapperStyleEntries.map(e => e.jsx).join(', ')} }}`
      : '';
    const instanceDataName = primary.originalDataName || displayName;
    const instanceTag = `<${iconSetName} data-id="${primary.sourceNodeId}" data-name="${instanceDataName}" name="${initialIconId}"${styleAttrFragment} />`;

    // Rewrite the page from the END backwards so earlier offsets stay valid:
    // the primary span → the instance tag, every other captured span → ''.
    const ops = captured
      .map((c, i) => ({ start: c.nodeStart, end: c.nodeEnd, replacement: i === 0 ? instanceTag : '' }))
      .sort((a, b) => b.start - a.start);
    let replacedCode = pageCode;
    for (const op of ops) {
      replacedCode = replacedCode.slice(0, op.start) + op.replacement + replacedCode.slice(op.end);
    }

    const finalPageCode = addImportIfNeeded(replacedCode, iconSetName, iconSetFilePath);

    trace.action('icon-set-ops:make', {
      iconSetFilePath, iconSetName, nodeIds, variantCount: entries.length, pageFilePath,
    });

    return { iconSetFilePath, iconSetName, updatedPageCode: finalPageCode, initialIconId };
  } catch (err) {
    trace.error('icon-set-ops:make-failed', {
      pageFilePath, nodeIds, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── addIconToSet ─────────────────────────────────────────────────────────

/**
 * Append a new icon entry to an existing icon-set file. By default
 * creates an empty 100×100 SVG placeholder; pass `svgJSX` to seed it
 * with content (e.g. when "Add to Icon Set" extracts an SVG from a page).
 *
 * Splices a new `<svg data-id="icon-N">` block into the master-view
 * `<div data-id="iconset-master">` at the next x-offset slot. The new
 * SVG block becomes the per-instance render automatically because the
 * default-export's instance branch picks children of master by data-id.
 */
export function addIconToSet(
  iconSetFilePath: string,
  options: {
    displayName?: string;
    svgJSX?: string;
    position?: { left: number; top: number };
    /** Override the new vector card's intrinsic dimensions. Defaults
     *  to `ICON_DEFAULT_W` / `ICON_DEFAULT_H` (240×240). The in-canvas
     *  "+ Vector" placeholder passes the SOURCE vector's size so the
     *  added card matches the variant the user is currently viewing —
     *  without it, a 600×400 source lands next to a 240×240 sibling
     *  and the row visibly staggers. */
    size?: { width: number; height: number };
  } = {},
): { iconId: string } | null {
  try {
    const resultId = { value: 'icon-1' };

    modifyProjectFile(iconSetFilePath, (code) => {
      // Read the existing iconConfig (source of truth for ids + positions).
      // Fall back to scanning JSX for legacy files that don't have iconConfig
      // yet (template pre-iconConfig — still produced <div data-id="...">
      // entries).
      let configs = parseIconSetConfig(code);
      const existingIdsFromConfig = new Set(configs.map(c => c.name));
      const existingIdsFromJSX = parseExistingIconIds(code);
      const allExisting = new Set<string>([...existingIdsFromConfig, ...existingIdsFromJSX]);
      const id = makeIconId(allExisting);
      resultId.value = id;

      // Default: empty card. The user draws shapes in via the
      // pencil/shape tools after entering the new variant — saves
      // them from deleting the placeholder rect first.
      // Normalise to a plain <svg> — a vector dragged from a component/variant
      // carries motion/variant promotion that would crash inside the icon file.
      const svg = stripMotionFromIconSvgMarkup(options.svgJSX ?? '');
      const left = options.position?.left
        ?? configs.length * (ICON_DEFAULT_W + ICON_DEFAULT_GAP);
      const top = options.position?.top ?? 0;
      const width = options.size?.width ?? ICON_DEFAULT_W;
      const height = options.size?.height ?? ICON_DEFAULT_H;
      const newBlock = buildIconJSXBlock({
        id,
        displayName: options.displayName || 'Vector',
        svgJSX: svg,
        leftPx: left,  // ignored by content-only buildIconJSXBlock; passed for type compat
        topPx: top,
      });

      // Append the new entry to iconConfig — this is what the canvas
      // reads for positioning. The JSX block below carries content only.
      const newConfig: IconConfig = {
        name: id,
        label: options.displayName || 'Vector',
        x: left,
        y: top,
        width,
        height,
        isPrimary: configs.length === 0,
      };
      configs = [...configs, newConfig];
      code = replaceIconSetConfigInCode(code, configs);

      // Splice the new block immediately before the master div's closing
      // tag. We brace-walk to find the correct `</div>` — the master is
      // typically the only top-level wrapper, but there could be nested
      // divs inside (e.g. someone added a foreignObject containing one).
      // Look for the icon-set's root div. Older files used data-id="iconset-master";
      // current template uses data-id="root" so the sandbox Renderer treats
      // the master file as a proper page.
      const rootIdx = code.indexOf('data-id="root"');
      const masterDivIdx = rootIdx !== -1 ? rootIdx : code.indexOf('data-id="iconset-master"');
      if (masterDivIdx === -1) {
        trace.error('icon-set-ops:add-no-master-div', { iconSetFilePath });
        return code;
      }
      // Find the master div's opening `>` then walk forward, balancing
      // `<div>` / `</div>` until depth returns to zero.
      const tagEndIdx = code.indexOf('>', masterDivIdx);
      if (tagEndIdx === -1) return code;
      let depth = 1;
      let scan = tagEndIdx + 1;
      while (scan < code.length && depth > 0) {
        const nextOpen = code.indexOf('<div', scan);
        const nextClose = code.indexOf('</div>', scan);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          scan = nextOpen + 4;
        } else {
          depth--;
          if (depth === 0) {
            // Insert just before this `</div>`. Indent for readability.
            const indent = '      ';
            const insertion = `${indent}${newBlock.replace(/\n/g, `\n${indent}`)}\n    `;
            return code.slice(0, nextClose) + insertion + code.slice(nextClose);
          }
          scan = nextClose + 6;
        }
      }
      return code;
    });

    clearIconSetCache();
    trace.action('icon-set-ops:add-icon', { iconSetFilePath, iconId: resultId.value });
    return { iconId: resultId.value };
  } catch (err) {
    trace.error('icon-set-ops:add-icon-failed', {
      iconSetFilePath, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── deleteIconSet ────────────────────────────────────────────────────────

/**
 * Remove an icon-set file + clean all its instances and imports.
 * Mirror of `deleteComponent`. Returns list of modified files.
 */
export function deleteIconSet(iconSetFilePath: string): string[] {
  const internalName = iconSetFilePath.replace('icons/', '').replace('.tsx', '');
  trace.action('icon-set-ops:delete', { iconSetFilePath, internalName });

  const modifiedFiles: string[] = [];
  const allFiles = projectFS.listFiles();
  for (const file of allFiles) {
    if (file === iconSetFilePath) continue;
    if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue;
    const code = projectFS.readFile(file);
    if (!code) continue;

    const importPattern = new RegExp(`import\\s+${internalName}\\s+from\\s+['"].*?${internalName}['"];?\\n?`);
    if (!importPattern.test(code)) continue;

    let cleaned = code;
    const selfClosingRe = new RegExp(`<${internalName}\\b[^>]*?\\/>\\s*`, 'g');
    cleaned = cleaned.replace(selfClosingRe, '');
    const openCloseRe = new RegExp(`<${internalName}\\b[^>]*>[\\s\\S]*?<\\/${internalName}>\\s*`, 'g');
    cleaned = cleaned.replace(openCloseRe, '');
    cleaned = syncImports(cleaned);

    if (cleaned !== code) {
      projectFS.writeFile(file, cleaned);
      modifiedFiles.push(file);
    }
  }

  projectFS.deleteFile(iconSetFilePath);
  clearIconSetCache();
  return modifiedFiles;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Strip wrapper-only style entries from a `<svg style={{...}}>` JSX string.
 *  Operates on source text rather than AST so this can run on a substring
 *  without re-parsing the whole file. We only touch the FIRST `style={{...}}`
 *  encountered, which on a fresh capture is the SVG root. */
function stripWrapperStyleProps(svgJSX: string): string {
  const styleIdx = svgJSX.indexOf('style={{');
  if (styleIdx === -1) return svgJSX;
  const objStart = styleIdx + 'style={{'.length;
  let depth = 1;
  let pos = objStart;
  while (pos < svgJSX.length && depth > 0) {
    if (svgJSX[pos] === '{') depth++;
    else if (svgJSX[pos] === '}') depth--;
    if (depth > 0) pos++;
  }
  const inner = svgJSX.slice(objStart, pos);
  // Split on top-level commas.
  const props = splitTopLevelCommas(inner);
  const kept: string[] = [];
  for (const p of props) {
    const colon = p.indexOf(':');
    if (colon === -1) { kept.push(p); continue; }
    const key = p.slice(0, colon).trim().replace(/^['"]|['"]$/g, '');
    if (!WRAPPER_ONLY_STYLE_PROPS.has(key)) kept.push(p);
  }
  if (kept.length === 0) {
    // Remove the whole `style={{...}}` attribute (drop preceding whitespace too).
    const attrStart = svgJSX.lastIndexOf(' ', styleIdx);
    return svgJSX.slice(0, attrStart) + svgJSX.slice(pos + 2); // +2 for `}}`
  }
  return svgJSX.slice(0, objStart) + kept.join(',') + svgJSX.slice(pos);
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(last, i));
      last = i + 1;
    }
  }
  out.push(s.slice(last));
  return out.map(x => x.trim()).filter(Boolean);
}

/** Parse existing icon ids from the master view's `<svg data-id="...">`
 *  children. We only look INSIDE the iconset-master div so SVGs in
 *  unrelated places (e.g. a comment example) don't collide. */
function parseExistingIconIds(code: string): Set<string> {
  const ids = new Set<string>();
  // Try data-id="root" (current template) first, fall back to legacy
  // data-id="iconset-master" so existing files keep working.
  const rootIdx = code.indexOf('data-id="root"');
  const masterIdx = rootIdx !== -1 ? rootIdx : code.indexOf('data-id="iconset-master"');
  if (masterIdx === -1) return ids;
  const tagEndIdx = code.indexOf('>', masterIdx);
  if (tagEndIdx === -1) return ids;
  // Walk to the matching `</div>` so we only scan master-direct children.
  let depth = 1;
  let scan = tagEndIdx + 1;
  let masterEnd = code.length;
  while (scan < code.length && depth > 0) {
    const nextOpen = code.indexOf('<div', scan);
    const nextClose = code.indexOf('</div>', scan);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      scan = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) { masterEnd = nextClose; break; }
      scan = nextClose + 6;
    }
  }
  const masterBody = code.slice(tagEndIdx, masterEnd);
  // Vector entries are wrapped in `<div data-id="icon-N">` (current
  // template). Legacy template used `<svg data-id="icon-N">`. Match
  // either tag so id-collision detection works for both — a missed
  // entry here means makeIconId returns a duplicate and every new
  // vector lands on top of icon-1 with the same id.
  const idRe = /<(?:div|svg)[^>]*?\bdata-id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(masterBody)) !== null) {
    ids.add(m[1]);
  }
  return ids;
}

export function addImportIfNeeded(code: string, internalName: string, filePath: string): string {
  if (code.includes(`import ${internalName}`) || code.includes(`import { ${internalName}`)) {
    return code;
  }
  const importPath = '@/' + filePath.replace(/\.tsx$/, '');
  const importStatement = `import ${internalName} from '${importPath}';\n`;
  const lastImportIdx = code.lastIndexOf('\nimport ');
  if (lastImportIdx !== -1) {
    const endOfLine = code.indexOf('\n', lastImportIdx + 1);
    return code.slice(0, endOfLine + 1) + importStatement + code.slice(endOfLine + 1);
  }
  return importStatement + code;
}

// ─── updateIconPosition ───────────────────────────────────────────────────
//
// Drag-commit hook for vector cards on the icon-set master. Mirrors
// `updateVariantPosition` from variant-ops: rewrites a single iconConfig
// entry's x/y in place, leaves all other entries (and the master JSX)
// untouched. Canvas.tsx routes vector-root drags here instead of writing
// inline left/top.

export function updateIconPosition(
  filePath: string,
  iconName: string,
  x: number,
  y: number,
): void {
  try {
    modifyProjectFile(filePath, (code) => {
      const configs = parseIconSetConfig(code);
      if (configs.length === 0) {
        trace.action('icon-set-ops:updatePosition-no-config', { filePath, iconName });
        return code;
      }
      const idx = configs.findIndex(c => c.name === iconName);
      if (idx === -1) {
        trace.action('icon-set-ops:updatePosition-not-found', { filePath, iconName });
        return code;
      }
      configs[idx] = { ...configs[idx], x: Math.round(x), y: Math.round(y) };
      return replaceIconSetConfigInCode(code, configs);
    });
    clearIconSetCache();
    trace.action('icon-set-ops:updatePosition', { filePath, iconName, x, y });
  } catch (err) {
    trace.error('icon-set-ops:updatePosition-failed', {
      filePath, iconName, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── updateIconSize ───────────────────────────────────────────────────────
//
// Same pattern for resize. Drags on the resize handles route here so the
// new width/height land in iconConfig instead of the vector div's inline
// style — keeps the master JSX clean and lets the canvas re-derive layout
// from a single source.

export function updateIconSize(
  filePath: string,
  iconName: string,
  width: number,
  height: number,
): void {
  try {
    modifyProjectFile(filePath, (code) => {
      const configs = parseIconSetConfig(code);
      if (configs.length === 0) return code;
      const idx = configs.findIndex(c => c.name === iconName);
      if (idx === -1) return code;
      configs[idx] = {
        ...configs[idx],
        width: Math.round(width),
        height: Math.round(height),
      };
      return replaceIconSetConfigInCode(code, configs);
    });
    clearIconSetCache();
    trace.action('icon-set-ops:updateSize', { filePath, iconName, width, height });
  } catch (err) {
    trace.error('icon-set-ops:updateSize-failed', {
      filePath, iconName, error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── removeIconFromSet ───────────────────────────────────────────────────
//
// Strip a single vector card from an icon-set master file. Removes BOTH
// the iconConfig entry AND the variant `<div data-id="...">` JSX block
// in one transactional write.
//
// Why both: the user-facing delete flow (backspace / context-menu Delete)
// goes through `removeNode` → queues a `removeNode` mutation that strips
// the JSX. Without this helper running too, the iconConfig entry sticks
// around, the IconSetTool's variant picker keeps showing the deleted
// vector as a phantom thumbnail (clicking it lands on null content),
// and the parser's iconConfig→node merge re-adds a 240×240 ghost rect
// to the master canvas on the next render.
//
// Refuses to remove the LAST remaining icon — the master file always
// needs at least one variant for the IconSet component to have something
// to render.
//
// Returns true when the file was modified, false when the variant id
// was missing or the call was blocked by the last-icon guard.

export function removeIconFromSet(filePath: string, iconName: string): boolean {
  let removed = false;
  try {
    modifyProjectFile(filePath, (code) => {
      const configs = parseIconSetConfig(code);
      if (configs.length <= 1) {
        trace.action('icon-set-ops:remove-blocked-last', { filePath, iconName });
        return code;
      }
      const idx = configs.findIndex(c => c.name === iconName);
      if (idx === -1) return code;
      const wasPrimary = configs[idx].isPrimary;
      const next = configs.filter(c => c.name !== iconName);
      // Promote a new primary if the removed one was it — same invariant
      // makeIconSet / addIconToSet maintain.
      if (wasPrimary && next.length > 0 && !next.some(c => c.isPrimary)) {
        next[0] = { ...next[0], isPrimary: true };
      }
      const nextCode = replaceIconSetConfigInCode(code, next);
      // Strip the variant's outer `<div data-id="...">...</div>` block
      // via brace-walk depth tracking (the variant container holds an
      // SVG + possibly user-added shapes).
      const dataIdMarker = `data-id="${iconName}"`;
      const blockStart = nextCode.indexOf(dataIdMarker);
      if (blockStart === -1) return nextCode;
      let openStart = blockStart;
      while (openStart > 0 && !nextCode.startsWith('<div', openStart)) openStart--;
      if (!nextCode.startsWith('<div', openStart)) return nextCode;
      let depth = 1;
      let scan = nextCode.indexOf('>', openStart) + 1;
      while (scan < nextCode.length && depth > 0) {
        const nextOpen = nextCode.indexOf('<div', scan);
        const nextClose = nextCode.indexOf('</div>', scan);
        if (nextClose === -1) break;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth++;
          scan = nextOpen + 4;
        } else {
          depth--;
          if (depth === 0) {
            const blockEnd = nextClose + '</div>'.length;
            // Trim leading whitespace + a trailing newline so we don't
            // leave a blank line where the variant used to be.
            let from = openStart;
            while (from > 0 && (nextCode[from - 1] === ' ' || nextCode[from - 1] === '\t')) from--;
            if (nextCode[from - 1] === '\n') from--;
            removed = true;
            return nextCode.slice(0, from) + nextCode.slice(blockEnd);
          }
          scan = nextClose + 6;
        }
      }
      return nextCode;
    });
    clearIconSetCache();
    trace.action('icon-set-ops:remove-icon', { filePath, iconName, removed });
    return removed;
  } catch (err) {
    trace.error('icon-set-ops:remove-icon-failed', {
      filePath, iconName, error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
