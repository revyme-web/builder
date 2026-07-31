// generator-motion-transition.ts — MotionConfig default transitions, per-variant
// entry transitions, and transition VARIABLE bindings.
// All code moved VERBATIM from generator-motion.ts (Phase 7.4 god-file split).
import { trace } from '@/shared/debug-trace';
import { findTagClose, findJSXDataIdIndex, quoteStyleValue, findStyleObjectEnd, ensureNamedImport } from './generator-utils';

// ─── MotionConfig Transition (root default) ────────────────────────────────

/**
 * Format a transition record as a JSX object literal string.
 * { type: 'spring', stiffness: '170' } → "{ type: 'spring', stiffness: 170 }"
 */
/** Motion-prop neutral defaults — the value that means "no transform"
 *  for each animatable framer-motion shorthand. Used by multi-section
 *  backfill so a prop set on only a later milestone doesn't bleed back
 *  into earlier stops via the first-known-value backfill. */
const MOTION_NEUTRALS: Record<string, string> = {
  opacity: '1',
  scale: '1', scaleX: '1', scaleY: '1', scaleZ: '1',
  rotate: '0', rotateX: '0', rotateY: '0', rotateZ: '0',
  x: '0', y: '0', z: '0',
  xPercent: '0', yPercent: '0',
  skew: '0', skewX: '0', skewY: '0',
  perspective: '0',
};

/** Read the AUTHORED static value of a JSX style property — used as the
 *  "rest state" for properties not set on the From stop. Matches the
 *  first `prop: 'value'` or `prop: value` occurrence inside this
 *  element's `style={{ … }}` attribute. Motion-bound assignments
 *  (`backgroundColor: someMotionVar`) are skipped because they have no
 *  quotes around the value. */
function getJSXStyleValue(code: string, nodeId: string, prop: string): string | null {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
  const tagStart = code.lastIndexOf('<', idIdx);
  const tagEnd = findTagClose(code, idIdx);
  if (tagStart === -1 || tagEnd === -1) return null;
  const styleStartIdx = code.indexOf('style={{', tagStart);
  if (styleStartIdx === -1 || styleStartIdx > tagEnd) return null;
  const sStart = styleStartIdx + 'style={{'.length;
  const sClose = findStyleObjectEnd(code, sStart);
  if (sClose === -1) return null;
  const styleContent = code.slice(sStart, sClose);
  // Quoted string value (CSS-style props: backgroundColor, color, etc.)
  const mStr = new RegExp(`(?:^|[,{\\s])${prop}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`).exec(styleContent);
  if (mStr) return mStr[1];
  // Bare numeric value (sometimes used for opacity, etc.)
  const mNum = new RegExp(`(?:^|[,{\\s])${prop}\\s*:\\s*([\\d.+-]+(?:px|%|deg)?)\\b`).exec(styleContent);
  if (mNum) return mNum[1];
  return null;
}

/** Format a `useSpring(value, …)` params object from the Transition
 *  panel's spring config. The panel emits one of two shapes:
 *    physics:  { type:'spring', stiffness, damping, mass? }
 *    time:     { type:'spring', duration, bounce }
 *  We detect by which fields are set and pass them straight through to
 *  framer-motion's `useSpring` (which accepts either form natively).
 *  The fallback for non-spring transitions matches the legacy default. */
function buildSpringParams(transition?: Record<string, string>): string {
  if (transition?.type === 'spring') {
    if (transition.stiffness) {
      const parts = [
        `stiffness: ${transition.stiffness}`,
        `damping: ${transition.damping || '30'}`,
      ];
      if (transition.mass) parts.push(`mass: ${transition.mass}`);
      parts.push('restDelta: 0.001');
      return `{ ${parts.join(', ')} }`;
    }
    if (transition.duration || transition.bounce) {
      const parts = [];
      if (transition.duration) parts.push(`duration: ${transition.duration}`);
      if (transition.bounce !== undefined) parts.push(`bounce: ${transition.bounce}`);
      return `{ ${parts.join(', ')} }`;
    }
  }
  // Legacy default for scroll-linked spring smoothing.
  return '{ stiffness: 100, damping: 30, restDelta: 0.001 }';
}

