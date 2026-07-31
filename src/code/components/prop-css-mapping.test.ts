import { describe, it, expect } from 'vitest';
import { localCssPropForVar, inferPropertyFromValue, resolveVariableCssProp, isVariableAppliedInCode, type ChildResolution } from './prop-css-mapping';

describe('localCssPropForVar — prop → cssProp resolution', () => {
  it('direct binding', () => {
    expect(localCssPropForVar('bg', `style={{ backgroundColor: bg }}`)).toBe('backgroundColor');
  });
  it('per-variant ternary (consequent) — radius variable', () => {
    expect(localCssPropForVar('zefzefze', `style={{ borderRadius: initialVariant === 'variant-1' ? zefzefze : '0' }}`)).toBe('borderRadius');
  });
  it('per-variant ternary (alternate branch)', () => {
    expect(localCssPropForVar('z', `style={{ opacity: variant === 'v' ? '1' : z }}`)).toBe('opacity');
  });
  it('does NOT false-match a CHAINED MotionConfig ternary consequent as a cssProp', () => {
    // chained per-variant transition — `… ? transition2 : variant === 'variant-1' ? transition1 …`. Neither var
    // is a STYLE binding, so cssProp must be '' (NOT the preceding consequent `transition2` / `transition`). This
    // is why the variable modal + instance editor kept the transition curve control instead of a raw input.
    const code = `<MotionConfig transition={variant === 'variant-2' ? transition2 : variant === 'variant-1' ? transition1 : transition}>`;
    expect(localCssPropForVar('transition1', code)).toBe('');
    expect(localCssPropForVar('transition2', code)).toBe('');
    expect(localCssPropForVar('transition', code)).toBe('');
  });
  it('overlay custom-property binding', () => {
    expect(localCssPropForVar('b', `style={{ "--b": b }}\n[data-id="x"]::after { border: var(--b); }`)).toBe('border');
  });
  it('overlay custom-property binding inside a per-variant ternary', () => {
    expect(localCssPropForVar('b', `style={{ "--b": initialVariant === 'v' ? b : 'none' }}\n[data-id="x"]::after { border: var(--b); }`)).toBe('border');
  });
  it('per-viewport __mq ternary → cssProp (both branches), with or without parens', () => {
    const t = `style={{ flex: '0 0 auto', transform: (__mq2 ? transform1 : transform) }}`;
    expect(localCssPropForVar('transform', t)).toBe('transform');   // base/else branch
    expect(localCssPropForVar('transform1', t)).toBe('transform');  // replica/then branch
    expect(localCssPropForVar('dir', `style={{ flexDirection: __mq1 ? dir : dirBase }}`)).toBe('flexDirection'); // no parens
  });
  it('no binding → empty', () => {
    expect(localCssPropForVar('zzz', `style={{ color: 'red' }}`)).toBe('');
    expect(localCssPropForVar('transform1', `style={{ width: '10px' }}`)).toBe(''); // no false key-match
  });
});

