/**
 * form-state-gen.ts — "Form State" wiring for component instances inside a form.
 *
 * design-tool parity: any component instance inside a `<form>` can map the form's
 * LIFECYCLE state (loading / success / error / disabled) to one of its own
 * variants. While the form submits, the button instance switches to its
 * "Loading" variant; on success → "Success"; on error → "Error"; etc.
 *
 * Model (source = deploy reality):
 *   - The form owns ONE lifecycle state var: `const [formState<Id>, setFormState<Id>]
 *     = useState('idle')`. The onSubmit handler (form-gen.ts) drives it through
 *     'loading' → 'success' | 'error' → 'idle'.
 *   - Each instance stores its mapping in a round-trip `data-form-state` JSON attr
 *     (like `data-form`/`data-overlay`) AND a generated `initialVariant={…}` ternary
 *     derived from it. The ternary is what actually drives the variant at runtime;
 *     the master re-syncs `variant` from `initialVariant` via its useEffect.
 *
 * Canvas-safe: the `initialVariant` ternary tests `formState<Id> === '…'` (NOT a
 * parent-variant identifier), so the parser can't resolve a static variant from
 * it → the instance shows the master's default on the canvas, while real React
 * drives it live. The user styles each STATE on the master's variant artboards.
 */

import * as t from '@babel/types';
import { trace } from '@/shared/debug-trace';
import { findJSXDataIdIndex, findTagClose, getJsonAttr, stripTagAttrBalanced } from './generator-utils';
import { insertConstIntoEnclosingFn } from './cms-responsive-gen';
import { parseJSX, findFirstElementByDataId, findAttribute } from '../parsing/ast-utils';

/** The form lifecycle states a variant can be mapped to (idle/default implicit). */
export const FORM_STATES = ['loading', 'success', 'error', 'disabled'] as const;
export type FormState = (typeof FORM_STATES)[number];

/** state → variant-name. e.g. `{ loading: 'loading', success: 'success' }`. */
export type FormStateMapping = Partial<Record<FormState, string>>;

/** Mapping a freshly-dropped Submit button starts with (the reference's defaults). */
export const DEFAULT_FORM_STATE_MAPPING: FormStateMapping = { loading: 'loading', success: 'success' };

/** Deterministic, unique-per-form lifecycle state var (`formState<Id>`). */
export function formStateVar(formId: string): string {
  const s = formId.replace(/[^a-zA-Z0-9]/g, '');
  return 'formState' + s.charAt(0).toUpperCase() + s.slice(1);
}

/** `setFormState<Id>` — the React setter paired with `formStateVar`. */
export function formStateSetter(stateVar: string): string {
  return 'set' + stateVar.charAt(0).toUpperCase() + stateVar.slice(1);
}

/**
 * The `initialVariant` expression for an instance: a ternary chain mapping the
 * form's lifecycle state to the chosen variant, falling back to 'default'.
 *   `formStateX === 'loading' ? 'loading' : formStateX === 'success' ? 'success' : 'default'`
 * Returns just `'default'` (a string literal) when nothing is mapped.
 */
export function buildInitialVariantExpr(stateVar: string, mapping: FormStateMapping): string {
  const branches = FORM_STATES
    .filter((s) => mapping[s])
    .map((s) => `${stateVar} === '${s}' ? '${mapping[s]}'`);
  if (branches.length === 0) return `'default'`;
  return `${branches.join(' : ')} : 'default'`;
}

/** Read the instance's `data-form-state` JSON attr → mapping (empty when absent). */
export function parseFormStateMapping(code: string, nodeId: string): FormStateMapping {
  const parsed = getJsonAttr<Record<string, unknown>>(code, nodeId, 'data-form-state');
  if (!parsed) return {};
  const out: FormStateMapping = {};
  for (const s of FORM_STATES) if (typeof parsed[s] === 'string') out[s] = parsed[s] as string;
  return out;
}

