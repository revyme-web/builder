// map-gen.ts — Code generation for inline .map() repeater system.
// "Make into Map" converts a single element into a .map() with data array.

import { trace } from '@/shared/debug-trace';
import { findJSXDataIdIndex } from './generator-utils';
import { findTagClose, findMatchingCloseTagIndex } from './generator-utils';
import { findMatchingParen } from '../parsing/parse-utils';
import { COLLECTION_MAP_CALL_RE, extractCollectionSlugSpan, itemVarFromCallbackParam } from './cms-gen';
import { parseJSXToNodes } from '../parsing/parser';

/**
 * Convert an element into an inline .map() repeater.
 *
 * Given an element like:
 *   <div data-id="card-1" style={{padding: '24px'}}>
 *     <h3 data-id="card-title">Hello World</h3>
 *     <p data-id="card-desc">Some description</p>
 *   </div>
 *
 * Produces:
 *   const card1Data = [
 *     { title: 'Hello World', desc: 'Some description' },
 *   ];
 *   ...
 *   {card1Data.map((item, idx) => (
 *     <div data-id={`card-${idx}`} key={idx} style={{padding: '24px'}}>
 *       <h3 data-id={`card-title-${idx}`}>{item.title}</h3>
 *       <p data-id={`card-desc-${idx}`}>{item.desc}</p>
 *     </div>
 *   ))}
 */
export function makeIntoMapInCode(
  code: string,
  nodeId: string,
  varName?: string,
): string {
  trace.fn('map-gen:makeIntoMap', { nodeId, varName });

  // Find the element in JSX
  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) {
    trace.error('map-gen:makeIntoMap', { message: 'Element not found', nodeId });
    return code;
  }

  // Find the opening < before the data-id
  const openStart = code.lastIndexOf('<', idIndex);
  if (openStart === -1) {
    trace.error('map-gen:makeIntoMap', { message: 'Opening tag not found', nodeId });
    return code;
  }

  // Extract tag name
  const tagMatch = code.slice(openStart + 1, idIndex).match(/^(\S+)/);
  if (!tagMatch) {
    trace.error('map-gen:makeIntoMap', { message: 'Tag name not found', nodeId });
    return code;
  }
  const tagName = tagMatch[1];

  // Find the full element (opening tag to closing tag)
  const elementJSX = extractFullElement(code, openStart, tagName);
  if (!elementJSX) {
    trace.error('map-gen:makeIntoMap', { message: 'Could not extract full element', nodeId, tagName });
    return code;
  }

  const { jsx: originalJSX, endIndex } = elementJSX;

  // Parse the element to extract text content for data fields
  const nodes = parseJSXToNodes(`export default function X() { return ${originalJSX}; }`);
  const rootNode = nodes.get(nodeId);
  if (!rootNode) {
    trace.error('map-gen:makeIntoMap', { message: 'Root node not found in parsed JSX', nodeId });
    return code;
  }

  // Generate variable name from data-id, ensuring no collision with existing const names
  const safeVarName = varName || generateUniqueVarName(nodeId, code);

  // Extract bindable text fields from children
  const dataItem: Record<string, string> = {};
  const bindings: { childId: string; field: string; text: string }[] = [];

  for (const childId of rootNode.children) {
    const child = nodes.get(childId);
    if (!child) continue;
    if (child.textContent && !child.textContent.includes('<')) {
      // Simple text content — make it a data field
      const fieldName = generateFieldName(childId, nodeId);
      dataItem[fieldName] = child.textContent.trim();
      bindings.push({ childId, field: fieldName, text: child.textContent.trim() });
    }
  }

  // If no bindable children found, create a minimal data item
  if (Object.keys(dataItem).length === 0) {
    dataItem['label'] = nodeId;
  }

  // Build the template JSX with bindings
  let templateJSX = originalJSX;

  // Keep the STATIC data-id on the template root — parser needs it to find the template.
  // Add key={idx} for React reconciliation.
  templateJSX = templateJSX.replace(
    `data-id="${nodeId}"`,
    `data-id="${nodeId}" key={idx}`,
  );

  // Bind text content: replace static text with {item.field} expressions
  for (const { childId, field, text } of bindings) {
    // Replace static text with binding expression
    // Text in JSX may have surrounding whitespace/newlines — use regex to match
    const escapedText = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const textRegex = new RegExp(`>\\s*${escapedText}\\s*<`);
    templateJSX = templateJSX.replace(textRegex, `>{item.${field}}<`);
  }

  // Build the const declaration
  const dataDecl = `const ${safeVarName} = [\n    ${JSON.stringify(dataItem)},\n  ];\n`;

  // Build the .map() expression
  const mapExpr = `{${safeVarName}.map((item, idx) => (\n      ${templateJSX}\n    ))}`;

  // Find the return statement to insert the const before it
  const returnIdx = code.lastIndexOf('return', openStart);
  if (returnIdx === -1) {
    trace.error('map-gen:makeIntoMap', { message: 'Return statement not found', nodeId });
    return code;
  }

  // Insert const declaration before return, replace element with .map()
  let result = code;

  // First: replace the original element with the .map() expression
  result = result.slice(0, openStart) + mapExpr + result.slice(endIndex);

  // Then: insert the data array const before the return statement
  // (need to recalculate returnIdx since we changed the code)
  const newReturnIdx = result.lastIndexOf('return', result.indexOf(mapExpr));
  if (newReturnIdx !== -1) {
    const indent = '  ';
    result = result.slice(0, newReturnIdx) + indent + dataDecl + '\n  ' + result.slice(newReturnIdx);
  }

  trace.action('map-gen:makeIntoMap:done', {
    nodeId, varName: safeVarName,
    fields: Object.keys(dataItem),
    bindingCount: bindings.length,
  });

  return result;
}

/**
 * Wrap a single element in a `.map()` bound to a CMS collection (in
 * `cms/{slug}.json`). The selected element becomes the template root —
 * exactly the same shape the parser already detects for inline `.map()`,
 * just with the source resolving to a CMS slug instead of a local array
 * literal. Field bindings (e.g. `{item.title}`) are NOT auto-injected
 * here; the user wires them per-property via the value-source picker.
 *
 * Given:
 *   <div data-id="card1"><h3>Hello</h3></div>
 *
 * Produces (top of file):
 *   import blogPosts from '@/cms/blog.json';
 *
 * And (in place of the original element):
 *   {blogPosts.map((item, idx) => (
 *     <div data-id="card1" key={idx}><h3>Hello</h3></div>
 *   ))}
 *
 * Parser then sets `collectionList: { source: 'blog', itemVar: 'item',
 * templateIds: { default: 'card1' } }` on whatever JSXElement contains
 * the `.map()` (the original element's parent).
 */
