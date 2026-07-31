// cms-search-field-gen.ts — Collection List "Search Field" (dynamic filter input).
//
// design-tool parity: in the Filters field-picker, choosing a TEXT field's
// "Dynamic → Search Field" creates a real search <input> just BEFORE the
// collection list, two-way bound to a PAGE VARIABLE, and adds a filter whose
// value reads that variable at runtime (`(var === '' || …includes(var))`).
//
// This module owns step (a): create the page variable + insert the bound input
// + emit its useState. The FILTER itself (valueSource:'searchField', valueVar)
// is written through the normal Collection List config path
// (buildFilterExpression already generates the guarded `||` predicate, and the
// parser round-trips it — see parser.ts tryParseDynamic). The two land in one
// flush so the var name stays consistent.

import * as t from '@babel/types';
import generate from '@babel/generator';
import { parseJSX, findFirstElementByDataId } from '../parsing/ast-utils';
import { addPageVariableInCode } from '../features/page-variables';
import { syncPageVariableHooks } from './page-variables-gen';
import { trace } from '@/shared/debug-trace';

/** Placeholder text for a fresh Search Field. ASCII dots (not the `…` glyph): a
 *  JSX string attribute does NOT process escapes, and babel's generator escapes
 *  non-ASCII to `…` → it would render the literal backslash sequence. */
export const SEARCH_FIELD_PLACEHOLDER = 'Search...';

/** `searchAuthor` → `setSearchAuthor` (matches the useState setter syncPageVariableHooks emits). */
function setterName(varName: string): string {
  return `set${varName.charAt(0).toUpperCase()}${varName.slice(1)}`;
}

// Inline magnifying-glass icon (URL-encoded SVG, grey stroke) painted as the
// input's background so the search box reads as a search box without needing a
// child element (an <input> is a void tag — it can't hold an icon node).
const SEARCH_ICON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%23999999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E\")";

/** The 200px-wide FRAME wrapping the field label + input (design-tool parity: a search
 *  field is a labelled control, not a bare full-width input). */
const SEARCH_FRAME_STYLE: Record<string, string> = {
  position: 'relative',
  width: '200px',
  height: 'auto',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '8px',
  marginBottom: '16px',
};

/** The field-name label above the input (e.g. "Title", "Author", "Bullet Point 2"). */
const SEARCH_LABEL_STYLE: Record<string, string> = {
  position: 'relative',
  margin: '0',
  fontFamily: 'Inter, sans-serif',
  fontSize: '14px',
  fontWeight: '500',
  color: '#333333',
};

/** The input itself: fills the frame (100%), light-grey pill, leading search glyph. */
const SEARCH_INPUT_STYLE: Record<string, string> = {
  width: '100%',
  height: '40px',
  boxSizing: 'border-box',
  padding: '0 16px 0 42px',
  borderRadius: '8px',
  border: '0',
  backgroundColor: '#ebebeb',   // a touch more grey than near-white #f5f5f5
  backgroundImage: SEARCH_ICON,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: '14px center',
  fontSize: '15px',
  color: '#222222',
  outline: 'none',
};

function styleObjectExpression(style: Record<string, string>): t.ObjectExpression {
  return t.objectExpression(
    Object.entries(style).map(([k, v]) => t.objectProperty(t.identifier(k), t.stringLiteral(v))),
  );
}

/** Build `<input data-id … type="text" placeholder value={var} onChange={…} style={…} />`
 *  (or `motion.input` in a component file so layout FLIP behaves). */
