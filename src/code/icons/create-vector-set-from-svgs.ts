// create-vector-set-from-svgs.ts — Build a new icon-set file from a list
// of SVG File objects (typically dropped onto the canvas).
//
// For each input SVG:
//   - Read as text
//   - Sanitize JSX-incompatible attrs (xmlns:xlink, xml:space, etc.)
//   - Wrap in our positioned-wrapper-SVG format so it sits inside its
//     icon card as a draggable / shape-editable vector
//   - Use the file's basename (sans extension) as the icon's display label
//
// Then assemble all entries via `buildIconSetFile` and write to ProjectFS.
// Returns the new file path + export name so the caller can drop an
// instance onto the current page.

import { projectFS } from '../project/project-fs';
import { queueMutation, flushNow } from '../mutation/mutation-queue';
import { buildIconSetFile, generateIconSetName, ICON_CARD_W, ICON_CARD_H, ICON_CARD_GAP, type IconEntryInput } from './icon-set-template';
import { clearIconSetCache } from './icon-set-registry';
import { convertSvgToEditableShapes } from '../svg/svg-import';
import { trace } from '@/shared/debug-trace';

export interface CreateVectorSetResult {
  iconSetFilePath: string;
  iconSetName: string;
  iconCount: number;
}

/**
 * Read a File as text via a FileReader. Resolves with the content,
 * rejects on read error. Dropped files arrive as standard File objects
 * — same API as the upload control.
 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error(`Failed to read ${file.name}`));
    reader.readAsText(file);
  });
}

/**
 * Read an SVG's intrinsic aspect from its viewBox (falling back to
 * width/height attrs; square when neither exists). Used to size each
 * icon's CARD so the vector "perfectly fits" its frame instead of
 * letterboxing inside a forced square.
 */
export function svgIntrinsicSize(rawSvg: string): { w: number; h: number } {
  const openMatch = rawSvg.match(/<svg\b([^>]*)>/i);
  const attrChunk = openMatch?.[1] ?? '';
  const vbMatch = attrChunk.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (vbMatch) {
    const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return { w: parts[2], h: parts[3] };
  }
  const wMatch = attrChunk.match(/(?:^|\s)width\s*=\s*["']([^"']+)["']/i);
  const hMatch = attrChunk.match(/(?:^|\s)height\s*=\s*["']([^"']+)["']/i);
  const w = wMatch ? parseFloat(wMatch[1]) : 0;
  const h = hMatch ? parseFloat(hMatch[1]) : 0;
  return w > 0 && h > 0 ? { w, h } : { w: ICON_CARD_W, h: ICON_CARD_H };
}

/**
 * Convert raw SVG markup into a positioned wrapper-SVG that fills its
 * icon card (`cardW`×`cardH`, default 240×240). Reuses the source's
 * viewBox + inner content; adds the data-id, data-name, position style,
 * and preserveAspectRatio that the canvas's shape system expects.
 *
 * The wrapper is marked `data-graphic="true"` — the parser keeps its
 * children OUT of the node tree and carries them as raw markup
 * (CanvasNode.graphicMarkup) so clipPaths/masks/gradients inside
 * imported icons actually render, and resize stays a plain box resize
 * (no viewBox/geometry bake). See parser.ts.
 *
 * Strips JSX-incompatible attrs (`xmlns:xlink`, `xml:space`, etc.) and
 * known noisy editor metadata (Inkscape, Adobe Illustrator namespaces).
 */
