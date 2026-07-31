// oracle/checks/scroll-dialect.ts — scroll dialect checks (pages).
// All code moved VERBATIM from check-file.ts (Phase 7.1 god-file split).

import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { traverse, jsxAttrs, stringAttr, unwrapSpring, containsIdentifierFrom } from './shared';
import type { OracleViolation } from './shared';

// ─── scroll dialect (pages) ───────────────────────────────────────────────────
//
// The scroll-parser (src/code/parsing/scroll-parser.ts) recognizes EXACTLY:
//   const xRef = useRef(null)                                  — no TS generics, init null
//   const { scrollYProgress: p } = useScroll({ target: xRef, offset: ['start end','end start'] })
//   const y = useTransform(p, [0, 1], [0, -80])                — identifier source, ARRAY ranges
//   const y = useSpring(useTransform(...), { ... }) | useSpring(p, { ... })
//   const t = useMotionTemplate`...${y_0}...`                  — slot transforms
//   <motion.div ref={xRef} data-id="hero" style={{ y }} />     — ref + data-id SAME tag,
//                                                                binding = bare identifier
// Anything else renders but the Animation panel sees nothing — bounce it.
const SCROLL_KEYS = new Set(['scrollYProgress', 'scrollXProgress', 'scrollY', 'scrollX']);

