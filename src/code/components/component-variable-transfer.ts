// component-variable-transfer.ts — When a node bound to PARENT variables is made into a component, the
// variables it references (and the `__mq` media-query gates those per-viewport bindings use) must be
// TRANSFERRED into the new component file as PROPS — otherwise the extracted JSX references undefined
// identifiers (`shadow5`, `transform`, `transform1`, `__mq2`) and the component file breaks. The instance then
// passes `prop={parentVar}` so the PARENT's variable still drives it — which the panel reads as an
// auto-hoisted variable on the instance (design-tool parity: a child variable becomes a hoisted instance variable).

import { parseComponentInfoFromSource } from './component-registry';
import { trace } from '@/shared/debug-trace';

export interface TransferVar {
  name: string;
  /** The name the prop takes ON THE CHILD, when it differs from the parent's.
   *
   *  Only event props rename. The parent's name carries the parent's MEANING
   *  ("Modal"), which the child has no business knowing — the same button might
   *  open a drawer somewhere else. So the child gets a prop named after the
   *  TRIGGER (`click` / "Click") and the instance wires `click={event1}`: the
   *  child publishes "I was clicked", the parent decides that means Modal.
   *  Matches the reference tool, where the extracted component shows
   *  `Click → Click` and the parent's instance shows `Click → <parent event>`. */
  childName?: string;
  /** Source literal for the component param default (`"none"`, `25`, `false`).
   *  `null` for an EVENT prop: a callback has no meaningful literal default, and
   *  seeding one would be worse than none — `event = ''` makes `onClick={event}`
   *  hand React a string, and `= undefined` is just noise. The param is emitted
   *  bare, exactly as the parent declares it. */
  literal: string | null;
  /** @propMeta label carried from the parent (friendly name). */
  label: string;
  /** @propMeta type carried from the parent, when present (border/shadow/…). */
  metaType?: string;
}
export interface TransferMq { id: string; query: string; }

// Structural params the component template already declares — never re-transfer these.
const RESERVED = new Set(['style', 'initialVariant', 'children', 'rest', 'props', 'key', 'ref']);

/** True if `name` appears in `code` as a VALUE (not merely an object KEY). A parent variable named like a CSS
 *  prop (`order`, `transform`, `opacity`) that appears ONLY as a style key is not a real reference — but the
 *  SAME name used in a value (a ternary branch, an `={…}`) is. We compare total occurrences against key-only
 *  occurrences: at least one non-key occurrence ⇒ referenced. */
