// agent/activity.ts — fold a run's raw tool calls into readable activity lines.
//
// A turn makes 20-40 tool calls. Rendering one row each produces a wall
// ("Reading source" x4, "Auditing design" x8, "Revyme Edit File") that says
// nothing about what happened to the user's website — the reader has to
// reverse-engineer intent from the agent's internal mechanics.
//
// So: collapse CONSECUTIVE calls of the same kind into ONE line phrased as an
// OUTCOME with a count — "Added 15 layers, edited 1", "Inspected 4 components".
// Reads are one line because the user does not care how many times the agent
// looked; writes carry counts because that is the change to their document.
// Screenshots always stand alone: the thumbnail IS the content.
//
// Pure and synchronous — no store, no React — so the phrasing is testable
// without a renderer.

/** What a step did, which decides how it is phrased and coloured. */
export type ActivityKind = 'read' | 'write' | 'view' | 'plan' | 'review';

export interface ActivityToolInput {
  id: string;
  name: string;
  ok: boolean | null;
  detail?: string;
  image?: string;
  /** How many things this ONE call touched — a batch of 15 adds is 15. Set at
   *  call time from the arguments so the raw args never have to be kept or
   *  persisted; `countFor` derives it. */
  count?: number;
  /** ms, for the trailing duration shown on each line. */
  ms?: number;
  /** What the model was thinking just before this call. Shown when its
   *  sub-step is expanded — the reason a step happened is the one thing the
   *  folded line genuinely cannot carry. Empty on engines that do not stream
   *  reasoning (the Claude CLI does not). */
  note?: string;
}

/** One call inside a folded step, shown when the step is expanded. */
export interface ActivitySubstep {
  label: string;
  ms: number;
  ok: boolean | null;
  note?: string;
}

export interface ActivityStep {
  kind: ActivityKind;
  /** The one line shown, already phrased: "Added 15 layers, edited 1". */
  label: string;
  /** Screenshots collected by this step, in call order. */
  images: string[];
  /** Humanized failure lines, deduped. Empty when everything landed. */
  failures: string[];
  /** True while the last call in the step has no result yet. */
  running: boolean;
  ms: number;
  /** How many tool calls folded in — drives the "show detail" affordance. */
  calls: number;
  /** The individual calls, each phrased on its own. Only worth showing when
   *  there is more than one; a step of one is already its own detail. */
  substeps: ActivitySubstep[];
}

interface Effect {
  kind: ActivityKind;
  /** Past-tense verb for a write. Writes tally by verb. */
  verb?: 'added' | 'edited' | 'deleted' | 'moved';
  /** What the tool acts on, singular. Writes default to "layer". */
  noun?: string;
}

/**
 * Per-tool phrasing. Only tools whose noun is NOT "layer" need an entry — the
 * prefix rules below cover the rest, including tools added later, so this table
 * cannot silently go stale the way an exhaustive list would.
 */