export function formatTransitionObj(t: Record<string, string>): string {
  const numericKeys = new Set(['duration', 'delay', 'stiffness', 'damping', 'mass', 'bounce']);
  const parts = Object.entries(t)
    .filter(([, v]) => v !== '' && v !== undefined)
    .map(([k, v]) => numericKeys.has(k) ? `${k}: ${v}` : `${k}: ${quoteStyleValue(v)}`);
  return `{ ${parts.join(', ')} }`;
}

/**
 * Wrap a single component-instance JSX (`<MoJiBa data-id="…" … />`) in a
 * `<MotionConfig transition={…}>…</MotionConfig>` wrapper, or update the
 * existing wrapper's transition. MotionConfig propagates the transition
 * via React context to all motion descendants — including the master root
 * inside the instance's expansion — so per-instance transitions become
 * possible without forcing the user to wrap the JSX themselves.
 *
 * `transition === null` removes the wrapper.
 *
 * Caller has already verified that the tag is a PascalCase component
 * instance (lowercase tags belong on the legacy `motion.*` path).
 */
function wrapInstanceWithMotionConfig(
  code: string,
  nodeId: string,
  transition: Record<string, string> | null,
): string {
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;

  // Locate the instance JSX boundaries: from `<TagName` back to `<`, and
  // forward to the matching `/>` (only self-closing handled here — the
  // existing component-instance writes are all self-closing).
  const tagStart = code.lastIndexOf('<', idIdx);
  if (tagStart === -1) return code;
  const tagEnd = findTagClose(code, idIdx);
  if (tagEnd === -1) return code;
  const isSelfClosing = code[tagEnd - 1] === '/';

  // Walk to closing tag for non-self-closing instances.
  const tagNameMatch = code.slice(tagStart + 1).match(/^([A-Za-z][A-Za-z0-9]*)/);
  if (!tagNameMatch) return code;
  const tagName = tagNameMatch[1];
  let endOfInstance = tagEnd + 1;
  if (!isSelfClosing) {
    const closePattern = `</${tagName}>`;
    const closeIdx = code.indexOf(closePattern, tagEnd);
    if (closeIdx === -1) return code;
    endOfInstance = closeIdx + closePattern.length;
  }

  // Detect existing wrapper: `<MotionConfig transition=…>…<TagName data-id=...
  // …</MotionConfig>`. We look only on the line(s) immediately before the
  // tag because nesting many wrappers is unusual.
  const before = code.slice(Math.max(0, tagStart - 200), tagStart);
  const wrapperOpenMatch = before.match(/<MotionConfig\s+transition=\{(\{[^}]*\})\}\s*>\s*$/);

  if (transition === null) {
    if (!wrapperOpenMatch) return code;
    // Strip wrapper open + matching close
    const wrapperOpenStart = tagStart - wrapperOpenMatch[0].length;
    // Find matching </MotionConfig> after the instance
    const after = code.slice(endOfInstance);
    const closeMatch = after.match(/^\s*<\/MotionConfig>/);
    if (!closeMatch) return code;
    const wrapperEnd = endOfInstance + closeMatch[0].length;
    const stripped = code.slice(0, wrapperOpenStart) + code.slice(tagStart, endOfInstance) + code.slice(wrapperEnd);
    trace.action('generator:motion-config-wrapper-removed', { nodeId });
    return stripped;
  }

  const transStr = formatTransitionObj(transition);

  if (wrapperOpenMatch) {
    // Update existing wrapper's transition
    const wrapperOpenStart = tagStart - wrapperOpenMatch[0].length;
    const newOpen = `<MotionConfig transition={${transStr}}>\n        `;
    const updated = code.slice(0, wrapperOpenStart) + newOpen + code.slice(tagStart);
    trace.action('generator:motion-config-wrapper-updated', { nodeId });
    return ensureMotionConfigImport(updated);
  }

  // Wrap fresh — preserve the indentation that prefixed the instance tag.
  const lineStart = code.lastIndexOf('\n', tagStart);
  const indent = code.slice(lineStart + 1, tagStart).replace(/\S.*/, '');
  const wrapped = `<MotionConfig transition={${transStr}}>\n${indent}  ${code.slice(tagStart, endOfInstance)}\n${indent}</MotionConfig>`;
  const updated = code.slice(0, tagStart) + wrapped + code.slice(endOfInstance);
  trace.action('generator:motion-config-wrapper-added', { nodeId });
  return ensureMotionConfigImport(updated);
}