describe('resolveVariableCssProp — shared resolver (local + forwarded-into-child)', () => {
  it('local direct binding (no child resolver needed)', () => {
    expect(resolveVariableCssProp('bg', `style={{ backgroundColor: bg }}`)).toBe('backgroundColor');
  });
  it('local per-variant ternary', () => {
    expect(resolveVariableCssProp('j', `style={{ justifyContent: initialVariant === 'v' ? j : 'center' }}`)).toBe('justifyContent');
  });

  // The HOISTED case: the variable is forwarded into a child instance prop, and the child binds that
  // prop to a cssProp. e.g. a page var → `<YuKuZa direction={directionHoisted}/>` → YuKuZa's `direction`
  // → flexDirection. The shared resolver recurses via the injected `resolveChildCode`.
  it('forwarded into a child instance prop → child cssProp', () => {
    const parent = `import YuKuZa from '@/components/YuKuZa';
      <YuKuZa direction={directionHoisted} data-id="f1" />`;
    const child = `function YuKuZa({ direction = "column" }) {
      return <motion.div style={{ flexDirection: direction }} />; }`;
    const resolveChild = (tag: string): ChildResolution | null =>
      tag === 'YuKuZa' ? { code: child, filePath: 'components/YuKuZa.tsx' } : null;
    expect(resolveVariableCssProp('directionHoisted', parent, 'app/layout-client.tsx', resolveChild)).toBe('flexDirection');
  });

  it('forwarded via a per-viewport TERNARY consequent (and the base) → child cssProp', () => {
    const parent = `import YuKuZa from '@/components/YuKuZa';
      <YuKuZa direction={__mq2 ? direction345 : direction5hoisted} data-id="f1" />`;
    const child = `function YuKuZa({ direction = "column" }) { return <motion.div style={{ flexDirection: direction }} />; }`;
    const resolveChild = (tag: string): ChildResolution | null =>
      tag === 'YuKuZa' ? { code: child, filePath: 'components/YuKuZa.tsx' } : null;
    // BOTH the per-viewport branch var AND the base var resolve to the child's flexDirection.
    expect(resolveVariableCssProp('direction345', parent, 'x.tsx', resolveChild)).toBe('flexDirection');
    expect(resolveVariableCssProp('direction5hoisted', parent, 'x.tsx', resolveChild)).toBe('flexDirection');
    // a DIFFERENT name that only appears as a member (`foo.direction345`) must NOT false-match.
    expect(resolveVariableCssProp('direction34', parent, 'x.tsx', resolveChild)).toBe('');
  });

  it('multi-level forwarding resolves through two hops', () => {
    const a = `import B from '@/components/B';\n<B p={topVar} />`;
    const b = `import C from '@/components/C';\nfunction B({ p }) { return <C q={p} />; }`;
    const c = `function C({ q = "0" }) { return <div style={{ opacity: q }} />; }`;
    const map: Record<string, ChildResolution> = {
      B: { code: b, filePath: 'components/B.tsx' },
      C: { code: c, filePath: 'components/C.tsx' },
    };
    const resolveChild = (tag: string): ChildResolution | null => map[tag] ?? null;
    expect(resolveVariableCssProp('topVar', a, 'components/A.tsx', resolveChild)).toBe('opacity');
  });

  it('no child resolver → forwarded var stays unresolved (empty)', () => {
    const parent = `<YuKuZa direction={directionHoisted} />`;
    expect(resolveVariableCssProp('directionHoisted', parent, 'x.tsx')).toBe('');
  });
});

describe('inferPropertyFromValue — orphan-variable control fallback', () => {
  it('hex color → backgroundColor', () => {
    expect(inferPropertyFromValue('#c13b48')).toBe('backgroundColor');
    expect(inferPropertyFromValue('#fff')).toBe('backgroundColor');
  });
  it('rgb/hsl color → backgroundColor', () => {
    expect(inferPropertyFromValue('rgba(0,0,0,0.5)')).toBe('backgroundColor');
    expect(inferPropertyFromValue('hsl(200, 50%, 50%)')).toBe('backgroundColor');
  });
  it('border shorthand → border', () => {
    expect(inferPropertyFromValue('1px solid #000')).toBe('border');
    expect(inferPropertyFromValue('2px dashed red')).toBe('border');
  });
  it('shadow → boxShadow', () => {
    expect(inferPropertyFromValue('0px 4px 8px rgba(0,0,0,0.25)')).toBe('boxShadow');
  });
  it('CSS cursor keyword → cursor (web cursor variable)', () => {
    expect(inferPropertyFromValue('pointer')).toBe('cursor');
    expect(inferPropertyFromValue('grab')).toBe('cursor');
    expect(inferPropertyFromValue('not-allowed')).toBe('cursor');
    expect(inferPropertyFromValue('ew-resize')).toBe('cursor');
  });

  it('ambiguous dimension / generic keyword → empty (text fallback)', () => {
    expect(inferPropertyFromValue('12px')).toBe('');
    expect(inferPropertyFromValue('50%')).toBe('');
    expect(inferPropertyFromValue('')).toBe('');
    expect(inferPropertyFromValue('auto')).toBe('');   // too ambiguous to be cursor
  });
  it('border check beats shadow for a border value', () => {
    // "1px solid #000" has a style keyword → border, not boxShadow.
    expect(inferPropertyFromValue('1px solid #000000')).toBe('border');
  });
});