export function bindToCmsCollectionInCode(
  code: string,
  nodeId: string,
  collectionSlug: string,
): string {
  trace.fn('map-gen:bindToCms', { nodeId, collectionSlug });

  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) {
    trace.error('map-gen:bindToCms', { message: 'Element not found', nodeId });
    return code;
  }

  const openStart = code.lastIndexOf('<', idIndex);
  if (openStart === -1) return code;

  const tagMatch = code.slice(openStart + 1, idIndex).match(/^(\S+)/);
  if (!tagMatch) return code;
  const tagName = tagMatch[1];

  const elementJSX = extractFullElement(code, openStart, tagName);
  if (!elementJSX) {
    trace.error('map-gen:bindToCms', { message: 'Could not extract full element', nodeId, tagName });
    return code;
  }

  const { jsx: originalJSX, endIndex } = elementJSX;
  const importVar = slugToVarName(collectionSlug);

  // Add `key={idx}` to the template root so React reconciles per item.
  // Static `data-id` is preserved — parser uses it to find the template.
  const templateJSX = originalJSX.replace(
    `data-id="${nodeId}"`,
    `data-id="${nodeId}" key={idx}`,
  );

  const mapExpr = `{${importVar}.map((item, idx) => (\n      ${templateJSX}\n    ))}`;
  let result = code.slice(0, openStart) + mapExpr + code.slice(endIndex);

  // Add the import only if it's not already there. Parser maps any default
  // specifier name → slug, so the variable name doesn't have to be canonical
  // — but matching `from '@/cms/SLUG.json'` exactly de-dupes correctly.
  const importPath = `'@/cms/${collectionSlug}.json'`;
  if (!result.includes(importPath)) {
    const importStmt = `import ${importVar} from ${importPath};\n`;
    const insertAt = findInsertionPointForImport(result);
    result = result.slice(0, insertAt) + importStmt + result.slice(insertAt);
  }

  trace.action('map-gen:bindToCms:done', { nodeId, collectionSlug, importVar });
  return result;
}

/**
 * Inverse of `bindToCmsCollectionInCode`: unwraps a CMS-bound element from
 * its enclosing `{varName.map((item, idx) => ( <template> ))}` so it goes
 * back to a plain template element. Strips the `key={idx}` we added at bind
 * time. Leaves the `import varName from '@/cms/<slug>.json'` line alone —
 * it's harmless and the user might re-bind, so we don't risk a noisy diff.
 *
 * Pattern we look for (matches what bindToCmsCollectionInCode emits):
 *   `{<importVar>.map((item, idx) => (` ... `))}`
 * Anchored on the element's `data-id="${nodeId}" key={idx}` marker.
 */
export function unbindFromCmsCollectionInCode(
  code: string,
  nodeId: string,
): string {
  trace.fn('map-gen:unbindFromCms', { nodeId });

  const idIndex = findJSXDataIdIndex(code, nodeId);
  if (idIndex === -1) {
    trace.error('map-gen:unbindFromCms', { message: 'Element not found', nodeId });
    return code;
  }

  const openStart = code.lastIndexOf('<', idIndex);
  if (openStart === -1) return code;

  const tagMatch = code.slice(openStart + 1, idIndex).match(/^(\S+)/);
  if (!tagMatch) return code;
  const tagName = tagMatch[1];

  const elementJSX = extractFullElement(code, openStart, tagName);
  if (!elementJSX) {
    trace.error('map-gen:unbindFromCms', { message: 'Could not extract full element', nodeId });
    return code;
  }
  const { jsx: originalJSX, endIndex } = elementJSX;

  // Walk backwards from the element's start to find the enclosing
  // `{<varName>.map((item, idx) => (` opener. Stop at any closing brace /
  // tag that would prove we left the wrapper — there's nothing to unbind
  // in that case.
  const before = code.slice(0, openStart);
  const mapOpenerRe = /\{(\w+)\.map\(\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*\(\s*$/;
  // Trim trailing whitespace so the regex's `$` anchor lands on the `(`.
  const trimmed = before.replace(/\s+$/, '');
  const trimDelta = before.length - trimmed.length;
  const mapMatch = trimmed.match(mapOpenerRe);
  if (!mapMatch) {
    trace.error('map-gen:unbindFromCms', { message: 'Map wrapper not found before element', nodeId });
    return code;
  }
  const wrapperStart = trimmed.length - mapMatch[0].length;

  // After the element, find the matching `))}` closer. There may be
  // whitespace between the element close and the `))}`.
  const afterCloseRe = /^\s*\)\s*\)\s*\}/;
  const after = code.slice(endIndex);
  const afterMatch = after.match(afterCloseRe);
  if (!afterMatch) {
    trace.error('map-gen:unbindFromCms', { message: 'Map wrapper closer not found after element', nodeId });
    return code;
  }
  const wrapperEnd = endIndex + afterMatch[0].length;

  // Strip `key={idx}` from the element. We add it at bind time; if the user
  // later renamed the iter param the regex still works because we capture
  // the ident from the map opener.
  const idxParam = mapMatch[3];
  const keyAttrRe = new RegExp(`\\s*key=\\{${idxParam}\\}`);
  const cleanedJSX = originalJSX.replace(keyAttrRe, '');

  const result = code.slice(0, wrapperStart) + cleanedJSX + code.slice(wrapperEnd);
  trace.action('map-gen:unbindFromCms:done', { nodeId });
  return result;
}

/** `'team-members'` → `'teamMembers'`. Used as the import variable name. */
function slugToVarName(slug: string): string {
  return slug.replace(/-(.)/g, (_, c: string) => c.toUpperCase());
}

/**
 * Repoint a CMS-bound `.map()` at a different collection. Replaces the
 * iterator variable name everywhere it appears as the `.map()` head and
 * swaps the import to the new slug. Field references inside the template
 * (e.g. `{item.title}`) are NOT rewritten — if the new schema uses
 * different field names, the user has to re-bind each property. Same
 * compromise the reference makes; field renaming is a separate operation.
 *
 * `parentNodeId` is the JSXElement that PARENT the `.map()` (the node
 * carrying `collectionList` in the parser's CanvasNode). We locate the
 * `.map()` opener inside that element's body so this works even if the
 * file has multiple `.map()`s in different elements.
 */