const EFFECTS: Record<string, Effect> = {
  get_screenshot: { kind: 'view' },
  audit_design: { kind: 'review' },
  verify_effect: { kind: 'review' },
  turn_diff: { kind: 'review' },
  submit_plan: { kind: 'plan' },
  submit_design_intent: { kind: 'plan' },

  // Reads, by what they look at.
  get_node_tree: { kind: 'read', noun: 'page' },
  get_selection: { kind: 'read', noun: 'selection' },
  list_pages: { kind: 'read', noun: 'page' },
  list_components: { kind: 'read', noun: 'component' },
  get_component: { kind: 'read', noun: 'component' },
  list_collections: { kind: 'read', noun: 'collection' },
  get_design_tokens: { kind: 'read', noun: 'design token' },
  get_dialect: { kind: 'read', noun: 'convention' },
  find_assets: { kind: 'read', noun: 'asset' },
  browse_marketplace: { kind: 'read', noun: 'template' },
  create_icon_set: { kind: 'write', verb: 'added', noun: 'icon set' },

  // Writes whose unit is not a layer.
  create_page: { kind: 'write', verb: 'added', noun: 'page' },
  create_component: { kind: 'write', verb: 'added', noun: 'component' },
  extract_component: { kind: 'write', verb: 'added', noun: 'component' },
  create_variant: { kind: 'write', verb: 'added', noun: 'variant' },
  set_variant: { kind: 'write', verb: 'edited', noun: 'variant' },
  set_token: { kind: 'write', verb: 'edited', noun: 'design token' },
  set_page_variable: { kind: 'write', verb: 'added', noun: 'variable' },
  bind_variable: { kind: 'write', verb: 'edited', noun: 'variable binding' },
  set_page_interaction: { kind: 'write', verb: 'added', noun: 'interaction' },
  set_motion_preset: { kind: 'write', verb: 'added', noun: 'animation' },
  create_overlay: { kind: 'write', verb: 'added', noun: 'overlay' },
  bind_cms_list: { kind: 'write', verb: 'edited', noun: 'collection binding' },
  bind_cms_field: { kind: 'write', verb: 'edited', noun: 'field binding' },
  set_form: { kind: 'write', verb: 'edited', noun: 'form' },
  set_page: { kind: 'read', noun: 'page' },

  // The CMS. Without these the `cms_` prefix defeats the verb-by-prefix rule
  // below and every call reads "Edited 1 layer" — about a collection.
  cms_get_collection: { kind: 'read', noun: 'collection' },
  cms_create_collection: { kind: 'write', verb: 'added', noun: 'collection' },
  cms_rename_collection: { kind: 'write', verb: 'edited', noun: 'collection' },
  cms_delete_collection: { kind: 'write', verb: 'deleted', noun: 'collection' },
  cms_add_field: { kind: 'write', verb: 'added', noun: 'field' },
  cms_update_field: { kind: 'write', verb: 'edited', noun: 'field' },
  cms_remove_field: { kind: 'write', verb: 'deleted', noun: 'field' },
  cms_add_items: { kind: 'write', verb: 'added', noun: 'item' },
  cms_update_item: { kind: 'write', verb: 'edited', noun: 'item' },
  cms_remove_item: { kind: 'write', verb: 'deleted', noun: 'item' },
  cms_set_item_translation: { kind: 'write', verb: 'edited', noun: 'translation' },
  // A manual is reading, not a change to the document.
  load_manual: { kind: 'read', noun: 'manual' },
  component_example: { kind: 'read', noun: 'example' },
  // `search_` is not a read prefix, so unlisted this read as a CHANGE.
  search_images: { kind: 'read', noun: 'image' },
  set_link: { kind: 'write', verb: 'edited', noun: 'link' },

  // Variants: which one shows, the transitions between them, their names.
  show_variant: { kind: 'write', verb: 'edited', noun: 'variant' },
  add_connection: { kind: 'write', verb: 'added', noun: 'transition' },
  remove_connection: { kind: 'write', verb: 'deleted', noun: 'transition' },
  rename_variant: { kind: 'write', verb: 'edited', noun: 'variant' },
  remove_variant: { kind: 'write', verb: 'deleted', noun: 'variant' },

  // Design tokens, typography presets, fonts.
  create_token: { kind: 'write', verb: 'added', noun: 'design token' },
  remove_token: { kind: 'write', verb: 'deleted', noun: 'design token' },
  set_dark_token: { kind: 'write', verb: 'edited', noun: 'design token' },
  set_typography_preset: { kind: 'write', verb: 'edited', noun: 'text style' },
  apply_typography_preset: { kind: 'write', verb: 'edited', noun: 'text style' },
  set_font: { kind: 'write', verb: 'edited', noun: 'font' },

  // Sizing, grid, transform, wrapping — all act on layers; the verb differs.
  wrap_in_layout: { kind: 'write', verb: 'added' },
  unfold_children: { kind: 'write', verb: 'deleted' },
  reorder_on_breakpoint: { kind: 'write', verb: 'moved' },

  // Collection lists and pages.
  set_list_config: { kind: 'write', verb: 'edited', noun: 'collection list' },
  set_pagination: { kind: 'write', verb: 'edited', noun: 'collection list' },
  link_rows_to_pages: { kind: 'write', verb: 'edited', noun: 'collection list' },
  create_collection_pages: { kind: 'write', verb: 'added', noun: 'page' },
  unbind_cms_field: { kind: 'write', verb: 'deleted', noun: 'field binding' },
  bind_cms_prop: { kind: 'write', verb: 'edited', noun: 'field binding' },
  cms_reorder_items: { kind: 'write', verb: 'moved', noun: 'item' },
  cms_reorder_fields: { kind: 'write', verb: 'moved', noun: 'field' },
  cms_duplicate_collection: { kind: 'write', verb: 'added', noun: 'collection' },
  delete_page: { kind: 'write', verb: 'deleted', noun: 'page' },
  rename_page: { kind: 'write', verb: 'edited', noun: 'page' },
  duplicate_page: { kind: 'write', verb: 'added', noun: 'page' },
  get_seo: { kind: 'read', noun: 'SEO setting' },
  set_page_metadata: { kind: 'write', verb: 'edited', noun: 'page setting' },
  set_site_metadata: { kind: 'write', verb: 'edited', noun: 'site setting' },

  // Motion.
  get_motion: { kind: 'read', noun: 'animation' },
  set_motion: { kind: 'write', verb: 'edited', noun: 'animation' },
  remove_motion: { kind: 'write', verb: 'deleted', noun: 'animation' },
  set_text_effect: { kind: 'write', verb: 'edited', noun: 'text effect' },

  // Localization.
  set_locales: { kind: 'write', verb: 'edited', noun: 'language' },
  list_texts: { kind: 'read', noun: 'text' },
  translate_texts: { kind: 'write', verb: 'edited', noun: 'translation' },
  add_language_switcher: { kind: 'write', verb: 'added', noun: 'language switcher' },

  // Built-in library.
  list_built_in_components: { kind: 'read', noun: 'component' },
  add_built_in_component: { kind: 'write', verb: 'added', noun: 'component' },

  // Masters and instances.
  set_variant_visibility: { kind: 'write', verb: 'edited', noun: 'variant' },
  detach_instance: { kind: 'write', verb: 'edited', noun: 'component instance' },
  add_component_prop: { kind: 'write', verb: 'added', noun: 'component prop' },

  // Text, states, forms, media, checks.
  set_text_on_breakpoint: { kind: 'write', verb: 'edited', noun: 'text' },
  set_text_fit: { kind: 'write', verb: 'edited', noun: 'text' },
  set_pseudo_style: { kind: 'write', verb: 'edited', noun: 'state style' },
  translate_attribute: { kind: 'write', verb: 'edited', noun: 'translation' },
  add_list_search: { kind: 'write', verb: 'added', noun: 'search field' },
  set_form_destination: { kind: 'write', verb: 'edited', noun: 'form' },
  add_form_field: { kind: 'write', verb: 'added', noun: 'form field' },
  add_submit_button: { kind: 'write', verb: 'added', noun: 'submit button' },
  set_background_video: { kind: 'write', verb: 'edited', noun: 'background video' },
  check_project: { kind: 'review' },

  // Site-level motion and templates.
  set_smooth_scroll: { kind: 'write', verb: 'edited', noun: 'scroll setting' },
  set_page_transition: { kind: 'write', verb: 'edited', noun: 'page transition' },
  set_cursor: { kind: 'write', verb: 'edited', noun: 'cursor' },
  set_glide: { kind: 'write', verb: 'edited', noun: 'animation' },
  list_templates: { kind: 'read', noun: 'template' },
  create_template: { kind: 'write', verb: 'added', noun: 'template' },
  assign_template: { kind: 'write', verb: 'edited', noun: 'template' },

  // Breakpoints, overrides, pins, list sources.
  list_viewports: { kind: 'read', noun: 'breakpoint' },
  add_viewport: { kind: 'write', verb: 'added', noun: 'breakpoint' },
  set_viewport_width: { kind: 'write', verb: 'edited', noun: 'breakpoint' },
  remove_viewport: { kind: 'write', verb: 'deleted', noun: 'breakpoint' },
  reset_overrides: { kind: 'write', verb: 'edited', noun: 'override' },
  pin_to_side: { kind: 'write', verb: 'edited' },
  change_list_source: { kind: 'write', verb: 'edited', noun: 'collection list' },
  add_shape: { kind: 'write', verb: 'added', noun: 'shape' },
  search_icons: { kind: 'read', noun: 'icon' },
  add_icon: { kind: 'write', verb: 'added', noun: 'icon' },
  // (create_icon_set is phrased above with the MCP tool of the same name.)
  write_override: { kind: 'write', verb: 'added', noun: 'code override' },
  set_code_overrides: { kind: 'write', verb: 'edited', noun: 'code override' },
  list_overrides: { kind: 'read', noun: 'code override' },
  list_sections: { kind: 'read', noun: 'section' },
  insert_section: { kind: 'write', verb: 'added', noun: 'section' },
  upload_image: { kind: 'write', verb: 'added', noun: 'image' },
  get_slots: { kind: 'read', noun: 'slot' },
  connect_slot: { kind: 'write', verb: 'edited', noun: 'slot' },
  disconnect_slot: { kind: 'write', verb: 'edited', noun: 'slot' },
  reorder_slot: { kind: 'write', verb: 'moved', noun: 'slot item' },
  list_plugins: { kind: 'read', noun: 'plugin' },
  write_plugin: { kind: 'write', verb: 'added', noun: 'plugin' },
  launch_plugin: { kind: 'view' },

  // Branches.
  list_branches: { kind: 'read', noun: 'branch' },
  create_branch: { kind: 'write', verb: 'added', noun: 'branch' },
  list_skills: { kind: 'read', noun: 'skill' },
  read_skill: { kind: 'read', noun: 'skill' },
  save_skill: { kind: 'write', verb: 'added', noun: 'skill' },
  add_icons_to_set: { kind: 'write', verb: 'added', noun: 'icon' },
  remove_icon_from_set: { kind: 'write', verb: 'deleted', noun: 'icon' },
  switch_branch: { kind: 'write', verb: 'moved', noun: 'branch' },
  review_branch: { kind: 'review' },
  apply_branch: { kind: 'write', verb: 'edited', noun: 'branch' },
  delete_branch: { kind: 'write', verb: 'deleted', noun: 'branch' },
};

