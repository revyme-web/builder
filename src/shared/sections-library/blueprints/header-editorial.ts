import type { SectionBlueprint } from '../types';

// Editorial bar — dark full-width header on the thirds law: logo zone,
// optically-centered links, inverted white pill CTA. DNA: the approved
// marketplace corpus (Vantel/MAISON archetype) — no blur, no shadow, no
// border; the bar commits to its ground color and the pill carries all
// the contrast.
export const headerEditorial: SectionBlueprint = {
  id: 'header-editorial',
  name: 'Editorial bar',
  category: 'header',
  description: 'Dark full-width bar, optically centered links, inverted pill CTA.',
  fonts: ['Bricolage Grotesque', 'Inter'],
  canvasSize: { width: '1280px', height: '88px' },
  source: `<div data-id="section-header-editorial" data-name="Header — Editorial" style={{
  position: 'relative', order: '0', flex: '0 0 auto',
  width: '100%', height: 'min-content', backgroundColor: '#050505',
  display: 'flex', flexDirection: 'column', justifyContent: 'flex-start'
}}>
  <div data-id="hed-bar" data-name="Bar" style={{
    position: 'relative', order: '0', flex: '0 0 auto',
    width: '100%', height: '88px', padding: '0px 48px',
    display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: '16px'
  }}>
    <div data-id="hed-logo" data-name="Logo" style={{
      position: 'relative', order: '0', flex: '1 0 0px', height: 'min-content',
      display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: '10px'
    }}>
      <svg data-id="hed-logo-mark" data-name="Mark" viewBox="0 0 26 26" preserveAspectRatio="none" style={{ position: 'relative', order: '0', flex: '0 0 auto', width: '26px', height: '26px', overflow: 'visible' }}>
        <svg data-id="hed-logo-spark" data-name="Spark" x="3" y="3" width="20" height="20" viewBox="0 0 20 20" preserveAspectRatio="none" overflow="visible"><path data-id="hed-logo-spark-g0" fill="#ffffff" d="M10 0 L12.6 7.4 L20 10 L12.6 12.6 L10 20 L7.4 12.6 L0 10 L7.4 7.4 Z" /></svg>
      </svg>
      <p data-id="hed-logo-word" data-name="Atelier" style={{
        position: 'relative', order: '1', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: '#ffffff', fontFamily: 'Bricolage Grotesque, sans-serif', fontSize: '19px', fontWeight: '600', lineHeight: '1.2', letterSpacing: '-0.2px'
      }}>Atelier</p>
    </div>
    <div data-id="hed-links" data-name="Links" style={{
      position: 'relative', order: '1', flex: '1 0 0px', height: 'min-content',
      display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: '44px'
    }}>
      <p data-id="hed-link-work" data-name="Work" style={{
        position: 'relative', order: '0', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: '#ffffff', fontFamily: 'Inter, sans-serif', fontSize: '15px', fontWeight: '500', lineHeight: '1.2'
      }}>Work</p>
      <p data-id="hed-link-studio" data-name="Studio" style={{
        position: 'relative', order: '1', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: 'rgba(255, 255, 255, 0.62)', fontFamily: 'Inter, sans-serif', fontSize: '15px', fontWeight: '500', lineHeight: '1.2'
      }}>Studio</p>
      <p data-id="hed-link-journal" data-name="Journal" style={{
        position: 'relative', order: '2', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: 'rgba(255, 255, 255, 0.62)', fontFamily: 'Inter, sans-serif', fontSize: '15px', fontWeight: '500', lineHeight: '1.2'
      }}>Journal</p>
      <p data-id="hed-link-contact" data-name="Contact" style={{
        position: 'relative', order: '3', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: 'rgba(255, 255, 255, 0.62)', fontFamily: 'Inter, sans-serif', fontSize: '15px', fontWeight: '500', lineHeight: '1.2'
      }}>Contact</p>
    </div>
    <div data-id="hed-cta-zone" data-name="Actions" style={{
      position: 'relative', order: '2', flex: '1 0 0px', height: 'min-content',
      display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end'
    }}>
      <div data-id="hed-cta" data-name="Start a project" style={{
        position: 'relative', order: '0', flex: '0 0 auto',
        width: 'min-content', height: 'min-content', padding: '12px 22px',
        backgroundColor: '#ffffff', borderRadius: '999px',
        display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center'
      }}>
        <p data-id="hed-cta-label" data-name="Label" style={{
          position: 'relative', order: '0', flex: '0 0 auto',
          margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
          color: '#050505', fontFamily: 'Inter, sans-serif', fontSize: '15px', fontWeight: '600', lineHeight: '1.2'
        }}>Start a project</p>
      </div>
    </div>
  </div>
</div>`,
};
