// DomainSection.tsx — Domain settings: default domain, custom subdomain, custom domain.
// Borderless-row layout: groups of labelled rows with hairline dividers.
// Shares the SettingsGroup/SettingsRow primitives with the rest of the
// SettingsOverlay so every section reads the same.

import React, { useState, useEffect, useCallback } from 'react';
import { useAtom } from 'jotai';
import { settingsSectionAtom } from '@/code/stores/website-settings-store';
import { trace } from '@/shared/debug-trace';
import {
  SettingsGroup,
  SettingsRow,
  RowButton,
  SettingsSpinner,
  Skeleton,
  ConfirmModal,
} from '@/editor/overlays/settings-shared';

// ─── Inline SVG icons ──────────────────────────────────────────────────────

const CheckIcon = ({ size = 14, className = '' }: { size?: number; className?: string }) => (
  <svg width={size} height={size} className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const GlobeIcon = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const AlertIcon = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

const RefreshIcon = ({ className = 'w-3.5 h-3.5' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

const CopyButton = ({ content }: { content: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="p-1 hover:bg-[var(--bg-hover)] cut-corners transition-colors text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
      title="Copy"
    >
      {copied ? <CheckIcon size={12} className="text-green-500" /> : (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
};

// ─── DomainSection ──────────────────────────────────────────────────────────

interface DomainSectionProps {
  websiteId: string;
}

export default function DomainSection({ websiteId }: DomainSectionProps) {
  const [, setActiveSection] = useAtom(settingsSectionAtom);

  // ─── Subdomain state ───────────────────────────────────────────────
  const [subdomain, setSubdomain] = useState<string | null>(null);
  const [customSubdomain, setCustomSubdomain] = useState('');
  const [customSubdomainInDb, setCustomSubdomainInDb] = useState<string | null>(null);
  const [isUpdatingCustomSubdomain, setIsUpdatingCustomSubdomain] = useState(false);
  const [customSubdomainError, setCustomSubdomainError] = useState('');
  const [showRemoveCustomSubdomainConfirm, setShowRemoveCustomSubdomainConfirm] = useState(false);

  // ─── Custom domain state ───────────────────────────────────────────
  const [customDomain, setCustomDomain] = useState('');
  const [customDomainInDb, setCustomDomainInDb] = useState<string | null>(null);
  const [isUpdatingCustomDomain, setIsUpdatingCustomDomain] = useState(false);
  const [customDomainError, setCustomDomainError] = useState('');
  const [showRemoveCustomDomainConfirm, setShowRemoveCustomDomainConfirm] = useState(false);
  // 'issuing' = hostname verified, SSL certificate still being provisioned.
  const [customDomainDnsStatus, setCustomDomainDnsStatus] = useState<
    'checking' | 'connected' | 'issuing' | 'not-connected' | null
  >(null);

  // ─── Subscription / publish state ──────────────────────────────────
  const [subscription, setSubscription] = useState<{
    planType: string;
    isActive: boolean;
    status?: string;
    currentPeriodEnd?: string;
    cancelAtPeriodEnd?: boolean;
    features?: { name: string };
  } | null>(null);
  const [isPublished, setIsPublished] = useState(false);

  // True until the first website + subscription fetch settles. While set,
  // each row renders a skeleton bar instead of its (still-empty) value.
  const [loading, setLoading] = useState(true);

  // ─── DNS check ─────────────────────────────────────────────────────

  const checkCustomDomainDns = useCallback(async (domain: string) => {
    if (!domain) { setCustomDomainDnsStatus(null); return; }
    trace.fn('domain-section:check-dns', { domain });
    setCustomDomainDnsStatus('checking');
    try {
      const response = await fetch(`/api/check-dns?domain=${encodeURIComponent(domain)}`);
      if (!response.ok) { setCustomDomainDnsStatus(null); return; }
      const data = await response.json();
      // Backend returns 'connected' | 'issuing' | 'not-connected'.
      setCustomDomainDnsStatus(
        data.status === 'connected'
          ? 'connected'
          : data.status === 'issuing'
            ? 'issuing'
            : 'not-connected',
      );
    } catch {
      setCustomDomainDnsStatus(null);
    }
  }, []);

  // ─── Data fetching ─────────────────────────────────────────────────

  const fetchWebsiteData = useCallback(async () => {
    if (!websiteId) return;
    trace.fn('domain-section:fetch-website-data', { websiteId });
    try {
      const response = await fetch(`/api/websites/${websiteId}`);
      if (response.ok) {
        // GET /api/websites/:id returns the row at the top level — there is
        // no `.website` wrapper. (LiveDropdown reads it the same flat way.)
        const data = await response.json();
        setSubdomain(data.subdomain || null);
        setCustomSubdomainInDb(data.custom_subdomain || null);
        setCustomSubdomain(data.custom_subdomain || '');
        setCustomDomainInDb(data.custom_domain || null);
        setCustomDomain(data.custom_domain || '');
        setIsPublished(data.is_published || false);
        if (data.custom_domain) checkCustomDomainDns(data.custom_domain);
      }
    } catch (error) {
      trace.error('domain-section:fetch-website-data', error);
    }
  }, [websiteId, checkCustomDomainDns]);

  useEffect(() => {
    if (!websiteId) {
      setLoading(false);
      return;
    }
    let cancelled = false;

    const fetchSubscription = async () => {
      try {
        const response = await fetch(`/api/stripe/website-subscription?websiteId=${websiteId}`);
        if (response.ok) {
          const data = await response.json();
          if (!cancelled) setSubscription(data);
        }
      } catch (error) {
        trace.error('domain-section:fetch-subscription', error);
      }
    };

    // Drop the skeletons only once BOTH fetches have settled.
    setLoading(true);
    Promise.allSettled([fetchWebsiteData(), fetchSubscription()]).then(() => {
      if (!cancelled) setLoading(false);
    });

    const handlePublishComplete = () => fetchWebsiteData();
    window.addEventListener('website-published', handlePublishComplete);
    return () => {
      cancelled = true;
      window.removeEventListener('website-published', handlePublishComplete);
    };
  }, [websiteId, fetchWebsiteData]);

  // Tell the header's publish dropdown to re-pull the website meta — its
  // "live URL" derives from custom_domain → custom_subdomain → subdomain, so
  // adding/removing either must re-sync it (otherwise it shows the stale
  // domain until a full page reload).
  const notifyMetaChanged = () => window.dispatchEvent(new Event('website-meta-changed'));

  // ─── Custom subdomain handlers ─────────────────────────────────────

  const handleUpdateCustomSubdomain = useCallback(async () => {
    setIsUpdatingCustomSubdomain(true);
    setCustomSubdomainError('');
    trace.action('domain-section:save-custom-subdomain', { customSubdomain });

    try {
      const trimmedSubdomain = customSubdomain.trim().toLowerCase();
      if (trimmedSubdomain && !/^[a-z0-9-]+$/.test(trimmedSubdomain)) {
        setCustomSubdomainError('Only lowercase letters, numbers, and hyphens allowed');
        setIsUpdatingCustomSubdomain(false);
        return;
      }

      const response = await fetch(`/api/websites/${websiteId}/custom-subdomain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customSubdomain: trimmedSubdomain || null }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Backend errors are { error: { code, message } }.
        setCustomSubdomainError(data.error?.message || 'Failed to update custom subdomain');
        setIsUpdatingCustomSubdomain(false);
        return;
      }

      setCustomSubdomainInDb(trimmedSubdomain || null);
      setCustomSubdomain(trimmedSubdomain || '');
      // A `warning` means the row saved but the live Worker sync failed —
      // surface it so the user knows to re-publish.
      setCustomSubdomainError(data.warning || '');
      trace.action('domain-section:custom-subdomain-saved', { subdomain: trimmedSubdomain });
      notifyMetaChanged();
    } catch (error) {
      trace.error('domain-section:save-custom-subdomain', error);
      setCustomSubdomainError('Failed to update custom subdomain. Please try again.');
    } finally {
      setIsUpdatingCustomSubdomain(false);
    }
  }, [websiteId, customSubdomain]);

  const handleRemoveCustomSubdomain = () => {
    if (!customSubdomainInDb) return;
    setShowRemoveCustomSubdomainConfirm(true);
  };

  const confirmRemoveCustomSubdomain = useCallback(async () => {
    setShowRemoveCustomSubdomainConfirm(false);
    setIsUpdatingCustomSubdomain(true);
    setCustomSubdomainError('');
    trace.action('domain-section:remove-custom-subdomain');

    try {
      const response = await fetch(`/api/websites/${websiteId}/custom-subdomain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customSubdomain: null }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Backend errors are { error: { code, message } }.
        setCustomSubdomainError(data.error?.message || 'Failed to remove custom subdomain');
        setIsUpdatingCustomSubdomain(false);
        return;
      }

      setCustomSubdomainInDb(null);
      setCustomSubdomain('');
      setCustomSubdomainError(data.warning || '');
      notifyMetaChanged();
    } catch (error) {
      trace.error('domain-section:remove-custom-subdomain', error);
      setCustomSubdomainError('Failed to remove custom subdomain. Please try again.');
    } finally {
      setIsUpdatingCustomSubdomain(false);
    }
  }, [websiteId]);

  // ─── Custom domain handlers ────────────────────────────────────────

  const handleUpdateCustomDomain = useCallback(async () => {
    setIsUpdatingCustomDomain(true);
    setCustomDomainError('');
    trace.action('domain-section:save-custom-domain', { customDomain });

    try {
      const trimmedDomain = customDomain.trim().toLowerCase();
      if (trimmedDomain && !/^[a-z0-9]+([-.]{1}[a-z0-9]+)*\.[a-z]{2,}$/i.test(trimmedDomain)) {
        setCustomDomainError('Invalid domain format. Use format like example.com or www.example.com');
        setIsUpdatingCustomDomain(false);
        return;
      }

      const response = await fetch(`/api/websites/${websiteId}/custom-domain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customDomain: trimmedDomain || null }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Backend errors are { error: { code, message } }.
        setCustomDomainError(data.error?.message || 'Failed to update custom domain');
        setIsUpdatingCustomDomain(false);
        return;
      }

      setCustomDomainInDb(trimmedDomain || null);
      setCustomDomain(trimmedDomain || '');
      // A `warning` means the row saved but the Cloudflare hostname sync
      // failed — surface it so the user knows to retry.
      setCustomDomainError(data.warning || '');
      trace.action('domain-section:custom-domain-saved', { domain: trimmedDomain });
      if (trimmedDomain) checkCustomDomainDns(trimmedDomain);
      notifyMetaChanged();
    } catch (error) {
      trace.error('domain-section:save-custom-domain', error);
      setCustomDomainError('Failed to update custom domain. Please try again.');
    } finally {
      setIsUpdatingCustomDomain(false);
    }
  }, [websiteId, customDomain, checkCustomDomainDns]);

  const handleRemoveCustomDomain = () => {
    if (!customDomainInDb) return;
    setShowRemoveCustomDomainConfirm(true);
  };

  const confirmRemoveCustomDomain = useCallback(async () => {
    setShowRemoveCustomDomainConfirm(false);
    setIsUpdatingCustomDomain(true);
    setCustomDomainError('');
    trace.action('domain-section:remove-custom-domain');

    try {
      const response = await fetch(`/api/websites/${websiteId}/custom-domain`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customDomain: null }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Backend errors are { error: { code, message } }.
        setCustomDomainError(data.error?.message || 'Failed to remove custom domain');
        setIsUpdatingCustomDomain(false);
        return;
      }

      setCustomDomainInDb(null);
      setCustomDomain('');
      setCustomDomainError(data.warning || '');
      setCustomDomainDnsStatus(null);
      notifyMetaChanged();
    } catch (error) {
      trace.error('domain-section:remove-custom-domain', error);
      setCustomDomainError('Failed to remove custom domain. Please try again.');
    } finally {
      setIsUpdatingCustomDomain(false);
    }
  }, [websiteId]);

  // ─── Derived lock state ────────────────────────────────────────────

  const isFreePlan = subscription?.planType === 'free';
  // Custom subdomain is locked while a custom domain is connected.
  const subdomainLocked = !!customDomainInDb;
  // Custom domain is locked while a custom subdomain is set, or on the
  // free plan (until they have already connected one).
  const domainLocked = !!customSubdomainInDb || (!customDomainInDb && isFreePlan);
  // The connected domain may be `www.example.com` or the bare apex — strip a
  // leading `www.` so the instructions can show the apex without the
  // "www.www.example.com" double-prefix bug.
  const customApex = (customDomainInDb ?? '').replace(/^www\./, '');

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <>
      <div className="space-y-8">
        {/* ─── Default domain ─── */}
        <SettingsGroup title="Default domain">
          <SettingsRow label="Address" interactive={false}>
            {loading ? (
              <Skeleton className="h-5 w-64" />
            ) : subdomain ? (
              <div className="flex items-center gap-2">
                <a
                  href={`https://${subdomain}.revyme.app`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-[var(--accent-text)] hover:underline truncate"
                >
                  {subdomain}.revyme.app
                </a>
                <CopyButton content={`https://${subdomain}.revyme.app`} />
                <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wider text-green-500 font-medium">
                  Always active
                </span>
              </div>
            ) : (
              <span className="text-sm text-[var(--text-tertiary)]">
                Auto-generated on first publish
              </span>
            )}
          </SettingsRow>
        </SettingsGroup>

        {/* ─── Custom subdomain ─── */}
        <SettingsGroup title="Custom subdomain">
          <SettingsRow label="Free revyme subdomain" htmlFor="custom-subdomain" align="top">
            {loading ? (
              <Skeleton className="h-7 w-72" />
            ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="flex items-center flex-1 min-w-0 gap-1">
                  <input
                    id="custom-subdomain"
                    type="text"
                    value={customSubdomain}
                    onChange={(e) => {
                      setCustomSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                      setCustomSubdomainError('');
                    }}
                    disabled={subdomainLocked || !!customSubdomainInDb}
                    placeholder="mygrocerystore"
                    className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] px-0 py-1 disabled:opacity-50"
                  />
                  <span className="shrink-0 text-sm text-[var(--text-tertiary)]">.revyme.app</span>
                </div>
                {!customSubdomainInDb && (
                  <RowButton
                    onClick={handleUpdateCustomSubdomain}
                    loading={isUpdatingCustomSubdomain}
                    variant="accent"
                    disabled={subdomainLocked || !customSubdomain}
                  >
                    Save
                  </RowButton>
                )}
                {customSubdomainInDb && (
                  <RowButton
                    onClick={handleRemoveCustomSubdomain}
                    loading={isUpdatingCustomSubdomain}
                    title="Remove custom subdomain"
                  >
                    Remove
                  </RowButton>
                )}
              </div>

              {customSubdomainError && (
                <p className="flex items-start gap-1.5 text-xs text-red-400">
                  <AlertIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{customSubdomainError}</span>
                </p>
              )}

              {subdomainLocked && !customSubdomainError && (
                <p className="text-xs text-[var(--text-tertiary)]">
                  Remove your custom domain to use a custom subdomain.
                </p>
              )}

              {customSubdomainInDb && !customSubdomainError && !subdomainLocked && (
                <p className="flex items-center gap-1.5 text-xs">
                  <CheckIcon size={14} className="text-green-500 shrink-0" />
                  <span className="text-[var(--text-secondary)]">
                    {isPublished ? 'Active at' : 'When published, will be active at'}
                  </span>
                  <a
                    href={`https://${customSubdomainInDb}.revyme.app`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--accent-text)] hover:underline"
                  >
                    {customSubdomainInDb}.revyme.app
                  </a>
                </p>
              )}

              {!customSubdomainInDb && !customSubdomainError && !subdomainLocked && (
                <p className="text-xs text-[var(--text-tertiary)]">
                  Only lowercase letters, numbers, and hyphens allowed.
                </p>
              )}
            </div>
            )}
          </SettingsRow>
        </SettingsGroup>

        {/* ─── Custom domain ─── */}
        <SettingsGroup title="Custom domain">
          <SettingsRow label="Connect your own domain" htmlFor="custom-domain" align="top">
            {loading ? (
              <Skeleton className="h-7 w-72" />
            ) : (
            <div className="flex flex-col gap-2">
              {/* Free plan + no domain yet — primary CTA is upgrade.
                  The backend 402s on attach anyway, so we surface the
                  upgrade path inline instead of letting the user type a
                  domain just to be rejected. */}
              {!customDomainInDb && isFreePlan && (
                <div className="flex items-center">
                  <RowButton
                    onClick={() => setActiveSection('plans')}
                    variant="accent"
                  >
                    Upgrade to Lite to connect custom domain
                  </RowButton>
                </div>
              )}

              {/* Paid plan + not connected yet — input + Connect */}
              {!customDomainInDb && !isFreePlan && (
                <div className="flex items-center gap-2">
                  <input
                    id="custom-domain"
                    type="text"
                    value={customDomain}
                    onChange={(e) => {
                      setCustomDomain(e.target.value.toLowerCase());
                      setCustomDomainError('');
                    }}
                    disabled={domainLocked}
                    placeholder="example.com"
                    className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] px-0 py-1 disabled:opacity-50"
                  />
                  <RowButton
                    onClick={handleUpdateCustomDomain}
                    loading={isUpdatingCustomDomain}
                    variant="accent"
                    disabled={domainLocked || !customDomain}
                  >
                    Connect
                  </RowButton>
                </div>
              )}

              {/* Connected — domain + live status + re-check + remove */}
              {customDomainInDb && (
                <div className="flex items-center gap-2">
                  <a
                    href={`https://${customDomainInDb}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-[var(--text-primary)] hover:text-[var(--accent-text)] truncate"
                  >
                    {customDomainInDb}
                  </a>
                  {customDomainDnsStatus === 'connected' ? (
                    <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">
                      <CheckIcon size={11} /> Live
                    </span>
                  ) : customDomainDnsStatus === 'checking' ? (
                    <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--bg-hover)] text-[var(--text-secondary)]">
                      <SettingsSpinner className="w-3 h-3" /> Checking
                    </span>
                  ) : customDomainDnsStatus === 'issuing' ? (
                    <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-[var(--accent)]/10 text-[var(--accent-text)]">
                      <SettingsSpinner className="w-3 h-3" /> Issuing SSL
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full bg-orange-500/10 text-orange-400">
                      Pending DNS
                    </span>
                  )}
                  <button
                    onClick={() => checkCustomDomainDns(customDomainInDb)}
                    disabled={customDomainDnsStatus === 'checking'}
                    title="Re-check DNS"
                    className="ml-auto shrink-0 p-1.5 cut-corners text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
                  >
                    <RefreshIcon
                      className={`w-3.5 h-3.5 ${customDomainDnsStatus === 'checking' ? 'animate-spin' : ''}`}
                    />
                  </button>
                  <RowButton onClick={handleRemoveCustomDomain} loading={isUpdatingCustomDomain}>
                    Remove
                  </RowButton>
                </div>
              )}

              {customDomainError && (
                <p className="flex items-start gap-1.5 text-xs text-red-400">
                  <AlertIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{customDomainError}</span>
                </p>
              )}

              {/* Locked: custom subdomain present */}
              {!!customSubdomainInDb && !customDomainError && (
                <p className="text-xs text-[var(--text-tertiary)]">
                  Remove your custom subdomain to connect a custom domain.
                </p>
              )}

              {/* (Free + no domain hint removed — the upgrade CTA button
                  above IS the call to action now.) */}

              {/* Expired subscription alert */}
              {customDomainInDb && isFreePlan && !customDomainError && (
                <p className="flex items-start gap-1.5 text-xs text-orange-400">
                  <AlertIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    Your subscription has expired. Upgrade to reactivate this domain, or
                    remove it above.
                  </span>
                </p>
              )}

              {/* Connected — all good */}
              {customDomainInDb && !customDomainError && customDomainDnsStatus === 'connected' && (
                <p className="text-xs text-[var(--text-secondary)]">
                  Your domain is live and secured with HTTPS — nothing else to do.
                </p>
              )}

              {/* Verified — SSL certificate still being issued */}
              {customDomainInDb && !customDomainError && customDomainDnsStatus === 'issuing' && (
                <p className="flex items-start gap-1.5 text-xs text-[var(--text-secondary)]">
                  <SettingsSpinner className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    DNS verified. Cloudflare is issuing the SSL certificate — this usually
                    takes a few minutes. Hit refresh to check.
                  </span>
                </p>
              )}

              {/* DNS instructions — only while the domain isn't pointing here yet */}
              {customDomainInDb &&
                (customDomainDnsStatus === 'not-connected' || customDomainDnsStatus === null) && (
                <div className="mt-1 cut-corners cut-border [--cut-border-color:var(--border-light)] border border-[var(--border-light)] bg-[var(--bg-hover)]/40 p-3 space-y-3">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-primary)]">
                    <GlobeIcon className="w-3.5 h-3.5 text-[var(--accent-text)]" />
                    Point your domain at Revyme
                  </p>
                  <p className="text-xs text-[var(--text-secondary)]">
                    Add one DNS record at your domain provider — the SSL certificate is
                    issued automatically once it points here, no other records needed.
                  </p>

                  {/* Subdomain — the reliable case */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-[var(--text-primary)]">
                      Recommended — connect a subdomain like www.{customApex}
                    </p>
                    <div className="ml-1 grid grid-cols-[56px_1fr] gap-x-2 gap-y-1 text-xs">
                      <span className="text-[var(--text-tertiary)]">Type</span>
                      <span className="text-[var(--text-primary)] font-medium">CNAME</span>
                      <span className="text-[var(--text-tertiary)]">Name</span>
                      <span className="text-[var(--text-primary)] font-medium">
                        www <span className="text-[var(--text-tertiary)] font-normal">(or your chosen subdomain)</span>
                      </span>
                      <span className="text-[var(--text-tertiary)]">Value</span>
                      <span className="text-[var(--accent-text)] font-medium">
                        {subdomain ? `${subdomain}.revyme.app` : 'your-site.revyme.app'}
                      </span>
                    </div>
                  </div>

                  {/* Apex — not recommended */}
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-[var(--text-primary)]">
                      Root domain ({customApex}) — not recommended
                    </p>
                    <p className="ml-1 text-xs text-[var(--text-secondary)]">
                      A root domain can't be a CNAME, and ALIAS / flattening doesn't reliably
                      verify with Cloudflare. Connect the{' '}
                      <span className="text-[var(--text-primary)]">www</span> subdomain above and
                      add a URL redirect from the root to it.
                    </p>
                  </div>

                  <p className="text-xs text-[var(--text-tertiary)]">
                    DNS changes can take up to a few hours to propagate.
                  </p>
                </div>
              )}
            </div>
            )}
          </SettingsRow>
        </SettingsGroup>
      </div>

      {/* Confirm Remove Custom Subdomain Modal */}
      <ConfirmModal
        isOpen={showRemoveCustomSubdomainConfirm}
        onConfirm={confirmRemoveCustomSubdomain}
        onCancel={() => setShowRemoveCustomSubdomainConfirm(false)}
        title="Remove custom subdomain"
        message="Are you sure you want to delete this subdomain? All people with this link will not have access to the website anymore."
        confirmText="Remove"
        cancelText="Cancel"
        variant="danger"
      />

      {/* Confirm Remove Custom Domain Modal */}
      <ConfirmModal
        isOpen={showRemoveCustomDomainConfirm}
        onConfirm={confirmRemoveCustomDomain}
        onCancel={() => setShowRemoveCustomDomainConfirm(false)}
        title="Remove custom domain"
        message="Are you sure you want to disconnect this domain? All people with this link will not have access to the website anymore."
        confirmText="Remove"
        cancelText="Cancel"
        variant="danger"
      />
    </>
  );
}
