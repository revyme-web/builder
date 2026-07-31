// control-menu-items.test.ts — Locks down the "Remove" menu entry (labelled
// "Remove" until 2026-07-26):
//
//   • the "shorthand row sees longhand-only values" branch — without it,
//     padding / margin / borderRadius rows hid the entry whenever the user wrote
//     longhands (`paddingTop: 100px`) without ever setting the shorthand, even
//     though the row is visibly populated;
//   • PRIMARY-ONLY visibility — on a replica / non-default variant the entry was
//     a strict duplicate of "Reset Override" (both end in `updateStyle(prop,'')`,
//     which routes into that viewport's `@media` rule), and the worse copy of it.

import { describe, expect, it, vi } from 'vitest';
import { getOverrideMenuItems, getVariableMenuItems, fieldTypesForProperty, getCmsBindingMenuItems, getAllMenuItems, type MenuContext, type MenuItem } from './control-menu-items';
import type { FieldDefinition } from '@/shared/types';

function makeCtx(over: Partial<MenuContext> = {}): MenuContext {
  return {
    property: 'opacity',
    nodeId: 'node-1',
    value: '',
    hasVariable: false,
    variableRef: null,
    hasOverride: false,
    isComponentFile: false,
    isPrimary: true,
    isDefaultLocale: true,
    activeLocale: 'en',
    hasLocaleOverride: false,
    createVariable: () => {},
    removeVariable: () => {},
    updateStyle: vi.fn(),
    updateStyles: vi.fn(),
    ...over,
  };
}

describe('fieldTypesForProperty — type-matched CMS binding (same rule as variables)', () => {
  // Layout / structural props have no variable type → bind to NOTHING.
  it.each(['width', 'height', 'padding', 'margin', 'transform', 'fontFamily', 'textAlign', 'flexDirection', 'borderRadius'])(
    'returns an EMPTY set for layout prop %s (no Bind to Field)',
    (prop) => { expect(fieldTypesForProperty(prop).size).toBe(0); },
  );

  it('Hide (display) → boolean fields only', () => {
    expect([...fieldTypesForProperty('display')]).toEqual(['boolean']);
    expect([...fieldTypesForProperty('visibility')]).toEqual(['boolean']);
    expect([...fieldTypesForProperty('flexWrap')]).toEqual(['boolean']);
  });

  it('numeric controls → number fields only', () => {
    for (const p of ['opacity', 'fontSize', 'gap', 'order', 'zIndex', 'scale']) {
      expect([...fieldTypesForProperty(p)]).toEqual(['number']);
    }
  });

  it('color controls → color fields only', () => {
    expect([...fieldTypesForProperty('color')]).toEqual(['color']);
    expect([...fieldTypesForProperty('borderColor')]).toEqual(['color']);
    expect([...fieldTypesForProperty('fill')]).toEqual(['color']);
  });

  it('backgroundColor: frame allows color+image, text node allows color only', () => {
    expect(fieldTypesForProperty('backgroundColor', 'div')).toEqual(new Set(['color', 'image', 'file']));
    expect(fieldTypesForProperty('backgroundColor', 'p')).toEqual(new Set(['color']));
  });

  it('image props → image/file; href → link/url/text/slug; text content → display text', () => {
    expect(fieldTypesForProperty('backgroundImage')).toEqual(new Set(['image', 'file']));
    expect(fieldTypesForProperty('src')).toEqual(new Set(['image', 'file']));
    expect(fieldTypesForProperty('href')).toEqual(new Set(['link', 'url', 'text', 'slug']));
    expect(fieldTypesForProperty('textContent')).toEqual(new Set(['text', 'textarea', 'richtext', 'slug']));
  });
});

