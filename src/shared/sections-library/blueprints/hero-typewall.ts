import type { SectionBlueprint } from '../types';

// Type-wall ledger hero — paper ground, one enormous tight-tracked
// headline, a baseline-aligned meta row, then hairline ledger rows on an
// off-center 50.77% split (Kova/Elena archetype). No image, no gradient,
// no button: the availability line is the CTA and the rules are the
// decoration. Two colors total.
export const heroTypewall: SectionBlueprint = {
  id: 'hero-typewall',
  name: 'Type-wall ledger hero',
  category: 'hero',
  description: 'Paper ground, giant tight display type, hairline ledger rows on an off-center split.',
  fonts: ['Inter'],
  canvasSize: { width: '1280px', height: '640px' },
  source: `<div data-id="section-hero-typewall" data-name="Hero — Type Wall" style={{
  position: 'relative', order: '0', flex: '0 0 auto',
  width: '100%', height: 'min-content', backgroundColor: '#F2F1ED',
  display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
  padding: '128px 40px 56px 40px'
}}>
  <p data-id="htw-title" data-name="Title" style={{
    position: 'relative', order: '0', flex: '0 0 auto',
    margin: '0px', width: '100%', height: 'auto',
    color: '#0C0C0C', fontFamily: 'Inter, sans-serif', fontSize: 'clamp(48px, 11vw, 168px)', fontWeight: '500', lineHeight: '0.88', letterSpacing: '-0.055em'
  }}>PRACTICAL MAGIC.</p>
  <div data-id="htw-meta" data-name="Meta" style={{
    position: 'relative', order: '1', flex: '0 0 auto',
    width: '100%', height: 'min-content', marginTop: '64px',
    display: 'flex', flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: '32px'
  }}>
    <p data-id="htw-meta-positioning" data-name="Positioning" style={{
      position: 'relative', order: '0', flex: '0 0 auto',
      margin: '0px', width: '100%', maxWidth: '440px', height: 'auto',
      color: '#0C0C0C', fontFamily: 'Inter, sans-serif', fontSize: '17px', fontWeight: '400', lineHeight: '1.45', letterSpacing: '-0.01em'
    }}>Independent studio for brand systems, digital product and art direction.</p>
    <p data-id="htw-meta-availability" data-name="Availability" style={{
      position: 'relative', order: '1', flex: '0 0 auto',
      margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap', textAlign: 'right',
      color: 'rgba(12, 12, 12, 0.55)', fontFamily: 'Inter, sans-serif', fontSize: '13px', fontWeight: '500', lineHeight: '1.4', letterSpacing: '1.5px'
    }}>NOW BOOKING — Q1 2027</p>
  </div>
  <div data-id="htw-ledger" data-name="Ledger" style={{
    position: 'relative', order: '2', flex: '0 0 auto',
    width: '100%', height: 'min-content', marginTop: '44px',
    display: 'flex', flexDirection: 'column', justifyContent: 'flex-start'
  }}>
    <div data-id="htw-row-1" data-name="Row 1" style={{
      position: 'relative', order: '0', flex: '0 0 auto',
      width: '100%', height: 'min-content', padding: '13px 0px 11px 0px',
      borderTop: '1px solid #0C0C0C',
      display: 'flex', flexDirection: 'row', justifyContent: 'flex-start'
    }}>
      <div data-id="htw-row-1-left" data-name="Left cell" style={{
        position: 'relative', order: '0', flex: '0 0 auto',
        width: '50.77%', height: 'min-content',
        display: 'flex', flexDirection: 'row', justifyContent: 'flex-start'
      }}>
        <p data-id="htw-row-1-left-label" data-name="Label" style={{
          position: 'relative', order: '0', flex: '0 0 auto',
          margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
          color: '#0C0C0C', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '600', lineHeight: '1.7'
        }}>Brand systems</p>
      </div>
      <div data-id="htw-row-1-right" data-name="Right cell" style={{
        position: 'relative', order: '1', flex: '1 0 0px', height: 'min-content',
        display: 'flex', flexDirection: 'row', justifyContent: 'flex-start'
      }}>
        <p data-id="htw-row-1-right-label" data-name="Label" style={{
          position: 'relative', order: '0', flex: '0 0 auto',
          margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
          color: '#0C0C0C', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '600', lineHeight: '1.7'
        }}>Art direction</p>
      </div>
    </div>
    <div data-id="htw-row-2" data-name="Row 2" style={{
      position: 'relative', order: '1', flex: '0 0 auto',
      width: '100%', height: 'min-content', padding: '13px 0px 11px 0px',
      borderTop: '1px solid #0C0C0C',
      display: 'flex', flexDirection: 'row', justifyContent: 'flex-start'
    }}>
      <div data-id="htw-row-2-left" data-name="Left cell" style={{
        position: 'relative', order: '0', flex: '0 0 auto',
        width: '50.77%', height: 'min-content',
        display: 'flex', flexDirection: 'row', justifyContent: 'flex-start'
      }}>
        <p data-id="htw-row-2-left-label" data-name="Label" style={{
          position: 'relative', order: '0', flex: '0 0 auto',
          margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
          color: '#0C0C0C', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '600', lineHeight: '1.7'
        }}>Digital product</p>
      </div>
      <div data-id="htw-row-2-right" data-name="Right cell" style={{
        position: 'relative', order: '1', flex: '1 0 0px', height: 'min-content',
        display: 'flex', flexDirection: 'row', justifyContent: 'flex-start'
      }}>
        <p data-id="htw-row-2-right-label" data-name="Label" style={{
          position: 'relative', order: '0', flex: '0 0 auto',
          margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
          color: '#0C0C0C', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '600', lineHeight: '1.7'
        }}>Type and editorial</p>
      </div>
    </div>
    <div data-id="htw-row-3" data-name="Row 3" style={{
      position: 'relative', order: '2', flex: '0 0 auto',
      width: '100%', height: 'min-content', padding: '13px 0px 11px 0px',
      borderTop: '1px solid #0C0C0C', borderBottom: '1px solid #0C0C0C',
      display: 'flex', flexDirection: 'row', justifyContent: 'flex-start'
    }}>
      <div data-id="htw-row-3-left" data-name="Left cell" style={{
        position: 'relative', order: '0', flex: '0 0 auto',
        width: '50.77%', height: 'min-content',
        display: 'flex', flexDirection: 'row', justifyContent: 'flex-start'
      }}>
        <p data-id="htw-row-3-left-label" data-name="Label" style={{
          position: 'relative', order: '0', flex: '0 0 auto',
          margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
          color: '#0C0C0C', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '600', lineHeight: '1.7'
        }}>Spaces</p>
      </div>
      <div data-id="htw-row-3-right" data-name="Right cell" style={{
        position: 'relative', order: '1', flex: '1 0 0px', height: 'min-content',
        display: 'flex', flexDirection: 'row', justifyContent: 'flex-start'
      }}>
        <p data-id="htw-row-3-right-label" data-name="Label" style={{
          position: 'relative', order: '0', flex: '0 0 auto',
          margin: '0px', width: 'max-content', height: 'auto', whiteSpace: 'nowrap',
          color: '#0C0C0C', fontFamily: 'Inter, sans-serif', fontSize: '14px', fontWeight: '600', lineHeight: '1.7'
        }}>Since 2019</p>
      </div>
    </div>
  </div>
</div>`,
};
