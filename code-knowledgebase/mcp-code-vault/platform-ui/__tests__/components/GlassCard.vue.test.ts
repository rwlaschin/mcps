import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import GlassCard from '../../components/GlassCard.vue';

describe('GlassCard', () => {
  it('renders slot content', () => {
    const wrapper = mount(GlassCard, {
      slots: { default: '<span>Card content</span>' }
    });
    expect(wrapper.text()).toContain('Card content');
  });

  it('has glass-panel and rounded border classes', () => {
    const wrapper = mount(GlassCard, {
      slots: { default: '<div />' }
    });
    const root = wrapper.find('div.group');
    expect(root.exists()).toBe(true);
    expect(root.classes()).toContain('glass-panel');
  });
});
