import agentPipelineSampleStepsJson from './agentPipelineSampleSteps.json'

const agentPipelineSampleSteps = agentPipelineSampleStepsJson as unknown

export type StructureMode = 'unstructured' | 'structured'

/** MIME type stored for structured global prompt output */
export type StructureMime = 'application/json' | 'application/x-yaml-extended'

export const STRUCTURE_MIME_JSON: StructureMime = 'application/json'
export const STRUCTURE_MIME_YAML: StructureMime = 'application/x-yaml-extended'

/** Single preset id for the agent pipeline step array (more presets can be added later). */
export const AGENT_PIPELINE_STEPS_PRESET = 'agent_pipeline_steps'

export const AGENT_PIPELINE_FIELD_GUIDE: Record<string, string> = {
  instructions: '<instructions for the llm for what the task will be>',
  model: '<llm model>',
  avatars: '<array of avatar names>',
  tools: '<array of tool names>',
  contexts: '<index of instruction results that should be included with this command>',
  includeInResults: '<boolean, for only final output stages>',
  failureStep: "<what step should be moved to incase of 'failure'>",
  successStep: "<what step should be moved to incase of 'success'>"
}

export type PromptStructurePresetMeta = {
  id: string
  label: string
  fieldGuide: Record<string, string>
  sampleDocument: unknown
}

export const PROMPT_STRUCTURE_PRESETS: PromptStructurePresetMeta[] = [
  {
    id: AGENT_PIPELINE_STEPS_PRESET,
    label: 'Agent pipeline (steps array)',
    fieldGuide: AGENT_PIPELINE_FIELD_GUIDE,
    sampleDocument: agentPipelineSampleSteps
  }
]

export function getPromptStructurePreset(id: string): PromptStructurePresetMeta | undefined {
  return PROMPT_STRUCTURE_PRESETS.find((p) => p.id === id)
}

export const structurePresetSelectOptions = PROMPT_STRUCTURE_PRESETS.map((p) => ({
  value: p.id,
  label: p.label
}))

export const structureMimeSelectOptions: Array<{ value: StructureMime; label: string }> = [
  { value: STRUCTURE_MIME_JSON, label: 'application/json (canonical JSON)' },
  { value: STRUCTURE_MIME_YAML, label: 'YAML (extended)' }
]
