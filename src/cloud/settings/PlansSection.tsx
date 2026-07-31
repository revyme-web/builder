// PlansSection.tsx — Per-site subscription plans.
//
// Card design copied 1:1 from revyme-old/builder/src/components/settings/
// PlansSettings.tsx — including the meteor `<Beam>` animation on the
// premium/high-end card. Tier data follows the new plans model:
//
//   Free €0         — standard card
//   Pro €10/mo      — standard card
//   Business €30/mo — premium card with Beam, "Coming soon"
//   Enterprise      — banner below the grid, not a card
//
// Per-site billing. Everything content-wise unlimited on every tier.
// Collaboration is unlimited & free, never a billing axis.

import React, { useState, useEffect, useCallback } from 'react';
import { trace } from '@/shared/debug-trace';
import { Skeleton } from '@/editor/overlays/settings-shared';
import Beam from './Beam';
import { ConfirmModalShell, ModalCancelButton, useEscapeToClose } from './shared';

// ─── Inline SVG icons ──────────────────────────────────────────────────────

const CheckIcon = ({ className = 'h-4 w-4' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const ExternalLinkIcon = ({ className = 'w-3 h-3' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

const Spinner = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

// ─── Plan definitions ──────────────────────────────────────────────────────

type PlanId = 'free' | 'lite' | 'pro' | 'studio';

interface PlanDef {
  id: PlanId;
  name: string;
  /** Per-site monthly price in EUR (0 = Free). */
  monthly: number;
  /** Annualized per-month price (~17% off). */
  annualPerMonth: number;
  /** Annual total in EUR. */
  annualTotal: number;
  /** Use the dark radial-gradient + Beam card design (the old "Premium" look). */
  premium?: boolean;
  /** "Coming soon" — disables the CTA + shows the badge. */
  comingSoon?: boolean;
  /** Bullet list shown in the card. */
  features: string[];
}

// Rank used to decide upgrade vs downgrade copy + routing. Mirrors the
// rank in backend/src/services/plan.ts.
const PLAN_RANK: Record<PlanId, number> = { free: 0, lite: 1, pro: 2, studio: 3 };

// The 3 buyable tiers — Free is shown via the "Current plan" banner at top
// when active, never as a card (you can't "upgrade to Free").
const PLANS: PlanDef[] = [
  {
    id: 'lite',
    name: 'Lite',
    monthly: 10,
    annualPerMonth: 8.33,
    annualTotal: 100,
    features: [
      'Custom domain',
      'No watermark',
      'Advanced analytics',
      '10 GB storage',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    monthly: 30,
    annualPerMonth: 25,
    annualTotal: 300,
    features: [
      'Everything in Lite, plus:',
      'Export to Tailwind',
      'A/B testing on every page · 2 goals per test',
      '7-day backup history',
      'Staging environment',
      '100 GB storage',
    ],
  },
  {
    id: 'studio',
    name: 'Studio',
    monthly: 60,
    annualPerMonth: 50,
    annualTotal: 600,
    premium: true,
    features: [
      'Everything in Pro, plus:',
      'Multivariate testing (A/B/C/D…) · Unlimited goals per test',
      '30-day backup history + editor restore',
      'Unlimited staging environments',
      'Dedicated Slack support',
      '500 GB storage',
    ],
  },
];

// ─── PlansSection ──────────────────────────────────────────────────────────

interface PlansSectionProps {
  websiteId: string;
}

export default function PlansSection({ websiteId }: PlansSectionProps) {
  const [subscription, setSubscription] = useState<{
    planType: string;
    isActive: boolean;
    status?: string;
    currentPeriodEnd?: string;
    cancelAtPeriodEnd?: boolean;
    billingPeriod?: string | null;
    name?: string;
    features?: { name: string };
  } | null>(null);
  const [isYearly, setIsYearly] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  // Pending tier change — opens the confirm modal. The actual API call
  // only fires once the user clicks Confirm. Null = modal closed.
  const [pendingChange, setPendingChange] = useState<{ plan: PlanDef; direction: 'upgrade' | 'downgrade' } | null>(null);

  useEffect(() => {
    if (!websiteId) {
      setLoading(false);
      return;
    }
    trace.fn('plans-section:fetch-subscription', { websiteId });
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/stripe/website-subscription?websiteId=${websiteId}`);
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) setSubscription(data);
        }
      } catch (error) {
        trace.error('plans-section:fetch-subscription', error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [websiteId]);

  const handleSubscribe = useCallback(
    async (planType: PlanId) => {
      try {
        setCheckoutLoading(planType);
        setSubscribeError(null);
        trace.action('plans-section:subscribe', { planType, isYearly });
        const response = await fetch('/api/stripe/create-checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            planType,
            billingPeriod: isYearly ? 'annual' : 'monthly',
            websiteId,
            // Send current page URL so Stripe redirects (success + cancel)
            // bring the user back to the exact project they were editing.
            returnUrl: window.location.href,
          }),
        });
        const data = await response.json();
        if (data.url) {
          window.location.href = data.url;
        } else if (data.error) {
          setSubscribeError(data.error?.message || String(data.error));
        }
      } catch (error) {
        trace.error('plans-section:subscribe-error', error);
        alert('Failed to start checkout. Please try again.');
      } finally {
        setCheckoutLoading(null);
      }
    },
    [websiteId, isYearly],
  );

  // Tier change for sites that already have an active subscription.
  // Hits POST /api/stripe/change-subscription, which uses
  // stripe.subscriptions.update with prorations — no redirect, no
  // portal detour. Refetches subscription state on success so the
  // "Current Plan" pill jumps to the new card immediately.
  const handleChangePlan = useCallback(
    async (planType: PlanId) => {
      try {
        setCheckoutLoading(planType);
        setSubscribeError(null);
        trace.action('plans-section:change', { planType, isYearly });
        const response = await fetch('/api/stripe/change-subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            planType,
            billingPeriod: isYearly ? 'annual' : 'monthly',
            websiteId,
          }),
        });
        const data = await response.json();
        if (!response.ok || data.error) {
          setSubscribeError(data.error?.message || 'Failed to change plan');
          return;
        }
        // Refresh the local subscription state so the UI flips its
        // "Current Plan" / "Upgrade" / "Downgrade" labels.
        const subRes = await fetch(`/api/stripe/website-subscription?websiteId=${websiteId}`);
        if (subRes.ok) setSubscription(await subRes.json());
      } catch (error) {
        trace.error('plans-section:change-error', error);
        setSubscribeError('Failed to change plan. Please try again.');
      } finally {
        setCheckoutLoading(null);
      }
    },
    [websiteId, isYearly],
  );

  const handleManageBilling = useCallback(async () => {
    try {
      trace.action('plans-section:manage-billing');
      const response = await fetch('/api/stripe/portal', { method: 'POST' });
      const data = await response.json();
      if (data.url) window.open(data.url, '_blank');
    } catch (error) {
      trace.error('plans-section:manage-billing-error', error);
      alert('Failed to open billing portal. Please try again.');
    }
  }, []);

  const handleContactEnterprise = useCallback(() => {
    trace.action('plans-section:contact-enterprise');
    window.open('mailto:hello@revyme.app?subject=Enterprise%20plan%20inquiry', '_blank');
  }, []);

  const currentPlan = (subscription?.planType ?? 'free') as PlanId;

  // No early-return skeleton — the plans grid (Lite / Pro / Studio) is
  // static content that doesn't depend on the subscription fetch, so we
  // render the full page chrome immediately. The only thing the fetch
  // resolves is which card is "current", and that flips inline via the
  // `loading` checks scattered through the JSX below (badge + active
  // border).

  // ─── Render ──────────────────────────────────────────────────────────
  //
  // Layout follows the same minimal flat idiom as the A/B detail page
  // and the redesigned Analytics / Staging / Backups sections:
  //   - Top section "Current plan" is flush (no card wrapper), separated
  //     from the picker grid by a hairline border-b.
  //   - The 3 plan choice cards keep their visual chrome on purpose —
  //     they're literal choice cards, the radial gradient + Beam are
  //     part of the picker UX. Everything AROUND them is flat.
  //   - Enterprise banner at the bottom drops its card wrapper and
  //     becomes a flush row separated by hairline border-t.
  return (
    <div>
      {/* ── Current plan — flat row, no card. Skeleton state preserves
          the same layout so the section doesn't shift when the
          subscription fetch resolves. */}
      {loading && (
        <div className="flex items-start justify-between pb-6 border-b border-[var(--border-light)]">
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              Current plan
            </p>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-3 w-72" />
          </div>
          <Skeleton className="h-6 w-16 rounded-md" />
        </div>
      )}
      {!loading && currentPlan === 'free' && (
        <div className="flex items-start justify-between pb-6 border-b border-[var(--border-light)]">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">
              Current plan
            </p>
            <h4 className="text-base font-semibold text-[var(--text-primary)]">Free</h4>
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              revyme.app subdomain · "Made with Revyme" badge · Basic analytics · 500 MB storage
            </p>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 rounded-md shrink-0">
            <div className="relative flex items-center justify-center w-2 h-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75 animate-ping"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
            </div>
            <span className="text-xs font-medium text-green-500">Active</span>
          </div>
        </div>
      )}

      {subscription && subscription.isActive && currentPlan !== 'free' && (
        <div className="flex items-start justify-between gap-3 pb-6 border-b border-[var(--border-light)]">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5">
              Current plan
            </p>
            <h4 className="text-base font-semibold text-[var(--text-primary)] capitalize">
              {subscription.name || currentPlan}
            </h4>
            {subscription.currentPeriodEnd && (
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                {subscription.cancelAtPeriodEnd
                  ? `Cancels on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                  : `Renews on ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handleManageBilling}
              className="inline-flex items-center gap-2 h-8 px-3 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] rounded-md transition-colors cursor-pointer"
            >
              Manage Billing
              <ExternalLinkIcon />
            </button>
            {subscription.cancelAtPeriodEnd ? (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-white/5 rounded-md">
                <div className="relative flex items-center justify-center w-2 h-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-white/40 opacity-75 animate-ping"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-white/60"></span>
                </div>
                <span className="text-xs font-medium text-[var(--text-secondary)]">
                  Canceled
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-green-500/10 rounded-md">
                <div className="relative flex items-center justify-center w-2 h-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75 animate-ping"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </div>
                <span className="text-xs font-medium text-green-500">Active</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Picker header — title on the left, yearly toggle on the
          right. Sits in the same hairline-separated rhythm as Current
          plan above. */}
      <div className="flex items-end justify-between py-6">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          Choose your plan
        </h3>

        <label className="flex items-center gap-3 cursor-pointer select-none">
          <span className="text-xs text-[var(--text-secondary)]">
            Yearly · save 17%
          </span>
          <button
            type="button"
            onClick={() => setIsYearly((v) => !v)}
            className={`relative w-9 h-5 rounded-full transition-colors ${
              isYearly ? 'bg-[var(--accent)]' : 'bg-black/[0.15] dark:bg-white/15'
            }`}
            aria-pressed={isYearly}
          >
            <span
              // Positioned with an explicit `left` rather than a Tailwind
              // `translate-x-*` class — the translate utility was
              // mis-rendering and flinging the thumb off the track's right
              // edge. Track is w-9 (36px), thumb w-4 (16px): 2px inset on
              // the left (off) and 36-16-2=18px on the right (on).
              className="absolute w-4 h-4 rounded-full bg-white"
              style={{ top: 2, left: isYearly ? 18 : 2, transition: 'left 0.18s ease' }}
            />
          </button>
        </label>
      </div>

      {subscribeError && (
        <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs rounded-lg">
          {subscribeError}
        </div>
      )}

      {/* ── Plans grid (3 cards, old design) ──────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {PLANS.map((plan) => {
          const isCurrent = currentPlan === plan.id;
          // Downgrades = current plan has a higher rank than this card.
          // They go through the Stripe billing portal (subscription
          // update) instead of a fresh checkout, which is the right
          // Stripe behavior — checkout would create a duplicate sub.
          const isDowngrade = !isCurrent && plan.id !== 'free'
            && PLAN_RANK[plan.id] < PLAN_RANK[currentPlan];
          const price = isYearly ? plan.annualPerMonth : plan.monthly;
          const priceLabel =
            price === 0 ? '€0' : `€${Number.isInteger(price) ? price : price.toFixed(2)}`;

          return (
            <div
              key={plan.id}
              className={`flex flex-col justify-between items-start gap-8 px-6 pt-8 pb-4 rounded-lg relative overflow-hidden ${
                plan.premium
                  // Tailwind 4 dropped --tw-gradient-stops; use literal hex
                  // for the radial. neutral-900 = #171717, neutral-950 = #0a0a0a.
                  ? 'bg-[radial-gradient(circle_at_top,_#171717_0%,_#0a0a0a_100%)] border border-white/10'
                  : 'bg-neutral-100 dark:bg-neutral-900/50 border border-neutral-200 dark:border-white/10'
              }`}
            >
              {/* Meteor streak — premium card only */}
              {plan.premium && <Beam showBeam className="top-0 block" />}

              {/* Top-right corner — Coming soon / Current Plan / Billed annually */}
              {plan.comingSoon ? (
                <div className="absolute top-4 right-4 z-10">
                  <span className="bg-white/10 backdrop-blur text-white text-xs font-semibold px-3 py-1 rounded-full border border-white/20">
                    Coming soon
                  </span>
                </div>
              ) : isCurrent ? (
                <div className="absolute top-4 right-4 z-10">
                  <span className="bg-[var(--accent)] text-white text-xs font-semibold px-3 py-1 rounded-full">
                    Current Plan
                  </span>
                </div>
              ) : isYearly && plan.annualTotal > 0 ? (
                <div className="absolute top-4 right-4">
                  <span className="text-xs text-neutral-500">
                    €{plan.annualTotal} billed annually
                  </span>
                </div>
              ) : null}

              <div>
                <h3
                  className={`text-base font-normal ${
                    plan.premium ? 'text-white' : 'text-neutral-900 dark:text-white'
                  }`}
                >
                  {plan.name}
                </h3>
                <p
                  className={`text-lg mt-4 font-medium ${
                    plan.premium
                      ? 'text-neutral-400'
                      : 'text-neutral-500 dark:text-neutral-400'
                  }`}
                >
                  {priceLabel} {price > 0 ? '/ month' : ''}
                </p>
                <div className="mt-4 space-y-2">
                  {plan.features.map((feature, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <CheckIcon
                        className={`h-4 w-4 mt-0.5 flex-shrink-0 ${
                          plan.premium
                            ? 'text-neutral-400'
                            : 'text-neutral-500 dark:text-neutral-400'
                        }`}
                      />
                      <p
                        className={`text-sm ${
                          plan.premium
                            ? 'text-neutral-400'
                            : 'text-neutral-600 dark:text-neutral-400'
                        }`}
                      >
                        {feature}
                      </p>
                    </div>
                  ))}
                </div>
              </div>

              <button
                onClick={() => {
                  if (plan.comingSoon || isCurrent || plan.id === 'free') return;
                  // Sites with an active sub: open the confirm modal
                  // so the user explicitly accepts the proration
                  // before we mutate their Stripe subscription. Free
                  // sites go straight to Stripe Checkout — Stripe's
                  // own payment page is the confirmation step there.
                  if (subscription && subscription.isActive) {
                    setPendingChange({ plan, direction: isDowngrade ? 'downgrade' : 'upgrade' });
                  } else {
                    handleSubscribe(plan.id);
                  }
                }}
                disabled={
                  isCurrent ||
                  plan.comingSoon ||
                  plan.id === 'free' ||
                  checkoutLoading === plan.id
                }
                className={`mt-4 w-full px-4 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 min-h-[40px] flex items-center justify-center cursor-pointer ${
                  plan.comingSoon
                    ? 'bg-white/5 text-white/60 cursor-not-allowed border border-white/10'
                    : isCurrent || plan.id === 'free'
                      ? 'bg-black/[0.04] dark:bg-white/5 text-[var(--text-tertiary)] cursor-not-allowed border border-[var(--control-border)]'
                      : plan.premium
                        ? 'bg-white text-black hover:bg-white/90'
                        : 'bg-neutral-800 dark:bg-white/10 hover:bg-neutral-700 dark:hover:bg-white/20 text-white'
                }`}
              >
                {checkoutLoading === plan.id ? (
                  <Spinner
                    className={`w-4 h-4 ${plan.premium ? 'text-black' : 'text-white'}`}
                  />
                ) : plan.comingSoon ? (
                  'Coming soon'
                ) : isCurrent ? (
                  'Current Plan'
                ) : plan.id === 'free' ? (
                  'Free forever'
                ) : isDowngrade ? (
                  `Downgrade to ${plan.name}`
                ) : (
                  `Upgrade to ${plan.name}`
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Enterprise — flush row below the grid (no card chrome).
          Same idiom as Backups' upsell row: heading on the left,
          single action on the right, hairline border-t separating it
          from the picker above. */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 pt-6 mt-6 border-t border-[var(--border-light)]">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            Enterprise
          </p>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Custom limits, dedicated support, SLA, SSO, and big-traffic deals
            — let's talk.
          </p>
        </div>
        <button
          onClick={handleContactEnterprise}
          className="self-start inline-flex items-center gap-2 h-8 px-3 text-xs font-medium text-[var(--text-primary)] bg-[var(--grid-line)] hover:bg-[var(--bg-hover)] rounded-md cursor-pointer transition-colors"
        >
          Contact us
          <ExternalLinkIcon />
        </button>
      </div>

      <ChangePlanConfirmModal
        pending={pendingChange}
        isYearly={isYearly}
        currentPeriodEnd={subscription?.currentPeriodEnd ?? null}
        onCancel={() => setPendingChange(null)}
        onConfirm={async () => {
          if (!pendingChange) return;
          await handleChangePlan(pendingChange.plan.id);
          setPendingChange(null);
        }}
        running={checkoutLoading !== null}
      />
    </div>
  );
}

// ─── Change-plan confirm modal ─────────────────────────────────────────────
//
// Matches the NameInputModal / RestoreConfirmModal pattern (portal,
// framer-motion, w-80 compact shell, header with title + close X, body
// + two-button footer). Required before we mutate the Stripe sub
// because change-subscription writes to the user's billing state.
//
// Explains the proration model in plain English so the user knows what
// will and won't get charged.

interface ChangePlanConfirmModalProps {
  pending: { plan: PlanDef; direction: 'upgrade' | 'downgrade' } | null;
  isYearly: boolean;
  currentPeriodEnd: string | null;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  running: boolean;
}

function ChangePlanConfirmModal({
  pending,
  isYearly,
  currentPeriodEnd,
  onCancel,
  onConfirm,
  running,
}: ChangePlanConfirmModalProps) {
  // Escape to close — but only when NOT mid-request, so the user can't
  // bail out of an in-flight Stripe call and end up in a weird state.
  useEscapeToClose(!!pending, running, onCancel);

  if (!pending) return null;

  const { plan, direction } = pending;
  const price = isYearly ? plan.annualPerMonth : plan.monthly;
  const priceLabel = `€${Number.isInteger(price) ? price : price.toFixed(2)}`;
  const periodLabel = isYearly ? 'year' : 'month';
  const renewalText = currentPeriodEnd
    ? `around ${new Date(currentPeriodEnd).toLocaleDateString()}`
    : 'your next renewal';

  const titleText = direction === 'upgrade'
    ? `Upgrade to ${plan.name}?`
    : `Downgrade to ${plan.name}?`;

  const bodyParas: string[] = direction === 'upgrade'
    ? [
        `Your subscription switches to ${plan.name} (${priceLabel}/${periodLabel}) right now and you get the new features immediately.`,
        `Your card will be charged the prorated difference between what you've already paid for the rest of this period and what the new tier costs over the same days. Your renewal date stays the same (${renewalText}).`,
      ]
    : [
        `Your subscription switches to ${plan.name} (${priceLabel}/${periodLabel}) right now. You'll immediately lose access to the features above this tier.`,
        `The unused portion of your current plan is credited toward your next invoice (${renewalText}) — you don't lose what you've already paid for.`,
      ];

  const submitText = direction === 'upgrade' ? `Upgrade to ${plan.name}` : `Downgrade to ${plan.name}`;

  return (
    <ConfirmModalShell
      open
      locked={running}
      onCancel={onCancel}
      title={titleText}
      widthClassName="w-[420px] max-w-[calc(100vw-2rem)]"
    >
      {bodyParas.map((p, i) => (
        <p key={i} className="text-xs leading-relaxed text-[var(--text-secondary)]">
          {p}
        </p>
      ))}

      <div className="flex items-center gap-2 pt-1">
        <ModalCancelButton onClick={onCancel} disabled={running} />
        <button
          onClick={() => { void onConfirm(); }}
          disabled={running}
          className="flex-1 h-8 px-3 text-xs rounded-[var(--radius-lg)] transition-colors font-medium flex items-center justify-center bg-[var(--accent)] hover:bg-[var(--accent-hover,var(--accent))] text-white disabled:opacity-100 disabled:bg-[var(--accent)] disabled:cursor-not-allowed cursor-pointer"
        >
          {running ? (
            <Spinner className="w-4 h-4 text-white" />
          ) : (
            submitText
          )}
        </button>
      </div>
    </ConfirmModalShell>
  );
}