describe('getCmsBindingMenuItems — Bind to Field only for same-typed fields', () => {
  const textFields: FieldDefinition[] = [
    { id: 'name', name: 'name', type: 'text' } as FieldDefinition,
    { id: 'bio', name: 'bio', type: 'textarea' } as FieldDefinition,
  ];
  const cmsBinding: MenuContext['cmsBinding'] = {
    slug: 'advisors', itemVar: 'item',
    fields: textFields, currentField: null,
    bindToField: vi.fn(), unbindField: vi.fn(), nodeTag: 'div',
  };

  it('NO "Bind to Field" for height when the collection has only text fields', () => {
    const ctx = makeCtx({ property: 'height', cmsBinding });
    expect(getCmsBindingMenuItems(ctx).find(i => i.label === 'Bind to Field')).toBeUndefined();
  });

  it('NO "Bind to Field" for Hide (display) when there is no boolean field', () => {
    const ctx = makeCtx({ property: 'display', cmsBinding });
    expect(getCmsBindingMenuItems(ctx).find(i => i.label === 'Bind to Field')).toBeUndefined();
  });

  it('SHOWS "Bind to Field" with the text fields for textContent', () => {
    const ctx = makeCtx({ property: 'textContent', cmsBinding });
    const bind = getCmsBindingMenuItems(ctx).find(i => i.label === 'Bind to Field');
    expect(bind).toBeDefined();
    expect(bind!.submenuItems!.map(s => s.label)).toEqual(['name', 'bio']);
  });
});

describe('getOverrideMenuItems — Remove', () => {
  // PRIMARY-ONLY. On a replica / non-default variant "Remove" duplicated
  // "Reset Override": both end in `updateStyle(prop, '')`, and
  // `updateNodeStyles` routes a non-primary write into that viewport's `@media`
  // rule (variant object for a master), where an empty value deletes the line.
  // It was also the worse copy — no `forceRenderAfterExternalEdit` — and showed
  // even when the tile had NO override, since its gate is the RESOLVED value
  // inherited from primary: clicking it then deleted a line that didn't exist.
  // User decision 2026-07-26.
  it('HIDES Remove on a replica viewport (Reset Override owns it there)', () => {
    const items = getOverrideMenuItems(makeCtx({ property: 'opacity', value: '0.5', isPrimary: false }));
    expect(items.find(i => i.label === 'Remove')).toBeUndefined();
  });

  it('HIDES Remove on a non-default component variant', () => {
    const items = getOverrideMenuItems(makeCtx({
      property: 'opacity', value: '0.5', isPrimary: false, isComponentFile: true,
    }));
    expect(items.find(i => i.label === 'Remove')).toBeUndefined();
  });

  it('HIDES it on a replica even when the value lives in longhands', () => {
    const items = getOverrideMenuItems(makeCtx({
      property: 'padding', value: '', isPrimary: false,
      styles: { paddingTop: '100px' },
    }));
    expect(items.find(i => i.label === 'Remove')).toBeUndefined();
  });

  it('a replica still gets Reset Override when the tile HAS one', () => {
    const items = getOverrideMenuItems(makeCtx({
      property: 'opacity', value: '0.5', isPrimary: false, hasOverride: true,
    }));
    expect(items.find(i => i.label === 'Reset Override')).toBeDefined();
    expect(items.find(i => i.label === 'Remove')).toBeUndefined();
  });

  it('SHOWS Remove on the primary / default-variant tile', () => {
    const items = getOverrideMenuItems(makeCtx({ property: 'opacity', value: '0.5', isPrimary: true }));
    expect(items.find(i => i.label === 'Remove')).toBeDefined();
  });

  it('is labelled "Remove", never "Reset Style" (the old name read as "reset to a default")', () => {
    const labels = getOverrideMenuItems(makeCtx({ property: 'opacity', value: '0.5' })).map(i => i.label);
    expect(labels).toContain('Remove');
    expect(labels).not.toContain('Reset Style');
  });

  it('hides Remove when neither value nor longhand is set', () => {
    const items = getOverrideMenuItems(makeCtx({ property: 'opacity', value: '' }));
    expect(items.find(i => i.label === 'Remove')).toBeUndefined();
  });

  it('shows Remove for a non-shorthand property when the value is set', () => {
    const ctx = makeCtx({ property: 'opacity', value: '0.5' });
    const items = getOverrideMenuItems(ctx);
    const reset = items.find(i => i.label === 'Remove');
    expect(reset).toBeDefined();
    reset!.onClick();
    expect(ctx.updateStyle).toHaveBeenCalledWith('opacity', '');
  });

  it('shows Remove for padding when only longhands are set', () => {
    const ctx = makeCtx({
      property: 'padding',
      value: '',
      styles: { paddingTop: '100px', paddingRight: '0', paddingBottom: '0', paddingLeft: '0' },
    });
    const items = getOverrideMenuItems(ctx);
    const reset = items.find(i => i.label === 'Remove');
    expect(reset).toBeDefined();
  });

  it('clears the shorthand AND all longhands in one batch when reset is clicked', () => {
    const updateStyles = vi.fn();
    const ctx = makeCtx({
      property: 'padding',
      value: '',
      styles: { paddingTop: '100px' },
      updateStyles,
    });
    const reset = getOverrideMenuItems(ctx).find(i => i.label === 'Remove')!;
    reset.onClick();
    expect(updateStyles).toHaveBeenCalledWith({
      padding: '',
      paddingTop: '',
      paddingRight: '',
      paddingBottom: '',
      paddingLeft: '',
    });
  });

  it('falls back to single-property reset when updateStyles is not provided', () => {
    const updateStyle = vi.fn();
    const ctx = makeCtx({
      property: 'padding',
      value: '',
      styles: { paddingTop: '100px' },
      updateStyle,
      updateStyles: undefined,
    });
    const reset = getOverrideMenuItems(ctx).find(i => i.label === 'Remove')!;
    reset.onClick();
    expect(updateStyle).toHaveBeenCalledWith('padding', '');
  });

  it('clears all four longhands for margin', () => {
    const updateStyles = vi.fn();
    const ctx = makeCtx({
      property: 'margin',
      value: '',
      styles: { marginRight: '12px' },
      updateStyles,
    });
    getOverrideMenuItems(ctx).find(i => i.label === 'Remove')!.onClick();
    expect(updateStyles).toHaveBeenCalledWith({
      margin: '',
      marginTop: '',
      marginRight: '',
      marginBottom: '',
      marginLeft: '',
    });
  });

  it('clears the four corner radii for borderRadius', () => {
    const updateStyles = vi.fn();
    const ctx = makeCtx({
      property: 'borderRadius',
      value: '',
      styles: { borderTopLeftRadius: '8px' },
      updateStyles,
    });
    getOverrideMenuItems(ctx).find(i => i.label === 'Remove')!.onClick();
    expect(updateStyles).toHaveBeenCalledWith({
      borderRadius: '',
      borderTopLeftRadius: '',
      borderTopRightRadius: '',
      borderBottomLeftRadius: '',
      borderBottomRightRadius: '',
    });
  });

  it('clears top/right/bottom/left longhands for inset', () => {
    const updateStyles = vi.fn();
    const ctx = makeCtx({
      property: 'inset',
      value: '',
      styles: { top: '10px', bottom: '10px' },
      updateStyles,
    });
    getOverrideMenuItems(ctx).find(i => i.label === 'Remove')!.onClick();
    expect(updateStyles).toHaveBeenCalledWith({
      inset: '', top: '', right: '', bottom: '', left: '',
    });
  });

  it('does NOT show Remove for a shorthand row when no longhand is set and value is empty', () => {
    const items = getOverrideMenuItems(makeCtx({
      property: 'padding', value: '', styles: {},
    }));
    expect(items.find(i => i.label === 'Remove')).toBeUndefined();
  });
});

