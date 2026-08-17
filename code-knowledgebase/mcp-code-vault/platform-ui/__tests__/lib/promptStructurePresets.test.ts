import { describe, expect, it } from 'vitest'
import {
  AGENT_PIPELINE_STEPS_PRESET,
  getPromptStructurePreset,
  PROMPT_STRUCTURE_PRESETS
} from '../../lib/promptStructurePresets'

describe('promptStructurePresets', () => {
  it('includes agent pipeline preset with sample array', () => {
    const p = getPromptStructurePreset(AGENT_PIPELINE_STEPS_PRESET)
    expect(p).toBeDefined()
    expect(Array.isArray(p!.sampleDocument)).toBe(true)
    expect((p!.sampleDocument as unknown[]).length).toBeGreaterThan(0)
    expect(Object.keys(p!.fieldGuide).length).toBeGreaterThan(0)
  })

  it('lists at least one preset', () => {
    expect(PROMPT_STRUCTURE_PRESETS.length).toBeGreaterThanOrEqual(1)
  })
})
