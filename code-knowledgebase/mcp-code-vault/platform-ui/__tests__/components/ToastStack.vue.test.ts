import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import ToastStack from '../../components/ToastStack.vue';
import { usePlatformToast } from '../../composables/usePlatformToast';

describe('ToastStack', () => {
  beforeEach(() => {
    const { toasts } = usePlatformToast();
    toasts.value = [];
  });

  it('renders success toasts from shared state', () => {
    const { success } = usePlatformToast();
    success('Saved');
    const wrapper = mount(ToastStack, { attachTo: document.body });
    try {
      expect(document.body.textContent).toContain('Saved');
    } finally {
      wrapper.unmount();
    }
  });

  it('renders error variant', () => {
    const { error } = usePlatformToast();
    error('Failed');
    const wrapper = mount(ToastStack, { attachTo: document.body });
    try {
      expect(document.body.textContent).toContain('Failed');
    } finally {
      wrapper.unmount();
    }
  });
});
