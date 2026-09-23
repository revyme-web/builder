import type { CapabilityCase } from '../harness';
import { COMPONENT_CASES } from './components';
import { CMS_CASES } from './cms';
import { TYPOGRAPHY_CASES } from './typography';
import { LAYOUT_CASES } from './layout';
import { LAYOUT_MORE_CASES } from './layout-more';
import { MOTION_CASES } from './motion';
import { I18N_VARS_FORMS_CASES } from './i18n-vars-forms';
import { CODE_PLUGINS_TEMPLATES_CASES } from './code-plugins-templates';
import { PAGES_ASSETS_CASES } from './pages-assets';
import { BRANCHING_CASES } from './branching';
import { SKILLS_CASES } from './skills';

export const ALL_CASES: CapabilityCase[] = [
  ...COMPONENT_CASES,
  ...CMS_CASES,
  ...TYPOGRAPHY_CASES,
  ...LAYOUT_CASES,
  ...LAYOUT_MORE_CASES,
  ...MOTION_CASES,
  ...I18N_VARS_FORMS_CASES,
  ...CODE_PLUGINS_TEMPLATES_CASES,
  ...PAGES_ASSETS_CASES,
  ...BRANCHING_CASES,
  ...SKILLS_CASES,
];
