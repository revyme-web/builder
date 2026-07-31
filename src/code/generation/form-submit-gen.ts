/**
 * form-submit-gen.ts — Submit button as a multi-variant component instance.
 *
 * Mirrors the CMS "Load More" mechanism (cms-pagination-gen.ts): a shared
 * design-component master is materialized once, and a form's plain
 * `<button type="submit">` is swapped for an instance of it. design-tool parity: the
 * master ships the FULL form-button variant set —
 *   default · default-hover · default-pressed · loading · disabled · success · error
 * — so the user can style each STATE on its own artboard. Which form lifecycle
 * state shows which variant is wired per-instance by the "Form State" tool
 * (form-state-gen.ts) via a `data-form-state` mapping + an `initialVariant`
 * ternary over the form's `formState<Id>` lifecycle var.
 *
 * Canvas-safe + deploy-correct: variant visibility uses standard variant style
 * objects (`animate={['default', variant]}`); hover/pressed via framer-motion
 * connections (the exact shape the editor's own parsers emit); the loading
 * spinner reuses `components/Spinner.tsx`. No deploy-time transform.
 */

import * as t from '@babel/types';
import { insertAfterLastImportLine } from './generator-utils';
import { trace } from '@/shared/debug-trace';
import { projectFS } from '../project/project-fs';
import { parseJSX, findFirstElementByDataId, findAttribute, getAttributeValue } from '../parsing/ast-utils';
import {
  SPINNER_COMPONENT_NAME,
  SPINNER_COMPONENT_PATH,
  buildSpinnerComponentCode,
} from './cms-pagination-gen';
import { setFormStateMappingInCode, DEFAULT_FORM_STATE_MAPPING } from './form-state-gen';

/** The shared "Form Submit" component master path + display/internal name. */
export const FORMSUBMIT_COMPONENT_NAME = 'FormSubmit';
const FORMSUBMIT_COMPONENT_PATH = 'components/FormSubmit.tsx';

/** Bump when the generated master shape changes (drives in-place upgrade). */
const FORMSUBMIT_GEN_TOKEN = '@formsubmit-gen v3';

/**
 * The deploy-correct multi-variant Form Submit COMPONENT master. A
 * `motion.button` (`type="submit"`, so a click inside the `<form>` fires the
 * form's onSubmit) with a Spinner slot + a label + per-state message texts.
 * Variant objects toggle which child shows per state; hover/pressed are wired
 * with connections (identical to the editor's own output).
 */