/** Ensure framer-motion's `MotionConfig` is imported alongside `motion`. */
function ensureMotionConfigImport(code: string): string {
  return ensureNamedImport(code, 'framer-motion', ['MotionConfig']);
}

/**
 * Wrap/update <MotionConfig transition={...}> around the component's return JSX.
 * Used when the ROOT element on the DEFAULT variant gets a transition.
 * MotionConfig propagates transition to all child motion elements.
 */
export function updateMotionConfigTransition(
  code: string,
  transition: Record<string, string> | null,
  // When set, write `<MotionConfig transition={varRef}>` (a VARIABLE identifier, single-brace) instead of the
  // `={{ … }}` object literal — the base/default transition bound to a variable. Takes precedence over `transition`.
  varRef?: string | null,
): string {
  trace.fn('generator.updateMotionConfigTransition', { transition, varRef });

  const writing = !!transition || !!(varRef && varRef.trim());

  // Ensure MotionConfig is imported
  if (writing && !code.includes('MotionConfig')) {
    if (code.includes("{ motion }")) {
      code = code.replace("{ motion }", "{ motion, MotionConfig }");
    } else if (code.includes("{ motion,")) {
      code = code.replace("{ motion,", "{ motion, MotionConfig,");
    }
  }

  const hasWrapper = code.includes('<MotionConfig');

  if (!writing) {
    // Remove MotionConfig wrapper (the open tag may carry `transition=`,
    // or it may be a bare `<MotionConfig>` — the auto-wrapped form always
    // includes transition, but be defensive).
    if (!hasWrapper) return code;
    // Match the opening tag for BOTH a `={{ … }}` object AND a `={ident}` variable form — else removing a
    // VARIABLE-bound MotionConfig stripped only `</MotionConfig>`, leaving an unbalanced opening tag → the
    // reported "Failed to parse JSX" crash on deleting a primary transition variable.
    code = code.replace(/<MotionConfig\s+transition=\{(?:\{[\s\S]*?\}|[^{}]*)\}\s*>/g, '');
    code = code.replace(/<MotionConfig\s*>/g, '');
    code = code.replace(/<\/MotionConfig>/g, '');
    // Collapse any blank lines produced by stripping the tag pair so the
    // file doesn't grow stair-stepped whitespace on repeated toggles.
    code = code.replace(/^\s*\n/gm, (m) => (m.length > 1 ? '\n' : m));
    return code;
  }

  // `transStr` is the EXPRESSION inside `transition={…}` — for a variable it's the bare identifier (→
  // `transition={varRef}`), for a literal it's the object string (→ `transition={{ … }}`).
  const transStr = (varRef && varRef.trim()) ? varRef.trim() : formatTransitionObj(transition!);

  if (hasWrapper) {
    // Update existing MotionConfig transition — match either the `={{ … }}` object OR a `={ident}` variable form.
    code = code.replace(
      /(<MotionConfig\s+transition=)(?:\{\{[^}]*\}\}|\{[^{}]*\})/,
      `$1{${transStr}}`
    );
    return code;
  }

  // Wrap inside the existing `<LayoutGroup>` if present — every component
  // file emitted by the codegen wraps its JSX in LayoutGroup, and that
  // form is shape-stable regardless of `return (...)` vs `return <...>` (we
  // used to depend on the parentheses form, which silently no-op'd on
  // files where the codegen had emitted the no-parens variant — the bug
  // the user observed: "I increase the transition slider and nothing
  // writes to the file"). LayoutGroup ↔ MotionConfig are independent
  // contexts so this nesting is harmless.
  const layoutGroupOpenMatch = code.match(/<LayoutGroup\b[^>]*>/);
  if (layoutGroupOpenMatch && layoutGroupOpenMatch.index !== undefined) {
    const openEnd = layoutGroupOpenMatch.index + layoutGroupOpenMatch[0].length;
    const closeIdx = code.indexOf('</LayoutGroup>', openEnd);
    if (closeIdx === -1) return code;
    const indent = '      ';
    const wrapped =
      code.slice(0, openEnd) +
      `\n${indent}<MotionConfig transition={${transStr}}>` +
      code.slice(openEnd, closeIdx) +
      `</MotionConfig>\n    ` +
      code.slice(closeIdx);
    return wrapped;
  }

  // Fallback: legacy `return ( ... )` form. Find the open paren and walk
  // the contents, then wrap.
  const returnParenMatch = code.match(/return\s*\(\s*\n?/);
  if (returnParenMatch) {
    const idx = code.indexOf(returnParenMatch[0]) + returnParenMatch[0].length;
    const afterReturn = code.slice(idx);
    const indentMatch = afterReturn.match(/^(\s*)</);
    const indent = indentMatch ? indentMatch[1] : '    ';
    code = code.slice(0, idx) + `${indent}<MotionConfig transition={${transStr}}>\n` + code.slice(idx);
    const returnIdx = code.indexOf(returnParenMatch[0]);
    const parenStart = returnIdx + returnParenMatch[0].length - 1;
    let pDepth = 1;
    let pPos = parenStart + 1;
    while (pPos < code.length && pDepth > 0) {
      if (code[pPos] === '(') pDepth++;
      else if (code[pPos] === ')') pDepth--;
      if (pDepth > 0) pPos++;
    }
    if (pPos < code.length) {
      const beforeClose = code.lastIndexOf('\n', pPos);
      const closeIndent = beforeClose >= 0 ? code.slice(beforeClose + 1, pPos).replace(/\S.*/, '') : '    ';
      code = code.slice(0, pPos) + `${closeIndent}</MotionConfig>\n  ` + code.slice(pPos);
    }
    return code;
  }

  // Last-resort fallback: `return <Tag` (no parens, no LayoutGroup). Wrap
  // around the bare top-level JSX.
  const bareReturnMatch = code.match(/return\s+(<[A-Za-z][^;]*?)(\s*;)/s);
  if (bareReturnMatch && bareReturnMatch.index !== undefined) {
    const inner = bareReturnMatch[1];
    const semi = bareReturnMatch[2];
    const start = bareReturnMatch.index + 'return '.length;
    const end = bareReturnMatch.index + bareReturnMatch[0].length;
    const replacement = `return <MotionConfig transition={${transStr}}>${inner}</MotionConfig>${semi}`;
    return code.slice(0, bareReturnMatch.index) + replacement + code.slice(end);
  }

  return code;
}

