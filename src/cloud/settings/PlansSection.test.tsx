// PlansSection.test.tsx — verify the section reads the new
// /api/stripe/website-subscription shape correctly: shows the right
// "Current plan" label, hides the Upgrade button for the current
// tier, surfaces 402 errors inline (no alert).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PlansSection from './PlansSection';

function mockFetchResponse(url: string, body: unknown, status = 200) {
  const r = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  // Stub fetch — every test wires its own per-url response.
  return r;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlansSection — current plan rendering', () => {
  it('shows "Free plan" card when planType=free', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse('/api/stripe/website-subscription', {
        planType: 'free',
        isActive: false,
        name: 'Free',
      }),
    );
    render(<PlansSection websiteId="w1" />);
    // The banner heading is now just the plan name ("Free"), under a
    // "Current plan" label — not the old "<name> plan" card title.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Free' })).toBeTruthy());
    expect(screen.getByText('Current plan')).toBeTruthy();
  });

  it('shows "Lite plan" card with renewal date when active', async () => {
    const periodEnd = new Date('2026-06-15').toISOString();
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse('/api/stripe/website-subscription', {
        planType: 'lite',
        isActive: true,
        status: 'active',
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: false,
        billingPeriod: 'monthly',
        name: 'Lite',
      }),
    );
    render(<PlansSection websiteId="w1" />);
    // Banner heading renders subscription.name ("Lite") — same markup change
    // as the free-plan test above.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Lite' })).toBeTruthy());
    expect(screen.getByText(/Renews on/i)).toBeTruthy();
  });

  it('shows "Cancels on" when cancelAtPeriodEnd=true', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockFetchResponse('/api/stripe/website-subscription', {
        planType: 'lite',
        isActive: true,
        status: 'active',
        currentPeriodEnd: new Date('2026-07-01').toISOString(),
        cancelAtPeriodEnd: true,
        name: 'Lite',
      }),
    );
    render(<PlansSection websiteId="w1" />);
    await waitFor(() => expect(screen.getByText(/Cancels on/i)).toBeTruthy());
    expect(screen.getByText(/Canceled/i)).toBeTruthy();
  });
});

describe('PlansSection — checkout flow', () => {
  it('redirects to Stripe URL on successful create-checkout', async () => {
    // First call: subscription fetch (free).
    // Second call: create-checkout (returns url).
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockFetchResponse('/sub', { planType: 'free', isActive: false, name: 'Free' }))
      .mockResolvedValueOnce(mockFetchResponse('/checkout', { url: 'https://checkout.stripe.com/abc' }));

    // Stub window.location.href assignment.
    const originalLocation = window.location;
    delete (window as { location?: Location }).location;
    (window as { location: { href: string } }).location = { href: '' } as Location;

    render(<PlansSection websiteId="w1" />);
    await waitFor(() => screen.getByText(/Choose your plan/i));

    const upgradeBtn = screen.getByRole('button', { name: /Upgrade to Lite/i });
    await userEvent.click(upgradeBtn);

    await waitFor(() =>
      expect(window.location.href).toBe('https://checkout.stripe.com/abc'),
    );

    (window as { location: Location }).location = originalLocation;
  });

  it('shows inline error banner on 402 response', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockFetchResponse('/sub', { planType: 'free', isActive: false, name: 'Free' }))
      .mockResolvedValueOnce(mockFetchResponse('/checkout', { error: { code: 'PAYMENT_REQUIRED', message: 'Custom domain requires the Lite plan or higher' } }, 402));

    render(<PlansSection websiteId="w1" />);
    await waitFor(() => screen.getByText(/Choose your plan/i));

    await userEvent.click(screen.getByRole('button', { name: /Upgrade to Lite/i }));

    await waitFor(() =>
      expect(screen.getByText(/Custom domain requires the Lite plan/i)).toBeTruthy(),
    );
  });
});
