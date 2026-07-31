import { describe, it, expect, vi } from 'vitest';
import { transform } from '@babel/standalone';
import {
  findInstanceTag,
  removeInstanceProp,
  setResponsiveOverride,
  setResponsiveBindingOverride,
  setConditionalInstanceProp,
  stripPropFromAllInstancesInCode,
} from './instance-prop-overrides';

describe('stripPropFromAllInstancesInCode — cross-file "remove at source" cascade core', () => {
  it('strips a prop from EVERY instance of a component, keeps other props + other components', () => {
    const code = `function L(){ return <div>
      <KuWoCo data-id="a" padding={p} hide={hide} />
      <KuWoCo data-id="b" hide={true} data-name="X" />
      <Other data-id="c" hide={hide} />
    </div>; }`;
    const out = stripPropFromAllInstancesInCode(code, 'KuWoCo', 'hide');
    expect(out).not.toMatch(/<KuWoCo[^>]*hide=/);            // every KuWoCo lost hide
    expect(out).toMatch(/<KuWoCo data-id="a" padding=\{p\}/); // sibling props kept
    expect(out).toMatch(/<Other data-id="c" hide=\{hide\}/);  // a DIFFERENT component is untouched
  });
  it('no-op when no instance passes the prop', () => {
    const code = `function L(){ return <div><KuWoCo data-id="a" padding={p} /></div>; }`;
    expect(stripPropFromAllInstancesInCode(code, 'KuWoCo', 'hide')).toBe(code);
  });
  it('also prunes the prop out of per-viewport data-responsive (empties → whole attr removed)', () => {
    const code = `function L(){ return <div><KuWoCo data-id="a" hide={hide} data-responsive='{"375":{"hide":false},"768":{"hide":true},"_bp":[375,768,1440]}' padding={p} /></div>; }`;
    const out = stripPropFromAllInstancesInCode(code, 'KuWoCo', 'hide');
    expect(out).not.toMatch(/hide=/);              // both the attr AND the data-responsive hide entries gone
    expect(out).not.toMatch(/data-responsive/);    // nothing left in it → whole attr removed
    expect(out).toMatch(/padding=\{p\}/);          // other props survive
  });
  it('keeps data-responsive when OTHER per-viewport props remain', () => {
    const code = `function L(){ return <div><KuWoCo data-id="a" hide={hide} data-responsive='{"768":{"hide":true,"gap":"10px"},"_bp":[768,375]}' /></div>; }`;
    const out = stripPropFromAllInstancesInCode(code, 'KuWoCo', 'hide');
    expect(out).toMatch(/data-responsive='\{"768":\{"gap":"10px"\},"_bp":\[768,375\]\}'/);
    expect(out).not.toMatch(/"hide"/);
  });
});

// setResponsiveOverride reads the project's viewport widths for the `_bp` list.
vi.mock('@/code/stores/viewport-store', () => ({
  getViewportWidths: () => ({ desktop: 1440, tablet: 768, mobile: 375 }),
}));

// An icon-set instance: PascalCase tag, a `name` prop, AND a `data-name` attr —
// the regexes must target `name` without clobbering `data-name`.
const INSTANCE = `<PoSuTa data-id="vector-1" data-name="Group" name="icon-1" style={{ left: '4px' }} />`;
const parses = (jsx: string) =>
  expect(() => transform(`const x = (${jsx});`, { presets: ['react', 'typescript'], filename: 'f.tsx' })).not.toThrow();

describe('findInstanceTag', () => {
  it('locates the tag by data-id', () => {
    const tag = findInstanceTag(INSTANCE, 'vector-1', 'PoSuTa');
    expect(tag).not.toBeNull();
    expect(INSTANCE.slice(tag!.tagStart, tag!.tagEnd)).toContain('name="icon-1"');
  });
});