export function changeCollectionSourceInCode(
  code: string,
  parentNodeId: string,
  newSlug: string,
  /** Optional `oldField → newField` map. When present, every `<itemVar>.<oldField>`
   *  reference inside the `.map()` body is rewritten to point at the new field.
   *  Built from the schemas in the caller (CollectionListTool) by matching
   *  fields by TYPE — so swapping `Blog Posts` for `Team Members` carries
   *  text bindings to the new schema's text field instead of leaving them
   *  pointing at a missing `title` and silently rendering blank. */
  fieldRemap?: Record<string, string>,
): string {
  trace.fn('map-gen:changeCollectionSource', { parentNodeId, newSlug, remapKeys: fieldRemap ? Object.keys(fieldRemap) : [] });

  const idIndex = findJSXDataIdIndex(code, parentNodeId);
  if (idIndex === -1) {
    trace.error('map-gen:changeCollectionSource', { message: 'Parent element not found', parentNodeId });
    return code;
  }
  const parentOpenStart = code.lastIndexOf('<', idIndex);
  if (parentOpenStart === -1) return code;
  const tagMatch = code.slice(parentOpenStart + 1, idIndex).match(/^(\S+)/);
  if (!tagMatch) return code;
  const parentEl = extractFullElement(code, parentOpenStart, tagMatch[1]);
  if (!parentEl) {
    trace.error('map-gen:changeCollectionSource', { message: 'Could not extract parent element' });
    return code;
  }

  // Find the `.map(` opener INSIDE the parent's body, then walk BACK past any
  // chained `.filter()/.sort()/.slice()` to the chain-head identifier (the slug
  // var). The old narrow `{(\w+)\.map\(` regex required the slug DIRECTLY before
  // `.map(` and a two-arg paren callback — so changing the source silently did
  // nothing once a filter/sort/limit was present, on a single-arg `item =>` map,
  // or a non-paren body. Reusing the shared chain-walk fixes all three +
  // canvasNodes lists.
  const slice = code.slice(parentOpenStart, parentOpenStart + parentEl.jsx.length);
  const mapRe = new RegExp(COLLECTION_MAP_CALL_RE.source, 'g');
  const mapMatch = mapRe.exec(slice);
  if (!mapMatch) {
    trace.error('map-gen:changeCollectionSource', { message: 'Map opener not found inside parent' });
    return code;
  }
  // Handles BOTH the inline chain head AND the responsive `__applyListConfig(slug, cfg)`
  // head (findCollectionChainHead returns null on the latter → source change no-op'd).
  const head = extractCollectionSlugSpan(slice, mapMatch.index);
  if (!head) {
    trace.error('map-gen:changeCollectionSource', { message: 'Cannot identify collection slug head' });
    return code;
  }
  const oldVarName = head.slug;
  const itemVar = itemVarFromCallbackParam(mapMatch[1]);
  const newVarName = slugToVarName(newSlug);

  // Build the new parent slice: replace ONLY the chain-head identifier with the
  // new slug var (keeping any .filter/.sort/.slice chain intact), then apply the
  // field remap on the resulting slice (regex — offset-independent). Doing all
  // parent edits on the isolated slice first avoids the offset drift the old code
  // had once the import line length changed.
  let newSlice = slice.slice(0, head.slugStart) + newVarName + slice.slice(head.slugEnd);
  if (fieldRemap && Object.keys(fieldRemap).length > 0) {
    for (const [oldField, newField] of Object.entries(fieldRemap)) {
      if (oldField === newField) continue;
      // Word-boundary both sides so `item.title` doesn't match `item.titleSuffix`.
      const re = new RegExp(`\\b${itemVar}\\.${oldField}\\b`, 'g');
      newSlice = newSlice.replace(re, `${itemVar}.${newField}`);
    }
    trace.action('map-gen:changeCollectionSource:remap', {
      itemVar, mappedFields: Object.entries(fieldRemap).filter(([o, n]) => o !== n),
    });
  }

  // Update the row's CMS-nav Link ROUTE. The `data-cms-nav` href is
  // `` `/<oldSlug>/${item?._slug ?? ''}` `` (see cmsNavHrefExpr) — after the
  // source swap it must point at the NEW collection's detail route
  // (`/<newSlug>/…`), else the row links to the old (or a non-existent) page.
  // Derive the old slug from the import we're about to swap, then rewrite the
  // leading route segment of every `href={`/<oldSlug>/…` in the .map() body.
  const oldSlugMatch = code.match(new RegExp(`import\\s+${oldVarName}\\s+from\\s+'@/cms/([^']+)\\.json'`));
  const oldSlug = oldSlugMatch?.[1];
  if (oldSlug && oldSlug !== newSlug) {
    const escOld = oldSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    newSlice = newSlice.replace(new RegExp('(href=\\{`)/' + escOld + '/', 'g'), `$1/${newSlug}/`);
  }

  let result = code.slice(0, parentOpenStart) + newSlice + code.slice(parentOpenStart + slice.length);

  // Swap the import. Match `import <oldVar> from '@/cms/<oldSlug>.json';`
  // and replace with the new var + slug. If the new import already exists
  // (user had it for another list), drop the old line entirely.
  const newImportPath = `'@/cms/${newSlug}.json'`;
  const newImportLine = `import ${newVarName} from ${newImportPath};`;
  const oldImportRe = new RegExp(
    `^import\\s+${oldVarName}\\s+from\\s+'@/cms/[^']+\\.json';\\s*\\n?`,
    'm',
  );
  if (result.includes(newImportLine)) {
    // Already imported elsewhere — drop the now-orphaned old import.
    result = result.replace(oldImportRe, '');
  } else {
    result = result.replace(oldImportRe, `${newImportLine}\n`);
    if (!result.includes(newImportLine)) {
      // Old import wasn't there (edge case — varName clash). Insert a fresh
      // import after the last existing one.
      const insertAt = findInsertionPointForImport(result);
      result = result.slice(0, insertAt) + newImportLine + '\n' + result.slice(insertAt);
    }
  }

  trace.action('map-gen:changeCollectionSource:done', { parentNodeId, oldVarName, newVarName, newSlug });
  return result;
}

/** Returns the offset right after the LAST `import ... from '...';` line in
 *  the file, or 0 if the file has no imports yet. New CMS imports go here so
 *  they sit alongside React / framer-motion / component imports — no jump
 *  cuts in the middle of the import block. */
function findInsertionPointForImport(code: string): number {
  const importRegex = /^import\s+[^;]+;\s*$/gm;
  let lastEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(code)) !== null) {
    lastEnd = match.index + match[0].length + 1; // +1 to skip the trailing newline
  }
  return lastEnd;
}

/**
 * Add an item to an existing inline .map() data array.
 */
export function addMapItemInCode(
  code: string,
  varName: string,
  newItem: Record<string, string>,
): string {
  trace.fn('map-gen:addMapItem', { varName });

  const decl = findArrayDecl(code, varName);
  if (!decl) {
    trace.error('map-gen:addMapItem', { message: 'Array declaration not found', varName });
    return code;
  }

  // Ensure trailing comma after last existing item before inserting
  const beforeClose = decl.arrayContent.trimEnd();
  let result = code;
  if (beforeClose.length > 0 && !beforeClose.endsWith(',')) {
    // Find the last non-whitespace char before ];
    const lastNonWs = code.slice(0, decl.closingBracket).search(/\S\s*$/);
    if (lastNonWs >= 0) {
      const insertCommaAt = lastNonWs + 1;
      result = code.slice(0, insertCommaAt) + ',' + code.slice(insertCommaAt);
    }
  }

  // Re-find closing bracket (may have shifted by 1 if comma was inserted)
  const freshDecl = findArrayDecl(result, varName);
  if (!freshDecl) return result;

  // Insert new item before the closing bracket
  const itemStr = `\n    ${JSON.stringify(newItem)},`;
  const out = result.slice(0, freshDecl.closingBracket) + itemStr + result.slice(freshDecl.closingBracket);
  trace.action('map-gen:addMapItem:done', { varName, fields: Object.keys(newItem) });
  return out;
}

/**
 * Remove an item from an existing inline .map() data array by index.
 */
export function removeMapItemInCode(
  code: string,
  varName: string,
  itemIndex: number,
): string {
  trace.fn('map-gen:removeMapItem', { varName, itemIndex });

  const decl = findArrayDecl(code, varName);
  if (!decl) {
    trace.error('map-gen:removeMapItem', { message: 'Array declaration not found', varName });
    return code;
  }

  const items = parseArrayItemRanges(decl.arrayContent);

  if (itemIndex < 0 || itemIndex >= items.length) {
    trace.error('map-gen:removeMapItem', { message: 'Index out of bounds', itemIndex, itemCount: items.length });
    return code;
  }

  // Remove the item (including trailing comma and whitespace)
  const item = items[itemIndex];
  let removeEnd = item.end;
  // Skip trailing comma and whitespace
  while (removeEnd < decl.arrayContent.length && (decl.arrayContent[removeEnd] === ',' || decl.arrayContent[removeEnd] === ' ' || decl.arrayContent[removeEnd] === '\n')) {
    removeEnd++;
  }

  const newArrayContent = decl.arrayContent.slice(0, item.start) + decl.arrayContent.slice(removeEnd);
  const out = code.slice(0, decl.arrayStart) + newArrayContent + code.slice(decl.closingBracket);
  trace.action('map-gen:removeMapItem:done', { varName, itemIndex, remainingCount: items.length - 1 });
  return out;
}

/**
 * Update a single item in an existing inline .map() data array by index.
 * Replaces the entire item object at the given index.
 */