export function wrapSvgForIconCard(
  rawSvg: string,
  iconId: string,
  displayName: string,
  cardW: number = ICON_CARD_W,
  cardH: number = ICON_CARD_H,
): string {
  // Find the root <svg ...> opening + the matching closing.
  const openMatch = rawSvg.match(/<svg\b([^>]*)>/i);
  if (!openMatch) {
    // Not a recognizable SVG — fall back to a placeholder rect so the
    // icon still appears in the master view.
    return `<svg data-id="shape-${iconId}-default" data-name="${displayName}" data-graphic="true" viewBox="0 0 ${cardW} ${cardH}" preserveAspectRatio="none" style={{ position: "absolute", width: "${cardW}px", height: "${cardH}px", left: "0px", top: "0px", overflow: "visible" }}><rect width="100%" height="100%" fill="#3b82f6" /></svg>`;
  }

  const attrChunk = openMatch[1];
  const closeIdx = rawSvg.lastIndexOf('</svg>');
  const inner = closeIdx > 0 ? rawSvg.slice(rawSvg.indexOf('>', openMatch.index!) + 1, closeIdx).trim() : '';

  // Extract viewBox; fall back to width/height attrs; final fallback: 0 0 240 240.
  const vbMatch = attrChunk.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  const wMatch = attrChunk.match(/(?:^|\s)width\s*=\s*["']([^"']+)["']/i);
  const hMatch = attrChunk.match(/(?:^|\s)height\s*=\s*["']([^"']+)["']/i);
  let viewBox = vbMatch?.[1];
  if (!viewBox) {
    const w = wMatch ? parseFloat(wMatch[1]) : 0;
    const h = hMatch ? parseFloat(hMatch[1]) : 0;
    viewBox = w > 0 && h > 0 ? `0 0 ${Math.round(w)} ${Math.round(h)}` : `0 0 ${ICON_CARD_W} ${ICON_CARD_H}`;
  }

  // Sanitize the inner content for JSX-safe inclusion:
  //   - Attribute names with colons (xml:space, xmlns:xlink) break JSX;
  //     drop those attrs entirely (browsers don't need them at runtime).
  //   - Editor-specific namespaces (sodipodi, inkscape) add noise.
  //   - Inline `<style>` blocks contain raw CSS with `{}` braces, which
  //     JSX interprets as expression interpolation and refuses to parse.
  //     Inline the rules onto matching `class="..."` elements as `style={...}`
  //     attrs before stripping the `<style>` element.
  let sanitized = inner;
  // SECURITY: dropped files are untrusted input. Strip active content —
  // script blocks, inline event handlers, javascript: URLs, and
  // foreignObject (which can embed arbitrary HTML) — before the markup
  // is baked into a project file.
  sanitized = sanitized.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
  sanitized = sanitized.replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '');
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  sanitized = sanitized.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  sanitized = sanitized.replace(/\s(?:href|xlink:href)\s*=\s*"\s*javascript:[^"]*"/gi, '');
  sanitized = sanitized.replace(/\s(?:href|xlink:href)\s*=\s*'\s*javascript:[^']*'/gi, '');
  // JSX SAFETY: HTML comments are a parse error in JSX, and CDATA markers
  // (common inside exported <style> blocks) confuse the inliner below.
  sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');
  sanitized = sanitized.replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '');
  sanitized = sanitized.replace(/\s(?:xmlns:[a-z]+|xml:[a-z]+|sodipodi:[a-z]+|inkscape:[a-z]+)\s*=\s*"[^"]*"/gi, '');
  sanitized = sanitized.replace(/\s(?:xmlns:[a-z]+|xml:[a-z]+|sodipodi:[a-z]+|inkscape:[a-z]+)\s*=\s*'[^']*'/gi, '');
  // Strip any inkscape/sodipodi metadata children entirely.
  sanitized = sanitized.replace(/<sodipodi:[^>]*\/?>(?:[\s\S]*?<\/sodipodi:[^>]*>)?/gi, '');
  sanitized = sanitized.replace(/<inkscape:[^>]*\/?>(?:[\s\S]*?<\/inkscape:[^>]*>)?/gi, '');
  sanitized = sanitized.replace(/<metadata\b[\s\S]*?<\/metadata>/gi, '');

  // Inline + remove <style> blocks.
  sanitized = inlineStyleBlocks(sanitized);
  // JSX doesn't accept `class=` (or `xlink:href=`) — rename.
  sanitized = sanitized.replace(/\sclass\s*=\s*("([^"]*)"|'([^']*)')/g, ' className=$1');
  sanitized = sanitized.replace(/\sxlink:href\s*=/gi, ' xlinkHref=');
  // Any REMAINING string style attrs (elements without a class — the
  // inliner above only touched class-bearing ones) become JSX objects;
  // React throws at runtime on `style="fill:red"`.
  sanitized = sanitized.replace(/\sstyle\s*=\s*"([^"]*)"/g, (_m, css) => ` style={{ ${cssTextToJsxProps(String(css))} }}`);
  sanitized = sanitized.replace(/\sstyle\s*=\s*'([^']*)'/g, (_m, css) => ` style={{ ${cssTextToJsxProps(String(css))} }}`);

  // Build the positioned wrapper SVG.
  return `<svg data-id="shape-${iconId}-default" data-name="${displayName}" data-graphic="true" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" style={{ position: "absolute", width: "${cardW}px", height: "${cardH}px", left: "0px", top: "0px", overflow: "visible" }}>${sanitized}</svg>`;
}