describe('setConditionalInstanceProp — per master variant', () => {
  it('writes a `name` ternary for a non-default variant, leaving data-name intact', () => {
    const out = setConditionalInstanceProp(INSTANCE, 'vector-1', 'PoSuTa', 'name', 'variant-1', 'icon-2');
    expect(out).toContain("name={initialVariant === 'variant-1' ? 'icon-2' : 'icon-1'}");
    expect(out).toContain('data-name="Group"'); // untouched
    parses(out);
  });

  it('uses `variant` as the discriminator when connections are wired', () => {
    const withConn = `const x = 0;\nconst y = useState(initialVariant);\n${INSTANCE}`;
    const out = setConditionalInstanceProp(withConn, 'vector-1', 'PoSuTa', 'name', 'variant-1', 'icon-2');
    expect(out).toContain("name={variant === 'variant-1' ? 'icon-2' : 'icon-1'}");
  });

  it('collapses to a plain name= when the default branch is updated (no overrides)', () => {
    const out = setConditionalInstanceProp(INSTANCE, 'vector-1', 'PoSuTa', 'name', 'default', 'icon-3');
    expect(out).toContain('name="icon-3"');
    expect(out).not.toContain('?'); // no ternary
    expect(out).toContain('data-name="Group"');
  });

  it('keeps existing per-variant overrides when the default changes', () => {
    let out = setConditionalInstanceProp(INSTANCE, 'vector-1', 'PoSuTa', 'name', 'variant-1', 'icon-2');
    out = setConditionalInstanceProp(out, 'vector-1', 'PoSuTa', 'name', 'default', 'icon-9');
    expect(out).toContain("name={initialVariant === 'variant-1' ? 'icon-2' : 'icon-9'}");
  });

  it('never deletes the name prop (default removeDefaultValue never equals an icon id)', () => {
    const out = setConditionalInstanceProp(INSTANCE, 'vector-1', 'PoSuTa', 'name', 'default', 'icon-1');
    expect(out).toContain('name="icon-1"');
  });
});

describe('setResponsiveOverride — per replica viewport', () => {
  it('writes a data-responsive `name` entry for the breakpoint', () => {
    const out = setResponsiveOverride(INSTANCE, 'vector-1', 'PoSuTa', 768, 'name', 'icon-2', 'icon-1');
    const m = out.match(/data-responsive='([^']*)'/);
    expect(m).not.toBeNull();
    const parsed = JSON.parse(m![1]);
    expect(parsed['768']).toEqual({ name: 'icon-2' });
    expect(parsed._bp).toEqual([375, 768, 1440]);
    expect(out).toContain('name="icon-1"'); // base name untouched
    parses(out);
  });

  it('clears the override (and the whole attr) when set back to the base value', () => {
    const withOv = setResponsiveOverride(INSTANCE, 'vector-1', 'PoSuTa', 768, 'name', 'icon-2', 'icon-1');
    const cleared = setResponsiveOverride(withOv, 'vector-1', 'PoSuTa', 768, 'name', 'icon-1', 'icon-1');
    expect(cleared).not.toContain('data-responsive');
    parses(cleared);
  });
});

// A component instance inside a .map() (Mechanism A): a CMS-bound prop +
// a `data-id`. The base binding `projectTitle={item.title}` lives elsewhere on
// the tag; here we only exercise the per-viewport data-responsive override.
const CARD = `<ProjectsCard data-id="card-1" projectTitle={item.title} gap="24" />`;