/** Verb by prefix, for everything the table does not name explicitly. */
const WRITE_PREFIXES: [string, Effect['verb']][] = [
  ['add_', 'added'],
  ['create_', 'added'],
  ['duplicate_', 'added'],
  ['delete_', 'deleted'],
  ['remove_', 'deleted'],
  ['move_', 'moved'],
  ['reorder_', 'moved'],
];

const READ_PREFIXES = ['get_', 'list_', 'read_', 'audit_', 'verify_', 'find_', 'browse_', 'inspect_'];

/** How many verb clauses a folded label shows before it elides. Past three the
 *  line stops being scannable and the detail belongs in the expansion. */
const MAX_LABEL_PARTS = 3;

/**
 * MCP tools arrive fully qualified (`mcp__revyme__revyme_edit_file`) and used
 * to reach the UI as "Revyme Edit File" — the transport's name for itself,
 * which means nothing to someone looking at their website. Strip the wrapper
 * and classify the bare verb like any other tool.
 */
export function normalizeToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, '').replace(/^revyme_/, '');
}

function effectFor(rawName: string): Effect {
  const name = normalizeToolName(rawName);
  const known = EFFECTS[name];
  if (known) return known;
  for (const [prefix, verb] of WRITE_PREFIXES) {
    if (name.startsWith(prefix)) return { kind: 'write', verb };
  }
  if (READ_PREFIXES.some((p) => name.startsWith(p))) return { kind: 'read' };
  // set_/apply_/submit_/bind_/batch/chain and anything unrecognised: assume it
  // CHANGED something. Under-reporting a change is the worse error — the user
  // would see no line for work that altered their document.
  return { kind: 'write', verb: 'edited' };
}