export function buildFormSubmitComponentCode(): string {
  return `'use client';

/** @name "Form Submit" */
/* ${FORMSUBMIT_GEN_TOKEN} */
import React, { useState, useEffect } from 'react';
import { motion, LayoutGroup } from 'framer-motion';
import { withResponsiveProps } from '@revyme/runtime';
import ${SPINNER_COMPONENT_NAME} from '@/components/Spinner';

const variantConfig = [
  { name: 'default', label: 'Default', x: 0, y: 0, isPrimary: true },
  { name: 'default-hover', label: 'Default - Hover', x: 320, y: 0, interactionType: 'hover', parentVariant: 'default' },
  { name: 'default-pressed', label: 'Default - Pressed', x: 320, y: 200, interactionType: 'pressed', parentVariant: 'default' },
  { name: 'loading', label: 'Loading', x: 640, y: 0 },
  { name: 'disabled', label: 'Disabled', x: 960, y: 0 },
  { name: 'success', label: 'Success', x: 1280, y: 0 },
  { name: 'error', label: 'Error', x: 1600, y: 0 },
];

const connections = [
  { from: 'default', to: 'default-hover', trigger: 'mouseEnter', sourceNode: 'formsubmit-root' },
  { from: 'default-hover', to: 'default', trigger: 'mouseLeave', sourceNode: 'formsubmit-root' },
  { from: 'default-hover', to: 'default-pressed', trigger: 'clickStart', sourceNode: 'formsubmit-root' },
  { from: 'default-pressed', to: 'default-hover', trigger: 'click', sourceNode: 'formsubmit-root' },
];

const rootVariants = {
  default: { backgroundColor: '#3b82f6', opacity: 1, pointerEvents: 'auto' },
  'default-hover': { backgroundColor: '#2563eb', opacity: 1, pointerEvents: 'auto' },
  'default-pressed': { backgroundColor: '#1d4ed8', opacity: 1, pointerEvents: 'auto' },
  'loading': { backgroundColor: '#3b82f6', opacity: 1, pointerEvents: 'none' },
  'disabled': { backgroundColor: '#9ca3af', opacity: 0.6, pointerEvents: 'none' },
  'success': { backgroundColor: '#22c55e', opacity: 1, pointerEvents: 'none' },
  'error': { backgroundColor: '#ef4444', opacity: 1, pointerEvents: 'none' },
};

const labelVariants = {
  default: { display: 'block' },
  'default-hover': { display: 'block' },
  'default-pressed': { display: 'block' },
  'loading': { display: 'none' },
  'disabled': { display: 'block' },
  'success': { display: 'none' },
  'error': { display: 'none' },
};

const spinnerWrapVariants = {
  default: { display: 'none' },
  'default-hover': { display: 'none' },
  'default-pressed': { display: 'none' },
  'loading': { display: 'flex' },
  'disabled': { display: 'none' },
  'success': { display: 'none' },
  'error': { display: 'none' },
};

const successTextVariants = {
  default: { display: 'none' },
  'default-hover': { display: 'none' },
  'default-pressed': { display: 'none' },
  'loading': { display: 'none' },
  'disabled': { display: 'none' },
  'success': { display: 'block' },
  'error': { display: 'none' },
};

const errorTextVariants = {
  default: { display: 'none' },
  'default-hover': { display: 'none' },
  'default-pressed': { display: 'none' },
  'loading': { display: 'none' },
  'disabled': { display: 'none' },
  'success': { display: 'none' },
  'error': { display: 'block' },
};

function ${FORMSUBMIT_COMPONENT_NAME}({ style, label = 'Submit', initialVariant = 'default', ...rest }: { style?: React.CSSProperties; label?: string; initialVariant?: string; [key: string]: any; }) {
  const [variant, setVariant] = useState(initialVariant);
  useEffect(() => { setVariant(initialVariant); }, [initialVariant]);
  return <LayoutGroup>
    <motion.button layout={true} data-id="formsubmit-root" {...rest} data-name="Submit" type="submit"
      variants={rootVariants} initial={['default', initialVariant]} animate={['default', variant]}
      onHoverStart={() => setVariant(variant === 'default' ? 'default-hover' : variant)}
      onHoverEnd={() => setVariant(variant === 'default-hover' ? 'default' : variant)}
      onTapStart={() => setVariant(variant === 'default-hover' ? 'default-pressed' : variant)}
      onTap={() => setVariant(variant === 'default-pressed' ? 'default-hover' : variant)}
      style={{
      position: 'relative',
      width: '200px',
      height: 'min-content',
      padding: '12px 24px',
      borderRadius: '8px',
      border: 'none',
      cursor: 'pointer',
      flex: '0 0 auto',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      ...style
    }}>
    <motion.div layout={true} data-id="formsubmit-spinner-wrap" data-name="Spinner Slot"
      variants={spinnerWrapVariants} initial={['default', initialVariant]} animate={['default', variant]} style={{
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        flex: '0 0 auto'
      }}>
      <${SPINNER_COMPONENT_NAME} data-id="formsubmit-spinner" />
    </motion.div>
    <motion.p layout={true} data-id="formsubmit-label" data-name="Text"
      variants={labelVariants} initial={['default', initialVariant]} animate={['default', variant]} style={{
        display: 'block',
        fontSize: '14px',
        color: '#ffffff',
        fontFamily: 'Inter, sans-serif',
        fontWeight: '600',
        lineHeight: '1.2',
        overflowWrap: 'break-word',
        position: 'relative',
        flex: '0 0 auto',
        margin: 0
      }}>
      {label}
    </motion.p>
    <motion.p layout={true} data-id="formsubmit-success" data-name="Success Text"
      variants={successTextVariants} initial={['default', initialVariant]} animate={['default', variant]} style={{
        display: 'none',
        fontSize: '14px',
        color: '#ffffff',
        fontFamily: 'Inter, sans-serif',
        fontWeight: '600',
        lineHeight: '1.2',
        position: 'relative',
        flex: '0 0 auto',
        margin: 0
      }}>
      Thank you
    </motion.p>
    <motion.p layout={true} data-id="formsubmit-error" data-name="Error Text"
      variants={errorTextVariants} initial={['default', initialVariant]} animate={['default', variant]} style={{
        display: 'none',
        fontSize: '14px',
        color: '#ffffff',
        fontFamily: 'Inter, sans-serif',
        fontWeight: '600',
        lineHeight: '1.2',
        position: 'relative',
        flex: '0 0 auto',
        margin: 0
      }}>
      Something went wrong
    </motion.p>
  </motion.button>
    </LayoutGroup>;
}

export default withResponsiveProps(${FORMSUBMIT_COMPONENT_NAME});
`;
}