describe('getVariableMenuItems — component "Set Variable" submenu (bind to existing prop)', () => {
  it('offers existing same-style component variables to bind to', () => {
    const ctx = makeCtx({
      property: 'border',
      isComponentFile: true,
      hasVariable: false,
      isPrimary: true,
      componentVariables: [
        { name: 'azefazef', default: '79px solid #b63030' },
        { name: 'otherBorder', default: '2px dashed #000' },
      ],
    });
    const items = getVariableMenuItems(ctx);
    const setVar = items.find(i => i.label === 'Set Variable');
    expect(setVar).toBeDefined();
    expect(setVar!.submenuItems!.map(i => i.label)).toEqual(['azefazef', 'otherBorder']);
  });

  it('Set Variable submenu shows the DISPLAY LABEL, not the prop id — but still binds by id', () => {
    const createVariable = vi.fn();
    const ctx = makeCtx({
      property: 'border', isComponentFile: true, createVariable,
      componentVariables: [{ name: 'justify', default: 'center', label: 'Justify 1' }],
    });
    const setVar = getVariableMenuItems(ctx).find(i => i.label === 'Set Variable')!;
    expect(setVar.submenuItems!.map(i => i.label)).toEqual(['Justify 1']); // label, not "justify"
    setVar.submenuItems![0].onClick();
    expect(createVariable).toHaveBeenCalledWith('border', 'justify', 'center'); // binds by id
  });

  it('clicking a submenu entry binds via createVariable(property, name, default)', () => {
    const createVariable = vi.fn();
    const ctx = makeCtx({
      property: 'border', isComponentFile: true, createVariable,
      componentVariables: [{ name: 'azefazef', default: '79px solid #b63030' }],
    });
    const setVar = getVariableMenuItems(ctx).find(i => i.label === 'Set Variable')!;
    setVar.submenuItems![0].onClick();
    expect(createVariable).toHaveBeenCalledWith('border', 'azefazef', '79px solid #b63030');
  });

  it('hides the submenu when the property already has a binding', () => {
    const ctx = makeCtx({
      property: 'border', isComponentFile: true, hasVariable: true, variableRef: 'azefazef',
      componentVariables: [{ name: 'azefazef', default: '79px solid #b63030' }],
    });
    expect(getVariableMenuItems(ctx).find(i => i.label === 'Set Variable')).toBeUndefined();
  });

  it('does not show the component submenu on page files (those use pageVariables)', () => {
    const ctx = makeCtx({
      property: 'border', isComponentFile: false,
      componentVariables: [{ name: 'azefazef', default: '79px solid' }],
    });
    // No page variables provided → no Set Variable submenu from either branch.
    expect(getVariableMenuItems(ctx).find(i => i.label === 'Set Variable')).toBeUndefined();
  });
});

