// instant-create-variable.ts — the canonical "Create Variable" flow used by every control.
//
// standard: create the variable IMMEDIATELY with a unique auto-name (camelCase of the control's label),
// bind it to the property, then open the manage modal on it in EDIT mode (rename / edit default) — NO separate
// create FORM with a "Create Variable" confirm button. Drives the GLOBAL <VariableModalHost> via
// `variableModalRequestAtom` so a control re-rendering into its bound branch on create doesn't unmount the modal.
//
// ControlLabel (style props) and FillControl (Fill's Color/Gradient/Image submenu) both call this so the create
// UX is identical everywhere.

import { buildComponentRegistry, parseComponentInfoFromSource } from '@/code/components/component-registry';
import { projectFS } from '@/code/project/project-fs';
import { queueMutation, flushNow } from '@/code/mutation/mutation-queue';
import { trace } from '@/shared/debug-trace';

export interface VariableModalRequest {
  property: string;
  propertyLabel: string;
  currentValue: string;
  variableRef: string;
  nameEditable: boolean;
}

export interface InstantCreateOpts {
  /** CSS property (or synthetic property) the variable drives — `backgroundColor`, `background`, … */
  property: string;
  /** Human label for the control ("Color", "Gradient", "Fill") — seeds the auto-name + the @propMeta label. */
  propertyLabel: string;
  /** The default value to seed the variable with (the control's current resolved value). */
  value: string;
  /** Active component/template file (to read existing prop names for uniqueness). */
  activeFilePath: string;
  /** Page variables (folded into the taken-name set so a page var isn't re-emitted). */
  pageVariables: { name: string }[];
  /** Binds the new variable to `property` (the control's own create routine). */
  createVariable: (property: string, name: string, value: string) => void;
  /** Opens the global manage modal on the new variable in edit mode. */
  setVariableModalRequest: (req: VariableModalRequest) => void;
}

/** Create a variable with a unique auto-name, bind it, and open the manage modal on it in EDIT mode. */
export function instantCreateAndEditVariable(opts: InstantCreateOpts): void {
  const { property, propertyLabel, value, activeFilePath, pageVariables, createVariable, setVariableModalRequest } = opts;
  const base = (propertyLabel || property).replace(/[^a-zA-Z0-9]/g, '');
  const baseName = (base.charAt(0).toLowerCase() + base.slice(1)) || 'variable';

  // Existing prop names (registry → fall back to parsing the active file for templates/pages, which live
  // OUTSIDE `components/`) + page variables → uniqueness set, so the name generator never collides.
  const registry = buildComponentRegistry(projectFS);
  let props: { name: string; label?: string }[] = [];
  for (const info of registry.values()) { if (info.filePath === activeFilePath) { props = info.props; break; } }
  if (props.length === 0 && activeFilePath) {
    const code = projectFS.readFile(activeFilePath);
    if (code) { try { props = parseComponentInfoFromSource(activeFilePath, code, String(code.length))?.props ?? []; } catch { /* parse mid-type */ } }
  }
  const takenNames = new Set([...props.map((p) => p.name), ...pageVariables.map((v) => v.name)]);
  let name = baseName;
  for (let i = 1; takenNames.has(name); i++) name = `${baseName}${i}`;

  // Friendly display LABEL ("Color", "Color 2") — decoupled from the camelCase id.
  const takenLabels = new Set(props.map((p) => p.label || p.name));
  const baseLabel = propertyLabel || property;
  let displayLabel = baseLabel;
  for (let i = 2; takenLabels.has(displayLabel); i++) displayLabel = `${baseLabel} ${i}`;

  createVariable(property, name, value);
  queueMutation({ type: 'setComponentPropLabel', propName: name, label: displayLabel });
  // Flush synchronously so the variable exists in the registry BEFORE the modal opens (else it opens blank).
  flushNow();
  trace.action('instant-create-variable', { property, name, displayLabel });
  setVariableModalRequest({ property, propertyLabel, currentValue: value, variableRef: name, nameEditable: true });
}
