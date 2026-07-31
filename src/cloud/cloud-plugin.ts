// cloud-plugin.ts — Registers cloud/SaaS settings sections into the plugin registry.
// Called once at app boot (e.g. in App.tsx) so the SettingsOverlay picks them up.

import { registerSettingsSection } from '@/plugins/plugin-registry';
import {
  SettingsDomainIcon,
  SettingsPlansIcon,
  SettingsAnalyticsIcon,
  SettingsBackupsIcon,
  SettingsStagingIcon,
  SettingsConnectAiIcon,
  SettingsAbTestsIcon,
  PagesLayersIcon,
} from '@/shared/icons';
import DomainSection from './settings/DomainSection';
import PlansSection from './settings/PlansSection';
import AnalyticsSection from './settings/AnalyticsSection';
import BackupsSection from './settings/BackupsSection';
import EnvironmentsSection from './settings/EnvironmentsSection';
import AbTestsSection from './settings/AbTestsSection';
import PagesSeoSection from './settings/PagesSeoSection';
import ConnectAiSection from './settings/ConnectAiSection';

export function initCloudPlugin(): void {
  // Pages — per-page SEO. Sits right after Website in General because
  // it's a sibling concept (one is site-level metadata, the other is
  // per-route). Sub-state (which page is selected) lives in
  // `selectedSeoPageAtom`; URL encoding is `?settings=pages:<slug>`.
  registerSettingsSection({
    id: 'pages',
    label: 'Pages',
    icon: PagesLayersIcon,
    category: 'General',
    component: PagesSeoSection,
    order: 0,
  });
  registerSettingsSection({
    id: 'domain',
    label: 'Domain',
    icon: SettingsDomainIcon,
    category: 'General',
    component: DomainSection,
    order: 1,
  });
  registerSettingsSection({
    id: 'plans',
    label: 'Plans',
    icon: SettingsPlansIcon,
    category: 'General',
    component: PlansSection,
    order: 2,
  });
  registerSettingsSection({
    id: 'backups',
    label: 'Backups',
    icon: SettingsBackupsIcon,
    category: 'General',
    component: BackupsSection,
    order: 3,
  });
  registerSettingsSection({
    id: 'staging',
    label: 'Staging',
    icon: SettingsStagingIcon,
    category: 'General',
    component: EnvironmentsSection,
    order: 4,
  });
  registerSettingsSection({
    id: 'connect-ai',
    label: 'Connect AI / MCP',
    icon: SettingsConnectAiIcon,
    category: 'General',
    component: ConnectAiSection,
    order: 5,
  });
  registerSettingsSection({
    id: 'ab-tests',
    label: 'A/B Tests',
    icon: SettingsAbTestsIcon,
    category: 'Insights',
    component: AbTestsSection,
    order: 1,
  });
  registerSettingsSection({
    id: 'analytics',
    label: 'Analytics',
    icon: SettingsAnalyticsIcon,
    category: 'Insights',
    component: AnalyticsSection,
    order: 0,
  });
}
