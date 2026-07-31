// scroll-parser.ts — Parse useScroll/useTransform/useSpring/useRef from component code.
// Reads ANY scroll-linked animation pattern — AI-generated, hand-written, or builder-created.
// Returns structured data that the AnimationTool can display and edit.

import { trace } from '@/shared/debug-trace';
import { nodeIdToVarName } from '@/shared/id-utils';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ScrollRef {
  varName: string;       // 'heroRef', 'sec1Ref'
  nodeId?: string;       // data-id of the element this ref is attached to
}

export interface ScrollSource {
  progressVar: string;   // the scrollYProgress alias: 'heroProgress', 'p1'
  refVar: string | null; // target ref variable (null = page scroll)
  offset: string | null; // raw offset string: '["start end", "end start"]'
  /** When the ref is resolved at mount via
   *  `useEffect(() => { ref.current = document.getElementById('id'); }, [])`
   *  the picked id is surfaced here. Used by Scroll Transform's
   *  "Section in View" mode — the useScroll target is another element
   *  on the page (anchored by id), not the animated element itself. */
  sectionId?: string;
}

export interface ScrollTransform {
  varName: string;        // 'heroOpacity', 'y1a'
  sourceVar: string;      // which progress var it reads from
  inputRange: string;     // raw: '[0, 0.3, 0.7, 1]'
  outputRange: string;    // raw: '[0, 1]' or '["0px", "60px"]'
  isSpring: boolean;      // wrapped in useSpring?
  springConfig?: string;  // raw: '{ stiffness: 100, damping: 30 }'
  isLatch?: boolean;      // Replay-off peak latch: useTransform(src, (v) => …)
}

export interface ScrollBinding {
  nodeId: string;         // data-id of the element
  property: string;       // 'opacity', 'y', 'scale', 'x', 'rotate'
  transformVar: string;   // which useTransform variable
}

/** Multi-section milestone — surfaced when the parser detects a multi-section
 *  scroll-anim block (page-level useScroll + N section refs resolved via
 *  getElementById + a useState position array + multi-stop useTransform).
 *  One entry per section; the order matches the section refs' order in
 *  the source. Each entry's `props` is the property values at that
 *  milestone (i.e. the section's "To" state). */
interface ScrollSectionMilestone {
  sectionId: string;
  props: Record<string, string>;
}

/** Multi-section block found in source — one block per animated nodeId. */
export interface ScrollMultiSectionBlock {
  nodeId: string;
  /** Property values BEFORE any section reaches its trigger position. */
  fromProps: Record<string, string>;
  /** Ordered milestones. */
  sections: ScrollSectionMilestone[];
  /** Detected viewport variant from the `offsetPx` constant the
   *  generator emits inside the mount effect. */
  sectionViewport: 'top' | 'middle' | 'bottom';
}

export interface ScrollAnimData {
  refs: ScrollRef[];
  sources: ScrollSource[];
  transforms: ScrollTransform[];
  bindings: ScrollBinding[];
  /** Multi-section blocks detected in source (one per animated nodeId).
   *  Empty when the file only has single-section / non-section animations. */
  multiSection?: ScrollMultiSectionBlock[];
}

// ─── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse all scroll-related hook declarations from a code string.
 * Finds: useRef, useScroll, useTransform, useSpring patterns.
 * Then scans JSX for ref={} and style={{ prop: motionValue }} bindings.
 */
