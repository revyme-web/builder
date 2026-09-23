// create-component-gen.ts — author a design-component master file from a
// DECLARATIVE spec (the file half of the agent's `create_component` tool).
//
// Pure `(spec, …args) => result` generator, same house style as
// extract-component-gen.ts (Babel locates spans, source-preserving surgery,
// oracle-canonical master shape): `"use client"` + runtime import +
// `/** @name */` + variantConfig ARRAY + destructured props with defaults +
// root `...style` spread + `initialVariant='default'` + withResponsiveProps
// export. Reuses the exported pure surgery helpers (never the pipelines).
//
// FROZEN BOUNDARIES (Porte 7 §7) : `makeComponent` (human convert),
// `buildExtractedMaster` (agent extract) and `component-spec/compile.ts`
// (design-spec loop) are NEVER imported nor modified here — behavior
// byte-identical. This emitter plugs into the EXISTING agent write path
// (wrapper → gateTurnFiles → commitTurnFiles, like extract), not a new loop.
//
// SCOPE (deliberately narrow — Ib-3 [FIGÉE]) :
// - `from` XOR `layout` (one required) : `from` authors the master FROM a
//   live subtree (page untouched — unlike extract which converts in place) ;
//   `layout` authors from an explicit element list. Both absent, or both
//   present → pedagogical refusal, never a shell master.
// - from-mode binds source literal texts to declared props BY DOCUMENT ORDER
//   (exact count required when props are declared ; zero props → all literal).
// - No expressions, no ternaries, no className, no free imports, no nested
//   component instances (flatten first) — anything else is a refusal naming
//   the fix, never silently dropped.
// - `{prop}` references (text, whole style values) must name a declared prop.

import { parseJSX, findFirstElementByDataId } from '@/code/parsing/ast-utils';
import { serializeVariantConfig } from '@/code/variants/variant-config';
import { setPropTypeInCode } from '@/code/components/prop-meta';
import { convertRootStyleForMaster } from './extract-component-gen';
import { trace } from '@/shared/debug-trace';

export type CreatePropType = 'string' | 'number' | 'boolean' | 'color' | 'image';

/** The builder's variable type id per declared prop type (component-ops CMS_FIELD_TO_PROP_TYPE). */
const PROP_META_TYPE: Record<CreatePropType, string> = { string: 'plainText', number: 'number', boolean: 'toggle', color: 'color', image: 'image' };

export interface CreatePropSpec {
  name: string;
  type: CreatePropType;
  default: unknown;
}

export interface CreateVariantSpec {
  name: string;
  label?: string;
}

export interface CreateLayoutNode {
  tag: string;
  text?: string;
  style?: Record<string, string>;
  children?: CreateLayoutNode[];
  dataId?: string;
}

export interface CreateComponentSpec {
  name: string;
  props: CreatePropSpec[];
  variants?: CreateVariantSpec[];
  /** data-id of a live subtree to author the master from (page untouched). */
  from?: string;
  /** Explicit element list for from-scratch authoring. */
  layout?: CreateLayoutNode[];
}

export interface CreatedProp {
  name: string;
  type: CreatePropType;
  /** TS literal for the default (`"Hi"`, `16`, `true`). */
  defaultLiteral: string;
}

export type CreateMasterResult =
  | { masterCode: string; props: CreatedProp[]; dataIds: string[]; needsMotion: boolean }
  | { error: string };

const COMPONENT_NAME_RE = /^[A-Z][A-Za-z0-9]*$/;
const PROP_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const VARIANT_NAME_RE = /^[a-z0-9-]+$/;
const DATA_ID_RE = /^[a-z0-9-]+$/;
const HTML_TAG_RE = /^[a-z][a-z0-9-]*$/;
const MOTION_TAG_RE = /^motion\.[A-Za-z][A-Za-z0-9]*$/;

