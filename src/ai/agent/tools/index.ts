import type { AgentTool } from '@/ai/agent';
import { READ_TOOLS } from './read';
import { PROPERTY_TOOLS } from './semantic-property';
import { STRUCTURE_TOOLS } from './semantic-structure';
import { ACTION_TOOLS } from './action-layer';
import { RICH_ACTION_TOOLS } from './action-layer-rich';
import { setPageTool } from './set-page';
import { setPageVariableTool, bindVariableTool } from './set-page-variable';
import { setPageInteractionTool } from './set-page-interaction';
import { applyFileEditTool } from './whole-file';
import { batchTool } from './batch';
import { chainTool } from './chain';
import { verifyEffectTool } from './verify-effect';
import { submitPlanTool } from './meta';
import { getScreenshotTool } from './screenshot';
import { CMS_TOOLS } from './cms';
import { loadSkillTool, componentExampleTool, getDialectTool } from './skills';
import { searchImagesTool } from './images';
import { setLinkTool } from './links';
import { COMPONENT_MORE_TOOLS } from './components-more';
import { TOKEN_TOOLS } from './tokens';
import { LAYOUT_MORE_TOOLS } from './layout-more';
import { CMS_MORE_TOOLS } from './cms-more';
import { PAGES_MORE_TOOLS } from './pages-more';
import { MOTION_MORE_TOOLS } from './motion-more';
import { I18N_TOOLS } from './i18n';
import { BUILT_IN_TOOLS } from './built-ins';
import { FORMS_TEXT_TOOLS } from './forms-text';
import { SITE_MOTION_TOOLS } from './site-motion';
import { VIEWPORT_TOOLS } from './viewports';
import { ICON_TOOLS } from './icons';
import { OVERRIDE_TOOLS } from './overrides';
import { ASSET_TOOLS } from './assets';
import { SLOT_TOOLS } from './slots';
import { PLUGIN_TOOLS } from './plugins';
import { BRANCH_TOOLS } from './branches';
import { PROJECT_SKILL_TOOLS } from './project-skills';

export { READ_TOOLS, PROPERTY_TOOLS, STRUCTURE_TOOLS, ACTION_TOOLS, RICH_ACTION_TOOLS, setPageTool, setPageVariableTool, setPageInteractionTool, applyFileEditTool, batchTool, chainTool, verifyEffectTool, submitPlanTool, getScreenshotTool, CMS_TOOLS, loadSkillTool, searchImagesTool, setLinkTool, COMPONENT_MORE_TOOLS, TOKEN_TOOLS, LAYOUT_MORE_TOOLS, CMS_MORE_TOOLS, PAGES_MORE_TOOLS, MOTION_MORE_TOOLS, I18N_TOOLS, BUILT_IN_TOOLS, FORMS_TEXT_TOOLS, SITE_MOTION_TOOLS, VIEWPORT_TOOLS, ICON_TOOLS, OVERRIDE_TOOLS, ASSET_TOOLS, SLOT_TOOLS, PLUGIN_TOOLS, BRANCH_TOOLS, PROJECT_SKILL_TOOLS };
export const ALL_TOOLS: AgentTool[] = [
  ...READ_TOOLS,
  ...PROPERTY_TOOLS,
  ...STRUCTURE_TOOLS,
  ...ACTION_TOOLS,
  ...RICH_ACTION_TOOLS,
  setPageTool,
  setPageVariableTool,
  bindVariableTool,
  setPageInteractionTool,
  applyFileEditTool,
  batchTool,
  chainTool,
  verifyEffectTool,
  submitPlanTool,
  getScreenshotTool,
  ...CMS_TOOLS,
  loadSkillTool,
  componentExampleTool,
  getDialectTool,
  searchImagesTool,
  setLinkTool,
  ...COMPONENT_MORE_TOOLS,
  ...TOKEN_TOOLS,
  ...LAYOUT_MORE_TOOLS,
  ...CMS_MORE_TOOLS,
  ...PAGES_MORE_TOOLS,
  ...MOTION_MORE_TOOLS,
  ...I18N_TOOLS,
  ...BUILT_IN_TOOLS,
  ...FORMS_TEXT_TOOLS,
  ...SITE_MOTION_TOOLS,
  ...VIEWPORT_TOOLS,
  ...ICON_TOOLS,
  ...OVERRIDE_TOOLS,
  ...ASSET_TOOLS,
  ...SLOT_TOOLS,
  ...PLUGIN_TOOLS,
  ...BRANCH_TOOLS,
  ...PROJECT_SKILL_TOOLS,
];