export function parseScrollHooks(code: string): ScrollAnimData {
  if (!code.includes('useScroll')) return { refs: [], sources: [], transforms: [], bindings: [] };
  trace.fn('scroll-parser:parse', { codeLength: code.length });

  const refs: ScrollRef[] = [];
  const sources: ScrollSource[] = [];
  const transforms: ScrollTransform[] = [];
  const bindings: ScrollBinding[] = [];

  // 1. Find useRef declarations: const xxxRef = useRef(null)
  const refRegex = /const\s+(\w+)\s*=\s*useRef\s*\(\s*null\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = refRegex.exec(code)) !== null) {
    refs.push({ varName: m[1] });
  }

  // 2. Find useScroll declarations
  // Pattern: const { scrollYProgress: xxx } = useScroll({ target: ref, offset: [...] })
  // Also: const { scrollYProgress } = useScroll()  (page-level)
  // Also: const { scrollY } = useScroll()
  const scrollRegex = /const\s*\{\s*(?:scrollYProgress|scrollXProgress|scrollY|scrollX)\s*(?::\s*(\w+))?\s*\}\s*=\s*useScroll\s*\(([^)]*)\)/g;
  while ((m = scrollRegex.exec(code)) !== null) {
    const progressVar = m[1] || 'scrollYProgress';
    const argsStr = m[2].trim();

    let refVar: string | null = null;
    let offset: string | null = null;

    if (argsStr) {
      // Extract target ref
      const targetMatch = argsStr.match(/target:\s*(\w+)/);
      if (targetMatch) refVar = targetMatch[1];

      // Extract offset
      const offsetMatch = argsStr.match(/offset:\s*(\[[\s\S]*?\])/);
      if (offsetMatch) offset = offsetMatch[1];
    }

    sources.push({ progressVar, refVar, offset });
  }

  // 2b. Find getElementById section bindings.
  //   useEffect(() => { someRef.current = document.getElementById('anchor'); }, []);
  // Match any whitespace between the assignment + the call. The id is the
  // string literal arg to getElementById. Map the ref var back to the
  // source(s) that use it so the editor can read the section selection.
  const sectionRegex = /(\w+)\.current\s*=\s*document\.getElementById\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/g;
  while ((m = sectionRegex.exec(code)) !== null) {
    const refVar = m[1];
    const sectionId = m[2];
    if (!sectionId) continue;
    for (const src of sources) {
      if (src.refVar === refVar) src.sectionId = sectionId;
    }
  }

  // 3. Find useTransform declarations
  // Pattern: const xxx = useTransform(progress, [inputs], [outputs])
  // Also: const xxx = useSpring(useTransform(progress, [...], [...]), { config })
  //
  // Input/output bracket groups allow ONE level of nesting so multi-section
  // input ranges like `[0, positions[0], positions[1], 1]` parse correctly.
  // The group is `\[(non-bracket | nested-bracket)*\]`.
  const arrayPat = `\\[(?:[^\\[\\]]|\\[[^\\]]*\\])*\\]`;
  // The OUTPUT range may also be a per-viewport GATED form `(__mqN ? [..] : [..])` (a
  // responsive Scroll Transform). The gate is a `__mqN`/`variant ===` test (no parens) and
  // the branches are arrays, so `\([^)]*\)` captures the whole ternary. Consumers that need
  // the endpoints (buildScrollFxSpec) unwrap it via parseScopedScalarExpr.
  const outPat = `(?:${arrayPat}|\\([^)]*\\))`;
  const transformRegex = new RegExp(
    `const\\s+(\\w+)\\s*=\\s*(useSpring\\s*\\(\\s*)?useTransform\\s*\\(\\s*(\\w+)\\s*,\\s*(${arrayPat})\\s*,\\s*(${outPat})\\s*\\)(?:\\s*,\\s*(\\{[^}]*\\})\\s*\\))?`,
    'g',
  );
  while ((m = transformRegex.exec(code)) !== null) {
    const varName = m[1];
    const isSpring = !!m[2];
    const sourceVar = m[3];
    const inputRange = m[4];
    const outputRange = m[5];
    const springConfig = m[6] || undefined;

    transforms.push({ varName, sourceVar, inputRange, outputRange, isSpring, springConfig });
  }

  // Replay-off peak LATCH: `const X = useTransform(src, (v) => { … })` — callback
  // form (no array ranges), so the array regex above misses it. Parse it so the
  // source-chain walk can follow through it AND Replay can be inferred from it.
  const latchRegex = /const\s+(\w+)\s*=\s*useTransform\s*\(\s*(\w+)\s*,\s*\([^)]*\)\s*=>/g;
  while ((m = latchRegex.exec(code)) !== null) {
    if (!transforms.some(t => t.varName === m![1])) {
      transforms.push({ varName: m[1], sourceVar: m[2], inputRange: '', outputRange: '', isSpring: false, isLatch: true });
    }
  }

  // Also find standalone useSpring wrapping a variable (not inline useTransform)
  // const smoothScroll = useSpring(scrollYProgress, { ... })
  const springOnlyRegex = /const\s+(\w+)\s*=\s*useSpring\s*\(\s*(\w+)\s*,\s*(\{[^}]*\})\s*\)/g;
  while ((m = springOnlyRegex.exec(code)) !== null) {
    // Only capture if the source is a scroll progress variable (not a useTransform result)
    const sourceIsProgress = sources.some(s => s.progressVar === m![2]);
    if (sourceIsProgress) {
      // This creates a smoothed version of the progress — store as a special transform
      transforms.push({
        varName: m[1],
        sourceVar: m[2],
        inputRange: '[0, 1]',
        outputRange: '[0, 1]', // pass-through
        isSpring: true,
        springConfig: m[3],
      });
    }
  }

  // 4. Scan JSX for bindings: ref={xxx} → map ref to nodeId
  // Find: ref={xxxRef} data-id="nodeId"
  // or: data-id="nodeId" ... ref={xxxRef}
  const refBindingRegex = /(?:ref=\{(\w+)\}[^>]*data-id="([^"]+)"|data-id="([^"]+)"[^>]*ref=\{(\w+)\})/g;
  while ((m = refBindingRegex.exec(code)) !== null) {
    const refVar = m[1] || m[4];
    const nodeId = m[2] || m[3];
    // Find the ref in our list and tag it with nodeId
    const ref = refs.find(r => r.varName === refVar);
    if (ref) ref.nodeId = nodeId;
  }

  // 4b. Find useMotionTemplate declarations (decomposed complex CSS values)
  // Pattern: const xxx = useMotionTemplate`...`
  const motionTemplateRegex = /const\s+(\w+)\s*=\s*useMotionTemplate`([^`]*)`/g;
  while ((m = motionTemplateRegex.exec(code)) !== null) {
    const varName = m[1];
    const templateStr = m[2]; // e.g., "polygon(${x_0}% ${x_1}%, ...)"

    // Find all slot transforms (varName_0, varName_1, ...) in order
    const slotTransforms = transforms
      .filter(t => t.varName.startsWith(varName + '_'))
      .sort((a, b) => {
        const aIdx = parseInt(a.varName.split('_').pop() || '0');
        const bIdx = parseInt(b.varName.split('_').pop() || '0');
        return aIdx - bIdx;
      });

    const sourceVar = slotTransforms[0]?.sourceVar || '';

    // Reconstruct the full CSS values at each stop by substituting slot values into the template
    if (slotTransforms.length > 0) {
      const slotRanges = slotTransforms.map(t => parseRange(t.outputRange));
      const stopCount = slotRanges[0]?.length || 0;
      const inputRange = slotTransforms[0] ? slotTransforms[0].inputRange : '[0, 1]';

      // Build output CSS string at each stop index
      const outputValues: string[] = [];
      for (let i = 0; i < stopCount; i++) {
        let css = templateStr;
        let slotIdx = 0;
        css = css.replace(/\$\{[^}]+\}/g, () => {
          const val = slotRanges[slotIdx]?.[i] ?? '0';
          slotIdx++;
          return val;
        });
        outputValues.push(css);
      }

      const outputRange = `[${outputValues.map(v => `"${v}"`).join(', ')}]`;
      transforms.push({ varName, sourceVar, inputRange, outputRange, isSpring: false });
    } else {
      transforms.push({ varName, sourceVar, inputRange: '', outputRange: '', isSpring: false });
    }
  }

  // 5. Scan style bindings: style={{ ..., opacity: heroOpacity, y: heroY }}
  // Find all motion value references in style objects on elements with data-id
  const allTransformVars = new Set(transforms.map(t => t.varName));
  const allMotionVars = allTransformVars;

  // Find data-id elements and check their style for motion value references.
  // The `[^<>]*?` bound keeps the match inside ONE JSX tag — otherwise a
  // styleless element followed by a sibling with style would steal the
  // sibling's binding (lazy match expands past the `>` of the first tag).
  // Style attribute values can't contain literal `<`/`>` in JSX, so this
  // is safe for our use case.
  const elementRegex = /data-id="([^"]+)"[^<>]*?style=\{\{([\s\S]*?)\}\}/g;
  while ((m = elementRegex.exec(code)) !== null) {
    const nodeId = m[1];
    const styleContent = m[2];

    // Find property: variableName patterns where variableName is a known transform
    const propRegex = /(\w+):\s*(\w+)/g;
    let pm;
    while ((pm = propRegex.exec(styleContent)) !== null) {
      if (allMotionVars.has(pm[2])) {
        bindings.push({ nodeId, property: pm[1], transformVar: pm[2] });
      }
    }
  }

  // 6. Multi-section detection.
  //
  // The generator emits a recognizable shape for multi-section blocks:
  //   const <name>Sec0Ref = useRef(null);
  //   const <name>Sec1Ref = useRef(null);
  //   const [<name>SecPositions, set<Name>SecPositions] = useState(...);
  //   useEffect(() => { Sec0Ref.current = document.getElementById('a');
  //                     Sec1Ref.current = document.getElementById('b');
  //                     const compute = () => { const offsetPx = <expr>; ... };
  //                     ... }, []);
  //   const { scrollYProgress: <name>Progress } = useScroll();   // page-level (no target)
  //   const <name><Prop> = useTransform(<source>, [0, <pos>[0], <pos>[1], 1], [<from>, <s0>, <s1>, <s1>]);
  //
  // We anchor on the `[varName, setVarName] = useState(...)` array where varName ends in
  // `SecPositions` — this uniquely identifies our generated blocks and tells us the
  // prefix to scan for refs + transforms.
  const multiSection: ScrollMultiSectionBlock[] = [];
  const positionsRegex = /const\s*\[\s*(\w+SecPositions)\s*,\s*(\w+)\s*\]\s*=\s*useState/g;
  while ((m = positionsRegex.exec(code)) !== null) {
    const positionsVar = m[1];
    const cleanName = positionsVar.replace(/SecPositions$/, '');

    // Find all section refs in declaration order, then drop any orphan
    // refs that don't have a getElementById binding inside the mount
    // effect. A previous-run cleanup miss could leave a `Sec2Ref`
    // declaration around after the user removed section 2 — counting
    // that orphan toward `sectionRefs.length` would make the output-
    // range length check `values.length !== sectionRefs.length + 2`
    // fail and the whole multi-section block would silently vanish
    // (trigger falls back to "On Scroll" on next open).
    const sectionRefRegex = new RegExp(`const\\s+(${cleanName}Sec(\\d+)Ref)\\s*=\\s*useRef`, 'g');
    const allSectionRefs: { varName: string; idx: number; sectionId: string }[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = sectionRefRegex.exec(code)) !== null) {
      const varName = sm[1];
      const idMatch = new RegExp(`${varName}\\.current\\s*=\\s*document\\.getElementById\\s*\\(\\s*['"\`]([^'"\`]*)['"\`]`).exec(code);
      allSectionRefs.push({
        varName,
        idx: parseInt(sm[2], 10),
        sectionId: idMatch ? idMatch[1] : '',
      });
    }
    // Keep only refs that ARE bound to an anchor — those are the live
    // section milestones. Orphans (no `getElementById` line) are ignored.
    // We re-check existence of the binding line directly because an
    // empty-string anchor ('') is still a binding, just an inert one.
    const sectionRefs = allSectionRefs
      .filter(r => new RegExp(`${r.varName}\\.current\\s*=\\s*document\\.getElementById\\s*\\(`).test(code))
      .sort((a, b) => a.idx - b.idx);
    if (sectionRefs.length === 0) continue;

    const sectionIds = sectionRefs.map(r => r.sectionId);

    // Detect viewport from the offsetPx expression inside the mount effect.
    // Match within roughly the closest useEffect that references our refs.
    const effectMatch = new RegExp(`useEffect\\(\\s*\\(\\)\\s*=>\\s*\\{[\\s\\S]*?${sectionRefs[0].varName}[\\s\\S]*?const\\s+offsetPx\\s*=\\s*([^;]+);`).exec(code);
    let sectionViewport: 'top' | 'middle' | 'bottom' = 'middle';
    if (effectMatch) {
      const expr = effectMatch[1].trim();
      if (expr === '0') sectionViewport = 'top';
      else if (/window\.innerHeight\s*$/.test(expr)) sectionViewport = 'bottom';
      else sectionViewport = 'middle';
    }

    // Find the page-level useScroll progress var produced for this prefix
    // (named `<cleanName>Progress`). Then find all useTransform/useSpring
    // outputs derived from it.
    const progressVar = `${cleanName}Progress`;
    // Smoothed alias (when transition.type === 'spring') is `<cleanName>Smooth`.
    const smoothVar = `${cleanName}Smooth`;
    const candidateSources = new Set<string>([progressVar, smoothVar]);

    // Collect transforms whose sourceVar matches our candidates AND whose
    // varName starts with cleanName (defensive — guards against other animations
    // on the same page that happen to read from scrollYProgress).
    const ourTransforms = transforms.filter(
      t => candidateSources.has(t.sourceVar) && t.varName.startsWith(cleanName),
    );

    if (ourTransforms.length === 0) continue;

    // For each transform, decode prop name + output range.
    //   varName = `<cleanName><PropCapitalized>`  →  prop = lowercaseFirst(suffix)
    //   outputRange = `[from, s0, s1, ..., sN, sN]`  (last value repeated for "held" tail)
    const propEntries: { prop: string; values: string[] }[] = [];
    for (const t of ourTransforms) {
      const suffix = t.varName.slice(cleanName.length);
      if (!suffix) continue;
      const prop = suffix.charAt(0).toLowerCase() + suffix.slice(1);
      const values = parseRange(t.outputRange);
      // Expected length: 1 (from) + sections.length + 1 (hold) = sections.length + 2
      if (values.length !== sectionRefs.length + 2) continue;
      propEntries.push({ prop, values });
    }

    if (propEntries.length === 0) continue;

    // Find the animated nodeId: the data-id element whose style binds to any of our transforms.
    let animatedNodeId = '';
    const ourTransformVars = new Set(ourTransforms.map(t => t.varName));
    for (const b of bindings) {
      if (ourTransformVars.has(b.transformVar)) { animatedNodeId = b.nodeId; break; }
    }
    if (!animatedNodeId) continue;

    // Build fromProps + sections[]
    const fromProps: Record<string, string> = {};
    const sectionsResult: ScrollSectionMilestone[] = sectionRefs.map((_, i) => ({
      sectionId: sectionIds[i] || '',
      props: {} as Record<string, string>,
    }));
    for (const { prop, values } of propEntries) {
      fromProps[prop] = values[0];
      for (let i = 0; i < sectionRefs.length; i++) {
        sectionsResult[i].props[prop] = values[1 + i];
      }
    }

    multiSection.push({
      nodeId: animatedNodeId,
      fromProps,
      sections: sectionsResult,
      sectionViewport,
    });
  }

  trace.fn('scroll-parser:result', {
    refs: refs.length, sources: sources.length,
    transforms: transforms.length, bindings: bindings.length,
    multiSection: multiSection.length,
  });

  return { refs, sources, transforms, bindings, multiSection: multiSection.length > 0 ? multiSection : undefined };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Get all scroll transforms bound to a specific node.
 * Returns the transforms + their source info for UI display.
 */
