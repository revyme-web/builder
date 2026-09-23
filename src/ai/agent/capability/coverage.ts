// capability/coverage.ts — the number this suite exists to produce.
//
// "Can the agent use Revyme?" used to be a belief. This turns it into a table:
// per area, how many features the agent can do end to end (PROVEN by a case),
// how many it cannot do yet (NAMED, with what would close them), and how many
// are broken (a case that should pass and does not).

import type { CapabilityCase, CaseResult, Domain } from './harness';

export const DOMAIN_LABEL: Record<Domain, string> = {
  components: 'Design components & variants',
  cms: 'CMS & collections',
  typography: 'Typography, tokens & paint',
  layout: 'Layout, sizing & responsive',
  motion: 'Motion, scroll & effects',
  'i18n-vars-forms': 'Localization, variables, interactions & forms',
  'code-plugins-templates': 'Code components, overrides, plugins & templates',
  'pages-assets': 'Pages, routing, assets & publish',
  branching: 'Branches — work on a copy, review, apply',
  skills: 'Project skills — the user’s saved instructions',
};

export interface DomainCoverage { domain: Domain; total: number; supported: number; missing: number; failing: number }

export function summarize(cases: readonly CapabilityCase[], results: readonly CaseResult[] = []): DomainCoverage[] {
  const failed = new Set(results.filter((r) => !r.ok).map((r) => r.id));
  return (Object.keys(DOMAIN_LABEL) as Domain[]).map((domain) => {
    const mine = cases.filter((c) => c.domain === domain);
    const failing = mine.filter((c) => c.status === 'supported' && failed.has(c.id)).length;
    return {
      domain,
      total: mine.length,
      supported: mine.filter((c) => c.status === 'supported').length - failing,
      missing: mine.filter((c) => c.status === 'missing').length,
      failing,
    };
  });
}

export function coverageTable(rows: readonly DomainCoverage[]): string {
  const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
  const lines = ['| Area | Features | Works | Not possible yet | Broken | Coverage |', '|---|---:|---:|---:|---:|---:|'];
  let t = 0, s = 0, m = 0, f = 0;
  for (const r of rows) {
    lines.push(`| ${DOMAIN_LABEL[r.domain]} | ${r.total} | ${r.supported} | ${r.missing} | ${r.failing} | ${pct(r.supported, r.total)} |`);
    t += r.total; s += r.supported; m += r.missing; f += r.failing;
  }
  lines.push(`| **Total** | **${t}** | **${s}** | **${m}** | **${f}** | **${pct(s, t)}** |`);
  return lines.join('\n');
}
