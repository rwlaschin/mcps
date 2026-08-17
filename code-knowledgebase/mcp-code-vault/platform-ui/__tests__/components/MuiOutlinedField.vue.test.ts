import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MuiOutlinedField from '../../components/MuiOutlinedField.vue'

describe('MuiOutlinedField', () => {
  it('emits update:modelValue on single-line input', async () => {
    const w = mount(MuiOutlinedField, {
      props: { id: 'f1', modelValue: '', label: 'Name' }
    })
    await w.find('input').setValue('x')
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['x'])
  })

  it('renders textarea when multiline and shows error text', () => {
    const w = mount(MuiOutlinedField, {
      props: {
        id: 'f2',
        modelValue: 'a',
        label: 'Body',
        multiline: true,
        error: 'Required'
      }
    })
    expect(w.find('textarea').exists()).toBe(true)
    expect(w.text()).toContain('Required')
  })

  it('renders select and emits on change', async () => {
    const w = mount(MuiOutlinedField, {
      props: {
        id: 'f3',
        modelValue: 'fast',
        label: 'Model category',
        select: true,
        options: [
          { value: 'fast', label: 'Fast' },
          { value: 'thinking', label: 'Thinking' }
        ]
      }
    })
    expect(w.find('select').exists()).toBe(true)
    await w.find('select').setValue('thinking')
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['thinking'])
  })
})