export function getScrollDataForNode(data: ScrollAnimData, nodeId: string): {
  bindings: ScrollBinding[];
  transforms: ScrollTransform[];
  source: ScrollSource | null;
  refVar: string | null;
  /** On-Scroll Direction/Replay — INFERRED FROM CODE (no comment markers):
   *  Replay = the source chain has no peak-latch; Direction = whether the output
   *  range starts at the prop's resting value (down) or ends at it (up). */
  direction: 'down' | 'up';
  replay: boolean;
} {
  // Exclude Scroll Speed (parallax) bindings — `y: <name>SpeedY` is its OWN
  // stackable effect (parseScrollSpeed), not a scrubbed scroll-transform.
  const nodeBindings = data.bindings.filter(b => b.nodeId === nodeId && !/SpeedY$/.test(b.transformVar));
  if (nodeBindings.length === 0) return { bindings: [], transforms: [], source: null, refVar: null, direction: 'down', replay: true };

  // Find transforms for these bindings
  const transformVars = new Set(nodeBindings.map(b => b.transformVar));
  const nodeTransforms = data.transforms.filter(t => transformVars.has(t.varName));

  // Walk the source chain transitively. Our generator emits
  //   useTransform(Smooth, …)  where  Smooth = useSpring(Progress, …)
  // so a binding's transform reads from the spring-pass-through, NOT
  // directly from the progress var. We need to follow `sourceVar → next
  // transform → its sourceVar → …` until we land on a var that names a
  // real `useScroll` progress. Without this hop, the lookup returns
  // null and the editor falls back to "On Scroll" / "Instant" even
  // though the source code clearly says Layer in View + Spring.
  const transformByName = new Map(data.transforms.map(t => [t.varName, t]));
  const visited = new Set<string>();
  const resolvedSourceVars = new Set<string>();
  // Collect chain transforms (e.g. the spring-smoothing pass-through)
  // so the editor can read `springConfig` from this node's data without
  // having to scan the whole transforms list separately.
  const chainTransforms: ScrollTransform[] = [];
  for (const t of nodeTransforms) {
    let cursor: string | undefined = t.sourceVar;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      if (data.sources.some(s => s.progressVar === cursor)) {
        resolvedSourceVars.add(cursor);
        break;
      }
      const next = transformByName.get(cursor);
      if (next) chainTransforms.push(next);
      cursor = next?.sourceVar;
    }
  }
  // Surface the chain transforms alongside the binding-owned ones — the
  // editor needs `isSpring + springConfig` to reconstruct the Transition
  // panel's state on re-open.
  const allNodeTransforms = [...nodeTransforms, ...chainTransforms];
  const source = data.sources.find(s => resolvedSourceVars.has(s.progressVar)) || null;

  // Find ref
  const refVar = source?.refVar || null;

  // Replay — inferred: false when the chain passes through a peak-latch.
  const replay = !chainTransforms.some(t => t.isLatch);
  // Direction — inferred from each prop transform's output range vs the prop's
  // RESTING value (opacity/scale → 1, transforms → 0). On Scroll enforces
  // From = resting, so down = [resting, To], up = [To, resting] (reversed).
  const restingFor = (prop: string) => (prop === 'opacity' || prop.startsWith('scale')) ? '1' : '0';
  let down = 0, up = 0;
  for (const b of nodeBindings) {
    const t = nodeTransforms.find(tt => tt.varName === b.transformVar);
    if (!t?.outputRange) continue;
    const outs = parseRange(t.outputRange);
    if (outs.length < 2) continue;
    const rest = restingFor(b.property);
    const first = outs[0].replace(/['"]/g, ''), last = outs[outs.length - 1].replace(/['"]/g, '');
    if (first === rest && last !== rest) down++;
    else if (last === rest && first !== rest) up++;
  }
  const direction: 'down' | 'up' = up > down ? 'up' : 'down';

  return { bindings: nodeBindings, transforms: allNodeTransforms, source, refVar, direction, replay };
}

/** Parse a parenless object literal body (`opacity: 0, rotate: 90`) → props map. */
function parseInlineObjectBody(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|([^,]+))/g)) {
    out[m[1]] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

/**
 * Parse a DIRECTION-TRIGGERED scroll (the reference "On Scroll") for a node — the
 * `useState` + `useMotionValueEvent` + `animate={X ? {To} : {rest}}` form (NOT
 * the scrubbed useScroll/useTransform). Returns the To props + direction +
 * replay + transition, or null if this node has no direction-triggered scroll.
 */
export function parseScrollDirection(code: string, nodeId: string): {
  toProps: Record<string, string>;
  direction: 'down' | 'up';
  replay: boolean;
  transition: Record<string, string>;
  scope?: import('../generation/scoped-expr').SerScope[];
} | null {
  const cleanName = nodeIdToVarName(nodeId);
  const stateVar = `${cleanName}Scrolled`;
  if (!new RegExp(`const \\[${stateVar},`).test(code)) return null;

  // The condition is `stateVar` OR a per-viewport gated `(stateVar && (__mqN || …))`.
  const animM = code.match(new RegExp(`animate=\\{(?:\\(${stateVar}\\s*&&\\s*\\(([^)]*)\\)\\)|${stateVar})\\s*\\?\\s*\\{([^}]*)\\}\\s*:\\s*\\{[^}]*\\}\\}`));
  const toProps = animM ? parseInlineObjectBody(animM[2]) : {};
  // Recover the presence scope from the gate condition (each `__mqN` → its query, each
  // `variant === 'x'` → that variant).
  let scope: import('../generation/scoped-expr').SerScope[] | undefined;
  if (animM?.[1]) {
    const out: import('../generation/scoped-expr').SerScope[] = [];
    for (const tok of animM[1].split('||').map(s => s.trim())) {
      const mq = tok.match(/^(__mq\d+)$/);
      if (mq) { const g = code.match(new RegExp(`const\\s+${mq[1]}\\s*=\\s*useMediaQuery\\('([^']+)'\\)`)); if (g) out.push({ query: g[1] }); continue; }
      const vr = tok.match(/(?:variant|initialVariant)\s*===\s*'([^']+)'/);
      if (vr) out.push({ variant: vr[1] });
    }
    if (out.length) scope = out;
  }
  // Direction: which scroll comparison sets the state TRUE.
  const cap = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
  const trueM = code.match(new RegExp(`if \\((y [<>]) prev\\) set${cap}Scrolled\\(true\\)`));
  const direction: 'down' | 'up' = trueM && trueM[1] === 'y >' ? 'down' : trueM && trueM[1] === 'y <' ? 'up' : 'down';
  const replay = new RegExp(`set${cap}Scrolled\\(false\\)`).test(code);
  const transM = code.match(new RegExp(`transition=\\{\\{([^}]*)\\}\\}`));
  // Only treat the transition as this node's if it's near the animate (best-effort).
  const transition = transM ? parseInlineObjectBody(transM[1]) : {};
  return { toProps, direction, replay, transition, ...(scope ? { scope } : {}) };
}