/**
 * Add/update transition inside a variant entry object.
 * Used for non-default variant transitions on any element.
 * e.g. 'variant-1': { backgroundColor: '#red', transition: { type: 'spring' } }
 */
export function updateVariantEntryTransition(
  code: string,
  nodeId: string,
  variantName: string,
  transition: Record<string, string> | null,
  // When set, write `transition: <varRef>` (a VARIABLE identifier) into the entry instead of an object literal
  // — this is how a per-variant transition VARIABLE binds (the framer-motion transition is natively per-variant
  // via the variant entry, so a variable per variant is just the identifier here). Takes precedence over
  // `transition`. null/undefined → object/strip behaviour as before.
  varRef?: string | null,
): string {
  trace.fn('generator.updateVariantEntryTransition', { nodeId, variantName, transition, varRef });

  // Find which variants const this node uses
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagEnd = code.indexOf('>', idIdx);
  if (tagEnd === -1) return code;
  const tagSlice = code.slice(idIdx, tagEnd);
  // Also unwrap the instance-size-override form `variants={__applyInstanceSize(foo, …)}`.
  const variantsMatch = tagSlice.match(/variants=\{(?:__applyInstanceSize\()?(\w+)/);
  let variantsVarName: string;
  if (variantsMatch) {
    variantsVarName = variantsMatch[1];
  } else {
    // No variants={...} prop yet. The user is setting a per-variant
    // transition without any per-variant style overrides — common when the
    // node already has `animate={variant}` from connections. Auto-create
    // an empty variants const + wire the prop so the entry has somewhere
    // to land. Without this, the write silently no-ops (the previous
    // symptom: "I set transition and nothing happens").
    if (!transition || Object.keys(transition).length === 0) return code;
    variantsVarName = nodeId.replace(/-(.)/g, (_, c: string) => c.toUpperCase()).replace(/-/g, '') + 'Variants';
    const variantsConst = `const ${variantsVarName} = {\n  default: {},\n  '${variantName}': {},\n};\n\n`;

    // Insert const before the component function declaration
    let insertIdx = code.indexOf('export default function');
    if (insertIdx === -1) {
      const funcMatch = code.match(/^function\s+\w+\s*\(/m);
      insertIdx = funcMatch ? code.indexOf(funcMatch[0]) : -1;
    }
    if (insertIdx === -1) return code;
    code = code.slice(0, insertIdx) + variantsConst + code.slice(insertIdx);

    // Insert variants={varName} on the JSX after data-id (string indices have
    // shifted from the const insertion above — re-find).
    const idIdx2 = findJSXDataIdIndex(code, nodeId);
    if (idIdx2 === -1) return code;
    const idPattern = `data-id="${nodeId}"`;
    const insertAfter = idIdx2 + idPattern.length;
    code = code.slice(0, insertAfter) + ` variants={${variantsVarName}}` + code.slice(insertAfter);
    trace.action('generator:auto-created-variants-const', { nodeId, variantsVarName, variantName });
  }

  // Find the variant entry
  const constPattern = `const ${variantsVarName}`;
  const constIdx = code.indexOf(constPattern);
  if (constIdx === -1) return code;

  // Find the variant entry block: 'variant-1': { ... }
  // Use a brace-depth approach to handle nested transition objects
  const afterConst = code.slice(constIdx);
  const entryStart = afterConst.match(new RegExp(`'?${variantName}'?\\s*:\\s*\\{`));
  if (!entryStart) return code;

  const entryStartIdx = constIdx + afterConst.indexOf(entryStart[0]) + entryStart[0].length;
  // Find matching closing } (brace/string-aware; unbalanced → end of code,
  // matching the historic naive walk's fallout)
  const entryEndCandidate = findStyleObjectEnd(code, entryStartIdx);
  const entryEndIdx = entryEndCandidate === -1 ? code.length : entryEndCandidate; // points at closing }

  let entryContent = code.slice(entryStartIdx, entryEndIdx);

  // Remove any existing `transition: <value>` from the entry. The value can be an OBJECT (`{…}`, with internal
  // commas), a QUOTED STRING (`'{}'` / `"spring"` — may contain BRACES, the case that corrupted to `{{}' }`
  // when a `[^,{}]+` strip stopped at the brace inside the string), a bare VARIABLE identifier (`ergerg`), or a
  // ternary. Scan the value's extent respecting nested braces/brackets/parens AND quotes, stopping at the
  // entry-level comma or the closing brace; then drop the now-dangling comma so the object list stays valid.
  // `\b` (+ keyMatch.index, not indexOf) avoids matching `transition:` inside a longer key like `mytransition:`.
  const keyMatch = entryContent.match(/\btransition\s*:\s*/);
  if (keyMatch && keyMatch.index !== undefined) {
    const kStart = keyMatch.index;
    let p = kStart + keyMatch[0].length;
    let depth = 0;
    let quote = '';
    while (p < entryContent.length) {
      const ch = entryContent[p];
      if (quote) {
        if (ch === '\\') { p += 2; continue; }
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
      } else if (ch === '{' || ch === '[' || ch === '(') {
        depth++;
      } else if (ch === '}' || ch === ']' || ch === ')') {
        if (depth === 0) break; // the entry's own closing brace
        depth--;
      } else if (ch === ',' && depth === 0) {
        break; // entry-level delimiter
      }
      p++;
    }
    entryContent = entryContent.slice(0, kStart) + entryContent.slice(p);
    // Heal the comma left behind (leading `, b`, trailing `a, `, or doubled `a, , b`).
    entryContent = entryContent.replace(/,\s*,/g, ', ').replace(/^\s*,\s*/, '').replace(/,\s*$/, '');
  }

  // Add the new transition. A VARIABLE binding (`transition: <varRef>`, an identifier) takes precedence over a
  // literal object; both land after the strip above so they cleanly replace any prior value/binding.
  if (varRef && varRef.trim()) {
    entryContent = entryContent.trimEnd();
    if (entryContent && !entryContent.endsWith(',')) entryContent += ',';
    entryContent += ` transition: ${varRef.trim()},`;
  } else if (transition && Object.keys(transition).length > 0 && transition.type !== 'instant') {
    const transStr = formatTransitionObj(transition);
    entryContent = entryContent.trimEnd();
    if (entryContent && !entryContent.endsWith(',')) entryContent += ',';
    entryContent += ` transition: ${transStr},`;
  }

  return code.slice(0, entryStartIdx) + entryContent + code.slice(entryEndIdx);
}

/**
 * Read a per-variant/per-mode transition VARIABLE binding — i.e. detect when the framer-motion transition for a
 * node is a bare IDENTIFIER (`transition: someVar` / `transition={someVar}` / `<MotionConfig transition={someVar}>`)
 * rather than an object literal. Returns the identifier name, or null. This is how the Transition control knows a
 * transition is bound to a variable (the variable lives in the framer-motion transition, NOT style.transition).
 * `mode` mirrors VariantTransitionControl's routing.
 */
export function readTransitionVarRef(
  code: string,
  nodeId: string,
  mode: 'motionConfig' | 'variantEntry' | 'elementProp',
  variantName?: string | null,
  // ROOT nodes inherit their per-variant transition from the MotionConfig; a CHILD does NOT (it shows its OWN
  // element-prop transition only, Default until overridden). Gates the MotionConfig fallback for variantEntry.
  onRoot = true,
): string | null {
  trace.fn('generator.readTransitionVarRef', { nodeId, mode, variantName, onRoot });
  const isIdent = (s: string): string | null => {
    const t = s.trim();
    return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
  };

  if (mode === 'motionConfig') {
    // The PRIMARY transition is the BASE (innermost else) of the MotionConfig ternary chain
    // (`{v1 ? t2 : primaryVar}`), or the whole value if it's a single identifier. `undefined` = no primary var.
    const mcMatch = code.match(/<MotionConfig\s+transition=(\{\{[\s\S]*?\}\}|\{[^{}]*\})/);
    if (!mcMatch) return null;
    const expr = mcMatch[1].slice(1, -1).trim();
    const base = /\?/.test(expr) ? (expr.match(/:\s*([^:?]*)$/)?.[1]?.trim() ?? '') : expr;
    return base === 'undefined' ? null : isIdent(base);
  }

  if (mode === 'variantEntry' && variantName) {
    // A per-variant transition VARIABLE lives in the FUNCTION-SCOPE element ternary
    // `transition={initialVariant === 'v1' ? <X> : base}` (NOT the module-scope variant object — a var there
    // would be an undefined identifier). Return X for this variant if it's an identifier; a literal branch
    // (`? { … } :`) → null (an override, not a variable).
    // A per-variant transition variable can live in TWO places: this node's OWN element-prop ternary (a CHILD's
    // INDIVIDUAL override), OR the MotionConfig (the ROOT/top-level cascade). Check the node's own first, then
    // fall back to the inherited MotionConfig.
    const idIdx = findJSXDataIdIndex(code, nodeId);
    if (idIdx !== -1) {
      const tagEnd = code.indexOf('>', idIdx);
      const tag = code.slice(idIdx, tagEnd === -1 ? undefined : tagEnd);
      const elem = tag.match(new RegExp(`\\btransition=\\{[^}]*?(?:initialVariant|variant)\\s*===\\s*'?${variantName}'?\\s*\\?\\s*([A-Za-z_$][\\w$]*)`));
      if (elem) return isIdent(elem[1]);
    }
    // CHILD has no own per-variant transition → it does NOT show the inherited MotionConfig one (Default instead).
    if (!onRoot) return null;
    const tern = code.match(new RegExp(`<MotionConfig\\s+transition=\\{[^}]*?(?:initialVariant|variant)\\s*===\\s*'?${variantName}'?\\s*\\?\\s*([A-Za-z_$][\\w$]*)`));
    return tern ? isIdent(tern[1]) : null;
  }

  // elementProp: `transition={IDENT}` on the node's own tag.
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return null;
  const tagEnd = code.indexOf('>', idIdx);
  const tagSlice = code.slice(idIdx, tagEnd === -1 ? undefined : tagEnd);
  const m = tagSlice.match(/\btransition=\{\s*([A-Za-z_$][\w$]*)\s*\}/);
  return m ? m[1] : null;
}

/**
 * Bind a PER-VARIANT transition variable as a FUNCTION-SCOPE ternary on the element's own `transition` prop:
 * `transition={initialVariant === 'variant-1' ? varName : baseExpr}`. The module-scope variant OBJECT can't
 * hold this (it would reference a function-scoped prop → "undefined identifier" crash) — so per-variant
 * transition VARIABLES live here, mirroring the per-variant style ternary in the inline style. Strips any
 * module-scope variant-object transition for this variant first. `baseExpr` = the inherited base (the
 * MotionConfig var name, or 'undefined' for none). Single-variant replace (chaining multiple is a follow-up).
 */
/**
 * Set the BASE (default/PRIMARY transition — the innermost else) of the MotionConfig ternary CHAIN, keeping every
 * per-variant branch intact: `<MotionConfig transition={v1 ? t2 : undefined}>` set base→primaryVar →
 * `{v1 ? t2 : primaryVar}`. A non-ternary MotionConfig (or none) is set/created directly. This is why setting a
 * transition on the PRIMARY no longer overrides the individual per-variant transitions (the reported bug).
 */
export function setMotionConfigBaseVar(code: string, varRef: string): string {
  trace.fn('generator.setMotionConfigBaseVar', { varRef });
  const mcMatch = code.match(/<MotionConfig\s+transition=(\{\{[\s\S]*?\}\}|\{[^{}]*\})/);
  if (!mcMatch) return updateMotionConfigTransition(code, null, varRef);
  const expr = mcMatch[1].slice(1, -1).trim();
  const newExpr = /\?/.test(expr) ? expr.replace(/:\s*[^:?]*$/, `: ${varRef}`) : varRef;
  return code.replace(/(<MotionConfig\s+transition=)(?:\{\{[\s\S]*?\}\}|\{[^{}]*\})/, `$1{${newExpr}}`);
}

export function setVariantTransitionPropVar(code: string, nodeId: string, variantName: string, varName: string, baseExpr: string, onRoot = true): string {
  trace.fn('generator.setVariantTransitionPropVar', { nodeId, variantName, varName, baseExpr, onRoot });
  code = updateVariantEntryTransition(code, nodeId, variantName, null); // strip any module-scope object override
  // Gate on the LIVE `variant` STATE (not static `initialVariant`). Mirrors setInlineVariableForVariant.
  const variantVar = /\banimate=\{variant\}/.test(code) || /animate=\{\['default',\s*variant\]\}/.test(code) || /\[variant,\s*set/.test(code) ? 'variant' : 'initialVariant';
  // CHAIN, don't replace: drop any prior branch for THIS variant, keep the rest — so adding never erases another.
  const dropBranch = (expr: string) => expr.replace(new RegExp(`(?:initialVariant|variant)\\s*===\\s*'?${variantName}'?\\s*\\?\\s*[^:?]*:\\s*`), '').trim();

  if (onRoot) {
    // ROOT / top-level: per-variant transition goes on the **MotionConfig** so it CASCADES to every animating
    // descendant that doesn't override (the reference's "the variant's transition applies to the whole animation").
    // Strip a stale element-prop ternary on the root first (older writes lived there).
    const ri = findJSXDataIdIndex(code, nodeId);
    if (ri !== -1) {
      const re = code.indexOf('>', ri);
      if (re !== -1) {
        const rt = code.slice(ri, re);
        if (/\btransition=\{[^}]*?(?:initialVariant|variant)\s*===/.test(rt)) {
          code = code.slice(0, ri) + rt.replace(/\s*\btransition=\{(?:\{[^}]*\}|[^{}]*)\}/, '') + code.slice(re);
        }
      }
    }
    const mcMatch = code.match(/<MotionConfig\s+transition=(\{\{[\s\S]*?\}\}|\{[^{}]*\})/);
    const rest = dropBranch(mcMatch ? mcMatch[1].slice(1, -1) : ((baseExpr && baseExpr.trim()) ? baseExpr.trim() : '{}'));
    const newExpr = `${variantVar} === '${variantName}' ? ${varName} : ${rest}`;
    if (mcMatch) return code.replace(/(<MotionConfig\s+transition=)(?:\{\{[\s\S]*?\}\}|\{[^{}]*\})/, `$1{${newExpr}}`);
    return updateMotionConfigTransition(code, null, newExpr);
  }

  // CHILD: an INDIVIDUAL per-variant transition on THIS child only → its OWN `transition` prop ternary, which
  // overrides the cascaded MotionConfig for this child. Base = `undefined` (inherit MotionConfig when not this
  // variant). Chained so multiple per-variant transitions on the same child don't erase each other.
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagEnd = code.indexOf('>', idIdx);
  if (tagEnd === -1) return code;
  let tag = code.slice(idIdx, tagEnd);
  const existing = tag.match(/\btransition=(\{\{[\s\S]*?\}\}|\{[^{}]*\})/);
  const childRest = dropBranch(existing ? existing[1].slice(1, -1) : 'undefined') || 'undefined';
  const ternary = `${variantVar} === '${variantName}' ? ${varName} : ${childRest}`;
  if (existing) {
    tag = tag.replace(/\btransition=(?:\{\{[\s\S]*?\}\}|\{[^{}]*\})/, `transition={${ternary}}`);
  } else {
    const dataId = `data-id="${nodeId}"`;
    const di = tag.indexOf(dataId);
    if (di === -1) return code;
    tag = tag.slice(0, di + dataId.length) + ` transition={${ternary}}` + tag.slice(di + dataId.length);
  }
  return code.slice(0, idIdx) + tag + code.slice(tagEnd);
}

/**
 * Revert a per-variant transition override → the variant re-inherits the base. Removes BOTH a variant-object
 * LITERAL (the diverge) AND the function-scope element-ternary VARIABLE for this variant. Single-variant
 * (removes the whole element `transition` prop when it's gated on this variant); chaining is a follow-up.
 */
export function revertVariantTransition(code: string, nodeId: string, variantName: string): string {
  trace.fn('generator.revertVariantTransition', { nodeId, variantName });
  let c = updateVariantEntryTransition(code, nodeId, variantName, null); // strip variant-object literal
  // Remove THIS variant's branch from the MotionConfig ternary CHAIN, keeping every OTHER variant's branch
  // (`v2 ? t4 : v1 ? t3 : base` revert v1 → `v2 ? t4 : base`). Single-ternary just becomes `{base}`.
  const mcMatch = c.match(/<MotionConfig\s+transition=(\{\{[\s\S]*?\}\}|\{[^{}]*\})/);
  if (mcMatch) {
    const expr = mcMatch[1].slice(1, -1);
    const next = expr.replace(new RegExp(`(?:initialVariant|variant)\\s*===\\s*'?${variantName}'?\\s*\\?\\s*[^:?]*:\\s*`), '').trim();
    if (next !== expr.trim()) c = c.replace(/(<MotionConfig\s+transition=)(?:\{\{[\s\S]*?\}\}|\{[^{}]*\})/, `$1{${next}}`);
  }
  // Also strip a stale element-prop ternary on the node (legacy per-variant writes).
  const idIdx = findJSXDataIdIndex(c, nodeId);
  if (idIdx === -1) return c;
  const tagEnd = c.indexOf('>', idIdx);
  if (tagEnd === -1) return c;
  let tag = c.slice(idIdx, tagEnd);
  if (new RegExp(`\\btransition=\\{[^}]*?(?:initialVariant|variant)\\s*===\\s*'?${variantName}'?`).test(tag)) {
    tag = tag.replace(/\s*\btransition=\{(?:\{[^}]*\}|[^{}]*)\}/, '');
    c = c.slice(0, idIdx) + tag + c.slice(tagEnd);
  }
  return c;
}

/**
 * Bind the ELEMENT-PROP transition to a variable identifier — `transition={varName}` on the node's own tag
 * (child-element default transition variable). Replaces an existing `transition={…}` (object or identifier) or
 * inserts after `data-id`. The motionConfig/variant-entry forms use update*Transition with varRef instead.
 */
export function setElementTransitionVar(code: string, nodeId: string, varName: string): string {
  trace.fn('generator.setElementTransitionVar', { nodeId, varName });
  const idIdx = findJSXDataIdIndex(code, nodeId);
  if (idIdx === -1) return code;
  const tagEnd = code.indexOf('>', idIdx);
  if (tagEnd === -1) return code;
  let tag = code.slice(idIdx, tagEnd);
  if (/\btransition=\{/.test(tag)) {
    tag = tag.replace(/\btransition=\{(?:\{[^}]*\}|[^{}]*)\}/, `transition={${varName}}`);
  } else {
    const dataId = `data-id="${nodeId}"`;
    const di = tag.indexOf(dataId);
    if (di === -1) return code;
    tag = tag.slice(0, di + dataId.length) + ` transition={${varName}}` + tag.slice(di + dataId.length);
  }
  return code.slice(0, idIdx) + tag + code.slice(tagEnd);
}



export { MOTION_NEUTRALS, getJSXStyleValue, buildSpringParams, wrapInstanceWithMotionConfig };
