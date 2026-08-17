import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ModelCategoriesInput from '../../components/ModelCategoriesInput.vue'

describe('ModelCategoriesInput', () => {
  it('renders without throwing when modelValue is undefined', () => {
    const wrapper = mount(ModelCategoriesInput, {
      props: { modelValue: undefined as unknown as string[] }
    })
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true)
  })

  it('renders when modelValue is null', () => {
    const wrapper = mount(ModelCategoriesInput, {
      props: { modelValue: null as unknown as string[] }
    })
    expect(wrapper.text()).toContain('Fast')
  })

  it('reflects built-in selections from modelValue', () => {
    const wrapper = mount(ModelCategoriesInput, {
      props: { modelValue: ['fast', 'Vision'] }
    })
    const boxes = wrapper.findAll('input[type="checkbox"]')
    expect((boxes[0]!.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('Vision')
  })

  it('toggles built-in category and emits update', async () => {
    const wrapper = mount(ModelCategoriesInput, {
      props: { modelValue: ['fast'] }
    })
    const boxes = wrapper.findAll('input[type="checkbox"]')
    await boxes[1]!.setValue(true)
    expect(wrapper.emitted('update:modelValue')?.pop()?.[0]).toContain('blended')
  })

  it('removes a custom tag', async () => {
    const wrapper = mount(ModelCategoriesInput, {
      props: { modelValue: ['fast', 'Vision'] }
    })
    await wrapper.find('button[aria-label="Remove Vision"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')?.pop()?.[0]).toEqual(['fast'])
  })

  it('adds custom tag from input', async () => {
    const wrapper = mount(ModelCategoriesInput, {
      props: { modelValue: [] }
    })
    const text = wrapper.find('input[type="text"]')
    await text.setValue('custom-tag')
    await text.trigger('keydown.enter')
    expect(wrapper.emitted('update:modelValue')?.pop()?.[0]).toContain('custom-tag')
  })
})