/**
 * How many things one call touched. A batch of 15 adds is 15 layers, not one
 * "Running batch" — the bulk path is exactly where the count matters most.
 */
export function countFor(input: Record<string, unknown> | undefined): number {
  if (!input) return 1;
  for (const key of ['ops', 'steps', 'edits', 'nodes', 'items']) {
    const v = input[key];
    if (Array.isArray(v) && v.length > 0) return v.length;
  }
  return 1;
}

function plural(noun: string, n: number): string {
  if (n === 1) return noun;
  return noun.endsWith('s') ? noun : `${noun}s`;
}

/**
 * "Added 15 layers, edited 1" — the noun is stated ONCE.
 *
 * Repeating it ("added 15 layers, edited 1 layer") doubles the length of the
 * line for no information: the unit has not changed between clauses. Clauses
 * past MAX_LABEL_PARTS elide to "…" and live in the expansion instead, so a
 * busy step stays one scannable line.
 */
function phraseWrites(tally: Map<string, { verb: string; noun: string; n: number }>): string {
  const entries = [...tally.values()].sort((a, b) => b.n - a.n);
  if (entries.length === 0) return 'Made changes';
  const shown = entries.slice(0, MAX_LABEL_PARTS);
  const parts = shown.map(({ verb, noun, n }, i) => (
    // The first clause names the unit; the rest inherit it, unless they measure
    // something else entirely ("edited 2 variants" after "added 3 layers").
    i === 0 || noun !== shown[0].noun ? `${verb} ${n} ${plural(noun, n)}` : `${verb} ${n}`
  ));
  const [first, ...rest] = parts;
  const head = first.charAt(0).toUpperCase() + first.slice(1);
  const line = [head, ...rest].join(', ');
  return entries.length > MAX_LABEL_PARTS ? `${line}, \u2026` : line;
}