export function buildSearchInputElement(
  varName: string,
  inputId: string,
  placeholder: string,
  isComponentFile: boolean,
): t.JSXElement {
  const setter = setterName(varName);
  // onChange={(e) => setVar(e.target.value)}
  const onChange = t.arrowFunctionExpression(
    [t.identifier('e')],
    t.callExpression(t.identifier(setter), [
      t.memberExpression(
        t.memberExpression(t.identifier('e'), t.identifier('target')),
        t.identifier('value'),
      ),
    ]),
  );

  const attrs: t.JSXAttribute[] = [
    t.jsxAttribute(t.jsxIdentifier('data-id'), t.stringLiteral(inputId)),
    t.jsxAttribute(t.jsxIdentifier('data-name'), t.stringLiteral('Search')),
    // Explicit marker so the Input tool renders the simplified "search input"
    // panel (Variable + Placeholder, not the full form Type/Name/Required set)
    // and knows which page variable backs it. Carries the var name redundantly
    // with value={var} so detection never depends on parsing the binding.
    t.jsxAttribute(t.jsxIdentifier('data-search-field'), t.stringLiteral(varName)),
    t.jsxAttribute(t.jsxIdentifier('type'), t.stringLiteral('text')),
    t.jsxAttribute(t.jsxIdentifier('placeholder'), t.stringLiteral(placeholder)),
    t.jsxAttribute(t.jsxIdentifier('value'), t.jsxExpressionContainer(t.identifier(varName))),
    t.jsxAttribute(t.jsxIdentifier('onChange'), t.jsxExpressionContainer(onChange)),
    t.jsxAttribute(t.jsxIdentifier('style'), t.jsxExpressionContainer(styleObjectExpression(SEARCH_INPUT_STYLE))),
  ];

  const name: t.JSXIdentifier | t.JSXMemberExpression = isComponentFile
    ? t.jsxMemberExpression(t.jsxIdentifier('motion'), t.jsxIdentifier('input'))
    : t.jsxIdentifier('input');

  const opening = t.jsxOpeningElement(name, attrs, true /* selfClosing */);
  return t.jsxElement(opening, null, [], true);
}

/** `div` → `div` or `motion.div` (component files get motion.* for layout FLIP). */
function tagNameNode(tag: string, isComponentFile: boolean): t.JSXIdentifier | t.JSXMemberExpression {
  return isComponentFile
    ? t.jsxMemberExpression(t.jsxIdentifier('motion'), t.jsxIdentifier(tag))
    : t.jsxIdentifier(tag);
}

/** Build the field-name label `<p data-id …>Title</p>`. */
function buildLabelElement(labelId: string, fieldLabel: string, isComponentFile: boolean): t.JSXElement {
  const attrs = [
    t.jsxAttribute(t.jsxIdentifier('data-id'), t.stringLiteral(labelId)),
    t.jsxAttribute(t.jsxIdentifier('data-name'), t.stringLiteral('Label')),
    t.jsxAttribute(t.jsxIdentifier('style'), t.jsxExpressionContainer(styleObjectExpression(SEARCH_LABEL_STYLE))),
  ];
  const name = tagNameNode('p', isComponentFile);
  return t.jsxElement(
    t.jsxOpeningElement(name, attrs, false),
    t.jsxClosingElement(name),
    [t.jsxText(fieldLabel)],
    false,
  );
}

/** Build the full Search Field subtree: a 200px frame holding the field-name
 *  label + the bound input. The `data-search-field` marker stays on the INPUT
 *  (so the Input tool shows the simplified Variable + Placeholder panel). */
export function buildSearchFieldFrame(
  varName: string,
  frameId: string,
  labelId: string,
  inputId: string,
  fieldLabel: string,
  placeholder: string,
  isComponentFile: boolean,
): t.JSXElement {
  const frameAttrs = [
    t.jsxAttribute(t.jsxIdentifier('data-id'), t.stringLiteral(frameId)),
    t.jsxAttribute(t.jsxIdentifier('data-name'), t.stringLiteral('Search')),
    t.jsxAttribute(t.jsxIdentifier('style'), t.jsxExpressionContainer(styleObjectExpression(SEARCH_FRAME_STYLE))),
  ];
  const name = tagNameNode('div', isComponentFile);
  return t.jsxElement(
    t.jsxOpeningElement(name, frameAttrs, false),
    t.jsxClosingElement(name),
    [
      buildLabelElement(labelId, fieldLabel, isComponentFile),
      buildSearchInputElement(varName, inputId, placeholder, isComponentFile),
    ],
    false,
  );
}

/** Derive the label + input ids from the frame id (one search field = one subtree). */
export const searchLabelId = (frameId: string): string => `${frameId}-label`;
export const searchInputId = (frameId: string): string => `${frameId}-input`;

