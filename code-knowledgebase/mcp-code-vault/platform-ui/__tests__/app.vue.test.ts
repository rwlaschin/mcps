import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import App from '../app.vue';

describe('App', () => {
  it('renders layout and page slot', () => {
    const wrapper = mount(App, {
      global: {
        stubs: {
          NuxtLayout: { template: '<div><slot /></div>' },
          NuxtPage: { template: '<div>page</div>' }
        }
      }
    });
    expect(wrapper.text()).toContain('page');
  });
});