/** One call, phrased on its own for the expanded list. */
function phraseOne(t: ActivityToolInput): string {
  const eff = effectFor(t.name);
  if (eff.kind === 'view') return 'Viewed the canvas';
  if (eff.kind === 'plan') return 'Shared a plan';
  if (eff.kind === 'review') return 'Reviewed changes';
  if (eff.kind === 'read') return phraseReads(eff.noun ? [eff.noun] : [], 1);
  if (t.ok === false) return 'Adjusted an edit';
  const tally = new Map([['k', { verb: eff.verb ?? 'edited', noun: eff.noun ?? 'layer', n: t.count ?? 1 }]]);
  return phraseWrites(tally);
}

/**
 * Reads are deliberately vaguer than writes. The user does not need a tally of
 * everything the agent looked at — only that it looked, and roughly at what —
 * so a read group names its DOMINANT subject and stops.
 */
function phraseReads(nouns: string[], calls: number): string {
  const counts = new Map<string, number>();
  for (const n of nouns) counts.set(n, (counts.get(n) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return calls > 1 ? `Inspected ${calls} things` : 'Inspected the project';
  const [noun, n] = ranked[0];
  if (ranked.length === 1 && n === 1) return `Inspected the ${noun}`;
  return `Inspected ${n} ${plural(noun, n)}`;
}

/**
 * Fold a run's calls into activity lines.
 *
 * Consecutive calls of the same kind merge; a change of kind starts a new line,
 * so the transcript still reads as "looked → built → looked again" rather than
 * one undifferentiated blob. A `view` never merges: its thumbnails are the
 * point, and stacking several screenshots under one label loses which is which.
 */
export function foldActivity(tools: ActivityToolInput[]): ActivityStep[] {
  const steps: ActivityStep[] = [];
  let current: ActivityStep | null = null;
  let writes = new Map<string, { verb: string; noun: string; n: number }>();
  let reads: string[] = [];

  const seal = () => {
    if (!current) return;
    if (current.kind === 'write') current.label = phraseWrites(writes);
    else if (current.kind === 'read') current.label = phraseReads(reads, current.calls);
    // A step of ONE is already its own detail — expanding it would just repeat
    // the line, so it carries no sub-steps and renders without a chevron.
    if (current.substeps.length < 2) current.substeps = [];
    steps.push(current);
    current = null;
    writes = new Map();
    reads = [];
  };

  for (const t of tools) {
    const eff = effectFor(t.name);
    // A failed call changed nothing, so it must not be counted as a write —
    // "Added 3 layers" for three bounced edits is a lie the user cannot check.
    const landed = t.ok !== false;

    if (!current || current.kind !== eff.kind || eff.kind === 'view') {
      seal();
      current = {
        kind: eff.kind,
        label: eff.kind === 'view' ? 'Viewed the canvas'
          : eff.kind === 'plan' ? 'Shared a plan'
          : eff.kind === 'review' ? 'Reviewed changes' : '',
        images: [], failures: [], running: false, ms: 0, calls: 0, substeps: [],
      };
    }

    current.calls += 1;
    current.ms += t.ms ?? 0;
    current.substeps.push({ label: phraseOne(t), ms: t.ms ?? 0, ok: t.ok, note: t.note });
    current.running = t.ok === null;
    if (t.image) current.images.push(t.image);
    if (t.ok === false && t.detail && !current.failures.includes(t.detail)) {
      current.failures.push(t.detail);
    }

    if (eff.kind === 'write' && landed) {
      const verb = eff.verb ?? 'edited';
      const noun = eff.noun ?? 'layer';
      const key = `${verb}:${noun}`;
      const prev = writes.get(key);
      const n = t.count ?? 1;
      if (prev) prev.n += n;
      else writes.set(key, { verb, noun, n });
    } else if (eff.kind === 'read') {
      if (eff.noun) reads.push(eff.noun);
    }
  }
  seal();

  // A write group where every call failed has nothing to tally but still
  // happened — say the attempt was made rather than dropping the line.
  for (const s of steps) {
    if (s.kind === 'write' && s.label === 'Made changes' && s.failures.length > 0) {
      s.label = 'Adjusted an edit';
    }
  }
  return steps;
}