/** Props the master plumbing owns — never declarable (clear refusal). */
const RESERVED_PROPS = new Set(['style', 'children', 'initialVariant', 'variant']);

const PROP_TS_TYPES: Record<CreatePropType, string> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  color: 'string',
  image: 'string',
};

function defaultMatchesType(type: CreatePropType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'color':
    case 'image':
      return typeof value === 'string' && (value as string).trim() !== '';
  }
}

function defaultLiteral(type: CreatePropType, value: unknown): string {
  if (type === 'string' || type === 'color' || type === 'image') return JSON.stringify(value);
  return String(value);
}

function slugify(name: string): string {
  return (
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-') ?? 'component'
  );
}

/** Validate the declarative envelope (both modes). Returns the error or null. */
function validateSpec(spec: CreateComponentSpec): string | null {
  if (!spec || typeof spec !== 'object') return 'Missing component spec — pass {name, props, from|layout}.';
  if (!COMPONENT_NAME_RE.test(spec.name ?? '')) {
    return `Invalid component name "${spec.name ?? ''}" — use PascalCase letters and digits, starting with a capital (e.g. Hero, PricingCard).`;
  }
  if (!Array.isArray(spec.props)) return 'Invalid props — pass an array (possibly empty) of {name, type, default}.';
  const seenProps = new Set<string>();
  for (const p of spec.props) {
    if (!p || !PROP_NAME_RE.test(p.name ?? '')) {
      return `Invalid prop name "${(p as CreatePropSpec)?.name ?? ''}" — use a valid JS identifier (e.g. title, price).`;
    }
    if (RESERVED_PROPS.has(p.name)) {
      return `Prop "${p.name}" is reserved by the master plumbing — rename it (e.g. ${p.name}Text).`;
    }
    if (seenProps.has(p.name)) return `Duplicate prop "${p.name}" — declare each prop once.`;
    seenProps.add(p.name);
    if (!(p.type in PROP_TS_TYPES)) {
      return `Invalid type "${(p as CreatePropSpec)?.type ?? ''}" for prop "${p.name}" — one of string|number|boolean|color|image.`;
    }
    if (!defaultMatchesType(p.type, p.default)) {
      return `Default for prop "${p.name}" does not match type "${p.type}" — fix the default (no expressions, literals only).`;
    }
  }
  const seenVariants = new Set<string>();
  for (const v of spec.variants ?? []) {
    if (!v || !VARIANT_NAME_RE.test(v.name ?? '')) {
      return `Invalid variant name "${(v as CreateVariantSpec)?.name ?? ''}" — lowercase letters, digits and hyphens (e.g. open, highlight).`;
    }
    if (v.name === 'default') return 'Variant "default" is built in (primary) — declare only the extra states.';
    if (seenVariants.has(v.name)) return `Duplicate variant "${v.name}" — declare each state once.`;
    seenVariants.add(v.name);
  }
  const hasFrom = typeof spec.from === 'string' && spec.from.trim() !== '';
  const hasLayout = Array.isArray(spec.layout) && spec.layout.length > 0;
  if (!hasFrom && !hasLayout) {
    return 'Nothing to author from — pass `from` (data-id of a live subtree to model the master on) or `layout` (explicit element list). A single static occurrence stays inline — do not create.';
  }
  if (hasFrom && hasLayout) {
    return 'Ambiguous source — pass `from` OR `layout`, not both.';
  }
  return null;
}

/** A `{prop}` reference — whole string. Returns the prop name or null. */
function propRefWhole(value: string): string | null {
  const m = /^\{([A-Za-z_$][A-Za-z0-9_$]*)\}$/.exec(value.trim());
  return m ? m[1] : null;
}

