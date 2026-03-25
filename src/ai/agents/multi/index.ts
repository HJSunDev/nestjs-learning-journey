export { MultiAgentService } from './multi-agent.service';
export {
  type AgentDefinition,
  type MultiAgentInvokeParams,
  type MultiAgentInvokeResult,
} from './multi-agent.types';
export { buildSupervisorPrompt, SUB_AGENT_PROMPTS } from './supervisor';
export {
  buildResearchAgent,
  RESEARCH_AGENT_DEF,
  buildCodeAgent,
  CODE_AGENT_DEF,
} from './sub-agents';