/**
 * Parse `<style>` blocks out of SVG markup and inline the rules onto
 * matching `class="..."` elements as `style={{ ... }}` JSX attrs. This
 * lets us drop SVGs that came from design tools (Illustrator, Inkscape,
 * Sketch) which often define class-based styles in a `<style>` block —
 * raw CSS body in JSX is a syntax error because `{}` look like expression
 * interpolation. Removing the `<style>` block AND inlining the rules
 * preserves the visual.
 *
 * Limitations: only plain class selectors (`.foo`) are supported. Multi-
 * level selectors, pseudo-classes, media queries, etc. are dropped (rare
 * in icon SVGs). When a class has multiple matching rules, the LAST rule's
 * properties win (mirrors CSS cascade order).
 */
function inlineStyleBlocks(svg: string): string {
  // Find every <style ...>...</style> block and pull the CSS body out.
  const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  const classRules = new Map<string, Record<string, string>>();
  let mStyle: RegExpExecArray | null;
  while ((mStyle = styleRegex.exec(svg)) !== null) {
    const cssBody = mStyle[1];
    // Split on `}` to get individual rules. Each rule is `selector { decls`.
    const ruleParts = cssBody.split('}');
    for (const part of ruleParts) {
      const idx = part.indexOf('{');
      if (idx === -1) continue;
      const selector = part.slice(0, idx).trim();
      const declBody = part.slice(idx + 1);
      // Only handle plain class selectors. Multi-selector lists are split.
      const classNames: string[] = [];
      for (const sel of selector.split(',').map(s => s.trim())) {
        const m = sel.match(/^\.([a-zA-Z_][\w-]*)$/);
        if (m) classNames.push(m[1]);
      }
      if (classNames.length === 0) continue;
      const decls: Record<string, string> = {};
      for (const decl of declBody.split(';')) {
        const colonIdx = decl.indexOf(':');
        if (colonIdx === -1) continue;
        const prop = decl.slice(0, colonIdx).trim();
        const value = decl.slice(colonIdx + 1).trim();
        if (!prop || !value) continue;
        decls[prop] = value;
      }
      if (Object.keys(decls).length === 0) continue;
      for (const cls of classNames) {
        const existing = classRules.get(cls) ?? {};
        classRules.set(cls, { ...existing, ...decls });
      }
    }
  }
  // Strip the <style> blocks now that we've harvested their rules.
  let out = svg.replace(styleRegex, '');
  if (classRules.size === 0) return out;

  // For each `class="X Y Z"` attribute, look up matching rules and
  // append/merge into a `style={{...}}` attr on the same element.
  out = out.replace(/(<\w[^>]*?)\s(?:class|className)\s*=\s*("([^"]*)"|'([^']*)')([^>]*>)/g,
    (_match, before: string, _quoted: string, dq: string | undefined, sq: string | undefined, after: string) => {
      const classList = (dq ?? sq ?? '').split(/\s+/).filter(Boolean);
      const merged: Record<string, string> = {};
      for (const cls of classList) {
        const r = classRules.get(cls);
        if (r) Object.assign(merged, r);
      }
      // Detect existing `style="..."` on the element, parse into kv map,
      // merge under (class rules win — they were defined with explicit
      // intent, the inline style usually just augments).
      const existingStyleMatch = (before + after).match(/\sstyle\s*=\s*"([^"]*)"/);
      if (existingStyleMatch) {
        for (const decl of existingStyleMatch[1].split(';')) {
          const colonIdx = decl.indexOf(':');
          if (colonIdx === -1) continue;
          const prop = decl.slice(0, colonIdx).trim();
          const value = decl.slice(colonIdx + 1).trim();
          if (prop && value && !(prop in merged)) merged[prop] = value;
        }
      }
      const beforeNoStyle = before.replace(/\sstyle\s*=\s*"[^"]*"/, '');
      const afterNoStyle = after.replace(/\sstyle\s*=\s*"[^"]*"/, '');
      const styleObj = Object.entries(merged).map(([k, v]) => {
        // CSS prop names with hyphens need camelCase for JSX style objects.
        const camel = k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        return `${camel}: '${v.replace(/'/g, "\\'")}'`;
      }).join(', ');
      return `${beforeNoStyle} style={{${styleObj}}}${afterNoStyle}`;
    });
  return out;
}