/** Parse a node's Scroll SPEED (parallax) percentage, or null if none. */
export function parseScrollSpeed(code: string, nodeId: string): number | null {
  const cleanName = nodeIdToVarName(nodeId);
  // The speed value may be a responsive ternary `(__mq0 ? 80 : 110)` — capture the
  // whole inner expression and take the BASE (the syntactic tail, the last number).
  const m = code.match(new RegExp(`const ${cleanName}SpeedY = useTransform\\([^,]+,\\s*\\(v\\)\\s*=>\\s*v \\* \\(1 - ([\\s\\S]+?) / 100\\)\\)`));
  if (!m) return null;
  const nums = m[1].match(/\d+(?:\.\d+)?/g);
  return nums && nums.length ? parseFloat(nums[nums.length - 1]) : null;
}

/**
 * Multi-section block bound to this node (when the parser detected the
 * multi-section generator pattern for it). Used by the editor to reconstruct
 * From + N sections + viewport from source.
 */
export function getMultiSectionForNode(
  data: ScrollAnimData,
  nodeId: string,
): ScrollMultiSectionBlock | null {
  return data.multiSection?.find(b => b.nodeId === nodeId) || null;
}

/**
 * Parse a useTransform output range string into individual values.
 * "[0, 1]" → ["0", "1"]
 * '["0px", "60px"]' → ["0px", "60px"]
 */
export function parseRange(rangeStr: string): string[] {
  // Remove brackets and split
  const inner = rangeStr.slice(1, -1).trim();
  const values: string[] = [];
  let depth = 0;
  let current = '';
  let inStr: string | null = null;

  for (const ch of inner) {
    if (inStr) {
      current += ch;
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; current += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      values.push(current.trim().replace(/^["']|["']$/g, ''));
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) values.push(current.trim().replace(/^["']|["']$/g, ''));

  return values;
}
