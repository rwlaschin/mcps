import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PlatformProjectSelect from '../../components/PlatformProjectSelect.vue';

describe('PlatformProjectSelect', () => {
  it('renders options and a decorative chevron', () => {
    const wrapper = mount(PlatformProjectSelect, {
      props: {
        modelValue: '',
        projects: [
          { key: 'default', name: 'Default Project' },
          { key: 'x', name: 'Other' }
        ],
        loading: false
      }
    });
    expect(wrapper.find('select').exists()).toBe(true);
    expect(wrapper.find('select option').exists()).toBe(true);
    expect(wrapper.html()).toContain('Default Project');
    expect(wrapper.html()).not.toContain('Default Project (default)');
    expect(wrapper.find('svg').exists()).toBe(true);
  });

  it('shows project key in parentheses when two projects share the same display name', () => {
    const wrapper = mount(PlatformProjectSelect, {
      props: {
        modelValue: '',
        projects: [
          { key: 'acme-dev', name: 'Acme' },
          { key: 'acme-prod', name: 'Acme' }
        ],
        loading: false
      }
    });
    expect(wrapper.html()).toContain('Acme (acme-dev)');
    expect(wrapper.html()).toContain('Acme (acme-prod)');
  });
});