export function updateMapItemInCode(
  code: string,
  varName: string,
  itemIndex: number,
  updatedItem: Record<string, string>,
): string {
  trace.fn('map-gen:updateMapItem', { varName, itemIndex, fields: Object.keys(updatedItem) });

  const decl = findArrayDecl(code, varName);
  if (!decl) {
    trace.error('map-gen:updateMapItem', { message: 'Array declaration not found', varName });
    return code;
  }

  const items = parseArrayItemRanges(decl.arrayContent);

  if (itemIndex < 0 || itemIndex >= items.length) {
    trace.error('map-gen:updateMapItem', { message: 'Index out of bounds', itemIndex, itemCount: items.length });
    return code;
  }

  const item = items[itemIndex];
  const newItemStr = JSON.stringify(updatedItem);
  const newArrayContent = decl.arrayContent.slice(0, item.start) + newItemStr + decl.arrayContent.slice(item.end);
  const out = code.slice(0, decl.arrayStart) + newArrayContent + code.slice(decl.closingBracket);
  trace.action('map-gen:updateMapItem:done', { varName, itemIndex });
  return out;
}

/**
 * Add a new field to ALL items in an existing inline .map() data array.
 * Each item gets the field with a default empty string value.
 */
export function addMapFieldInCode(
  code: string,
  varName: string,
  fieldName: string,
  defaultValue: string = '',
): string {
  trace.fn('map-gen:addMapField', { varName, fieldName, defaultValue });

  const decl = findArrayDecl(code, varName);
  if (!decl) {
    trace.error('map-gen:addMapField', { message: 'Array declaration not found', varName });
    return code;
  }

  const items = parseArrayItemRanges(decl.arrayContent);

  if (items.length === 0) {
    trace.error('map-gen:addMapField', { message: 'No items found in array', varName });
    return code;
  }

  // Process items in reverse order to preserve indices
  let newArrayContent = decl.arrayContent;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const itemStr = newArrayContent.slice(item.start, item.end);
    try {
      const parsed = JSON.parse(itemStr);
      parsed[fieldName] = defaultValue;
      const newItemStr = JSON.stringify(parsed);
      newArrayContent = newArrayContent.slice(0, item.start) + newItemStr + newArrayContent.slice(item.end);
    } catch {
      // If parse fails, skip this item
      trace.error('map-gen:addMapField', { message: 'Failed to parse item', index: i });
    }
  }

  const out = code.slice(0, decl.arrayStart) + newArrayContent + code.slice(decl.closingBracket);
  trace.action('map-gen:addMapField:done', { varName, fieldName, itemCount: items.length });
  return out;
}

/**
 * Bind a style property to the map data: converts an inline style value to item.fieldName
 * in the template JSX, and adds the field (with the current value) to all items in the data array.
 *
 * e.g. backgroundColor: '#80aa53' → backgroundColor: item.bgColor
 *      + adds bgColor: '#80aa53' to all data items
 */