/** CSS declaration text ("fill:red; stroke-width:2") → JSX style-object
 *  body ("fill: 'red', strokeWidth: '2'"). Used for bare `style="..."`
 *  string attrs that survive the class-rule inliner. */
function cssTextToJsxProps(cssText: string): string {
  const parts: string[] = [];
  for (const decl of cssText.split(';')) {
    const colonIdx = decl.indexOf(':');
    if (colonIdx === -1) continue;
    const prop = decl.slice(0, colonIdx).trim();
    const value = decl.slice(colonIdx + 1).trim();
    if (!prop || !value) continue;
    const camel = prop.replace(/-([a-z])/g, (_m: string, c: string) => c.toUpperCase());
    parts.push(`${camel}: '${value.replace(/'/g, "\\'")}'`);
  }
  return parts.join(', ');
}

/**
 * Slugify a display name for use as the icon's data-id / data-name. Falls
 * back to "Icon" when the input has no usable chars.
 */
function basenameToLabel(filename: string): string {
  const stem = filename.replace(/\.[^/.]+$/, '');
  return stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Icon';
}

/** Per-file guardrails for dropped sets: an oversized "icon" is usually a
 *  full illustration export, and hundreds of files would grind the parser. */
export const MAX_SVG_FILE_BYTES = 512 * 1024;
export const MAX_ICONS_PER_SET = 100;

export interface PreflightSvg {
  label: string;
  text: string;
}
export interface SvgPreflightResult {
  valid: PreflightSvg[];
  skipped: { name: string; reason: string }[];
}

/** Cheap content sniff — extension/mime lie sometimes; the markup doesn't. */
export function looksLikeSvg(text: string): boolean {
  return /<svg[\s>]/i.test(text);
}

/**
 * Read + validate dropped SVG files BEFORE the naming modal opens, so the
 * dialog can show honest counts ("12 icons ready · 2 skipped"). Skips:
 * oversized files, files whose content isn't actually SVG, unreadable
 * files, and everything past the per-set cap.
 */
export async function preflightSvgFiles(files: File[]): Promise<SvgPreflightResult> {
  const valid: PreflightSvg[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const file of files) {
    if (valid.length >= MAX_ICONS_PER_SET) {
      skipped.push({ name: file.name, reason: `over the ${MAX_ICONS_PER_SET}-icon limit` });
      continue;
    }
    if (file.size > MAX_SVG_FILE_BYTES) {
      skipped.push({ name: file.name, reason: 'too large (max 512KB)' });
      continue;
    }
    try {
      const text = await readFileAsText(file);
      if (!looksLikeSvg(text)) {
        skipped.push({ name: file.name, reason: 'not valid SVG' });
        continue;
      }
      valid.push({ label: basenameToLabel(file.name), text });
    } catch {
      skipped.push({ name: file.name, reason: 'could not be read' });
    }
  }
  trace.action('preflight-svg-files', { total: files.length, valid: valid.length, skipped: skipped.length });
  return { valid, skipped };
}

/**
 * Create a fresh icon-set master file from N dropped SVG files.
 * Synchronously writes via projectFS + queues the same write through the
 * mutation queue so atom subscribers (component registry, layers panel)
 * pick up the new file on the next flush.
 *
 * The display name supplied by the caller (typically from the
 * NewVectorSetModal) becomes the @name annotation; the file basename is
 * derived from `generateIconSetName()` to guarantee no collisions.
 */