/** Emit the canonical master file around a JSX body. */
function emitMaster(
  name: string,
  props: CreatedProp[],
  variants: CreateVariantSpec[],
  body: string,
  needsMotion: boolean,
): string {
  const params = ['style', ...props.map((p) => `${p.name} = ${p.defaultLiteral}`), `initialVariant = 'default'`].join(',\n  ');
  const types = [
    'style?: React.CSSProperties',
    ...props.map((p) => `${p.name}?: ${PROP_TS_TYPES[p.type]}`),
    'initialVariant?: string',
  ].join(';\n  ');
  const variantEntries = [
    { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
    ...variants.map((v, i) => ({
      name: v.name,
      label: v.label ?? v.name.charAt(0).toUpperCase() + v.name.slice(1),
      x: (i + 1) * 100,
      y: 0,
    })),
  ];
  const motionImport = needsMotion ? `import { motion } from 'framer-motion';\n` : '';
  return `"use client";

import { withResponsiveProps } from "@revyme/runtime";
${motionImport}
/** @name "${name}" */
export ${serializeVariantConfig(variantEntries)}

function ${name}({
  ${params},
}: {
  ${types};
}) {
  return (
${body}
  );
}

export default withResponsiveProps(${name});
`;
}

/** Remove the minimal common indent, then indent every line by `spaces`. */
function reindent(slice: string, spaces: number): string {
  const lines = slice.split('\n');
  const indents = lines
    .filter((l) => l.trim() !== '')
    .map((l) => l.match(/^ */)?.[0].length ?? 0);
  const min = indents.length > 0 ? Math.min(...indents) : 0;
  const pad = ' '.repeat(spaces);
  return lines.map((l) => (l.trim() === '' ? '' : pad + l.slice(min))).join('\n');
}

interface PreparedProps {
  created: CreatedProp[];
  byName: Map<string, CreatedProp>;
}

// ─── from-mode ─────────────────────────────────────────────────────────────

function buildFrom(
  spec: CreateComponentSpec,
  prepared: PreparedProps,
  sourceCode: string | undefined,
): { body: string; dataIds: string[]; needsMotion: boolean } | { error: string } {
  if (!sourceCode) return { error: 'Missing source code — `from` needs the active file content.' };
  const from = (spec.from as string).trim();
  const ast = parseJSX(sourceCode);
  if (!ast) return { error: 'Could not parse the active file.' };
  let rootStart = -1;
  let rootEnd = -1;
  let rootTag = '';
  const texts: { start: number; end: number; value: string }[] = [];
  let nestedInstance: string | null = null;
  findFirstElementByDataId(ast, from, (path, element) => {
    const opening: any = element.openingElement;
    const tag = opening.name;
    rootTag = tag?.type === 'JSXIdentifier' ? (tag.name as string) : '';
    if (element.loc) {
      rootStart = element.loc.start.index;
      rootEnd = element.loc.end.index;
    }
    path.traverse({
      JSXElement: {
        enter(childPath: any) {
          const childTag = childPath.node.openingElement?.name;
          const childName = childTag?.type === 'JSXIdentifier' ? (childTag.name as string) : '';
          if (childName && childName[0] !== childName[0].toLowerCase() && !nestedInstance) {
            nestedInstance = childName;
          }
        },
      },
      JSXText(textPath: any) {
        const raw: string = textPath.node.value ?? '';
        if (raw.trim() === '') return;
        const loc = textPath.node.loc;
        if (!loc) return;
        const lead = raw.length - raw.trimStart().length;
        const trail = raw.length - raw.trimEnd().length;
        texts.push({ start: loc.start.index + lead, end: loc.end.index - trail, value: raw.trim() });
      },
    });
  });
  if (rootStart === -1 || rootEnd === -1 || !rootTag) {
    return { error: `No node with data-id="${from}" in the active file.` };
  }
  if (rootTag[0] !== rootTag[0].toLowerCase()) {
    return { error: `"${from}" is already a component instance (<${rootTag}>) — create models plain elements; instantiate or edit the existing component instead.` };
  }
  if (nestedInstance) {
    return { error: `Subtree "${from}" contains a component instance (<${nestedInstance}>) — flatten to plain elements first (create authors self-contained masters).` };
  }
  const inSubtree = texts.filter((t) => t.start >= rootStart && t.end <= rootEnd).sort((a, b) => a.start - b.start);
  if (prepared.created.length > 0 && inSubtree.length !== prepared.created.length) {
    return {
      error: `Source "${from}" has ${inSubtree.length} text leaves but ${prepared.created.length} props declared — declare exactly one prop per text leaf in document order (extras stay impossible to bind).`,
    };
  }
  let slice = sourceCode.slice(rootStart, rootEnd);
  // Zero declared props → texts stay literal (static repeatable master).
  if (prepared.created.length > 0) {
    const ordered = inSubtree
      .map((t, i) => ({ ...t, prop: prepared.created[i].name, start: t.start - rootStart, end: t.end - rootStart }))
      .sort((a, b) => b.start - a.start);
    for (const s of ordered) {
      slice = slice.slice(0, s.start) + `{${s.prop}}` + slice.slice(s.end);
    }
  }
  slice = convertRootStyleForMaster(slice);
  // data-ids travel with the slice (kept, like extract).
  const dataIds: string[] = [];
  for (const m of slice.matchAll(/data-id="([^"]+)"/g)) dataIds.push(m[1]);
  const needsMotion = /<motion\.[A-Za-z0-9]+[\s>]/.test(slice);
  return { body: reindent(slice, 4), dataIds, needsMotion };
}

// ─── layout-mode ───────────────────────────────────────────────────────────

function buildLayout(
  spec: CreateComponentSpec,
  prepared: PreparedProps,
  slug: string,
): { body: string; dataIds: string[]; needsMotion: boolean } | { error: string } {
  const dataIds: string[] = [];
  const usedIds = new Set<string>();
  const tagCounts = new Map<string, number>();
  let needsMotion = false;
  /** Declared props actually bound ({prop} in text or whole style values). */
  const boundProps = new Set<string>();

  const checkTag = (tag: string): string | null => {
    if (HTML_TAG_RE.test(tag)) return null;
    if (MOTION_TAG_RE.test(tag)) {
      needsMotion = true;
      return null;
    }
    return `Invalid tag "<${tag}>" — lowercase HTML tags or motion.* only (no components: flatten first).`;
  };

  const allocId = (explicit: string | undefined, tag: string): string | { error: string } => {
    if (explicit !== undefined) {
      if (!DATA_ID_RE.test(explicit)) return { error: `Invalid data-id "${explicit}" — kebab-case (e.g. card-title).` };
      if (usedIds.has(explicit)) return { error: `Duplicate data-id "${explicit}" in layout — every element needs a unique one.` };
      usedIds.add(explicit);
      dataIds.push(explicit);
      return explicit;
    }
    const base = tag.startsWith('motion.') ? tag.slice('motion.'.length).toLowerCase() : tag;
    const n = (tagCounts.get(base) ?? 0) + 1;
    tagCounts.set(base, n);
    const id = n === 1 ? `${slug}-${base}` : `${slug}-${base}-${n}`;
    usedIds.add(id);
    dataIds.push(id);
    return id;
  };

  const emitText = (text: string): string | { error: string } => {
    // `{prop}` refs bind; anything else must be literal (no expressions).
    // `<` is escaped (`&lt;`) — a raw `<` would break JSX parsing.
    const esc = (s: string): string => s.replace(/</g, '&lt;');
    // Whole-value binding first: the allowed {propName} text form.
    const whole = propRefWhole(text);
    if (whole !== null) {
      if (!prepared.byName.has(whole)) {
        return { error: `Unknown prop "{${whole}}" in text — declare it in props first.` };
      }
      boundProps.add(whole);
      return `{${whole}}`;
    }
    const re = /\{([A-Za-z_$][A-Za-z0-9_$]*)\}/g;
    let hasBinding = false;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!prepared.byName.has(m[1])) {
        return { error: `Unknown prop "{${m[1]}}" in text — declare it in props first.` };
      }
      hasBinding = true;
    }
    if (!hasBinding) {
      if (/[{}]/.test(text)) return { error: `Invalid text "${text}" — braces are only for {prop} bindings (literals otherwise).` };
      return esc(text);
    }
    // Mixed literal + binding (e.g. "Only {price}/mo") is a computed text
    // expression — the text tool cannot edit it (TEXT_EXPRESSION, blocking).
    // Refuse with the fix: split into separate elements or bind one whole prop.
    return {
      error: `Mixed text "${text}" mixes a literal with a {prop} binding — computed text is uneditable (write the final text as a literal, or bind the whole text to one prop, or split into separate elements).`,
    };
  };

  const emitNode = (
    node: CreateLayoutNode,
    indent: string,
    flowHint: { order: string; flex: boolean } | null,
  ): string | { error: string } => {
    if (!node || typeof node !== 'object') return { error: 'Invalid layout node — each node needs a tag.' };
    const tagErr = checkTag(node.tag ?? '');
    if (tagErr) return { error: tagErr };
    const idOrErr = allocId(node.dataId, node.tag);
    if (typeof idOrErr !== 'string') return idOrErr;
    if (node.style !== undefined && (node.style === null || typeof node.style !== 'object' || Array.isArray(node.style))) {
      return { error: `Invalid style on "<${node.tag}>" — pass a record of string values (literals or whole-value {prop}).` };
    }
    const styleEntries: string[] = [];
    const seenKeys = new Set<string>();
    for (const [k, v] of Object.entries(node.style ?? {})) {
      if (typeof v !== 'string') return { error: `Invalid style value for "${k}" — strings only (literals or "{prop}").` };
      const ref = propRefWhole(v);
      if (ref !== null) {
        if (!prepared.byName.has(ref)) return { error: `Unknown prop "{${ref}}" in style — declare it in props first.` };
        boundProps.add(ref);
        styleEntries.push(`${k}: ${ref}`);
      } else {
        if (/[{}]/.test(v)) return { error: `Invalid style value "${v}" — only whole-value {prop} bindings, no embedded expressions.` };
        styleEntries.push(`${k}: ${JSON.stringify(v)}`);
      }
      seenKeys.add(k);
    }
    // Canonical flex/grid dialect (same shape the builder's own insert paths
    // seed, and the FLEX_CHILD_* oracle rules require): flow children of a
    // flex/grid container carry a quoted sequential order (+ non-shrinking
    // flex on flex containers). Model-passed values win; gaps are filled.
    if (flowHint !== null) {
      if (!seenKeys.has('order')) styleEntries.push(`order: '${flowHint.order}'`);
      if (flowHint.flex && !seenKeys.has('flex')) styleEntries.push(`flex: '0 0 auto'`);
    }
    const styleAttr = styleEntries.length > 0 ? ` style={{ ${styleEntries.join(', ')} }}` : '';
    const children = node.children ?? [];
    if (!Array.isArray(children)) return { error: `Invalid children on "<${node.tag}>" — pass an array.` };
    const ownDisplay = typeof node.style?.display === 'string' ? node.style.display : null;
    const isFlexParent = ownDisplay === 'flex' || ownDisplay === 'inline-flex';
    const isGridParent = ownDisplay === 'grid' || ownDisplay === 'inline-grid';
    const childStrs: string[] = [];
    let flowIndex = 0;
    for (const c of children) {
      const cPos = typeof c?.style?.position === 'string' ? c.style.position : null;
      const isFlowChild = cPos !== 'absolute' && cPos !== 'fixed';
      // The rule counts flow in SOURCE order — text leaves don't participate,
      // but element order among themselves is the document order. Text is
      // emitted before children (see below), so element indices count
      // element siblings only, matching the oracle's element-only walk.
      const hint =
        (isFlexParent || isGridParent) && isFlowChild
          ? { order: String(flowIndex), flex: isFlexParent }
          : null;
      if (isFlowChild) flowIndex++;
      const r = emitNode(c, `${indent}  `, hint);
      if (typeof r !== 'string') return r;
      childStrs.push(r);
    }
    if (node.text !== undefined && typeof node.text !== 'string') {
      return { error: `Invalid text on "<${node.tag}>" — strings only (literals or {prop} bindings).` };
    }
    const textPart = node.text !== undefined ? emitText(node.text) : '';
    if (typeof textPart !== 'string') return textPart;
    const inner = [...(textPart !== '' ? [`${indent}  ${textPart}`] : []), ...childStrs].join('\n');
    if (inner === '') return `${indent}<${node.tag} data-id="${idOrErr}"${styleAttr} />`;
    return `${indent}<${node.tag} data-id="${idOrErr}"${styleAttr}>\n${inner}\n${indent}</${node.tag}>`;
  };

  // Reserve the wrapper root id FIRST so an explicit child dataId equal to
  // it is an honest duplicate error (M6), never a silent collision.
  const rootId = `${slug}-root`;
  usedIds.add(rootId);
  dataIds.push(rootId);
  const roots: string[] = [];
  for (const n of spec.layout as CreateLayoutNode[]) {
    const r = emitNode(n, '    ', null);
    if (typeof r !== 'string') return r;
    roots.push(r);
  }
  // Layout mode authors a single-root master (one root invariant): siblings
  // are wrapped in the slug root. The root carries NO position (canvas owns
  // master placement — COMPONENT_ROOT_POSITION) and spreads ...style
  // (ROOT_STYLE_SPREAD) so instance placement applies.
  const wrapped = `    <div data-id="${rootId}" style={{ ...style }}>\n${roots.join('\n')}\n    </div>`;
  // B1: declared-but-never-bound props are dead API (the gate would bounce
  // UNUSED_COMPONENT_PROP) — refuse at the compiler with the fix, like every
  // other shape refusal here.
  const unbound = [...prepared.byName.keys()].filter((n) => !boundProps.has(n));
  if (unbound.length > 0) {
    return {
      error: `Prop "${unbound[0]}" is declared but never bound — bind it as {${unbound[0]}} in text or a whole style value, or remove it from props.`,
    };
  }
  return { body: wrapped, dataIds, needsMotion };
}

