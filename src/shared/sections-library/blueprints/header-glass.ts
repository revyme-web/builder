import type { SectionBlueprint } from '../types';

// Glass pill nav — a floating rounded bar inside a padded wrapper (Wisp
// archetype): translucent fill + blur + one hairline highlight border +
// a single soft shadow, asymmetric padding so the dark pill CTA sits
// flush against the right edge. Thirds law keeps the links centered.
export const headerGlass: SectionBlueprint = {
  id: 'header-glass',
  name: 'Glass pill nav',
  category: 'header',
  description: 'Floating translucent pill bar with blur, hairline highlight and flush CTA.',
  fonts: ['Plus Jakarta Sans', 'Inter'],
  canvasSize: { width: '1280px', height: '96px' },
  source: `<div data-id="section-header-glass" data-name="Header — Glass" style={{
  position: 'relative', order: '0', flex: '0 0 auto',
  width: '100%', height: 'min-content', padding: '16px 72px',
  display: 'flex', flexDirection: 'column', justifyContent: 'flex-start'
}}>
  <div data-id="hgl-bar" data-name="Bar" style={{
    position: 'relative', order: '0', flex: '0 0 auto',
    width: '100%', height: 'min-content', padding: '10px 12px 10px 20px',
    backgroundColor: 'rgba(255, 255, 255, 0.55)', borderRadius: '34px',
    border: '1px solid rgba(255, 255, 255, 0.9)',
    backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    boxShadow: '0px 0.5px 5px 0px rgba(76, 76, 76, 0.10)',
    display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: '16px'
  }}>
    <div data-id="hgl-logo" data-name="Logo" style={{
      position: 'relative', order: '0', flex: '1 0 0px', height: 'min-content',
      display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: '9px'
    }}>
      <svg data-id="hgl-logo-mark" data-name="Mark" viewBox="0 0 22 22" preserveAspectRatio="none" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '22px', height: '22px', overflow: 'visible' }}>
        <svg data-id="hgl-logo-diamond" data-name="Diamond" x="0" y="0" width="22" height="22" viewBox="0 0 22 22" preserveAspectRatio="none" overflow="visible"><path data-id="hgl-logo-diamond-g0" fill="#14191F" d="M11 0 L22 11 L11 22 L0 11 Z" /></svg>
      </svg>
      <p data-id="hgl-logo-word" data-name="Northwind" style={{
        position: 'relative', order: '1', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: '#14191F', fontFamily: 'Plus Jakarta Sans, sans-serif', fontSize: '17px', fontWeight: '700', lineHeight: '1.2', letterSpacing: '-0.3px'
      }}>Northwind</p>
    </div>
    <div data-id="hgl-links" data-name="Links" style={{
      position: 'relative', order: '1', flex: '1 0 0px', height: 'min-content',
      display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: '28px'
    }}>
      <p data-id="hgl-link-product" data-name="Product" style={{
        position: 'relative', order: '0', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: '#14191F', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '500', lineHeight: '1.4'
      }}>Product</p>
      <p data-id="hgl-link-pricing" data-name="Pricing" style={{
        position: 'relative', order: '1', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: '#525866', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '500', lineHeight: '1.4'
      }}>Pricing</p>
      <p data-id="hgl-link-stories" data-name="Stories" style={{
        position: 'relative', order: '2', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: '#525866', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '500', lineHeight: '1.4'
      }}>Stories</p>
      <p data-id="hgl-link-support" data-name="Support" style={{
        position: 'relative', order: '3', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: '#525866', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '500', lineHeight: '1.4'
      }}>Support</p>
    </div>
    <div data-id="hgl-cta-zone" data-name="Actions" style={{
      position: 'relative', order: '2', flex: '1 0 0px', height: 'min-content',
      display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end'
    }}>
      <div data-id="hgl-cta" data-name="Get started" style={{
        position: 'relative', order: '0', flex: '0 0 auto',
        width: 'min-content', height: 'min-content', padding: '11px 20px',
        backgroundColor: '#14191F', borderRadius: '100px',
        display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center'
      }}>
        <p data-id="hgl-cta-label" data-name="Label" style={{
          position: 'relative', order: '0', flex: '0 0 auto',
          margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
          color: '#ffffff', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '500', lineHeight: '1.2'
        }}>Get started</p>
      </div>
    </div>
  </div>
</div>`,
};
