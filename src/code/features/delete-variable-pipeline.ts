// delete-variable-pipeline.ts — the COMPLETE single-file variable delete, extracted from the
// mutation queue's `deleteComponentVariable` case so the cross-file cascade
// (`cascade-delete-variable.ts`) applies the IDENTICAL cleanup to every file it walks.
//
// One call erases a variable from ONE file everywhere it can live:
//   1. scroll-variant resting-var refs (`fromVar`) — cleared FIRST so the regenerated
//      useState/handlers don't reference the soon-to-be-deleted identifier
//   2. the function param + every reference (style values, instance-prop exprs, `{name}`
//      text children, withCursor spreads) — inlined to the default literal
//   3. the `@propMeta` entry (type / description / options / label)
//   4. a template's `__templateProps` per-route values (base + `name@<width>` overrides)
//   5. the `@pageVariables` JSON entry (the Variables modal's source of truth)
// Steps 4–5 are no-ops for pure components; 1–3 are no-ops for plain page variables.
// Pure string → string; callers own queueing/writes.

import { deleteComponentVariableInCode } from './variable-ops';
import { removePageVariableInCode } from './page-variables';
import { setPropDescriptionInCode, setPropTypeInCode, setPropOptionsInCode, setPropLabelInCode } from '../components/prop-meta';
import { removeTemplateVarFromCode } from '../generation/template-route-gen';
import { removeScrollVariantFromVarRefs } from '../generation/scroll-variant-gen';
import { trace } from '@/shared/debug-trace';

export function applyDeleteVariablePipeline(code: string, propName: string, defaultValue?: string): string {
  let c = removeScrollVariantFromVarRefs(code, propName);
  c = deleteComponentVariableInCode(c, propName, defaultValue);
  c = setPropTypeInCode(c, propName, '');
  c = setPropDescriptionInCode(c, propName, '');
  c = setPropOptionsInCode(c, propName, []);
  c = setPropLabelInCode(c, propName, ''); // clearing the label prunes a now-empty @propMeta entry
  c = removeTemplateVarFromCode(c, propName);
  c = removePageVariableInCode(c, propName);
  trace.action('delete-variable-pipeline:apply', { propName, changed: c !== code });
  return c;
}