/** Strip an attribute (string `name='…'` or expression `name={…}`) from a tag
 *  slice. Delegates to the shared brace/string-BALANCED strip — the old local
 *  regex (`\{[^}]*\}`) stopped at the first `}` and could truncate a nested
 *  `initialVariant={…}` ternary (sanctioned fix, phase-9 9.2d). */
function stripAttr(tag: string, name: string): string {
  return stripTagAttrBalanced(tag, name);
}

/**
 * Write `data-form-state` + the derived `initialVariant` ternary onto the
 * instance, and ensure the form's lifecycle `useState('idle')` is declared.
 * An empty mapping clears the wiring (removes both attrs).
 */
export function setFormStateMappingInCode(
  code: string,
  nodeId: string,
  stateVar: string,
  mapping: FormStateMapping,
): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx < 0) {
    trace.action('form-state-gen:set-skip', { nodeId, reason: 'data-id-not-found' });
    return code;
  }
  const ltIdx = code.lastIndexOf('<', idIdx);
  const tagClose = findTagClose(code, idIdx);
  if (ltIdx < 0 || tagClose < 0) return code;

  let tag = code.slice(ltIdx, tagClose);
  // Find where the tag name ends (after `<FormSubmit`) so fresh attrs go first.
  const nameEnd = ltIdx + 1 + (tag.slice(1).match(/^[A-Za-z0-9.]+/)?.[0].length ?? 0);
  tag = stripAttr(stripAttr(tag, 'data-form-state'), 'initialVariant');

  const hasMapping = FORM_STATES.some((s) => mapping[s]);
  let next: string;
  if (hasMapping) {
    const json = JSON.stringify(mapping);
    const expr = buildInitialVariantExpr(stateVar, mapping);
    const inject = ` data-form-state='${json}' initialVariant={${expr}}`;
    // Re-slice the rebuilt tag relative to the original code positions.
    const rebuiltTag = tag;
    const afterName = (nameEnd - ltIdx);
    const newTag = rebuiltTag.slice(0, afterName) + inject + rebuiltTag.slice(afterName);
    next = code.slice(0, ltIdx) + newTag + code.slice(tagClose);
    // Declare the lifecycle var once (insertConstIntoEnclosingFn isn't idempotent).
    const decl = `const [${stateVar}, ${formStateSetter(stateVar)}] = useState('idle');`;
    if (!next.includes(decl)) next = insertConstIntoEnclosingFn(next, nodeId, decl);
  } else {
    next = code.slice(0, ltIdx) + tag + code.slice(tagClose);
  }
  trace.action('form-state-gen:set', { nodeId, stateVar, states: Object.keys(mapping).filter((k) => mapping[k as FormState]) });
  return next;
}

/** Tag name of a JSX opening element (`form` / `motion.form`). */
function tagNameOf(name: t.JSXOpeningElement['name']): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name) && t.isJSXIdentifier(name.object) && t.isJSXIdentifier(name.property)) {
    return `${name.object.name}.${name.property.name}`;
  }
  return '';
}

/**
 * The id of the `<form>` (or `<motion.form>`) that ENCLOSES `nodeId`, or null.
 * Used by the move round-trip to rebind a moved instance's Form State to the
 * form it landed in.
 */
export function enclosingFormIdInCode(code: string, nodeId: string): string | null {
  const ast = parseJSX(code);
  if (!ast) return null;
  let found: string | null = null;
  findFirstElementByDataId(ast, nodeId, (path: any) => {
    let p = path.parentPath;
    while (p) {
      if (typeof p.isJSXElement === 'function' && p.isJSXElement()) {
        const opening = (p.node as t.JSXElement).openingElement;
        const name = tagNameOf(opening.name);
        if (name === 'form' || name === 'motion.form') {
          const idAttr = findAttribute(opening, 'data-id');
          if (idAttr && idAttr.value && t.isStringLiteral(idAttr.value)) { found = idAttr.value.value; return; }
        }
      }
      p = p.parentPath;
    }
  });
  return found;
}