describe('getAllMenuItems — hideVariableMenu (Slug control shows only its OWN Set Variable)', () => {
  const extra: MenuItem[] = [{
    label: 'Set Variable', show: true, onClick: () => {},
    submenuItems: [{ label: 'This Row', show: true, onClick: () => {} }],
  }];
  const ctxWithVars = () => makeCtx({
    property: 'border', isComponentFile: true, hasVariable: false, isPrimary: true,
    componentVariables: [{ name: 'azefazef', default: '79px solid #b63030' }],
  } as Partial<MenuContext>);

  it('WITHOUT hideVariableMenu → BOTH the variable "Set Variable" and the extra (the duplicate bug)', () => {
    const items = getAllMenuItems(ctxWithVars(), extra, {});
    expect(items.filter(i => i.label === 'Set Variable')).toHaveLength(2);
  });

  it('WITH hideVariableMenu → only the extraMenuItems "Set Variable" (no duplicate)', () => {
    const items = getAllMenuItems(ctxWithVars(), extra, { hideVariableMenu: true, hideCmsBinding: true, hideResetStyle: true });
    const setVars = items.filter(i => i.label === 'Set Variable');
    expect(setVars).toHaveLength(1);
    expect(setVars[0].submenuItems!.map(s => s.label)).toEqual(['This Row']);
  });
});

describe('getVariableMenuItems — hideSet suppresses the generic Set Variable (auto-dedup)', () => {
  // A design-component instance prop control injects its OWN "Set Variable" (binds via setInstanceProp,
  // not the css-property style path). The generic one must be suppressed so it can't bind the wrong target.
  const ctx = () => makeCtx({
    property: 'display', isComponentFile: true, hasVariable: false,
    componentVariables: [{ name: 'hide', default: 'false', label: 'hidehoist' }],
  });
  it('shows the generic Set Variable by default', () => {
    expect(getVariableMenuItems(ctx()).some(i => i.label === 'Set Variable')).toBe(true);
  });
  it('hideSet:true → generic Set Variable removed (the injected one replaces it)', () => {
    expect(getVariableMenuItems(ctx(), { hideSet: true }).some(i => i.label === 'Set Variable')).toBe(false);
  });
  it('hideCreate does NOT remove Set Variable (Fill keeps existing-variable detection)', () => {
    expect(getVariableMenuItems(ctx(), { hideCreate: true }).some(i => i.label === 'Set Variable')).toBe(true);
  });
});
