import type { SectionBlueprint } from '../types';

// Editorial photo hero — bottom-anchored content over a full-bleed image
// with a HORIZONTAL scrim protecting the type column (Vantel/MAISON
// archetype). Asymmetric two-column baseline pairing: giant display
// wordmark + stats on the left, one quiet sentence on the right. No
// buttons — the corpus's strongest heroes let the type carry the ask.
export const heroEditorial: SectionBlueprint = {
  id: 'hero-editorial',
  name: 'Editorial photo hero',
  category: 'hero',
  description: 'Bottom-anchored display type over a full-bleed photo with a horizontal scrim.',
  fonts: ['Bricolage Grotesque', 'Inter'],
  canvasSize: { width: '1280px', height: '820px' },
  source: `<div data-id="section-hero-editorial" data-name="Hero — Editorial" style={{
  position: 'relative', order: '0', flex: '0 0 auto',
  width: '100%', height: '100vh', minHeight: '720px', overflow: 'hidden',
  backgroundColor: '#050505',
  display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
  padding: '0px 46px 84px 46px'
}}>
  <div data-id="hfr-backdrop" data-name="Backdrop" data-pinned="true" style={{
    position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%',
    backgroundImage: 'url(https://images.unsplash.com/photo-1487958449943-2429e8be8625?auto=format&fit=crop&w=1800&q=80)',
    backgroundSize: 'cover', backgroundPosition: '62% center'
  }}></div>
  <div data-id="hfr-scrim" data-name="Scrim" data-pinned="true" style={{
    position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%',
    background: 'linear-gradient(90deg, rgba(5, 5, 5, 0.92) 0%, rgba(5, 5, 5, 0.55) 48%, rgba(5, 5, 5, 0.12) 100%)'
  }}></div>
  <div data-id="hfr-content" data-name="Content" style={{
    position: 'relative', order: '0', flex: '0 0 auto',
    width: '100%', height: 'min-content',
    display: 'flex', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: '48px', flexWrap: 'wrap'
  }}>
    <div data-id="hfr-main" data-name="Main" style={{
      position: 'relative', order: '0', flex: '1 0 0px', height: 'min-content',
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start'
    }}>
      <p data-id="hfr-eyebrow" data-name="Eyebrow" style={{
        position: 'relative', order: '0', flex: '0 0 auto',
        margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
        color: 'rgba(255, 255, 255, 0.6)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', fontWeight: '400', lineHeight: '1.7', letterSpacing: '1px'
      }}>STUDIO — EST. 2016</p>
      <p data-id="hfr-title" data-name="Title" style={{
        position: 'relative', order: '1', flex: '0 0 auto',
        margin: '0px', width: '100%', height: 'auto', marginTop: '14px',
        color: '#ffffff', fontFamily: 'Bricolage Grotesque, sans-serif', fontSize: 'clamp(56px, 9vw, 124px)', fontWeight: '500', lineHeight: '0.9', letterSpacing: '-0.04em'
      }}>Form follows feeling</p>
      <p data-id="hfr-lead" data-name="Lead" style={{
        position: 'relative', order: '2', flex: '0 0 auto',
        margin: '0px', width: '100%', maxWidth: '560px', height: 'auto', marginTop: '26px',
        color: '#ffffff', fontFamily: 'Inter, sans-serif', fontSize: '19px', fontWeight: '500', lineHeight: '1.5'
      }}>We design calm, durable places — and carry them from first sketch to final brick.</p>
      <div data-id="hfr-stats" data-name="Stats" style={{
        position: 'relative', order: '3', flex: '0 0 auto',
        width: 'min-content', height: 'min-content', marginTop: '34px',
        display: 'flex', flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'flex-start', gap: '52px'
      }}>
        <div data-id="hfr-stat-1" data-name="Stat 1" style={{
          position: 'relative', order: '0', flex: '0 0 auto',
          width: 'min-content', height: 'min-content',
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start', gap: '6px'
        }}>
          <p data-id="hfr-stat-1-value" data-name="Value" style={{
            position: 'relative', order: '0', flex: '0 0 auto',
            margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
            color: '#ffffff', fontFamily: 'Inter, sans-serif', fontSize: '18px', fontWeight: '600', lineHeight: '1.3'
          }}>120+</p>
          <p data-id="hfr-stat-1-label" data-name="Label" style={{
            position: 'relative', order: '1', flex: '0 0 auto',
            margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
            color: 'rgba(255, 255, 255, 0.55)', fontFamily: 'Inter, sans-serif', fontSize: '13px', fontWeight: '500', lineHeight: '1.4'
          }}>Projects delivered</p>
        </div>
        <div data-id="hfr-stat-2" data-name="Stat 2" style={{
          position: 'relative', order: '1', flex: '0 0 auto',
          width: 'min-content', height: 'min-content',
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start', gap: '6px'
        }}>
          <p data-id="hfr-stat-2-value" data-name="Value" style={{
            position: 'relative', order: '0', flex: '0 0 auto',
            margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
            color: '#ffffff', fontFamily: 'Inter, sans-serif', fontSize: '18px', fontWeight: '600', lineHeight: '1.3'
          }}>14</p>
          <p data-id="hfr-stat-2-label" data-name="Label" style={{
            position: 'relative', order: '1', flex: '0 0 auto',
            margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
            color: 'rgba(255, 255, 255, 0.55)', fontFamily: 'Inter, sans-serif', fontSize: '13px', fontWeight: '500', lineHeight: '1.4'
          }}>Years of practice</p>
        </div>
        <div data-id="hfr-stat-3" data-name="Stat 3" style={{
          position: 'relative', order: '2', flex: '0 0 auto',
          width: 'min-content', height: 'min-content',
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start', gap: '6px'
        }}>
          <p data-id="hfr-stat-3-value" data-name="Value" style={{
            position: 'relative', order: '0', flex: '0 0 auto',
            margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
            color: '#ffffff', fontFamily: 'Inter, sans-serif', fontSize: '18px', fontWeight: '600', lineHeight: '1.3'
          }}>9</p>
          <p data-id="hfr-stat-3-label" data-name="Label" style={{
            position: 'relative', order: '1', flex: '0 0 auto',
            margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
            color: 'rgba(255, 255, 255, 0.55)', fontFamily: 'Inter, sans-serif', fontSize: '13px', fontWeight: '500', lineHeight: '1.4'
          }}>Design awards</p>
        </div>
      </div>
    </div>
    <div data-id="hfr-aside" data-name="Aside" style={{
      position: 'relative', order: '1', flex: '0 0 auto',
      width: '380px', height: 'min-content',
      display: 'flex', flexDirection: 'column', justifyContent: 'flex-start'
    }}>
      <p data-id="hfr-aside-text" data-name="Aside text" style={{
        position: 'relative', order: '0', flex: '0 0 auto',
        margin: '0px', width: '100%', height: 'auto',
        color: 'rgba(255, 255, 255, 0.72)', fontFamily: 'Inter, sans-serif', fontSize: '21px', fontWeight: '400', lineHeight: '1.55'
      }}>We believe restraint is a material. Every project begins with what can be left out.</p>
    </div>
  </div>
</div>`,
};
