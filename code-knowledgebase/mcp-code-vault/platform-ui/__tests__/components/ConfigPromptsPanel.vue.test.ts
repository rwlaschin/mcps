import { describe, expect, it } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ConfigPromptsPanel from '../../components/ConfigPromptsPanel.vue'

const basePrompt = {
  _id: 'p1',
  name: 'User Request',
  prompt: 'body',
  usage_type: 'file processor',
  prompt_type: 'processing' as const,
  category: 'blended' as const,
  is_default: true,
  save_to_seed: true
}

describe('ConfigPromptsPanel', () => {
  it('shows structure preview when processing prompt is structured', () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [
          {
            _id: 'p1',
            name: 'User Request',
            prompt: 'body',
            usage_type: 'file processor',
            prompt_type: 'processing' as const,
            category: 'blended' as const,
            is_default: true,
            save_to_seed: true,
            structure_mode: 'structured' as const,
            structure_preset: 'agent_pipeline_steps',
            structure_mime: 'application/json' as const
          }
        ],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    expect(w.get('[data-testid="structure-guide-preview"]').text()).toContain('instructions')
    expect(w.get('[data-testid="structure-sample-preview"]').text()).toContain('gemini')
  })

  it('uses toggle buttons: Structured shows previews, Unstructured hides them', async () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [{ ...basePrompt }],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    expect(w.find('[data-testid="structure-guide-preview"]').exists()).toBe(false)
    await w.get('[data-testid="structure-toggle-structured"]').trigger('click')
    expect(w.get('[data-testid="structure-guide-preview"]').text()).toContain('instructions')
    await w.get('[data-testid="structure-toggle-unstructured"]').trigger('click')
    expect(w.find('[data-testid="structure-guide-preview"]').exists()).toBe(false)
  })

  it('switches sample preview to YAML when serialization is YAML extended', async () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [
          {
            _id: 'p1',
            name: 'User Request',
            prompt: 'body',
            usage_type: 'file processor',
            prompt_type: 'processing' as const,
            category: 'blended' as const,
            is_default: true,
            save_to_seed: true,
            structure_mode: 'structured' as const,
            structure_preset: 'agent_pipeline_steps',
            structure_mime: 'application/json' as const
          }
        ],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    const mimeSelect = w.findAll('select').find((s) => s.attributes('id') === 'prompt-structure-mime')
    expect(mimeSelect?.exists()).toBe(true)
    await mimeSelect!.setValue('application/x-yaml-extended')
    const sample = w.get('[data-testid="structure-sample-preview"]').text()
    expect(sample).toMatch(/^-/)
    expect(sample).toContain('instructions:')
  })

  it('emits save with structure fields', async () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [
          {
            _id: 'p1',
            name: 'A',
            prompt: 'body',
            usage_type: 'file processor',
            prompt_type: 'processing' as const,
            category: 'fast' as const,
            is_default: false,
            save_to_seed: false
          }
        ],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    await w.find('form').trigger('submit.prevent')
    expect(w.emitted('save')?.[0]?.[0]).toMatchObject({
      structure_mode: 'unstructured',
      structure_preset: 'agent_pipeline_steps',
      structure_mime: 'application/json'
    })
  })

  it('emits select when choosing another saved prompt', async () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [
          { ...basePrompt, _id: 'p1', name: 'One' },
          { ...basePrompt, _id: 'p2', name: 'Two' }
        ],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    const buttons = w.findAll('aside button')
    await buttons[1]!.trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['p2'])
  })

  it('exposed startNewDraft clears selection and form', async () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [{ ...basePrompt }],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    const vm = w.vm as { startNewDraft?: () => void }
    vm.startNewDraft!()
    await flushPromises()
    expect(w.emitted('select')?.some((e) => e[0] === '')).toBe(true)
  })

  it('shows validation errors when name or body empty', async () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [],
        selectedPromptId: '',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    await w.find('form').trigger('submit.prevent')
    expect(w.emitted('save')).toBeFalsy()
    expect(w.text()).toContain('Name is required')
    expect(w.text()).toContain('Prompt body is required')
  })

  it('coerces unknown structure preset when loading a prompt', async () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [
          {
            ...basePrompt,
            structure_mode: 'structured' as const,
            structure_preset: 'no-such-preset',
            structure_mime: 'application/json' as const
          }
        ],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    await flushPromises()
    const preset = w.find('#prompt-structure-preset')
    expect((preset.element as HTMLSelectElement).value).toBe('agent_pipeline_steps')
  })

  it('emits save with YAML extended mime when draft uses it', async () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [
          {
            ...basePrompt,
            structure_mode: 'structured' as const,
            structure_preset: 'agent_pipeline_steps',
            structure_mime: 'application/x-yaml-extended' as const
          }
        ],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    const vm = w.vm as { submitDraft?: () => void }
    vm.submitDraft!()
    expect(w.emitted('save')?.[0]?.[0]).toMatchObject({
      structure_mime: 'application/x-yaml-extended'
    })
  })

  it('shows usage type combobox input', () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [{ ...basePrompt }],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    expect(w.find('#prompt-usage-type').exists()).toBe(true)
  })

  it('shows output shape toggles for non–file-processor usage types', () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [
          {
            ...basePrompt,
            usage_type: 'user request',
            prompt_type: 'agent' as const
          }
        ],
        selectedPromptId: 'p1',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    expect(w.find('[data-testid="structure-toggle-unstructured"]').exists()).toBe(true)
    expect(w.find('[data-testid="structure-toggle-structured"]').exists()).toBe(true)
  })

  it('resets draft when selected id is missing from list', async () => {
    const w = mount(ConfigPromptsPanel, {
      props: {
        prompts: [{ ...basePrompt }],
        selectedPromptId: 'ghost',
        seedWriteEnabled: true
      },
      global: {
        stubs: { GlassCard: { template: '<div><slot /></div>' } }
      }
    })
    await flushPromises()
    const nameInput = w.find('#prompt-name')
    expect((nameInput.element as HTMLInputElement).value).toBe('')
  })
})
