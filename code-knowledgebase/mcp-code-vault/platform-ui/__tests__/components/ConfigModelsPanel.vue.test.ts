import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfigModelsPanel from '../../components/ConfigModelsPanel.vue'

describe('ConfigModelsPanel', () => {
  it('mounts with grouped saved models and shows provider actions', () => {
    const wrapper = mount(ConfigModelsPanel, {
      props: {
        savedModels: [
          {
            _id: '1',
            provider: 'gemini',
            name: 'models/x',
            label: 'Model X',
            access_key: 'secret-key-long'
          },
          {
            _id: '2',
            provider: 'gemini',
            name: 'models/y',
            label: 'Model Y',
            access_key: 'secret-key-long'
          }
        ],
        discoveredModels: []
      },
      global: {
        stubs: {
          GlassCard: { template: '<div><slot /></div>' },
          StyleUiButton: { template: '<button type="button"><slot /></button>' },
          Icon: true,
          ModelCategoriesInput: true,
          Teleport: { template: '<div><slot /></div>' }
        }
      }
    })
    expect(wrapper.text()).toContain('GEMINI')
    expect(wrapper.text()).toContain('2 saved')
    const buttons = wrapper.findAll('button')
    expect(buttons.length).toBeGreaterThan(0)
  })

  it('splits same vendor into separate rows when credential_id differs', () => {
    const wrapper = mount(ConfigModelsPanel, {
      props: {
        savedModels: [
          {
            _id: '1',
            provider: 'gemini',
            credential_id: '507f1f77bcf86cd7994390a1',
            name: 'models/x',
            label: 'Model X',
            access_key: 'key-aaaa'
          },
          {
            _id: '2',
            provider: 'gemini',
            credential_id: '507f1f77bcf86cd7994390a2',
            name: 'models/x',
            label: 'Model X copy',
            access_key: 'key-bbbb'
          }
        ],
        discoveredModels: []
      },
      global: {
        stubs: {
          GlassCard: { template: '<div><slot /></div>' },
          StyleUiButton: { template: '<button type="button"><slot /></button>' },
          Icon: true,
          ModelCategoriesInput: true,
          Teleport: { template: '<div><slot /></div>' }
        }
      }
    })
    const t = wrapper.text()
    expect(t.match(/GEMINI/g)?.length).toBe(2)
    expect(t.match(/1 saved/g)?.length).toBe(2)
  })

  it('remote wizard catalog row tolerates missing capabilities', async () => {
    const wrapper = mount(ConfigModelsPanel, {
      props: {
        savedModels: [],
        discoveredModels: [
          {
            id: 'm1',
            name: 'm1',
            label: 'L1',
            capabilities: undefined as unknown as string[]
          }
        ]
      },
      global: {
        stubs: {
          GlassCard: { template: '<div><slot /></div>' },
          StyleUiButton: { template: '<button type="button"><slot /></button>' },
          Icon: true,
          ModelCategoriesInput: true,
          Teleport: { template: '<div><slot /></div>' }
        }
      }
    })
    await wrapper.vm.openRemoteModal()
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('New remote model provider')
    expect(wrapper.text()).toContain('L1')
  })

  it('clears API key, catalog filter, and custom tab defaults when provider changes', async () => {
    const wrapper = mount(ConfigModelsPanel, {
      props: { savedModels: [], discoveredModels: [] },
      global: {
        stubs: {
          GlassCard: { template: '<div><slot /></div>' },
          StyleUiButton: { template: '<button type="button"><slot /></button>' },
          Icon: true,
          ModelCategoriesInput: true,
          Teleport: { template: '<div><slot /></div>' }
        }
      }
    })
    await wrapper.vm.openRemoteModal()
    await wrapper.vm.$nextTick()

    expect((wrapper.find('#wiz-provider').element as HTMLSelectElement).value).toBe('openai')

    await wrapper.find('#wiz-key').setValue('sk-test-secret')
    await wrapper.vm.$nextTick()

    await wrapper.find('#wiz-provider').setValue('anthropic')
    await wrapper.vm.$nextTick()

    expect((wrapper.find('#wiz-provider').element as HTMLSelectElement).value).toBe('anthropic')
    expect((wrapper.find('#wiz-key').element as HTMLInputElement).value).toBe('')
    expect(wrapper.emitted('clear-discovered')?.length).toBeGreaterThan(0)
  })
})
