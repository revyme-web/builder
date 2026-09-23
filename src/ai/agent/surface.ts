// surface.ts — WHERE the user is when they talk to the agent.
//
// There is ONE agent and ONE chat body (`AgentChat`), hosted by every AI panel
// in the editor: the canvas dock, the code-component editor, the CMS. What
// differs between them is not the agent — it is what the user is LOOKING AT,
// and therefore what "make it faster" or "add a date field" refers to.
//
// Before this, each panel had its own brain (a one-shot Gemini rewrite for code
// components, a separate tool loop for the CMS, the agent for pages): three
// prompts, three sets of capabilities, and a feature added to one — image
// paste, oracle feedback, undo as one step — missing from the others. The
// agent itself was only ever told `Editing: <the page underneath>`, so mounted
// inside the code-component editor it would have edited the page.
//
// SOFT FOCUS, by decision (2026-09-21): the surface says what a request is
// ABOUT by default, never what the agent is ALLOWED to touch. Inside the
// component editor, "now put it on the home page" still works. A hard fence
// per panel would just rebuild the separate brains with extra steps.

export type AgentSkillName = 'code-component' | 'cms' | 'plugin';

export type AgentSurface =
  | { kind: 'canvas'; filePath: string | null }
  | { kind: 'code-component'; filePath: string }
  /** The plugin editor (plugins/<Name>.tsx) — source + live preview. */
  | { kind: 'plugin'; filePath: string }
  /** An icon set (icons/<Set>.tsx) open on the canvas — its icons as cards. */
  | { kind: 'icon-set'; filePath: string }
  | { kind: 'cms'; collection: string | null; expandedItemId: string | null; focusedFieldId: string | null };

/** The editor state a surface is resolved from — plain values, so the rule is
 *  testable without atoms. */
export interface SurfaceState {
  activeFilePath: string | null;
  componentEditorFile: string | null;
  cmsOpen: boolean;
  cmsCollection: string | null;
  cmsExpandedItem: string | null;
  cmsFocusedField: string | null;
  /** The file the plugin editor has open, if it is open. */
  pluginEditorFile?: string | null;
}

/**
 * Which surface the user is on. Overlays win over what they cover, topmost
 * first: the code-component editor is a full-screen overlay and can be opened
 * FROM the CMS or the canvas, so it outranks both; the CMS covers the canvas.
 */
export function resolveAgentSurface(s: SurfaceState): AgentSurface {
  // The plugin editor, like the code-component editor, is a full-screen
  // overlay over everything else.
  if (s.pluginEditorFile) return { kind: 'plugin', filePath: s.pluginEditorFile };
  if (s.componentEditorFile) return { kind: 'code-component', filePath: s.componentEditorFile };
  if (s.cmsOpen) {
    return { kind: 'cms', collection: s.cmsCollection, expandedItemId: s.cmsExpandedItem, focusedFieldId: s.cmsFocusedField };
  }
  // An icon set is edited ON the canvas, but a bare "add a heart" there means
  // an icon in the set — not a node on a page.
  if (s.activeFilePath && /^icons\/[^/]+\.tsx$/.test(s.activeFilePath)) return { kind: 'icon-set', filePath: s.activeFilePath };
  return { kind: 'canvas', filePath: s.activeFilePath };
}

/** The manual the service attaches for a surface — the detailed rules for the
 *  kind of work that surface implies. The canvas needs none: its rules ARE the
 *  system prompt. */
export function skillForSurface(surface: AgentSurface): AgentSkillName | null {
  if (surface.kind === 'code-component') return 'code-component';
  if (surface.kind === 'cms') return 'cms';
  if (surface.kind === 'plugin') return 'plugin';
  return null;
}

/** What the request tells the service about the surface. Names only — the
 *  description itself travels in the context block. */
export function surfaceForRequest(surface: AgentSurface): { kind: AgentSurface['kind']; skill: AgentSkillName | null } {
  return { kind: surface.kind, skill: skillForSurface(surface) };
}

export interface CodeComponentFacts {
  /** `@label`, else the file's base name. */
  label: string;
  lines: number;
  controls: { key: string; type: string; label?: string }[];
  /** The values the preview is rendering with right now. */
  previewProps: Record<string, unknown>;
}

export interface PluginFacts {
  name: string;
  lines: number;
}

export interface IconSetFacts {
  name: string;
  icons: string[];
}

export interface CmsCollectionFacts {
  name: string;
  slug: string;
  fields: { id: string; name: string; type: string }[];
  itemCount: number;
  expandedItemTitle?: string | null;
  focusedFieldName?: string | null;
}

const PROPS_CAP = 600;
const FIELDS_CAP = 40;

