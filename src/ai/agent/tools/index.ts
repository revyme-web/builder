import type { AgentTool } from '@/ai/agent';
import { READ_TOOLS } from './read';
import { PROPERTY_TOOLS } from './semantic-property';
import { STRUCTURE_TOOLS } from './semantic-structure';
import { ACTION_TOOLS } from './action-layer';
import { RICH_ACTION_TOOLS } from './action-layer-rich';
import { setPageTool } from './set-page';
import { setPageVariableTool } from './set-page-variable';
import { setPageInteractionTool } from './set-page-interaction';
import { applyFileEditTool } from './whole-file';
import { batchTool } from './batch';
import { chainTool } from './chain';
import { verifyEffectTool } from './verify-effect';
import { submitPlanTool } from './meta';
import { getScreenshotTool } from './screenshot';

export { READ_TOOLS, PROPERTY_TOOLS, STRUCTURE_TOOLS, ACTION_TOOLS, RICH_ACTION_TOOLS, setPageTool, setPageVariableTool, setPageInteractionTool, applyFileEditTool, batchTool, chainTool, verifyEffectTool, submitPlanTool, getScreenshotTool };
export const ALL_TOOLS: AgentTool[] = [
  ...READ_TOOLS,
  ...PROPERTY_TOOLS,
  ...STRUCTURE_TOOLS,
  ...ACTION_TOOLS,
  ...RICH_ACTION_TOOLS,
  setPageTool,
  setPageVariableTool,
  setPageInteractionTool,
  applyFileEditTool,
  batchTool,
  chainTool,
  verifyEffectTool,
  submitPlanTool,
  getScreenshotTool,
];