/** Write the Form Submit master to ProjectFS (idempotent; upgrades old gens). */
export function ensureFormSubmitComponentFile(): void {
  const existing = projectFS.readFile(FORMSUBMIT_COMPONENT_PATH);
  // Ours = carries the formsubmit-root data-id. Re-generate when the gen token
  // changes (shape upgrade). A user-customized component (no formsubmit-root) is
  // left untouched.
  const isOldAutoGen = existing != null
    && existing.includes('data-id="formsubmit-root"')
    && !existing.includes(FORMSUBMIT_GEN_TOKEN);
  if (existing != null && !isOldAutoGen) return;
  projectFS.writeFile(FORMSUBMIT_COMPONENT_PATH, buildFormSubmitComponentCode());
  trace.action('form-submit-gen:ensureComponentFile', { path: FORMSUBMIT_COMPONENT_PATH, upgraded: isOldAutoGen });
}

/** Ensure the shared Spinner master exists too (FormSubmit imports it). */
export function ensureFormSubmitSpinnerFile(): void {
  if (projectFS.readFile(SPINNER_COMPONENT_PATH) != null) return;
  projectFS.writeFile(SPINNER_COMPONENT_PATH, buildSpinnerComponentCode());
  trace.action('form-submit-gen:ensureSpinnerFile', { path: SPINNER_COMPONENT_PATH });
}

const FORMSUBMIT_IMPORT = `import ${FORMSUBMIT_COMPONENT_NAME} from '@/components/FormSubmit';`;

/** Add `import FormSubmit from '@/components/FormSubmit'` after the last import. */
function ensureFormSubmitImport(code: string): string {
  if (code.includes(FORMSUBMIT_IMPORT)) return code;
  return insertAfterLastImportLine(code, FORMSUBMIT_IMPORT) ?? code;
}

/** Tag name of a JSX opening element (`button` / `motion.button` / `FormSubmit`). */
function tagNameOf(name: t.JSXOpeningElement['name']): string {
  if (t.isJSXIdentifier(name)) return name.name;
  if (t.isJSXMemberExpression(name) && t.isJSXIdentifier(name.object) && t.isJSXIdentifier(name.property)) {
    return `${name.object.name}.${name.property.name}`;
  }
  return '';
}