function compactJson(value: unknown, cap: number): string {
  let s: string;
  try { s = JSON.stringify(value); } catch { return '{}'; }
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/**
 * The "Where the user is" section of the per-turn context block.
 *
 * Written as instructions about DEFAULTS ("unless they say otherwise"), which
 * is what makes the focus soft: the model is told what a bare request means
 * here, and is never told it cannot leave.
 */
export function describeSurface(
  surface: AgentSurface,
  facts: { codeComponent?: CodeComponentFacts | null; cms?: CmsCollectionFacts | null; plugin?: PluginFacts | null; iconSet?: IconSetFacts | null } = {},
): string {
  const lines = ['## Where the user is'];

  if (surface.kind === 'plugin') {
    const f = facts.plugin;
    lines.push(
      `The user has the PLUGIN EDITOR open on \`${surface.filePath}\`${f ? ` ("${f.name}", ${f.lines} lines)` : ''}: ` +
      'its source beside a live preview of the plugin panel — they are NOT looking at the page.',
    );
    lines.push(
      'A request here is about THIS plugin unless they say otherwise. Read it with `read_source` (same path) and write it with ' +
      '`write_plugin` (its name) — the whole file, checked on the way in; the editor shows it as soon as it lands, and ' +
      '`launch_plugin` runs it. Leave pages and other files alone unless the user asks for them.',
    );
    lines.push('The `plugin` manual is attached below — the SDK surface and the shape a plugin file must have.');
    return lines.join('\n');
  }

  if (surface.kind === 'icon-set') {
    const f = facts.iconSet;
    lines.push(
      `The user has the ICON SET \`${surface.filePath}\`${f ? ` ("${f.name}", ${f.icons.length} icon${f.icons.length === 1 ? '' : 's'}${f.icons.length ? `: ${f.icons.slice(0, 30).join(', ')}${f.icons.length > 30 ? ', …' : ''}` : ''})` : ''} open on the canvas — each icon is a card.`,
    );
    lines.push(
      'A request here is about THIS set unless they say otherwise: "add a heart" or "a set of 6 people icons" means new icons IN it — ' +
      '`search_icons` for real icons, then `add_icons_to_set` (by library name, or SVG you write); `remove_icon_from_set` takes one out; ' +
      'an icon\'s shapes and colours are ordinary nodes (`get_node_tree`, `set_styles`). Keep new icons in the set\'s existing style — stroke vs fill, weight, corner radius.',
    );
    return lines.join('\n');
  }

  if (surface.kind === 'code-component') {
    const f = facts.codeComponent;
    lines.push(
      `The user has the CODE COMPONENT EDITOR open on \`${surface.filePath}\`${f ? ` ("${f.label}", ${f.lines} lines)` : ''}. ` +
      'They see this file\'s source beside a live preview of it — they are NOT looking at the page.',
    );
    lines.push(
      `A request here is about THIS component unless they say otherwise. Read it with \`read_source\` (path \`${surface.filePath}\`) ` +
      `and change it with \`apply_file_edit\` (same path, kind "component") — the write is checked by the code-component oracle and ` +
      'the preview updates when it lands. Leave pages and other files alone unless the user asks for them.',
    );
    if (f && f.controls.length > 0) {
      lines.push(`Controls it exposes: ${f.controls.map((c) => `${c.key} (${c.type})`).join(', ')}.`);
    }
    if (f && Object.keys(f.previewProps).length > 0) {
      lines.push(`Preview is rendering with: ${compactJson(f.previewProps, PROPS_CAP)}`);
    }
    lines.push('The `code-component` manual is attached below — it is the contract this file must satisfy.');
    return lines.join('\n');
  }

  if (surface.kind === 'cms') {
    const f = facts.cms;
    if (!f) {
      lines.push(
        'The user has the CMS open with no collection selected. A request here is about collections and their content unless they say ' +
        'otherwise — `list_collections` to see what exists, `cms_create_collection` to start one.',
      );
    } else {
      lines.push(
        `The user has the CMS open on the collection "${f.name}" (slug \`${f.slug}\`): ${f.fields.length} field${f.fields.length === 1 ? '' : 's'}, ` +
        `${f.itemCount} item${f.itemCount === 1 ? '' : 's'}. They see its items and fields — they are NOT looking at the page.`,
      );
      const shown = f.fields.slice(0, FIELDS_CAP);
      if (shown.length > 0) {
        lines.push(
          `Fields (id · name · type): ${shown.map((x) => `${x.id} · ${x.name} · ${x.type}`).join('; ')}` +
          (f.fields.length > shown.length ? `; …${f.fields.length - shown.length} more (cms_get_collection)` : ''),
        );
      }
      if (f.expandedItemTitle) lines.push(`Open item: "${f.expandedItemTitle}"${f.focusedFieldName ? `, in the field "${f.focusedFieldName}"` : ''}.`);
      lines.push(
        'A request here is about THIS collection\'s schema and content unless they say otherwise. Use the `cms_*` tools; their ' +
        '`collection` argument defaults to this one. Designing the page that shows it is a separate job — do it only when asked.',
      );
    }
    lines.push('The `cms` manual is attached below.');
    return lines.join('\n');
  }

  lines.push(`The user is on the canvas, editing \`${surface.filePath ?? 'unknown'}\`.`);
  return lines.join('\n');
}

/** What the empty chat and its input say, per panel — the one place the ONE
 *  chat body admits it is hosted somewhere specific. */
export function surfaceCopy(kind: AgentSurface['kind']): { empty: string; placeholder: string } {
  if (kind === 'plugin') {
    return { empty: 'Describe a plugin or a change to this one — the agent knows the Revyme plugin SDK.', placeholder: 'Describe the plugin or a change…' };
  }
  if (kind === 'icon-set') {
    return { empty: 'Ask for icons for this set — e.g. "add 6 people icons in the same style".', placeholder: 'Describe the icons to add or change…' };
  }
  if (kind === 'code-component') {
    return { empty: 'Ask for a change to this component — a new control, a different effect, a bug to fix.', placeholder: 'Describe the change to this component…' };
  }
  if (kind === 'cms') {
    return { empty: 'Ask for a collection — its fields, its content, e.g. "create a 10-article blog".', placeholder: 'Describe the collection or content…' };
  }
  return { empty: 'Ask for a change to this page — a section, a restyle, a new component.', placeholder: 'Describe the change…' };
}
