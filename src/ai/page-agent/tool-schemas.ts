// tool-schemas.ts — Gemini FunctionDeclaration[] for the page-agent.
//
// This is the AI's vocabulary for editing a page. The principle: every
// mutation tool is a thin wrapper over a `Mutation` variant from
// mutation-queue.ts — the SAME
// validated path the human UI drives. The AI never touches raw JSX structure,
// so it cannot break the opinionated file format (data-id invariants, inline
// style object shape, canvasNodes fragment, @canvas/@name JSDoc, import sync).
//
// `edit_file` is the one escape hatch — the AI's "open the Code Editor"
// equivalent — and the system prompt frames it as a last resort.
//
// Each schema name here MUST have a matching executor in tool-executors.ts.

/** Gemini function declaration shape (loose — the SDK accepts this). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

// ─── Read tools — the AI's eyes ─────────────────────────────────────────────

const READ_TOOLS: ToolSchema[] = [
  {
    name: 'get_node_tree',
    description:
      'Get the full element tree of the CURRENT page: every node with its id (data-id), tag, data-name, inline styles, text content, and child ids. Call this first to understand the page before editing. Cheap — call it again after mutations to see the updated tree.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'find_nodes',
    description:
      'Search the current page for nodes matching a filter. Use this instead of walking get_node_tree when you need "all elements with X". All filters are ANDed; omit a filter to ignore it.',
    parameters: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Exact HTML tag, e.g. "div", "p", "img", "section".' },
        nameContains: { type: 'string', description: 'Substring match against data-name (case-insensitive).' },
        textContains: { type: 'string', description: 'Substring match against text content (case-insensitive).' },
        hasStyleProp: { type: 'string', description: 'Only nodes that set this inline style property, e.g. "color", "backgroundColor".' },
      },
    },
  },
  {
    name: 'get_node_styles',
    description: 'Get the full inline style object and tag/name/text for a single node by its data-id.',
    parameters: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: 'The data-id of the node.' } },
      required: ['nodeId'],
    },
  },
  {
    name: 'list_files',
    description: 'List every file path in the project (pages, components, globals.css, etc.).',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_file',
    description:
      'Read the raw text content of a project file. Use this only when you need to understand bespoke code (a component\'s internals, globals.css). For editing page elements, prefer the structured tools.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Project-relative path, e.g. "components/Hero.tsx".' } },
      required: ['path'],
    },
  },
  {
    name: 'get_design_tokens',
    description: 'List the project\'s design tokens (CSS custom properties): name, value, category. These are referenced in styles as var(--name).',
    parameters: { type: 'object', properties: {} },
  },
];

// ─── Animation property schemas (shared by add_appear / add_hover / add_loop)
//
// Each `from` / `to` motion state, and each per-key keyframes entry, is
// declared here with an EXPLICIT type. Gemini sees a fully-typed
// JSON-Schema for every animatable property — so the model can't:
//   - send comma-separated strings for keyframes (schema demands array)
//   - send strings for opacity (schema demands number)
//   - send `repeat: null` (schema demands number, enum-validated kind)
//   - invent properties like `mediaQueries` (schema is closed set)
//   - send `"#fff"` with literal quote chars (string type passes raw value)
//
// The set mirrors `TRANSFORM_KEYS` + `ADDABLE_STYLE_ATOMS` from
// `editor/tools/AnimationTool/motion/MotionPropsEditor.tsx` — i.e. exactly
// what the human user can pick from the panel's "To" sheet.

const MOTION_STATE_PROPERTIES: Record<string, any> = {
  // ── Transform numbers (always-visible row in the editor's panel) ────────
  opacity:        { type: 'number', description: '0 (invisible) → 1 (fully visible).' },
  rotate:         { type: 'number', description: 'Z-axis rotation in degrees.' },
  rotateX:        { type: 'number', description: '3D X-axis rotation (deg).' },
  rotateY:        { type: 'number', description: '3D Y-axis rotation (deg).' },
  scale:          { type: 'number', description: 'Uniform scale. 1 = original, 1.05 = grow 5%.' },
  scaleX:         { type: 'number' },
  scaleY:         { type: 'number' },
  scaleZ:         { type: 'number' },
  skew:           { type: 'number', description: 'Skew degrees on both axes.' },
  skewX:          { type: 'number' },
  skewY:          { type: 'number' },
  x:              { type: 'number', description: 'Translate X in pixels.' },
  y:              { type: 'number', description: 'Translate Y in pixels.' },
  z:              { type: 'number', description: 'Translate Z in pixels (3D).' },
  xPercent:       { type: 'number', description: 'Translate X as percent of own width.' },
  yPercent:       { type: 'number', description: 'Translate Y as percent of own height.' },
  perspective:    { type: 'number', description: 'Perspective in pixels (parent of 3D children).' },
  transformStyle: { type: 'string', enum: ['flat', 'preserve-3d'], description: '"preserve-3d" enables 3D children.' },
  // ── Animatable style strings (the "Add Property" set in the editor) ─────
  backgroundColor: { type: 'string', description: 'CSS color, e.g. "#ff3366", "rgba(0,0,0,0.5)". Plain string, no quotes inside.' },
  color:           { type: 'string', description: 'Text color (CSS color).' },
  borderColor:     { type: 'string' },
  border:          { type: 'string', description: 'CSS border shorthand, e.g. "1px solid #fff".' },
  borderRadius:    { type: 'string', description: 'CSS border-radius, e.g. "8px", "50%".' },
  boxShadow:       { type: 'string', description: 'CSS box-shadow, e.g. "0 10px 30px rgba(0,0,0,0.3)".' },
  filter:          { type: 'string', description: 'CSS filter, e.g. "blur(10px)".' },
  clipPath:        { type: 'string', description: 'CSS clip-path, e.g. "circle(50%)".' },
  maskImage:       { type: 'string', description: 'CSS mask-image.' },
  padding:         { type: 'string', description: 'CSS padding shorthand.' },
  margin:          { type: 'string', description: 'CSS margin shorthand.' },
  overflow:        { type: 'string', enum: ['visible', 'hidden', 'scroll', 'auto'] },
};

// For loop keyframes: each property becomes an ARRAY of the underlying type.
// Numbers → `number[]`, strings → `string[]`, enums → `string[]`. Gemini
// must send `rotate: [0, 360]` — the comma-string hack is schema-violating.
const MOTION_KEYFRAMES_PROPERTIES: Record<string, any> = Object.fromEntries(
  Object.entries(MOTION_STATE_PROPERTIES).map(([k, spec]) => [k, {
    type: 'array',
    items: spec,
    description: `Keyframe sequence (2+ values). ${(spec as any).description ?? ''}`.trim(),
  }]),
);

const TRANSITION_PROPERTIES: Record<string, any> = {
  duration: { type: 'number', description: 'Seconds. e.g. 0.5, 2.' },
  delay:    { type: 'number', description: 'Seconds before the animation starts.' },
  ease: {
    type: 'string',
    enum: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'circIn', 'circOut', 'circInOut',
           'backIn', 'backOut', 'backInOut', 'anticipate'],
    description: 'motion built-in easing.',
  },
};

const LOOP_TRANSITION_PROPERTIES: Record<string, any> = {
  ...TRANSITION_PROPERTIES,
  repeatType: {
    type: 'string',
    enum: ['loop', 'reverse', 'mirror'],
    description: '"loop": restart, "reverse": forward+backward, "mirror": with reversed easing.',
  },
};

function buildAnimationToolSchemas(): ToolSchema[] {
  return [
    {
      name: 'add_appear',
      description:
        'Add a scroll-triggered "appear" animation. The element starts in `from` state and animates to `to` when it scrolls into view. Standard pattern: `from = { opacity: 0, y: 24 }`, `to = { opacity: 1, y: 0 }`. Writes `initial`, `whileInView`, and `transition` props. Auto-converts the element to motion.* and syncs imports.',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string', description: 'The data-id of the node.' },
          from: {
            type: 'object',
            properties: MOTION_STATE_PROPERTIES,
            description: 'Starting state (writes to `initial=`). Omit for an animate-only effect.',
          },
          to: {
            type: 'object',
            properties: MOTION_STATE_PROPERTIES,
            description: 'Visible state (writes to `whileInView=`). Required.',
          },
          transition: {
            type: 'object',
            properties: TRANSITION_PROPERTIES,
            description: 'Timing: duration, delay, ease.',
          },
        },
        required: ['nodeId', 'to'],
      },
    },
    {
      name: 'remove_appear',
      description: 'Remove the appear animation from a node (clears initial + whileInView).',
      parameters: {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
      },
    },
    {
      name: 'add_hover',
      description:
        'Add a hover effect. Element transitions to `to` while the user hovers (writes to `whileHover=`). Pattern: `to = { scale: 1.05 }` or `{ backgroundColor: "#ff3366" }`.',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          to: {
            type: 'object',
            properties: MOTION_STATE_PROPERTIES,
            description: 'State while hovered.',
          },
          transition: {
            type: 'object',
            properties: TRANSITION_PROPERTIES,
            description: 'Timing: duration, delay, ease. Defaults to a snappy 0.2s.',
          },
        },
        required: ['nodeId', 'to'],
      },
    },
    {
      name: 'remove_hover',
      description: 'Remove the hover animation from a node.',
      parameters: {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
      },
    },
    {
      name: 'add_loop',
      description:
        'Add an INFINITELY looping animation. Each property is a keyframe array — values play in sequence then restart forever. Examples: `{ rotate: [0, 360] }` for spin; `{ scale: [1, 1.1, 1], opacity: [0.4, 1, 0.4] }` for a pulse. Writes `animate=` with keyframes and `transition=` with `repeat: Infinity`.',
      parameters: {
        type: 'object',
        properties: {
          nodeId: { type: 'string' },
          keyframes: {
            type: 'object',
            properties: MOTION_KEYFRAMES_PROPERTIES,
            description: 'Each key is an ARRAY of 2+ keyframe values. Example: { rotate: [0, 360] }, { scale: [1, 1.1, 1] }.',
          },
          transition: {
            type: 'object',
            properties: LOOP_TRANSITION_PROPERTIES,
            description: 'duration is per cycle. ease: "linear" for smooth rotation, "easeInOut" for breathing. repeatType: "loop" restart, "reverse" yo-yo.',
          },
        },
        required: ['nodeId', 'keyframes'],
      },
    },
    {
      name: 'remove_loop',
      description: 'Remove the loop animation from a node (clears animate + transition).',
      parameters: {
        type: 'object',
        properties: { nodeId: { type: 'string' } },
        required: ['nodeId'],
      },
    },
  ];
}

// ─── Mutation tools — the AI's hands. Each wraps a Mutation variant. ─────────

const MUTATION_TOOLS: ToolSchema[] = [
  {
    name: 'update_node_styles',
    description:
      'Update inline CSS styles on a node. Property names are camelCase (backgroundColor, fontSize). An empty-string value REMOVES that property. Only pass the properties you want to change — others are left untouched.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The data-id of the node.' },
        styles: { type: 'object', description: 'camelCase CSS property -> value. Empty string removes the property.' },
      },
      required: ['nodeId', 'styles'],
    },
  },
  {
    name: 'update_node_text',
    description: 'Replace the text content of a node. Plain text or simple HTML.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The data-id of the node.' },
        text: { type: 'string', description: 'The new text content.' },
      },
      required: ['nodeId', 'text'],
    },
  },
  {
    name: 'add_node',
    description:
      'Insert a new element inside a parent. The new element gets a fresh unique data-id automatically (returned in the result). Use index to control insert position among the parent\'s children (omit = append).',
    parameters: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: 'The data-id of the parent element to insert into.' },
        nodeType: { type: 'string', description: 'HTML tag for the new element, e.g. "div", "section", "p", "img", "button".' },
        styles: { type: 'object', description: 'Initial inline styles (camelCase). Optional.' },
        name: { type: 'string', description: 'data-name (layers-panel display name). Optional.' },
        textContent: { type: 'string', description: 'Initial text content. Optional.' },
        attrs: { type: 'object', description: 'Initial HTML attributes (src, alt, href...). Optional.' },
        index: { type: 'number', description: 'Insert position among siblings. Omit to append.' },
      },
      required: ['parentId', 'nodeType'],
    },
  },
  {
    name: 'remove_node',
    description: 'Delete a node and all of its children.',
    parameters: {
      type: 'object',
      properties: { nodeId: { type: 'string', description: 'The data-id of the node to delete.' } },
      required: ['nodeId'],
    },
  },
  {
    name: 'move_node',
    description: 'Move a node into a different parent. Optionally set its insert position among the new siblings.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The data-id of the node to move.' },
        newParentId: { type: 'string', description: 'The data-id of the destination parent.' },
        index: { type: 'number', description: 'Insert position among the new parent\'s children. Omit to append.' },
      },
      required: ['nodeId', 'newParentId'],
    },
  },
  {
    name: 'reorder_node',
    description: 'Reorder a node within its CURRENT parent (change its position among siblings).',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The data-id of the node to reorder.' },
        parentId: { type: 'string', description: 'The data-id of its current parent.' },
        index: { type: 'number', description: 'New position among siblings (0-based).' },
      },
      required: ['nodeId', 'parentId', 'index'],
    },
  },
  {
    name: 'rename_node',
    description: 'Set the data-name of a node (its display name in the layers panel). Does not change the tag or id.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The data-id of the node.' },
        name: { type: 'string', description: 'The new display name.' },
      },
      required: ['nodeId', 'name'],
    },
  },
  {
    name: 'update_html_attrs',
    description: 'Update HTML attributes on a node (src, alt, href, aria-label, role, etc.). Empty-string value removes an attribute.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The data-id of the node.' },
        attrs: { type: 'object', description: 'attribute name -> value. Empty string removes the attribute.' },
      },
      required: ['nodeId', 'attrs'],
    },
  },
  {
    name: 'change_tag',
    description: 'Change the HTML tag of a node (e.g. div -> section). Updates both the opening and closing tag; keeps id, styles, children.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The data-id of the node.' },
        newTag: { type: 'string', description: 'The new HTML tag.' },
      },
      required: ['nodeId', 'newTag'],
    },
  },
  // ── Animation tools (typed) ──────────────────────────────────────────────
  // These three tools (add_appear / add_hover / add_loop) mirror the editor's
  // own Animation panel row-for-row. Every property is declared in the JSON
  // schema with a strict type — so Gemini CANNOT invent properties, send
  // comma-separated strings instead of arrays, send `repeat: null` instead of
  // a number, or wrap colors in extra quotes. The executor builds the right
  // motion-prop object server-side and routes through the SAME
  // `updateMotionProp` mutation the editor uses on every panel interaction.
  ...buildAnimationToolSchemas(),
  {
    name: 'add_preset_token',
    description:
      'Create a new design token (CSS custom property) in globals.css. After creating it you can reference it in styles as "var(--name)". Use this for "extract colors into presets"-style requests.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Token name WITHOUT the -- prefix, e.g. "brand-primary".' },
        value: { type: 'string', description: 'Token value, e.g. "#6366f1", "48px".' },
        category: {
          type: 'string',
          description: 'One of: color, typography, spacing, margin, radius, shadow, border, image, video, other.',
        },
        label: { type: 'string', description: 'Optional human-readable label.' },
      },
      required: ['name', 'value', 'category'],
    },
  },
  {
    name: 'update_preset_token',
    description: 'Change the value of an existing design token.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Token name WITHOUT the -- prefix.' },
        value: { type: 'string', description: 'The new value.' },
      },
      required: ['name', 'value'],
    },
  },
];

// ─── Escape hatch — last resort, for bespoke code only ──────────────────────

const ESCAPE_TOOLS: ToolSchema[] = [
  {
    name: 'edit_file',
    description:
      'LAST RESORT. Overwrite a whole file with new content. Only use this for bespoke code that no structured tool can express (custom component internals, globals.css edits). NEVER use it to edit page element structure or styles — the structured tools above are safer and preserve the canvas file format. Always pass the COMPLETE new file content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project-relative path. Created if missing.' },
        content: { type: 'string', description: 'The COMPLETE new file content. Not a diff.' },
      },
      required: ['path', 'content'],
    },
  },
];

// ─── Variant tools — DESIGN COMPONENT masters only ──────────────────────────
// A design component is a variant state machine. These edit the variant layer:
// the variant list, the connections that move between variants, and the
// per-variant style / text overrides. Sent ONLY when the active file is a
// component master (the agent client picks the tool set).

const VARIANT_TOOLS: ToolSchema[] = [
  {
    name: 'get_variants',
    description: 'List the design component\'s variants and the connections between them. Call this before adding/wiring variants.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_variant',
    description:
      'Add a new variant (visual state) to the component. The primary variant is always "default"; new variants get short ids like "annual", "hover". After adding a variant you MUST add a connection to reach it.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Variant id, e.g. "annual" — short, lowercase.' },
        label: { type: 'string', description: 'User-facing label, e.g. "Annual billing". Optional.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'remove_variant',
    description: 'Remove a variant and its per-variant overrides.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The variant id to remove.' } },
      required: ['name'],
    },
  },
  {
    name: 'add_connection',
    description:
      'Wire a transition between two variants. Without a connection a variant is unreachable. ' +
      'sourceNode scopes the trigger to a specific element (a tab button) — clicking THAT node ' +
      'fires the transition; omit it and the whole component root is the trigger. For a tab bar, ' +
      'always pass each tab button as sourceNode.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source variant id.' },
        to: { type: 'string', description: 'Target variant id.' },
        trigger: { type: 'string', description: 'click | clickStart | mouseEnter | mouseLeave | inView' },
        sourceNode: {
          type: 'string',
          description: 'Optional data-id of the element that triggers the transition (e.g. a tab button). Omit = the component root.',
        },
      },
      required: ['from', 'to', 'trigger'],
    },
  },
  {
    name: 'remove_connection',
    description: 'Remove the transition from one variant to another.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source variant id.' },
        to: { type: 'string', description: 'Target variant id.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'set_variant_style',
    description:
      'Set per-variant style overrides on a node — the style it takes ONLY in that variant. Base styles stay in update_node_styles. Per-variant POSITION uses left/top, never x/y.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The data-id of the node.' },
        variantName: { type: 'string', description: 'The variant id this override applies to.' },
        styles: { type: 'object', description: 'camelCase CSS property -> value, only the props that differ in this variant.' },
      },
      required: ['nodeId', 'variantName', 'styles'],
    },
  },
  {
    name: 'set_variant_text',
    description:
      'Set the text a node shows ONLY in a given variant (e.g. a price node showing "39" in the "annual" variant). The primary variant keeps the node\'s base text.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The data-id of the node.' },
        variantName: { type: 'string', description: 'The variant id this text applies to.' },
        text: { type: 'string', description: 'The text for this variant.' },
      },
      required: ['nodeId', 'variantName', 'text'],
    },
  },
];

/** The full tool surface sent to Gemini each turn (pages). */
export const PAGE_AGENT_TOOLS: ToolSchema[] = [
  ...READ_TOOLS,
  ...MUTATION_TOOLS,
  ...ESCAPE_TOOLS,
];

/** Tool surface for DESIGN COMPONENT masters — page tools + the variant layer. */
export const DESIGN_COMPONENT_TOOLS: ToolSchema[] = [
  ...READ_TOOLS,
  ...MUTATION_TOOLS,
  ...VARIANT_TOOLS,
  ...ESCAPE_TOOLS,
];

/** Tool names that mutate the project (vs read-only). Used for logging / UI. */
export const MUTATION_TOOL_NAMES = new Set<string>([
  ...MUTATION_TOOLS.map(t => t.name),
  ...VARIANT_TOOLS.filter(t => t.name !== 'get_variants').map(t => t.name),
  ...ESCAPE_TOOLS.map(t => t.name),
]);
