import { describe, test, expect, vi } from 'vitest';
vi.mock('@/shared/debug-trace', () => ({ trace: { action: vi.fn(), fn: vi.fn(), dom: vi.fn(), error: vi.fn() } }));
import { outOfFlowOrderHealsForCode } from './out-of-flow-order-migrate';

const PAGE = (heroOrder: string) => `export default function Page() {
  return (
    <div data-id="wrap" style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <div data-id="header" style={{ position: 'relative', height: '81px', order: '0' }}></div>
      <div data-id="section" style={{ position: 'relative', height: '600px', order: '1', backgroundColor: '#000' }}></div>
      <div data-id="hero" style={{ position: 'absolute', left: '0px', top: '0px', height: '400px'${heroOrder} }}></div>
      <div data-id="bg" style={{ position: 'absolute', left: '0px', top: '0px' }}></div>
    </div>
  );
}`;

describe('outOfFlowOrderHealsForCode', () => {
  test('an absolute sibling after an order:1 flow sibling gets z-index 1 (its own order is irrelevant in Chrome)', () => {
    expect(outOfFlowOrderHealsForCode(PAGE(''))).toEqual([{ nodeId: 'hero', zIndex: 1 }, { nodeId: 'bg', zIndex: 1 }]);
    expect(outOfFlowOrderHealsForCode(PAGE(", order: '1'"))).toEqual([{ nodeId: 'hero', zIndex: 1 }, { nodeId: 'bg', zIndex: 1 }]);
  });
  test('authored z-index respected; nothing when flow orders are all 0', () => {
    expect(outOfFlowOrderHealsForCode(PAGE(", zIndex: '4'"))).toEqual([{ nodeId: 'bg', zIndex: 1 }]);
    const allZero = PAGE('').replace("order: '1'", "order: '0'");
    expect(outOfFlowOrderHealsForCode(allZero)).toEqual([]);
  });
});