/**
 * Strip the RUNTIME `initialVariant={formState…}` binding from a Form Submit
 * instance, keeping the `data-form-state` spec. Called when the instance is
 * dragged OUT of its form (onto the canvas / a canvas frame = module scope):
 * the binding would reference an out-of-scope `formState<Id>` and crash. The
 * spec is retained so re-entry into a form can rebind. Idempotent.
 */
export function dormantizeFormStateBinding(code: string, nodeId: string): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx < 0) return code;
  const ltIdx = code.lastIndexOf('<', idIdx);
  const tagClose = findTagClose(code, idIdx);
  if (ltIdx < 0 || tagClose < 0) return code;
  const tag = code.slice(ltIdx, tagClose);
  const stripped = stripAttr(tag, 'initialVariant');
  if (stripped === tag) return code;
  trace.action('form-state-gen:dormantize', { nodeId });
  return code.slice(0, ltIdx) + stripped + code.slice(tagClose);
}

/**
 * Restore the `initialVariant` binding from the `data-form-state` spec when a
 * Form Submit instance lands back INSIDE a form (rebinding to THAT form's
 * `formState<Id>` + ensuring its useState). No-op when there's no spec or the
 * node isn't inside a form (stays dormant). Inverse of dormantize.
 */
export function rehydrateFormStateBinding(code: string, nodeId: string): string {
  const mapping = parseFormStateMapping(code, nodeId);
  if (!FORM_STATES.some((s) => mapping[s])) return code; // no spec → nothing to restore
  const formId = enclosingFormIdInCode(code, nodeId);
  if (!formId) return code; // not inside a form → leave dormant
  trace.action('form-state-gen:rehydrate', { nodeId, formId });
  return setFormStateMappingInCode(code, nodeId, formStateVar(formId), mapping);
}