export function isReferencedAsValue(code: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = code.match(new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`, 'g'))?.length ?? 0;
  if (all === 0) return false;
  // Object-key occurrences: preceded by `{`/`,` (+ ws) and followed by `:` (+ ws).
  const keys = code.match(new RegExp(`(?<=[{,]\\s{0,60})${esc}(?=\\s{0,60}:)`, 'g'))?.length ?? 0;
  return all > keys;
}

/** Coerce a prop's string default into a JS literal matching its type (number/boolean stay raw, else a quoted
 *  string). `varType` is the @propMeta type vocab (number/slider, toggle/boolean, …). */
function defaultLiteral(type: string | undefined, dflt: string): string {
  const v = dflt ?? '';
  if ((type === 'number' || type === 'slider') && /^-?[\d.]+$/.test(v)) return v;
  if ((type === 'toggle' || type === 'boolean') && (v === 'true' || v === 'false')) return v;
  return JSON.stringify(v);
}

/** Handler attr → the child prop name + label it becomes. `onClick` reads as
 *  "Click" in the panel, which is the trigger the user actually set. */
const TRIGGER_LABEL: Record<string, string> = {
  onClick: 'Click', onTap: 'Tap',
  onMouseEnter: 'Mouse Enter', onMouseLeave: 'Mouse Leave',
  onHoverStart: 'Hover Start', onHoverEnd: 'Hover End',
  onFocus: 'Focus', onBlur: 'Blur', onSubmit: 'Submit',
};

/**
 * The trigger-derived child prop for an event var, or null when the var is NOT
 * used purely as an `on<Trigger>={var}` handler.
 *
 * The "purely" matters: a var also passed into a nested instance
 * (`someProp={event1}`) has no single trigger to name it after, and renaming
 * would silently repoint that other usage. Those keep the parent's name.
 */
export function triggerPropForEvent(code: string, varName: string): { name: string; label: string } | null {
  const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const handlers = [...code.matchAll(new RegExp(`on([A-Z]\\w*)=\\{\\s*${esc}\\s*\\}`, 'g'))];
  if (handlers.length === 0) return null;
  // Every reference must be one of those handlers, else the rename is unsafe.
  const total = code.match(new RegExp(`(?<![\\w$.])${esc}(?![\\w$])`, 'g'))?.length ?? 0;
  if (total !== handlers.length) return null;
  // One trigger only — two different triggers firing the same parent event can't
  // collapse into a single child prop name.
  const attrs = new Set(handlers.map(h => `on${h[1]}`));
  if (attrs.size !== 1) return null;
  const attr = [...attrs][0]!;
  const bare = attr.slice(2);                       // onClick → Click
  return { name: bare.charAt(0).toLowerCase() + bare.slice(1), label: TRIGGER_LABEL[attr] ?? bare };
}

/** `click`, then `click2`, `click3`… — two nodes wired to different parent events
 *  both want the `click` name. */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

/** Parse the parent's raw `@propMeta {…}` map (labels + types EXACTLY as authored). */
function parsePropMetaMap(code: string): Record<string, { label?: string; type?: string }> {
  const m = code.match(/@propMeta\s+(\{[\s\S]*?\})\s*\*\//);
  if (!m) return {};
  try { return JSON.parse(m[1]); } catch { return {}; }
}

/** Parse the parent's `const __mqN = useMediaQuery('<query>')` declarations. */
function parseMqHooks(code: string): TransferMq[] {
  const out: TransferMq[] = [];
  const re = /const\s+(__mq\d+)\s*=\s*useMediaQuery\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) out.push({ id: m[1], query: m[2] });
  return out;
}

/** Find the parent variables (and `__mq` gates) the built component code references but does NOT declare.
 *  Variables are read from the parent's FUNCTION PARAMS (the runtime source of truth) — NOT the
 *  `@pageVariables` annotation, which can be stale/incomplete (a var added as a param + @propMeta may never
 *  reach the @pageVariables block, so reading it dropped shadow5/transform/transform1 entirely). */
export function collectTransferableVariables(componentCode: string, parentCode: string, parentPath: string): { vars: TransferVar[]; mqs: TransferMq[] } {
  const info = parseComponentInfoFromSource(parentPath, parentCode, String(parentCode.length));
  const params = info?.props ?? [];
  const meta = parsePropMetaMap(parentCode);
  const vars: TransferVar[] = [];
  // Child-side names must not collide with the template's own params or each other.
  const taken = new Set<string>([...RESERVED, ...params.map(x => x.name)]);
  for (const p of params) {
    if (RESERVED.has(p.name)) continue;
    // EVENT props are declared WITHOUT a default (`function Header({ …, event1 })`)
    // because a callback has nothing sensible to default to. The `defaultValue ==
    // null` gate below reads that as "required prop, not a variable" and skipped
    // them — so extracting a node carrying `onClick={event1}` produced a component
    // referencing an identifier it never declared, and an instance that passed
    // nothing. Runtime ReferenceError, and the interaction silently lost
    // (reported 2026-08-24). They transfer like any other prop; they just carry no
    // literal.
    const isEvent = (meta[p.name]?.type ?? p.varType) === 'event';
    if (!isEvent && p.defaultValue == null) continue;           // required prop (e.g. children) — not a variable
    if (!isReferencedAsValue(componentCode, p.name)) continue;
    // Event props publish a TRIGGER on the child, not the parent's meaning.
    const trigger = isEvent ? triggerPropForEvent(componentCode, p.name) : null;
    const childName = trigger ? uniqueName(trigger.name, taken) : undefined;
    if (childName) taken.add(childName);
    vars.push({
      name: p.name,
      childName,
      // Coerce with the MOST specific type (raw @propMeta type, else the param's varType) so number/boolean
      // literals stay raw. Event props get no literal — see TransferVar.literal.
      literal: isEvent ? null : defaultLiteral(meta[p.name]?.type ?? p.varType, p.defaultValue!),
      label: trigger?.label ?? p.label ?? p.name,
      // @propMeta type carried VERBATIM from the parent (undefined when the parent had none → the prop's icon
      // defers to its binding, so a shadow var stored without a type shows the shadow icon, not the
      // @pageVariables 'color' primitive).
      metaType: meta[p.name]?.type,
    });
  }
  const mqs = parseMqHooks(parentCode).filter(m => isReferencedAsValue(componentCode, m.id));
  return { vars, mqs };
}

// Standard responsive hook — copied into the component when any `__mq` gate is transferred (the gates use it).
// `useState`/`useEffect` are bare so `syncImports` adds them to the React import.
const USE_MEDIA_QUERY_FN = `function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const on = () => setMatches(mql.matches);
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}`;

/** Inject the transferred variables into the built component code: params (signature) + `@propMeta` (labels)
 *  + `__mq` hooks + `useMediaQuery`. Caller should run `syncImports` afterwards (for useState/useEffect). */
export function applyVariableTransfer(code: string, componentName: string, vars: TransferVar[], mqs: TransferMq[]): string {
  let out = code;

  // 1. Params — add `name = <literal>` to the destructured signature, before `...rest`. The `[key: string]:
  //    any` index signature already types them, so no per-param type annotation is needed.
  if (vars.length > 0) {
    // `literal === null` → an event prop: emit the param BARE (`event1`), which is
    // how the parent declares it too. Giving a callback a default would either
    // hand React a non-function or add dead noise.
    const params = vars
      .map(v => (v.literal === null ? (v.childName ?? v.name) : `${v.name} = ${v.literal}`))
      .join(', ');
    out = out.replace(
      /(function\s+\w+\(\{\s*style,\s*initialVariant\s*=\s*'default',\s*)(\.\.\.rest\s*\})/,
      `$1${params}, $2`,
    );
  }

  // 1b. Body — repoint the handler at the RENAMED prop. Scoped to the handler
  //     attribute so a same-named identifier elsewhere can't be caught; the
  //     rename only happens when every reference IS such a handler anyway
  //     (see triggerPropForEvent).
  for (const v of vars) {
    if (!v.childName || v.childName === v.name) continue;
    const esc = v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(on[A-Z]\\w*=\\{\\s*)${esc}(\\s*\\})`, 'g'), `$1${v.childName}$2`);
  }

  // 2. @propMeta — friendly labels (+ types) so the prop rows / instance pills read like the parent's.
  if (vars.length > 0) {
    const metaMap: Record<string, { type?: string; label: string }> = {};
    for (const v of vars) {
      const key = v.childName ?? v.name;
      metaMap[key] = v.metaType ? { type: v.metaType, label: v.label } : { label: v.label };
    }
    const block = `/** @propMeta ${JSON.stringify(metaMap)} */\n`;
    out = /@name\s+"[^"]*"\s*\*\//.test(out)
      ? out.replace(/(@name\s+"[^"]*"\s*\*\/\n)/, `$1${block}`)
      : block + out;
  }

  // 3. __mq gates — re-declare the hooks inside the component body and copy `useMediaQuery` to module scope.
  if (mqs.length > 0) {
    out = out.replace(new RegExp(`(\\nfunction\\s+${componentName}\\()`), `\n${USE_MEDIA_QUERY_FN}\n$1`);
    const hookLines = mqs.map(m => `  const ${m.id} = useMediaQuery('${m.query}');`).join('\n') + '\n';
    out = out.replace(/(\[key: string\]: any \}\) \{\n)/, `$1${hookLines}`);
  }

  trace.action('component-variable-transfer:apply', { componentName, vars: vars.map(v => v.name), mqs: mqs.map(m => m.id) });
  return out;
}

/** Instance attrs that pass each transferred variable through from the PARENT (`shadow5={shadow5}` …) so the
 *  parent's variable still drives the prop — auto-hoisted on the instance. */
export function buildInstanceVariableAttrs(vars: TransferVar[]): string {
  // `childProp={parentVar}` — the two names differ for a renamed event prop.
  return vars.map(v => ` ${v.childName ?? v.name}={${v.name}}`).join('');
}