function checkScrollDialect(ast: t.File, v: OracleViolation[]): void {
  const refVars = new Set<string>();          // valid `= useRef(null)` declarations
  const motionVars = new Set<string>();       // transforms/springs/templates + progress vars
  const sourceUsed = new Set<string>();       // vars consumed by other hooks
  const targetRefs: Array<{ name: string; line?: number }> = [];
  const declaredTransforms: Array<{ name: string; line?: number }> = [];

  // pass 1 — declarations
  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      const init = path.node.init;
      const line = path.node.loc?.start.line;

      // useRef
      if (t.isCallExpression(init) && t.isIdentifier(init.callee, { name: 'useRef' })) {
        const typed = !!(init as t.CallExpression & { typeParameters?: unknown; typeArguments?: unknown }).typeParameters
          || !!(init as t.CallExpression & { typeArguments?: unknown }).typeArguments;
        const nullInit = init.arguments.length === 1 && t.isNullLiteral(init.arguments[0]);
        if (typed || !nullInit) {
          v.push({
            code: 'SCROLL_REF_SHAPE', tier: 2, line,
            message: `Scroll refs must be declared exactly "const xRef = useRef(null);" (line ${line}) — no TypeScript generics, no initial value. The scroll system matches this exact shape; "useRef<HTMLDivElement>(null)" is invisible to it.`,
          });
        } else if (t.isIdentifier(path.node.id)) {
          refVars.add(path.node.id.name);
        }
        return;
      }

      // useScroll
      if (t.isCallExpression(init) && t.isIdentifier(init.callee, { name: 'useScroll' })) {
        if (!t.isObjectPattern(path.node.id)) {
          v.push({
            code: 'SCROLL_USESCROLL_SHAPE', tier: 2, line,
            message: `useScroll (line ${line}) must be destructured: "const { scrollYProgress } = useScroll(...)" (optionally aliased: "{ scrollYProgress: heroProgress }").`,
          });
          return;
        }
        for (const prop of path.node.id.properties) {
          if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key) || !SCROLL_KEYS.has(prop.key.name)) {
            v.push({
              code: 'SCROLL_USESCROLL_SHAPE', tier: 2, line,
              message: `useScroll (line ${line}) must destructure one of scrollYProgress/scrollXProgress/scrollY/scrollX.`,
            });
            continue;
          }
          const alias = t.isIdentifier(prop.value) ? prop.value.name : prop.key.name;
          motionVars.add(alias);
        }
        const arg = init.arguments[0];
        if (arg) {
          if (!t.isObjectExpression(arg)) {
            v.push({
              code: 'SCROLL_USESCROLL_SHAPE', tier: 2, line,
              message: `useScroll options (line ${line}) must be an inline object: useScroll({ target: xRef, offset: ['start end', 'end start'] }).`,
            });
          } else {
            for (const p of arg.properties) {
              if (!t.isObjectProperty(p) || !t.isIdentifier(p.key)) continue;
              if (p.key.name === 'target') {
                if (t.isIdentifier(p.value)) targetRefs.push({ name: p.value.name, line });
                else v.push({
                  code: 'SCROLL_USESCROLL_SHAPE', tier: 2, line,
                  message: `useScroll target (line ${line}) must be a ref variable (target: heroRef).`,
                });
              } else if (p.key.name === 'offset' && !t.isArrayExpression(p.value)) {
                v.push({
                  code: 'SCROLL_USESCROLL_SHAPE', tier: 2, line,
                  message: `useScroll offset (line ${line}) must be an inline array of two strings, e.g. offset: ['start end', 'end start'].`,
                });
              }
            }
          }
        }
        return;
      }

      // useTransform / useSpring (possibly nested)
      const call = t.isCallExpression(init) ? init : null;
      if (!call || !t.isIdentifier(path.node.id)) return;
      const name = path.node.id.name;
      const inner = unwrapSpring(call);

      if (inner && t.isIdentifier(inner.callee, { name: 'useTransform' })) {
        declaredTransforms.push({ name, line });
        motionVars.add(name);
        const [src, a1, a2] = inner.arguments;
        // source: a single motion variable, OR an array of them (the composed
        // form the builder writes when effects stack: useTransform([a, t], ([a, t]) => a * t))
        if (t.isIdentifier(src)) {
          sourceUsed.add(src.name);
        } else if (t.isArrayExpression(src) && src.elements.every((e) => t.isIdentifier(e))) {
          for (const e of src.elements) sourceUsed.add((e as t.Identifier).name);
        } else {
          v.push({
            code: 'SCROLL_TRANSFORM_SOURCE', tier: 2, line,
            message: `useTransform's first argument (line ${line}) must be a progress/motion VARIABLE (the destructured scrollYProgress or another transform) or an array of them — not an expression.`,
          });
        }
        const isCallback = t.isArrowFunctionExpression(a1) || t.isFunctionExpression(a1);
        if (!isCallback) {
          if (!t.isArrayExpression(a1)) {
            v.push({
              code: 'SCROLL_TRANSFORM_RANGES', tier: 2, line,
              message: `useTransform input range (line ${line}) must be an inline ARRAY literal, e.g. [0, 1] — the scroll editor reads the endpoints from it.`,
            });
          }
          const outOk = t.isArrayExpression(a2)
            || (t.isConditionalExpression(a2) && t.isArrayExpression(a2.consequent) && t.isArrayExpression(a2.alternate));
          if (a2 != null && !outOk) {
            v.push({
              code: 'SCROLL_TRANSFORM_RANGES', tier: 2, line,
              message: `useTransform output range (line ${line}) must be an inline ARRAY literal (e.g. [0, -80]) or a responsive ternary of two arrays.`,
            });
          }
        }
        return;
      }

      if (t.isIdentifier(call.callee, { name: 'useSpring' }) && t.isIdentifier(call.arguments[0])) {
        motionVars.add(name);
        sourceUsed.add((call.arguments[0] as t.Identifier).name);
        return;
      }

      // useMotionValue(x) — a raw motion value (composed-fx building block).
      // Recorded for expression detection; never flagged unbound (the imperative
      // animate() calls in handlers/effects consume it invisibly).
      if (t.isIdentifier(call.callee, { name: 'useMotionValue' })) {
        motionVars.add(name);
        return;
      }

      // useMotionTemplate`...`
      if (t.isTaggedTemplateExpression(path.node.init) && t.isIdentifier(path.node.init.tag, { name: 'useMotionTemplate' })) {
        motionVars.add(name);
        for (const e of path.node.init.quasi.expressions) {
          if (t.isIdentifier(e)) sourceUsed.add(e.name);
        }
      }
    },

    CallExpression(path: NodePath<t.CallExpression>) {
      // useMotionValueEvent(scrollVar, ...) — direction dialect consumes the var
      if (t.isIdentifier(path.node.callee, { name: 'useMotionValueEvent' }) && t.isIdentifier(path.node.arguments[0])) {
        sourceUsed.add((path.node.arguments[0] as t.Identifier).name);
      }
    },
  });

  // pass 2 — JSX attachments + style bindings
  const refAttachments = new Map<string, boolean>(); // refVar → has data-id on same tag
  const styleBound = new Set<string>();
  traverse(ast, {
    JSXElement(path: NodePath<t.JSXElement>) {
      const attrs = jsxAttrs(path.node.openingElement);
      const hasDataId = stringAttr(attrs, 'data-id') != null;
      const refAttr = attrs.find((a) => a.name.name === 'ref');
      if (refAttr && t.isJSXExpressionContainer(refAttr.value) && t.isIdentifier(refAttr.value.expression)) {
        refAttachments.set(refAttr.value.expression.name, hasDataId);
      }
      const styleAttr = attrs.find((a) => a.name.name === 'style');
      if (styleAttr && t.isJSXExpressionContainer(styleAttr.value) && t.isObjectExpression(styleAttr.value.expression)) {
        for (const prop of styleAttr.value.expression.properties) {
          if (!t.isObjectProperty(prop)) continue;
          if (t.isIdentifier(prop.value)) {
            styleBound.add(prop.value.name);
          } else if (containsIdentifierFrom(prop.value, motionVars)) {
            v.push({
              code: 'MOTION_VALUE_EXPRESSION', tier: 2, line: prop.loc?.start.line,
              message: `A motion value is used inside an expression in style (line ${prop.loc?.start.line}). Bindings must be BARE identifiers (style={{ y: heroY }}); to combine or scale values, create another useTransform/useMotionTemplate and bind that.`,
            });
          }
        }
      }
    },

    // IMPERATIVE ref attachment — the editor's On-Scroll text effect (and the
    // section-mode scroll-transform guard) never bind a JSX `ref=` attr; they
    // resolve the target in an effect:
    //   useEffect(() => { xTeRef.current = document.querySelector("[data-id='…']") || document.body; }, []);
    // A `<ref>.current = …querySelector("[data-id…]")…` assignment satisfies the
    // same contract (the selector IS the data-id link), so treat it as attached —
    // without this, every editor-generated On-Scroll text effect false-positives
    // SCROLL_TARGET_UNATTACHED when the file round-trips through an AI submit.
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      const { left, right } = path.node;
      if (
        !t.isMemberExpression(left) || !t.isIdentifier(left.object) ||
        !t.isIdentifier(left.property, { name: 'current' })
      ) return;
      let selectsDataId = false;
      t.traverseFast(right, (n) => {
        if (
          t.isCallExpression(n) && t.isMemberExpression(n.callee) &&
          t.isIdentifier(n.callee.property, { name: 'querySelector' }) &&
          n.arguments.length > 0 && t.isStringLiteral(n.arguments[0]) &&
          n.arguments[0].value.includes('data-id')
        ) selectsDataId = true;
      });
      if (selectsDataId && refAttachments.get(left.object.name) !== true) {
        refAttachments.set(left.object.name, true);
      }
    },
  });

  // reconcile
  for (const ref of targetRefs) {
    if (!refVars.has(ref.name)) {
      v.push({
        code: 'SCROLL_REF_SHAPE', tier: 2, line: ref.line,
        message: `useScroll target "${ref.name}" (line ${ref.line}) is not declared as "const ${ref.name} = useRef(null);" — declare it exactly that way.`,
      });
    } else if (refAttachments.get(ref.name) == null) {
      v.push({
        code: 'SCROLL_TARGET_UNATTACHED', tier: 2, line: ref.line,
        message: `useScroll target "${ref.name}" (line ${ref.line}) is never attached — add ref={${ref.name}} to the element being tracked (the SAME tag that carries its data-id).`,
      });
    } else if (refAttachments.get(ref.name) === false) {
      v.push({
        code: 'SCROLL_TARGET_UNATTACHED', tier: 2, line: ref.line,
        message: `The element carrying ref={${ref.name}} has no data-id — the ref and a data-id must sit on the same element or the scroll editor cannot find the node.`,
      });
    }
  }
  for (const tr of declaredTransforms) {
    if (!styleBound.has(tr.name) && !sourceUsed.has(tr.name)) {
      v.push({
        code: 'SCROLL_UNBOUND_VALUE', tier: 2, line: tr.line,
        message: `Motion value "${tr.name}" (line ${tr.line}) is declared but never bound — it animates nothing. Bind it on the target element: style={{ y: ${tr.name} }} (bare identifier), or remove it.`,
      });
    }
  }
}

export { checkScrollDialect };