/**
 * Create a Search Field for a collection list:
 *   1. add a text page variable (`varName`, default '')
 *   2. insert a 200px FRAME (field-name label + bound input) as the previous
 *      sibling of the list
 *   3. emit its `useState` (syncPageVariableHooks)
 *
 * The list-config filter (valueSource:'searchField', valueVar:varName) is added
 * separately by the caller through updateCollectionConfig.
 *
 * Returns the code unchanged (minus the variable, which is harmless) if the list
 * element isn't found or the insert isn't possible — never throws.
 */
export function addSearchFieldInCode(
  code: string,
  listNodeId: string,
  varName: string,
  frameId: string,
  fieldLabel: string,
  placeholder: string,
  isComponentFile: boolean,
  /** Optional URL query-param name (design-tool parity — `?<queryParam>=` shareable
   *  filtered views). Stored on the page variable; empty → none. */
  queryParam?: string,
): string {
  trace.fn('cms-search-field:add', { listNodeId, varName, frameId, fieldLabel, isComponentFile, queryParam });

  // 1. Declare the page variable (text, empty default). No-op if it exists.
  let out = addPageVariableInCode(code, { name: varName, type: 'text', default: '', ...(queryParam ? { queryParam } : {}) });

  // 2. Insert the search FRAME immediately before the list container.
  const ast = parseJSX(out);
  if (!ast) {
    trace.error('cms-search-field:parse-failed', { listNodeId });
    return out;
  }
  let inserted = false;
  findFirstElementByDataId(ast, listNodeId, (path) => {
    try {
      path.insertBefore(buildSearchFieldFrame(varName, frameId, searchLabelId(frameId), searchInputId(frameId), fieldLabel, placeholder, isComponentFile));
      inserted = true;
    } catch (err) {
      trace.error('cms-search-field:insert-failed', { listNodeId, error: err instanceof Error ? err.message : String(err) });
    }
  });
  if (!inserted) {
    trace.error('cms-search-field:list-not-found', { listNodeId });
    return out;
  }

  try {
    out = generate(ast, { retainLines: true }, out).code;
  } catch (err) {
    trace.error('cms-search-field:generate-failed', { listNodeId, error: err instanceof Error ? err.message : String(err) });
    return code; // bail to the pre-mutation code so nothing is half-written
  }

  // 3. Emit the useState for the new variable (now referenced by the input).
  out = syncPageVariableHooks(out);
  trace.action('cms-search-field:added', { listNodeId, varName, frameId });
  return out;
}

/**
 * Re-bind a Search Field <input> to a (possibly different / freshly-created) page
 * variable — the "pick a variable" dropdown on a MISSING search input. Rewrites the
 * input's `data-search-field`, `value={var}` and `onChange={(e)=>setVar(...)}` to
 * `newVar`. (Caller declares the var + emits its useState; the filter, if any, is
 * re-wired separately via the Collection List tool.)
 */
export function setSearchInputVariableInCode(code: string, inputId: string, newVar: string): string {
  const ast = parseJSX(code);
  if (!ast) return code;
  const setter = setterName(newVar);
  const onChange = t.arrowFunctionExpression(
    [t.identifier('e')],
    t.callExpression(t.identifier(setter), [
      t.memberExpression(t.memberExpression(t.identifier('e'), t.identifier('target')), t.identifier('value')),
    ]),
  );
  let mutated = false;
  findFirstElementByDataId(ast, inputId, (path) => {
    const opening = path.node.openingElement;
    const setAttr = (name: string, valueNode: t.JSXAttribute['value']) => {
      const existing = opening.attributes.find(
        (a: t.JSXAttribute | t.JSXSpreadAttribute): a is t.JSXAttribute => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === name,
      );
      if (existing) existing.value = valueNode;
      else opening.attributes.push(t.jsxAttribute(t.jsxIdentifier(name), valueNode));
    };
    setAttr('data-search-field', t.stringLiteral(newVar));
    setAttr('value', t.jsxExpressionContainer(t.identifier(newVar)));
    setAttr('onChange', t.jsxExpressionContainer(onChange));
    mutated = true;
  });
  if (!mutated) return code;
  try {
    const out = generate(ast, { retainLines: true }, code).code;
    trace.action('cms-search-field:rebind', { inputId, newVar });
    return out;
  } catch (err) {
    trace.error('cms-search-field:rebind-failed', { inputId, error: err instanceof Error ? err.message : String(err) });
    return code;
  }
}