describe('setResponsiveBindingOverride — per-viewport CMS rebind', () => {
  it('rebinds a prop to a DIFFERENT field on one viewport (computed form, live item.field)', () => {
    const out = setResponsiveBindingOverride(CARD, 'card-1', 'ProjectsCard', 768, 'projectTitle', { kind: 'field', expr: 'item.shortTitle' });
    // Computed form so the live field-ref reaches withResponsiveProps per row.
    expect(out).toContain('data-responsive={JSON.stringify(');
    expect(out).toContain('"projectTitle":item.shortTitle');
    expect(out).toContain('"_bp":[375,768,1440]');
    expect(out).toContain('projectTitle={item.title}'); // base binding untouched
    parses(out);
  });

  it('unbind→default on one viewport = a quoted LITERAL override (all-literal → compact string form)', () => {
    // No field-ref present → stays the static string form; withResponsiveProps
    // merges the literal default on 375 while the base item.title shows elsewhere.
    const out = setResponsiveBindingOverride(CARD, 'card-1', 'ProjectsCard', 375, 'projectTitle', { kind: 'literal', value: 'Untitled' });
    expect(out).toContain("data-responsive='");
    expect(out).not.toContain('JSON.stringify');
    expect(JSON.parse(out.match(/data-responsive='([^']*)'/)![1])['375']).toEqual({ projectTitle: 'Untitled' });
    parses(out);
  });

  it('unbind→default COEXISTS with a field-ref → computed form keeps the literal quoted', () => {
    let out = setResponsiveBindingOverride(CARD, 'card-1', 'ProjectsCard', 768, 'projectTitle', { kind: 'field', expr: 'item.shortTitle' });
    out = setResponsiveBindingOverride(out, 'card-1', 'ProjectsCard', 375, 'projectTitle', { kind: 'literal', value: 'Untitled' });
    expect(out).toContain('data-responsive={JSON.stringify(');
    expect(out).toContain('"projectTitle":item.shortTitle'); // 768 field-ref
    expect(out).toContain('"projectTitle":"Untitled"');      // 375 literal stays quoted
    parses(out);
  });

  it('clear (reset override) removes that viewport entry / the whole attr', () => {
    const bound = setResponsiveBindingOverride(CARD, 'card-1', 'ProjectsCard', 768, 'projectTitle', { kind: 'field', expr: 'item.shortTitle' });
    const cleared = setResponsiveBindingOverride(bound, 'card-1', 'ProjectsCard', 768, 'projectTitle', { kind: 'clear' });
    expect(cleared).not.toContain('data-responsive');
    parses(cleared);
  });

  it('coexists with a static literal override in the SAME viewport entry', () => {
    // First a static prop override (gap) on 768 → string form…
    let out = setResponsiveOverride(CARD, 'card-1', 'ProjectsCard', 768, 'gap', '16', '24');
    expect(out).toContain("data-responsive='");
    // …then a CMS field-ref on the same viewport → upgrades to computed form, keeps both.
    out = setResponsiveBindingOverride(out, 'card-1', 'ProjectsCard', 768, 'projectTitle', { kind: 'field', expr: 'item.shortTitle' });
    expect(out).toContain('data-responsive={JSON.stringify(');
    expect(out).toContain('"gap":16');
    expect(out).toContain('"projectTitle":item.shortTitle');
    parses(out);
  });

  it('round-trips: a second override on the computed form preserves the existing field-ref', () => {
    let out = setResponsiveBindingOverride(CARD, 'card-1', 'ProjectsCard', 768, 'projectTitle', { kind: 'field', expr: 'item.shortTitle' });
    out = setResponsiveBindingOverride(out, 'card-1', 'ProjectsCard', 375, 'projectTitle', { kind: 'literal', value: 'Untitled' });
    expect(out).toContain('"projectTitle":item.shortTitle'); // 768 preserved
    expect(out).toContain('"projectTitle":"Untitled"');      // 375 added
    parses(out);
  });

  it('downgrades back to the static string form when the last field-ref is cleared', () => {
    let out = setResponsiveOverride(CARD, 'card-1', 'ProjectsCard', 768, 'gap', '16', '24');           // string
    out = setResponsiveBindingOverride(out, 'card-1', 'ProjectsCard', 768, 'projectTitle', { kind: 'field', expr: 'item.shortTitle' }); // computed
    out = setResponsiveBindingOverride(out, 'card-1', 'ProjectsCard', 768, 'projectTitle', { kind: 'clear' });                          // gap-only again
    expect(out).toContain("data-responsive='");          // back to string form
    expect(out).not.toContain('JSON.stringify');
    expect(out).toContain('"gap":16');
    parses(out);
  });
});

describe('removeInstanceProp', () => {
  it('removes `name` without touching `data-name`', () => {
    const out = removeInstanceProp(INSTANCE, 'vector-1', 'PoSuTa', 'name');
    expect(out).not.toContain('name="icon-1"');
    expect(out).toContain('data-name="Group"');
  });
});

// ── Prop VALUES hold nested objects — the delimiter must count depth ────────
// `\{[^}]*\}` stops at the FIRST `}`. On a cursor's opts (a transition object
// nested inside the opts object) that cut mid-value and left a stray `}}`,
// producing `<ZoGaCo}} key={idx}` — unparseable. Live find 2026-07-30; the
// original test fixture used a FLAT object, which is why it passed.
describe('removeInstanceProp — nested braces and > inside attr values', () => {
  const CURSOR_OPTS = '{{"mode":"follow","side":"bottom","align":"center","transition":{"type":"spring","stiffness":300,"damping":30}}}';

  it('removes a prop whose value contains a NESTED object, leaving no stray braces', () => {
    const code = `<div>{projects.map((item, idx) => (
  <ZoGaCo cursorOpts=${CURSOR_OPTS} cursor={JiViVu} key={idx} data-id="proj-row" title={item.title} />
))}</div>`;
    const out = removeInstanceProp(code, 'proj-row', 'ZoGaCo', 'cursorOpts');
    expect(out).not.toContain('cursorOpts');
    expect(out).not.toContain('}}}');                       // no orphaned closers
    expect(out).toContain('<ZoGaCo cursor={JiViVu} key={idx}'); // tag still well-formed
    expect(out).toContain('title={item.title}');
    // brace balance across the whole file is preserved
    expect((out.match(/\{/g) || []).length).toBe((out.match(/\}/g) || []).length);
  });

  it('removing BOTH cursor props in sequence leaves a valid tag', () => {
    const code = `<ZoGaCo cursorOpts=${CURSOR_OPTS} cursor={JiViVu} key={idx} data-id="row" title={item.title} />`;
    let out = removeInstanceProp(code, 'row', 'ZoGaCo', 'cursor');
    out = removeInstanceProp(out, 'row', 'ZoGaCo', 'cursorOpts');
    expect(out).toBe('<ZoGaCo key={idx} data-id="row" title={item.title} />');
  });

  it('stripping `cursor` does NOT touch `cursorOpts` (prefix collision)', () => {
    const code = `<ZoGaCo cursor={JiViVu} cursorOpts=${CURSOR_OPTS} data-id="row" />`;
    const out = removeInstanceProp(code, 'row', 'ZoGaCo', 'cursor');
    expect(out).toContain('cursorOpts=');
    expect(out).not.toMatch(/\scursor=/);
  });

  it('a `>` inside an attr value does not end the tag early', () => {
    const code = `<ZoGaCo onPick={(a) => a.id} cursorOpts=${CURSOR_OPTS} data-id="row" title="x" />`;
    const out = removeInstanceProp(code, 'row', 'ZoGaCo', 'cursorOpts');
    expect(out).toContain('onPick={(a) => a.id}');
    expect(out).toContain('title="x"');
    expect(out).not.toContain('cursorOpts');
  });

  it('leaves the file untouched when the value is unbalanced', () => {
    const code = `<ZoGaCo cursorOpts={{"a":1 data-id="row" />`;
    expect(removeInstanceProp(code, 'row', 'ZoGaCo', 'cursorOpts')).toBe(code);
  });
});


// ── The VERBATIM tag from the live project file ────────────────────────────
// Multi-line pretty-printed (babel had reformatted it), nested transition object,
// and a template-literal href. This exact input is what produced `<ZoGaCo}} key={idx}`.
describe('removeInstanceProp — verbatim live instance tag', () => {
  const REAL = `<ZoGaCo cursorOpts={{
          "mode": "follow",
          "side": "bottom",
          "align": "center",
          "transition": {
            "type": "spring",
            "stiffness": 300,
            "damping": 30
          }
        }} cursor={JiViVu} key={idx} data-id="proj-row" data-name="a" style={{
          position: 'relative',
          flex: '0 0 auto',
          order: '0',
          width: '100%'
        }} title={item.title} client={item.client} services={item.services} year={item.year} linkHref={\`/projects/\${item?._slug ?? ''}\`} />`;

  it('strips both cursor props and the result still parses as JSX', () => {
    let out = removeInstanceProp(REAL, 'proj-row', 'ZoGaCo', 'cursor');
    out = removeInstanceProp(out, 'proj-row', 'ZoGaCo', 'cursorOpts');
    expect(out).not.toContain('cursorOpts');
    expect(out).not.toMatch(/\scursor=/);
    expect(out).toContain('title={item.title}');
    expect(out).toContain('linkHref=');                    // template literal survived
    expect(out).toContain("width: '100%'");                // style object survived
    expect(() => transform(`const a = ${out};`, { presets: [['react', {}]] })).not.toThrow();
  });
});