export async function createVectorSetFromSvgs(
  displayName: string,
  svgFiles: File[] | PreflightSvg[],
): Promise<CreateVectorSetResult | null> {
  if (svgFiles.length === 0) return null;

  try {
    const iconSetName = generateIconSetName();
    const iconSetFilePath = `icons/${iconSetName}.tsx`;

    // Accept either raw Files (legacy callers) or preflighted entries —
    // the drop flow preflights first so its modal shows honest counts.
    const fileTexts: PreflightSvg[] = svgFiles[0] instanceof File
      ? (await preflightSvgFiles(svgFiles as File[])).valid
      : (svgFiles as PreflightSvg[]);
    if (fileTexts.length === 0) return null;

    // Build IconEntryInput[] — one per dropped SVG, laid out as a GRID of
    // cards with a gap (small sets = one row like the reference; bigger sets wrap
    // square-ish so 100 icons don't become a 28,000px-wide strip). These
    // land in iconConfig verbatim — NOTE `buildIconSetFile` treats leftPx
    // via `??`, so an explicit 0 here IS x:0 (the old `leftPx: 0` stacked
    // every card in one pile).
    const cols = fileTexts.length <= 6
      ? fileTexts.length
      : Math.min(10, Math.ceil(Math.sqrt(fileTexts.length)));
    let editableCount = 0;
    const entries: IconEntryInput[] = fileTexts.map((f, i) => {
      // Card matches the vector's intrinsic aspect (width fixed at 240) so
      // the icon perfectly fits its frame — a 780×500 badge gets a 240×154
      // card instead of letterboxing inside a square. Height clamps to the
      // row step so rows never overlap.
      const { w: vbW, h: vbH } = svgIntrinsicSize(f.text);
      const cardW = ICON_CARD_W;
      const cardH = Math.max(96, Math.min(ICON_CARD_H, Math.round((ICON_CARD_W * vbH) / vbW) || ICON_CARD_H));
      const iconId = `icon-${i + 1}`;
      // FIRST CHOICE: transpile to the editor's NATIVE shape format (paths
      // with baked transforms, <g>s as real editor groups) so every shape
      // is vertex-editable via double-click, exactly like drawn shapes.
      // Falls back to the opaque data-graphic wrapper when the SVG uses
      // features the shape model can't hold (masks, gradients, clip paths,
      // text, <use>…) — still pixel-correct, just not shape-editable.
      const converted = convertSvgToEditableShapes(f.text, {
        iconId, displayName: f.label, cardW, cardH,
      });
      if (converted) editableCount++;
      return {
        id: iconId,
        displayName: f.label,
        svgJSX: converted?.jsx ?? wrapSvgForIconCard(f.text, iconId, f.label, cardW, cardH),
        leftPx: (i % cols) * (ICON_CARD_W + ICON_CARD_GAP),
        topPx: Math.floor(i / cols) * (ICON_CARD_H + ICON_CARD_GAP),
        widthPx: cardW,
        heightPx: cardH,
      };
    });
    trace.action('create-vector-set-from-svgs:convert-stats', {
      total: entries.length, editable: editableCount, graphicFallback: entries.length - editableCount,
    });

    const code = buildIconSetFile(iconSetName, displayName || 'Icon Set', entries);

    projectFS.writeFile(iconSetFilePath, code);
    clearIconSetCache();
    // Queue a writeFile so atom-driven readers (component registry,
    // layers panel) pick up the new icon-set file on the next flush.
    // CRITICAL: do NOT call `syncQueueCode('')` here — that resets the
    // queue's view of the ACTIVE file's source to empty string, so any
    // SUBSEQUENT mutation against the active page (e.g. the
    // `addCanvasNode` the caller queues to drop the new icon-set
    // instance) applies to empty code and wipes the entire page.
    // makeIconSet doesn't do this either; the writeFile mutation alone
    // is enough — it targets a NEW file path so there's nothing in the
    // active-file queue to collide with.
    queueMutation({ type: 'writeFile', filePath: iconSetFilePath, content: code });
    flushNow();

    trace.action('create-vector-set-from-svgs:done', {
      iconSetFilePath, iconSetName, iconCount: entries.length, displayName,
    });

    return { iconSetFilePath, iconSetName, iconCount: entries.length };
  } catch (err) {
    trace.error('create-vector-set-from-svgs:failed', {
      error: err instanceof Error ? err.message : String(err),
      fileCount: svgFiles.length,
    });
    return null;
  }
}