// ─── entry ─────────────────────────────────────────────────────────────────

export function buildCreatedMaster(
  spec: CreateComponentSpec,
  opts: { sourceCode?: string } = {},
): CreateMasterResult {
  trace.fn('generator.buildCreatedMaster', { name: (spec as CreateComponentSpec)?.name });
  const specErr = validateSpec(spec);
  if (specErr) return { error: specErr };
  const prepared: PreparedProps = {
    created: spec.props.map((p) => ({ name: p.name, type: p.type, defaultLiteral: defaultLiteral(p.type, p.default) })),
    byName: new Map(),
  };
  for (const p of prepared.created) prepared.byName.set(p.name, p);

  const slug = slugify(spec.name);
  const hasFrom = typeof spec.from === 'string' && (spec.from as string).trim() !== '';
  const built = hasFrom
    ? buildFrom(spec, prepared, opts.sourceCode)
    : buildLayout(spec, prepared, slug);
  if ('error' in built) return built;
  const body = built.body;
  let masterCode = emitMaster(spec.name, prepared.created, spec.variants ?? [], body, built.needsMotion);
  // The Variables panel types a prop by its @propMeta entry, and the
  // Localization panel lists an instance's text props ONLY when the entry says
  // plainText — a declared prop without one is untyped and untranslatable.
  for (const p of prepared.created) masterCode = setPropTypeInCode(masterCode, p.name, PROP_META_TYPE[p.type]);
  return { masterCode, props: prepared.created, dataIds: built.dataIds, needsMotion: built.needsMotion };
}