/** All trimmed text inside a JSX element subtree, joined (the button's label). */
function extractText(el: t.JSXElement): string {
  const parts: string[] = [];
  const visit = (node: t.Node) => {
    if (t.isJSXText(node)) {
      const trimmed = node.value.trim();
      if (trimmed) parts.push(trimmed);
    } else if (t.isJSXExpressionContainer(node) && t.isStringLiteral(node.expression)) {
      parts.push(node.expression.value);
    }
    if ('children' in node && Array.isArray((node as t.JSXElement).children)) {
      for (const c of (node as t.JSXElement).children) visit(c);
    }
  };
  for (const c of el.children) visit(c);
  return parts.join(' ').trim();
}

interface SubmitButton { start: number; end: number; dataId: string; label: string; }

/**
 * Replace the form's submit `<button>` with a `<FormSubmit>` instance, add its
 * import, seed the default Form State mapping (loading/success) + the form's
 * `formState<Id>` useState. Idempotent: skips when the form already contains a
 * `<FormSubmit>` or has no `<button>`. Prefers a `type="submit"` button.
 *
 * `opts.wireFormState` (default true) controls the lifecycle wiring. Set it
 * FALSE for a form dropped on the CANVAS (a `const canvasNodes = (<>…</>)`
 * fragment lives at module scope — it can't hold a `useState`), so the button
 * still becomes a component instance but renders its static `default` variant
 * with no state binding (no undefined-var reference).
 */
export function convertSubmitButtonInCode(
  code: string,
  formId: string,
  stateVar: string,
  opts: { wireFormState?: boolean } = {},
): string {
  const wireFormState = opts.wireFormState ?? true;
  const ast = parseJSX(code);
  if (!ast) return code;

  let chosen: SubmitButton | null = null;
  let alreadyConverted = false;

  findFirstElementByDataId(ast, formId, (formPath) => {
    formPath.traverse({
      JSXElement(p: any) {
        const node = p.node as t.JSXElement;
        const name = tagNameOf(node.openingElement.name);
        if (name === FORMSUBMIT_COMPONENT_NAME) { alreadyConverted = true; return; }
        if (name !== 'button' && name !== 'motion.button') return;
        if (node.start == null || node.end == null) return;
        const idAttr = findAttribute(node.openingElement, 'data-id');
        const dataId = (idAttr && getAttributeValue(idAttr)) || `submit-${formId}`;
        const typeAttr = findAttribute(node.openingElement, 'type');
        const isSubmit = typeAttr ? getAttributeValue(typeAttr) === 'submit' : false;
        const cand: SubmitButton = { start: node.start, end: node.end, dataId, label: extractText(node) || 'Submit' };
        // Keep the first button; upgrade to a type="submit" one if found.
        if (!chosen || isSubmit) chosen = cand;
      },
    });
  });

  if (alreadyConverted || !chosen) {
    trace.action('form-submit-gen:convert-skip', { formId, reason: alreadyConverted ? 'already-converted' : 'no-button' });
    return code;
  }
  // Narrow: TS loses the assignment made inside the traverse callback.
  const btn: SubmitButton = chosen;

  // The instance fills the form column (`width: 100%`) — the master root's own
  // 200px is just its standalone default; inside a form the button stretches.
  const repl = `<${FORMSUBMIT_COMPONENT_NAME} data-id="${btn.dataId}" data-name="Submit" label={${JSON.stringify(btn.label)}} style={{ width: "100%" }} />`;
  let next = code.slice(0, btn.start) + repl + code.slice(btn.end);
  next = ensureFormSubmitImport(next);
  // Seed the default state→variant mapping + the lifecycle useState — only when
  // the form lives inside a component function (a page/template/component). A
  // canvas-node form is module-scope JSX with no place for a useState, so it
  // stays a static instance (default variant).
  if (wireFormState) {
    next = setFormStateMappingInCode(next, btn.dataId, stateVar, DEFAULT_FORM_STATE_MAPPING);
  }
  trace.action('form-submit-gen:converted', { formId, dataId: btn.dataId, label: btn.label, stateVar, wireFormState });
  return next;
}