export function bindStyleToMapInCode(
  code: string,
  nodeId: string,
  varName: string,
  styleProp: string,
  fieldName: string,
  currentValue: string,
): string {
  trace.fn('map-gen:bindStyle', { nodeId, varName, styleProp, fieldName, currentValue });

  // Detect the iterator variable name from the .map() callback
  const iterVar = detectIteratorVar(code, varName);

  // Find the .map() call range so we only modify the template INSIDE it (not duplicates outside)
  const mapCallIdx = code.indexOf(`${varName}.map(`);
  const searchStart = mapCallIdx >= 0 ? mapCallIdx : 0;

  // Find data-id INSIDE the .map() body
  const idPattern = `data-id="${nodeId}"`;
  const idIdx = code.indexOf(idPattern, searchStart);
  if (idIdx === -1) {
    trace.error('map-gen:bindStyle', { message: 'Node not found in .map() body', nodeId });
    return code;
  }

  // Find the style={{ ... }} block for this element
  const styleStart = code.indexOf('style={{', idIdx);
  if (styleStart === -1 || styleStart > idIdx + 2000) {
    trace.error('map-gen:bindStyle', { message: 'Style block not found near node', nodeId });
    return code;
  }

  // Find the matching }}
  let braceDepth = 0;
  let styleEnd = styleStart + 7;
  for (; styleEnd < code.length; styleEnd++) {
    if (code[styleEnd] === '{') braceDepth++;
    else if (code[styleEnd] === '}') {
      if (braceDepth === 0) break;
      braceDepth--;
    }
  }
  const styleBlock = code.slice(styleStart, styleEnd + 2);

  // Find and replace the property value in the style block
  const propPatterns = [
    new RegExp(`(${styleProp}\\s*:\\s*)(['"])([^'"]*?)\\2`),
    new RegExp(`(${styleProp}\\s*:\\s*)(\\d[\\d.]*)`),
    new RegExp(`(${styleProp}\\s*:\\s*)([a-zA-Z_][a-zA-Z0-9_.]*)`),
  ];

  let newStyleBlock = styleBlock;
  let replaced = false;
  for (const pattern of propPatterns) {
    if (pattern.test(newStyleBlock)) {
      newStyleBlock = newStyleBlock.replace(pattern, `$1${iterVar}.${fieldName}`);
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // Property doesn't exist in the style block yet — add it with the binding.
    // styleBlock = "style={{ ... }}" — insert before the inner } of the closing }}.
    // styleEnd points at the OUTER } (where braceDepth first hits 0 in the scan loop).
    // The inner } is one position before that.
    const innerBracePos = styleEnd - styleStart - 1;
    if (innerBracePos <= 0) {
      trace.error('map-gen:bindStyle', { message: 'Style block closing not found', nodeId, styleProp });
      return code;
    }
    // Check if we need a comma after the last property
    const beforeClose = styleBlock.slice(0, innerBracePos).trimEnd();
    const needsComma = beforeClose.length > 0 && !beforeClose.endsWith(',') && !beforeClose.endsWith('{');
    const comma = needsComma ? ',' : '';
    newStyleBlock = styleBlock.slice(0, innerBracePos) + `${comma} ${styleProp}: ${iterVar}.${fieldName}` + styleBlock.slice(innerBracePos);
    trace.action('map-gen:bindStyle:added-new-prop', { nodeId, styleProp, fieldName });
  }

  let result = code.slice(0, styleStart) + newStyleBlock + code.slice(styleStart + styleBlock.length);

  // Step 2: Add the field to all items in the data array
  result = addMapFieldInCode(result, varName, fieldName, currentValue);

  trace.action('map-gen:bindStyle:done', { nodeId, styleProp, fieldName, currentValue, iterVar });
  return result;
}

/**
 * Unbind a style property from map data: converts item.fieldName back to an inline value
 * and removes the field from all items in the data array.
 */
export function unbindStyleFromMapInCode(
  code: string,
  nodeId: string,
  varName: string,
  styleProp: string,
  fieldName: string,
  inlineValue: string,
): string {
  trace.fn('map-gen:unbindStyle', { nodeId, varName, styleProp, fieldName, inlineValue });

  // Find the node's style and replace item.fieldName with the inline value
  const idPattern = `data-id="${nodeId}"`;
  const idIdx = code.indexOf(idPattern);
  if (idIdx === -1) {
    trace.error('map-gen:unbindStyle', { message: 'Node not found', nodeId });
    return code;
  }

  // Replace item.fieldName with the quoted value
  const bindingPattern = new RegExp(`(${styleProp}\\s*:\\s*)item\\.${fieldName}`);
  const replacement = `$1'${inlineValue}'`;
  const result = code.replace(bindingPattern, replacement);

  // Note: we don't remove the field from data items — stale fields are harmless
  trace.action('map-gen:unbindStyle:done', { nodeId, styleProp, fieldName, inlineValue });
  return result;
}

/**
 * Unbind a component-instance PROP from a CMS field: strip the `propName={…}`
 * attribute off the instance's opening tag so it falls back to the component's
 * default (the inverse of bindPropToMapInCode's insert/rewrite). Used by the
 * CmsBoundPill × on a component prop inside a collection list.
 */
export function unbindPropFromMapInCode(code: string, nodeId: string, propName: string): string {
  trace.fn('map-gen:unbindProp', { nodeId, propName });
  const idPattern = `data-id="${nodeId}"`;
  const idIdx = code.indexOf(idPattern);
  if (idIdx === -1) {
    trace.error('map-gen:unbindProp', { message: 'Node not found', nodeId });
    return code;
  }
  // Match ` propName={…}` near the data-id (the instance's bound attribute). The
  // binding value is either a simple `item.field` member (`[^{}]*` is brace-safe)
  // or the WHOLE-VALUE image form `` {`url(${item.field})`} `` — a template literal
  // whose nested `${}` braces the simple pattern can't cross, so try the
  // template-shaped pattern (backtick-delimited, no nested backticks) FIRST.
  const regionStart = Math.max(0, idIdx - 200);
  const region = code.slice(regionStart, idIdx + 2000);
  const m = new RegExp(`\\s${propName}=\\{\`[^\`]*\`\\}`).exec(region)
    ?? new RegExp(`\\s${propName}=\\{[^{}]*\\}`).exec(region);
  if (!m) return code;
  const absIdx = regionStart + m.index;
  const result = code.slice(0, absIdx) + code.slice(absIdx + m[0].length);
  trace.action('map-gen:unbindProp:done', { nodeId, propName });
  return result;
}

/**
 * Bind a component prop to map data: converts a static prop to item.fieldName.
 * e.g. glowColor="#df2b2b" → glowColor={item.glowColor}
 *      + adds glowColor: '#df2b2b' to all data items
 * `urlWrap` = whole-value IMAGE prop (master binds it bare, values carry the
 * url() wrap): the binding becomes `propName={`url(${item.field})`}` and the
 * seeded data value is UNWRAPPED to a plain URL (the CMS field convention).
 */
export function bindPropToMapInCode(
  code: string,
  nodeId: string,
  varName: string,
  propName: string,
  fieldName: string,
  currentValue: string,
  urlWrap = false,
): string {
  trace.fn('map-gen:bindProp', { nodeId, varName, propName, fieldName, currentValue, urlWrap });

  // Detect the iterator variable name from the .map() callback: varName.map((iterVar, idx) => ...)
  const iterVar = detectIteratorVar(code, varName);

  // Find the .map() call range so we only modify the template INSIDE it
  const mapCallIdx = code.indexOf(`${varName}.map(`);
  const searchStart = mapCallIdx >= 0 ? mapCallIdx : 0;

  const idPattern = `data-id="${nodeId}"`;
  const idIdx = code.indexOf(idPattern, searchStart);
  if (idIdx === -1) {
    trace.error('map-gen:bindProp', { message: 'Node not found in .map() body', nodeId });
    return code;
  }

  // Search near the data-id for the prop — within the opening tag.
  // `\b` before the prop name is CRITICAL: a shorter prop must NOT match inside a
  // longer sibling. e.g. binding `ergerg` would otherwise rewrite `ergergerg={…}`
  // (the tail "ergerg=" sits inside "ergergerg=" with no word boundary) — the
  // user-reported bug where setting the color var overrode the image var above it.
  const searchRegion = code.slice(Math.max(0, idIdx - 200), idIdx + 2000);
  const patterns = [
    new RegExp(`\\b(${propName}=)"([^"]*?)"`),       // propName="value"
    new RegExp(`\\b(${propName}=)\\{'([^']*?)'\\}`),  // propName={'value'}
    new RegExp(`\\b(${propName}=)\\{(\\d[\\d.]*)\\}`), // propName={123}
    // propName={`…`} — a template-literal value (an existing whole-value image
    // binding being REBOUND to another field). Must run BEFORE the generic
    // pattern: `[^}]+` stops at the template's nested `${…}` close brace and
    // would splice mid-expression, leaving a dangling ``)`}`` → corrupt JSX.
    new RegExp(`\\b(${propName}=)\\{\`[^\`]*\`\\}`),
    new RegExp(`\\b(${propName}=)\\{([^}]+)\\}`),      // propName={expr} (generic)
  ];

  // Whole-value image binding wraps the plain-URL field at the binding site.
  const bindingExpr = urlWrap
    ? `${propName}={\`url(\${${iterVar}.${fieldName}})\`}`
    : `${propName}={${iterVar}.${fieldName}}`;

  let replaced = false;
  let result = code;
  const regionStart = Math.max(0, idIdx - 200);

  for (const pattern of patterns) {
    const match = pattern.exec(searchRegion);
    if (match) {
      const fullMatch = match[0];
      const absIdx = regionStart + match.index;
      result = result.slice(0, absIdx) + bindingExpr + result.slice(absIdx + fullMatch.length);
      replaced = true;
      break;
    }
  }

  if (!replaced) {
    // The prop isn't on the instance yet — a freshly dropped component uses the
    // component's DEFAULT value, so there's no `propName=` attribute to rewrite.
    // Binding must ADD it: insert `propName={iterVar.field}` right after this
    // instance's `data-id` so it lands inside the correct opening tag (works for
    // self-closing `<Comp … />` and `<Comp …>…</Comp>` alike). Without this the
    // bind was a silent no-op for components dropped into a collection-list item.
    const insertAt = idIdx + idPattern.length;
    result = result.slice(0, insertAt) + ` ${bindingExpr}` + result.slice(insertAt);
    trace.action('map-gen:bindProp:inserted', { nodeId, propName, fieldName, iterVar, urlWrap });
  }

  // Add the field to all data items (inline arrays only; CMS-sourced lists already
  // have the field in their schema, so addMapFieldInCode no-ops there). Image
  // fields hold PLAIN urls — unwrap a url(...)-wrapped current value before seeding.
  const seedValue = urlWrap ? currentValue.replace(/^url\((['"]?)(.*?)\1\)$/i, '$2') : currentValue;
  result = addMapFieldInCode(result, varName, fieldName, seedValue);

  trace.action('map-gen:bindProp:done', { nodeId, propName, fieldName, currentValue, iterVar });
  return result;
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

/**
 * Find the array declaration for `const varName = [...]` in code.
 * Returns the character positions needed to manipulate the array contents,
 * or null if the declaration is not found.
 */
function findArrayDecl(
  code: string,
  varName: string,
): { arrayStart: number; closingBracket: number; arrayContent: string } | null {
  const declPattern = `const ${varName} = [`;
  const declIdx = code.indexOf(declPattern);
  if (declIdx === -1) return null;

  const arrayStart = declIdx + declPattern.length;
  const closingBracket = code.indexOf('];', declIdx);
  if (closingBracket === -1) return null;

  return {
    arrayStart,
    closingBracket,
    arrayContent: code.slice(arrayStart, closingBracket),
  };
}

/**
 * Parse `{ }` brace pairs in array content to find the start/end of each
 * object literal item. Handles nested braces correctly.
 */
function parseArrayItemRanges(
  arrayContent: string,
): { start: number; end: number }[] {
  const items: { start: number; end: number }[] = [];
  let depth = 0;
  let itemStart = -1;
  for (let i = 0; i < arrayContent.length; i++) {
    if (arrayContent[i] === '{') {
      if (depth === 0) itemStart = i;
      depth++;
    } else if (arrayContent[i] === '}') {
      depth--;
      if (depth === 0 && itemStart >= 0) {
        items.push({ start: itemStart, end: i + 1 });
        itemStart = -1;
      }
    }
  }
  return items;
}

/**
 * Detect the iterator variable name from a `.map()` callback.
 * e.g. `cardData.map((item, idx) => ...)` → `'item'`
 * Falls back to `'item'` if no match is found.
 */
function detectIteratorVar(code: string, varName: string): string {
  const mapCallMatch = code.match(new RegExp(`${varName}\\.map\\(\\(([a-zA-Z_$][a-zA-Z0-9_$]*)`));
  return mapCallMatch ? mapCallMatch[1] : 'item';
}

/**
 * Find the iterator variable of the nearest `.map((iter, …) =>` whose body
 * ENCLOSES the element with `data-id={nodeId}`. Returns null when the node
 * isn't inside any `.map()` (e.g. it's been dragged out to the canvas or a
 * plain page frame). Scans every `<x>.map((iter` opener left of the tag and
 * keeps the deepest one whose matching `)` closes AFTER the tag — i.e. a true
 * ancestor, not a sibling map. Shared by the CMS-field drop binder and the
 * detach/rehydrate round-trip (`cms-detach-gen`).
 */
export function getEnclosingMapIteratorForNode(code: string, nodeId: string): string | null {
  return getEnclosingMapParamsForNode(code, nodeId)?.iterVar ?? null;
}

/** Both callback params of the nearest enclosing `.map((iter, index) =>` — same
 *  ancestor walk as getEnclosingMapIteratorForNode. `indexVar` is null for the
 *  single-param form (`.map(item =>` / `.map((item) =>`). Make Component uses it
 *  to hoist a bare stagger-index reference (`delay: index * 0.1`) into a prop. */
export function getEnclosingMapParamsForNode(code: string, nodeId: string): { iterVar: string; indexVar: string | null } | null {
  const found = findEnclosingMapForNode(code, nodeId);
  return found ? { iterVar: found.iterVar, indexVar: found.indexVar } : null;
}

/** The SOURCE EXPRESSION of the nearest enclosing `.map()` — the array being
 *  mapped (`collection1.slice(1)`, `__applyListConfig(collection1, cfg)`,
 *  `card1Data`) plus its iterator. The CMS detach path uses it to resolve which
 *  collection (and which row) the dragged node was displaying, so the values
 *  can be baked onto the detached node. Same ancestor walk as
 *  getEnclosingMapIteratorForNode. */
export function getEnclosingMapSourceForNode(code: string, nodeId: string): { iterVar: string; sourceExpr: string } | null {
  const found = findEnclosingMapForNode(code, nodeId);
  if (!found) return null;
  // Walk BACKWARDS from the `.` of `.map(` over the source expression: member
  // chains, call args and index brackets (balanced), identifiers.
  let k = found.mapDotIdx;
  while (k > 0) {
    const c = code[k - 1];
    if (/[\w$]/.test(c) || c === '.') { k--; continue; }
    if (c === ')' || c === ']') {
      let depth = 0, p = k - 1;
      for (; p >= 0; p--) {
        const ch = code[p];
        if (ch === ')' || ch === ']') depth++;
        else if (ch === '(' || ch === '[') { depth--; if (depth === 0) break; }
      }
      if (p < 0) break;
      k = p; continue;
    }
    break;
  }
  const sourceExpr = code.slice(k, found.mapDotIdx).trim();
  return sourceExpr ? { iterVar: found.iterVar, sourceExpr } : null;
}

function findEnclosingMapForNode(code: string, nodeId: string): { iterVar: string; indexVar: string | null; mapDotIdx: number } | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = code.indexOf('>', idIdx);
  if (tagStart === -1 || tagEnd === -1) return null;
  // Match `.map((iter` OR `.map(iter` — what precedes `.map` is IRRELEVANT (it can
  // be a bare slug, OR `.filter()/.sort()/.slice()`, OR `__applyListConfig(...)` whose
  // last char is `)`, not an identifier). The OLD regex required `<ident>.map(`, so it
  // silently returned null for ANY chained/paginated/responsive list → the CMS-detach
  // dormantize never ran and `{item.field}` dangled at module scope on drag-out.
  // The optional `, index` group only matches the parenthesized two-param form.
  const mapRegex = /\.map\(\s*\(?\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:,\s*([a-zA-Z_$][a-zA-Z0-9_$]*))?/g;
  let found: { iterVar: string; indexVar: string | null; mapDotIdx: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = mapRegex.exec(code)) !== null) {
    if (match.index >= tagStart) break; // past the element
    const openParen = code.indexOf('(', match.index + 1); // the `(` of `.map(`
    if (openParen === -1) continue;
    const closeParen = findMatchingParen(code, openParen);
    if (closeParen === -1) continue;
    if (closeParen > tagEnd) found = { iterVar: match[1], indexVar: match[2] ?? null, mapDotIdx: match.index }; // ancestor map — keep the deepest
  }
  return found;
}

// ─── Private Helpers ─────────────────────────────────────────────────────────

function generateVarName(nodeId: string): string {
  // "card-1" → "card1Data", "feat-card-2" → "featCard2Data"
  // Keep the trailing number to avoid collisions between siblings
  const base = nodeId.replace(/-/g, '_');
  const camel = base.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  return camel + 'Data';
}

/** Generate a unique variable name that doesn't conflict with existing const declarations. */
function generateUniqueVarName(nodeId: string, code: string): string {
  let name = generateVarName(nodeId);
  // Check if this const name already exists in the code
  let suffix = 0;
  while (code.includes(`const ${name} = [`)) {
    suffix++;
    name = generateVarName(nodeId) + suffix;
  }
  return name;
}

function generateFieldName(childId: string, parentId: string): string {
  // "card-title" → "title", "card-desc" → "desc"
  const parentBase = parentId.replace(/-\d+$/, '');
  let field = childId.replace(parentBase + '-', '').replace(/-\d+$/, '');
  if (!field) field = childId;
  return field.replace(/-/g, '_').replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Extract the full JSX element from opening tag to closing tag (or self-closing).
 */
function extractFullElement(
  code: string,
  openStart: number,
  tagName: string,
): { jsx: string; endIndex: number } | null {
  // Check for self-closing tag first
  const selfCloseEnd = code.indexOf('/>', openStart);
  const childOpen = code.indexOf('>', openStart);

  if (selfCloseEnd !== -1 && (childOpen === -1 || selfCloseEnd < childOpen)) {
    // Self-closing: <tag ... />
    const endIndex = selfCloseEnd + 2;
    return { jsx: code.slice(openStart, endIndex), endIndex };
  }

  if (childOpen === -1) return null;

  // Has children — find matching closing tag (shared depth matcher: skips
  // self-closing same-tag children + suffix-checks the tag name).
  const closeStart = findMatchingCloseTagIndex(code, tagName, childOpen + 1);
  if (closeStart === -1) return null;
  const endIndex = closeStart + `</${tagName}>`.length;
  return { jsx: code.slice(openStart, endIndex), endIndex };
}

/**
 * Auto-bind a freshly-dropped CMS-field placeholder to the iterator
 * variable of its enclosing `.map(...)`, if any.
 *
 * The drop pipeline lands a `<p data-cms-field="<slug>:<fieldId>">…</p>`
 * carrying a binding hint. This function:
 *   1. Locates that element by `data-id`.
 *   2. Reads its `data-cms-field` attribute.
 *   3. Walks the source upward for the nearest `<varName>.map((iter, …) =>`
 *      ancestor — the closing `)` of which encloses the element.
 *   4. If an enclosing map is found, rewrites the element's text content
 *      to `{iter.<fieldId>}` and strips the `data-cms-field` attribute.
 *   5. Otherwise leaves the JSX alone (the placeholder is its own thing
 *      until the user wraps a parent in a `.map()` later).
 *
 * Pure — returns a new code string. Called from mutation-queue's flush
 * right after `addNode` so the binding lands in the same write as the
 * drop, with no second commit.
 */
export function bindCmsFieldOnDropInCode(code: string, nodeId: string): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) {
    trace.action('map-gen:bindCmsField:node-not-found', { nodeId });
    return code;
  }

  // Find the opening tag start and end for this element
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = code.indexOf('>', idIdx);
  if (tagStart === -1 || tagEnd === -1) return code;
  const openTagSrc = code.slice(tagStart, tagEnd + 1);

  // Extract the data-cms-field attribute value
  const fieldAttrMatch = openTagSrc.match(/\s+data-cms-field="([^"]+)"/);
  if (!fieldAttrMatch) {
    trace.action('map-gen:bindCmsField:no-attr', { nodeId });
    return code;
  }
  const [, attrValue] = fieldAttrMatch;
  const sepIdx = attrValue.indexOf(':');
  if (sepIdx === -1) return code;
  const fieldId = attrValue.slice(sepIdx + 1);
  if (!fieldId) return code;

  // Nearest enclosing `<varName>.map((iter, …) =>` ancestor (shared helper).
  let iterVar: string | null = getEnclosingMapIteratorForNode(code, nodeId);

  if (!iterVar) {
    // No enclosing `.map()`. On a CMS detail page the page-level
    // `const item = <data>.find(...)` is the binding root — `{item.x}`
    // works directly without an iterator. Detect that pattern; if
    // present, bind to `item.<fieldId>` and continue. Detail pages are
    // generated with this exact `const item =` shape (see cms-page-ops
    // `createDetailPage`), so a literal substring check is enough.
    if (/\bconst\s+item\s*=\s*\w+\.find\(/.test(code)) {
      iterVar = 'item';
      trace.action('map-gen:bindCmsField:detail-page-fallback', { nodeId, fieldId });
    } else {
      trace.action('map-gen:bindCmsField:no-enclosing-map', { nodeId, fieldId });
      return code;
    }
  }

  // Decide what to bind based on `data-cms-bind-target`. Default = "text"
  // (the placeholder pattern) so older drops without the target hint
  // still bind to text content as before.
  const targetMatch = openTagSrc.match(/\s+data-cms-bind-target="([^"]+)"/);
  const target = targetMatch?.[1] ?? 'text';
  const expr = `${iterVar}.${fieldId}`;

  // Strip the binding-hint attributes from the opening tag (`data-cms-field`
  // and `data-cms-bind-target`). They're hints, not runtime concerns —
  // once bound, the iterVar reference is the source of truth.
  let newOpenTag = openTagSrc
    .replace(/\s+data-cms-field="[^"]+"/, '')
    .replace(/\s+data-cms-bind-target="[^"]+"/, '');

  if (target === 'src' || target === 'href') {
    // Replace the `src="..."` / `href="..."` attribute value with the
    // JSX expression. Both attributes use the same shape. Element is
    // self-closing (img) or has its own children we don't touch (a).
    const re = new RegExp(`\\s+${target}="[^"]*"`);
    newOpenTag = newOpenTag.replace(re, ` ${target}={${expr}}`);
    // If the attr wasn't present, append it.
    if (!newOpenTag.includes(`${target}={${expr}}`)) {
      newOpenTag = newOpenTag.replace(/\s*\/?>$/, ` ${target}={${expr}}>`);
      // Preserve self-closing if original was: only matters for img.
      const wasSelfClose = openTagSrc.endsWith('/>');
      if (wasSelfClose) newOpenTag = newOpenTag.replace(/>$/, ' />');
    }
    const result = code.slice(0, tagStart) + newOpenTag + code.slice(tagEnd + 1);
    trace.action('map-gen:bindCmsField:bound-attr', { nodeId, fieldId, iterVar, target });
    return result;
  }

  if (target.startsWith('style:')) {
    // style:<prop> — rewrite the matching CSS prop in the inline style
    // object to the JSX expression. e.g.
    //   style={{backgroundColor: '#ccc'}}  →  style={{backgroundColor: iter.x}}
    const styleProp = target.slice('style:'.length);
    const propRe = new RegExp(`(${styleProp}\\s*:\\s*)(['"])([^'"]*?)\\2`);
    if (propRe.test(newOpenTag)) {
      newOpenTag = newOpenTag.replace(propRe, `$1${expr}`);
    }
    const result = code.slice(0, tagStart) + newOpenTag + code.slice(tagEnd + 1);
    trace.action('map-gen:bindCmsField:bound-style', { nodeId, fieldId, iterVar, styleProp });
    return result;
  }

  // Default: text-content binding. Find the closing tag and replace the
  // children-slot with `{iterVar.fieldId}`. The attribute strip changed
  // offsets; re-scan from the rewritten opening tag.
  let result = code.slice(0, tagStart) + newOpenTag + code.slice(tagEnd + 1);
  const tagNameMatch = newOpenTag.match(/^<(\w+)/);
  if (!tagNameMatch) return result;
  const tagName = tagNameMatch[1];
  const newTagEnd = tagStart + newOpenTag.length - 1;
  const closeTag = `</${tagName}>`;
  const closeIdx = result.indexOf(closeTag, newTagEnd + 1);
  if (closeIdx === -1) return result;

  result = result.slice(0, newTagEnd + 1) + `{${expr}}` + result.slice(closeIdx);
  trace.action('map-gen:bindCmsField:bound-text', { nodeId, fieldId, iterVar });
  return result;
}

/**
 * Build the `href` template-literal expression for a CMS nav link.
 *   - 'self' → the current item (`params.slug`).
 *   - 'prev' / 'next' → the adjacent item, resolved from collection order;
 *     out-of-bounds (first/last) → `?._slug ?? ''` → `/<col>/`.
 *   - 'row'  → the current map iterator's slug — for links living inside
 *     a `.map((item) => …)` over the collection. Resolves to each row's
 *     detail page URL at render time. `itemVar` is the map's iterator
 *     variable ('item', 'post', etc. — read off the wrapper node's
 *     `collectionList.itemVar` by the caller).
 */
export function cmsNavHrefExpr(collection: string, colVar: string, mode: 'self' | 'prev' | 'next' | 'row', itemVar?: string): string {
  if (mode === 'self') {
    return '`/' + collection + "/${params?.slug ?? ''}`";
  }
  if (mode === 'row') {
    // Falls back gracefully to "/<col>/" if the item happens to be missing
    // a slug — symmetric with the prev/next out-of-bounds behavior.
    return '`/' + collection + '/${' + (itemVar || 'item') + "?._slug ?? ''}`";
  }
  const offset = mode === 'prev' ? '- 1' : '+ 1';
  return '`/' + collection + '/${' + colVar + '['
    + colVar + ".findIndex((i) => i._slug === params?.slug) " + offset
    + "]?._slug ?? ''}`";
}

/**
 * Remove the `href` attribute from a JSX opening tag, handling BOTH a
 * string value (`href="…"`) and an expression value (`href={…}`) — the
 * latter needs brace-balanced scanning since the expression itself
 * contains `${…}`. Returns the tag unchanged when there is no `href`.
 */
function stripHrefAttr(tag: string): string {
  const m = tag.match(/\s+href=/);
  if (!m || m.index === undefined) return tag;
  const start = m.index;
  const valStart = start + m[0].length;
  const ch = tag[valStart];
  let end: number;
  if (ch === '"' || ch === "'") {
    end = tag.indexOf(ch, valStart + 1);
    if (end === -1) return tag;
    end += 1;
  } else if (ch === '{') {
    let depth = 0;
    end = valStart;
    for (; end < tag.length; end++) {
      if (tag[end] === '{') depth++;
      else if (tag[end] === '}' && --depth === 0) { end++; break; }
    }
  } else {
    return tag;
  }
  return tag.slice(0, start) + tag.slice(end);
}

/**
 * Set (or clear) a CMS prev/next navigation binding on an existing
 * element — the Link tool's "Slug" control.
 *
 * `mode`:
 *   - 'self' / 'prev' / 'next' — rewrites `href` to the resolved-item
 *     expression and stamps `data-cms-nav="<mode>"` (the marker the Link
 *     tool reads back to show the linked state).
 *   - 'none' — strips both `href` and `data-cms-nav`.
 *
 * `collection` is the detail page's collection slug. For prev/next the
 * collection var is read from the page's `const item = <col>.find(...)`
 * line. Caller ensures the tag is a `<Link>` (via a changeTag mutation).
 */
export function setCmsNavHrefInCode(
  code: string,
  nodeId: string,
  mode: 'self' | 'prev' | 'next' | 'row' | 'none',
  collection: string,
  // Required only for `mode === 'row'`. The iterator var read off the
  // wrapping `.map((item) => …)` (from the wrapper node's
  // `collectionList.itemVar`). For other modes it's ignored.
  itemVar?: string,
): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) {
    trace.action('map-gen:setCmsNavHref:node-not-found', { nodeId });
    return code;
  }
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart === -1) return code;
  // findTagClose skips `>` inside `{…}` — essential here because an
  // existing nav `href` contains `=>` (the findIndex arrow function);
  // a plain indexOf('>') would stop on that arrow.
  const tagEnd = findTagClose(code, tagStart);
  if (tagEnd === -1) return code;
  const openTagSrc = code.slice(tagStart, tagEnd + 1);

  // Clean slate — drop any prior nav marker + href.
  let newOpenTag = stripHrefAttr(openTagSrc.replace(/\s+data-cms-nav="(prev|next|self|row)"/, ''));

  if (mode !== 'none') {
    // prev/next need the collection var (to walk the array); 'self' only
    // needs `params`; 'row' only needs the map's itemVar.
    let colVar = '';
    if (mode === 'prev' || mode === 'next') {
      const colVarMatch = code.match(/\bconst\s+item\s*=\s*([a-zA-Z_$][\w$]*)\.find\(/);
      if (!colVarMatch) {
        trace.action('map-gen:setCmsNavHref:not-a-detail-page', { nodeId });
        return code;
      }
      colVar = colVarMatch[1];
    }
    const expr = cmsNavHrefExpr(collection, colVar, mode, itemVar);
    // Insert the marker + resolved href right after the tag name.
    newOpenTag = newOpenTag.replace(/^<([A-Za-z][\w.]*)/, `<$1 data-cms-nav="${mode}" href={${expr}}`);
  }

  trace.action('map-gen:setCmsNavHref:done', { nodeId, mode, collection, itemVar });
  return code.slice(0, tagStart) + newOpenTag + code.slice(tagEnd + 1);
}

/**
 * Bind a freshly-dropped CMS prev/next navigation link.
 *
 * The drop pipeline lands a native
 *   `<a data-cms-nav="prev|next" data-cms-collection="<slug>" href="#">`.
 * It drops as `<a>` (not `<Link>`) so the drag strategy doesn't treat it
 * as a project component and mis-import `@/components/Link`. This pass:
 *   1. rewrites the `<a>`/`</a>` tag to `<Link>`/`</Link>`,
 *   2. rewrites `href` to a self-contained expression resolving the
 *      ADJACENT collection item's detail-page URL,
 *   3. drops the drop-only `data-cms-collection` hint, but KEEPS
 *      `data-cms-nav` — the persistent marker the Link tool reads back.
 * `syncImports` then adds `import Link from 'next/link'` on its own — it
 * already knows `<Link>` is a framework tag.
 *
 *   href={`/<slug>/${<col>[<col>.findIndex((i) => i._slug === params?.slug) + 1]?._slug ?? ''}`}
 *
 * No `Page()`-body changes are needed — the expression is self-contained,
 * so it works on any detail page (it only needs `params`, always present,
 * and the collection import var, which it reads from the page's
 * `const item = <col>.find(...)` line). At the first/last item the index
 * lands out of bounds → `?._slug ?? ''` → the href degrades to `/<slug>/`.
 *
 * Pure — returns a new code string. Called from mutation-queue's flush
 * right after `addNode`, so the binding lands in the same write as the drop.
 */
export function bindCmsNavLinkOnDropInCode(code: string, nodeId: string): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) {
    trace.action('map-gen:bindCmsNav:node-not-found', { nodeId });
    return code;
  }
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart === -1) return code;
  // findTagClose skips `>` inside `{…}` (e.g. an existing href expression's
  // `=>` arrow) so the tag boundary is found correctly.
  const tagEnd = findTagClose(code, tagStart);
  if (tagEnd === -1) return code;
  const openTagSrc = code.slice(tagStart, tagEnd + 1);

  const dirMatch = openTagSrc.match(/\s+data-cms-nav="(prev|next)"/);
  const colMatch = openTagSrc.match(/\s+data-cms-collection="([^"]+)"/);
  if (!dirMatch || !colMatch) {
    trace.action('map-gen:bindCmsNav:no-attr', { nodeId });
    return code;
  }
  const direction = dirMatch[1];
  const slug = colMatch[1];

  // The collection var is whatever the detail page binds `item` to:
  //   const item = <collectionVar>.find((i) => i._slug === params?.slug) …
  const colVarMatch = code.match(/\bconst\s+item\s*=\s*([a-zA-Z_$][\w$]*)\.find\(/);
  if (!colVarMatch) {
    trace.action('map-gen:bindCmsNav:not-a-detail-page', { nodeId });
    return code;
  }
  const colVar = colVarMatch[1];

  const expr = cmsNavHrefExpr(slug, colVar, direction as 'prev' | 'next');

  // Rewrite the opening tag: `<a …>` → `<Link …>`, drop the drop-only
  // `data-cms-collection` hint, turn the placeholder href into the
  // resolved expression. `data-cms-nav` is KEPT — it's the persistent
  // marker the Link tool reads back to show the linked state.
  let newOpenTag = openTagSrc
    .replace(/^<a\b/, '<Link')
    .replace(/\s+data-cms-collection="[^"]+"/, '');
  if (/\s+href="[^"]*"/.test(newOpenTag)) {
    newOpenTag = newOpenTag.replace(/\s+href="[^"]*"/, ` href={${expr}}`);
  } else {
    newOpenTag = newOpenTag.replace(/\s*>$/, ` href={${expr}}>`);
  }

  let result = code.slice(0, tagStart) + newOpenTag + code.slice(tagEnd + 1);

  // Rewrite the matching closing tag `</a>` → `</Link>`. The nav link's
  // content is just static text, so the first `</a>` after the opening
  // tag is its closer.
  const closeIdx = result.indexOf('</a>', tagStart + newOpenTag.length);
  if (closeIdx !== -1) {
    result = result.slice(0, closeIdx) + '</Link>' + result.slice(closeIdx + 4);
  }

  trace.action('map-gen:bindCmsNav:bound', { nodeId, direction, slug, colVar });
  return result;
}

/** Find the index of the `)` that matches the `(` at `openIdx`. -1 if unbalanced. */