/** Strip the brace-aware `onSubmit={…}` handler from a JSX string slice. */
function stripOnSubmitHandlers(s: string): string {
  let out = s;
  for (;;) {
    const i = out.indexOf('onSubmit={');
    if (i === -1) break;
    let depth = 0;
    let end = -1;
    for (let j = i + 'onSubmit='.length; j < out.length; j++) {
      const c = out[j];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;
    let from = i;
    if (out[from - 1] === ' ') from--;
    out = out.slice(0, from) + out.slice(end + 1);
  }
  return out;
}

/**
 * Dormantize EVERY module-scope-dependent form binding inside the `canvasNodes`
 * fragment — fired when a whole `<form>` (or any subtree) is dragged onto the
 * canvas. The page-function vars those bindings reference (`formState<X>`,
 * `setFormState<X>`, `__mqN` gates) are out of scope in the module-scope
 * fragment → "References undefined identifier … would crash". Collapses:
 *   - responsive-attr ternaries `attr={__mq0 ? 'date' : 'text'}` → `attr="text"`
 *   - `attr={variant === 'm' ? 'date' : 'text'}`                 → `attr="text"`
 *   - FormSubmit `initialVariant={formState<X> === …}`           → removed
 *   - `<form>` `onSubmit={…}`                                     → removed
 * Idempotent; cheap-guarded; flush-time self-heal. (A canvas form is scratch —
 * re-configure after dragging it back into a viewport.)
 */
export function dormantizeFormBindingsInCanvas(code: string): string {
  const start = code.indexOf('const canvasNodes');
  if (start === -1) return code;
  // The fragment is emitted as `const canvasNodes = <>…</>;` OR `= (<>…</>);`.
  const open = code.indexOf('<>', start);
  if (open === -1) return code;
  const close = code.lastIndexOf('</>'); // canvasNodes is the file's last fragment
  if (close <= open) return code;
  let frag = code.slice(open + 2, close);
  if (!/__mq\d+|initialVariant=\{formState|onSubmit=\{/.test(frag)) return code;
  const before = frag;
  // 1. Collapse responsive-attr ternaries (viewport / variant gated) → base literal.
  frag = frag.replace(
    /\s([A-Za-z][\w-]*)=\{(?:__mq\d+|(?:initialVariant|variant) === '[^']*') \? "[^"]*"(?: : (?:__mq\d+|(?:initialVariant|variant) === '[^']*') \? "[^"]*")* : "([^"]*)"\}/g,
    ' $1="$2"',
  );
  // 2. Strip FormSubmit initialVariant (formState lifecycle binding).
  frag = frag.replace(/\sinitialVariant=\{formState[A-Za-z0-9]+ === [^}]*\}/g, '');
  // 3. Strip form onSubmit handlers.
  frag = stripOnSubmitHandlers(frag);
  if (frag === before) return code;
  trace.action('form-state-gen:dormantize-canvas-forms', {});
  return code.slice(0, open + 2) + frag + code.slice(close);
}

/**
 * SELF-HEAL: re-declare a `formState<X>` lifecycle var that is REFERENCED (by an
 * onSubmit `setFormState<X>(…)` or a `formState<X> === …` binding) but NOT
 * declared in its enclosing function — the case when a `<form>` is made into a
 * design component: make-component carries the onSubmit + FormSubmit binding into
 * the master, but the `const [formState<X>, …] = useState('idle')` stayed in the
 * page → "formState<X> is not defined" crash. Injects the useState (via
 * `React.useState`, so no import dependency) at the top of the function that
 * holds the first reference. Idempotent; run on the master after extraction.
 */
export function healMissingFormStateDeclarations(code: string): string {
  const refs = new Set<string>();
  for (const m of code.matchAll(/\bformState[A-Za-z0-9]+\b/g)) refs.add(m[0]);
  let result = code;
  for (const v of refs) {
    if (new RegExp(`const \\[\\s*${v}\\b`).test(result)) continue; // already declared
    const refIdx = result.search(new RegExp(`\\b${v}\\b`));
    if (refIdx < 0) continue;
    // Find the opening brace of the function that ENCLOSES the first reference.
    const fnRe = /function\s+\w+\s*\([^)]*\)\s*\{/g;
    let m: RegExpExecArray | null;
    let braceAt = -1;
    while ((m = fnRe.exec(result))) {
      const b = m.index + m[0].length;
      if (b <= refIdx) braceAt = b; else break;
    }
    if (braceAt < 0) continue;
    result = result.slice(0, braceAt) + `\n  const [${v}, ${formStateSetter(v)}] = React.useState('idle');` + result.slice(braceAt);
    trace.action('form-state-gen:heal-missing-decl', { stateVar: v });
  }
  return result;
}

/**
 * SELF-HEAL: strip any `initialVariant={formState<X> === …}` whose `formState<X>`
 * useState is no longer declared in the file (an instance moved out of its form
 * before the dormantize fix, leaving a dangling reference that blocks EVERY
 * later mutation with "References undefined identifier"). Keeps `data-form-state`
 * so a later re-entry can rehydrate. Idempotent; cheap-guarded. Run on flush.
 */
export function healOrphanedFormStateBindings(code: string): string {
  if (!code.includes('initialVariant={formState')) return code;
  const vars = new Set<string>();
  for (const m of code.matchAll(/initialVariant=\{(formState[A-Za-z0-9]+)\s*===/g)) vars.add(m[1]);
  let result = code;
  for (const v of vars) {
    if (new RegExp(`const\\s*\\[\\s*${v}\\b`).test(code)) continue; // declared → fine
    result = result.replace(new RegExp(`\\sinitialVariant=\\{${v} === [^}]*\\}`, 'g'), '');
    trace.action('form-state-gen:heal-orphan', { stateVar: v });
  }
  return result;
}