describe('isVariableAppliedInCode — hide created-but-unused variables (both tools)', () => {
  it('UNUSED variable (param default + @propMeta only) → false (the reported "content" bug)', () => {
    const code = `/** @propMeta {"content":{"type":"plainText","label":"Link 3 Color"}} */
function Header({ content = "AI Intelligence" }) {
  return <p style={{ color: '#fff' }}>AI Intelligence</p>;
}`;
    expect(isVariableAppliedInCode('content', code)).toBe(false);
  });

  it('every binding form → true', () => {
    expect(isVariableAppliedInCode('title', `<p>{title}</p>`)).toBe(true);                                   // text node
    expect(isVariableAppliedInCode('accent', `style={{ backgroundColor: accent }}`)).toBe(true);            // style value
    expect(isVariableAppliedInCode('color1', `style={{ color: color1, padding: '4px' }}`)).toBe(true);      // style value (mid-object)
    expect(isVariableAppliedInCode('cursorVar', `<Card someCursor={cursorVar} />`)).toBe(true);             // forwarded instance prop
    expect(isVariableAppliedInCode('transition11', `transition={variant === 'on' ? transition11 : undefined}`)).toBe(true); // per-variant ternary attr
    expect(isVariableAppliedInCode('color', `style={{ color: variant === "variant-6" ? color : "#000000" }}`)).toBe(true); // per-variant STYLE ternary, TRUE branch (the "Logo Color" bug)
    expect(isVariableAppliedInCode('color', `style={{ color: variant === "variant-6" ? "#000000" : color }}`)).toBe(true); // per-variant STYLE ternary, FALSE branch
    expect(isVariableAppliedInCode('myCursor', `{...withCursor(myCursor, {})}`)).toBe(true);                // cursor call arg
    expect(isVariableAppliedInCode('shadowV', `boxShadow: 'var(--shadowV)'`)).toBe(true);                   // CSS custom property
    expect(isVariableAppliedInCode('onCardClick', `onClick={() => setTimeout(onCardClick, 500)}`)).toBe(true); // delayed event call
  });

  it('does NOT false-match member access or a longer identifier', () => {
    expect(isVariableAppliedInCode('name', `<p>{item.name}</p>`)).toBe(false);   // CMS field, not the variable
    expect(isVariableAppliedInCode('name', `<p>{data?.name}</p>`)).toBe(false);  // optional chaining (?.) — member access, not the var (guards the new `? name` form)
    expect(isVariableAppliedInCode('color', `style={{ color: colorScheme }}`)).toBe(false); // longer ident
    expect(isVariableAppliedInCode('color', `style={{ color: '#fff' }}`)).toBe(false);      // literal value, not the var
  });

  it('a DESIGN TOKEN var(--color-white) does NOT count as using a variable named "color" (real template bug)', () => {
    // The hyphen in --color-white reads as a word boundary, so a bare `--color\b` wrongly matched it →
    // an orphan "Link 1 Color" (color) variable showed in the Template tool. The custom-property name must
    // not continue with a word char OR hyphen.
    expect(isVariableAppliedInCode('color', `style={{ backgroundColor: 'var(--color-white)' }}`)).toBe(false);
    expect(isVariableAppliedInCode('color', `color: 'var(--color-white-60)'`)).toBe(false);
    expect(isVariableAppliedInCode('shadowV', `boxShadow: 'var(--shadowV)'`)).toBe(true); // exact custom-prop still matches
  });

  it('does NOT match the param default, @propMeta key, or a template route map', () => {
    expect(isVariableAppliedInCode('content', `function F({ content = "AI Intelligence" }) {}`)).toBe(false);
    expect(isVariableAppliedInCode('content', `/** @propMeta {"content":{"type":"plainText"}} */`)).toBe(false);
    expect(isVariableAppliedInCode('content', `const __templateProps = {"/blog":{"content":"x"}};`)).toBe(false);
    expect(isVariableAppliedInCode('content', `content = __tp.content ?? content;`)).toBe(false);
  });
});
