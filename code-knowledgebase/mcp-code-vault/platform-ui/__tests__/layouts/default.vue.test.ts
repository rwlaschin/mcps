import { nextTick } from 'vue';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import DefaultLayout from '../../layouts/default.vue';
import { DOCS_NAV_AGENT_ENTRIES_KEY } from '../../composables/useDocsNavAgentEntries';

const mockUseRoute = vi.fn();
const mockUseRouter = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: () => mockUseRoute(),
  useRouter: () => mockUseRouter()
}));

const nuxtLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>'
};

describe('Default layout', () => {
  beforeEach(() => {
    mockUseRoute.mockReturnValue({ path: '/', hash: '' });
    mockUseRouter.mockReturnValue({ replace: vi.fn(), push: vi.fn() });
    (globalThis as unknown as { useState: (k: string, init: () => unknown) => { value: unknown } }).useState(
      DOCS_NAV_AGENT_ENTRIES_KEY,
      () => []
    ).value = [];
  });

  it('renders sidebar with Stats, Config, Scan, Docs links', () => {
    const wrapper = mount(DefaultLayout, {
      slots: { default: '<div>page content</div>' },
      global: {
        stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
      }
    });
    expect(wrapper.text()).toContain('Stats');
    expect(wrapper.text()).toContain('Config');
    expect(wrapper.text()).toContain('Scan');
    expect(wrapper.text()).toContain('Docs');
    expect(wrapper.text()).toContain('page content');
  });

  it('when route is /docs, shows doc subheadings with correct hrefs', () => {
    mockUseRoute.mockReturnValue({ path: '/docs', hash: '' });
    const wrapper = mount(DefaultLayout, {
      slots: { default: '<div>docs</div>' },
      global: {
        stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
      }
    });
    const links = wrapper.findAll('a[href^="#"]');
    expect(links.length).toBe(8);
    expect(links.map((l) => l.attributes('href'))).toEqual([
      '#quick-start',
      '#setting-up-mcp-cursor',
      '#using-the-mcp',
      '#tool-ping',
      '#tool-settings',
      '#tool-config',
      '#user-interface',
      '#configuration'
    ]);
    expect(wrapper.text()).toContain('Quick start');
    expect(wrapper.text()).toContain('MCP setup in Cursor');
    expect(wrapper.text()).toContain('MCP tools reference');
    expect(wrapper.text()).toContain('ping');
    expect(wrapper.text()).toContain('settings');
    expect(wrapper.text()).toContain('config');
    expect(wrapper.text()).toContain('Platform UI');
  });

  it('when route is not /docs, does not show doc subheadings', () => {
    mockUseRoute.mockReturnValue({ path: '/' });
    const wrapper = mount(DefaultLayout, {
      slots: { default: '<div>stats</div>' },
      global: {
        stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
      }
    });
    const hashLinks = wrapper.findAll('a[href^="#"]');
    expect(hashLinks.length).toBe(0);
  });

  it('when route is /config but route.hash lags, uses window.location.hash for Personas highlight', async () => {
    mockUseRoute.mockReturnValue({ path: '/config', hash: '' });
    const replace = vi.fn();
    mockUseRouter.mockReturnValue({ replace, push: vi.fn() });
    vi.stubGlobal('window', { location: { hash: '#prompts-personas' } });
    try {
      const wrapper = mount(DefaultLayout, {
        slots: { default: '<div>config</div>' },
        global: {
          stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
        }
      });
      await nextTick();
      const personasLink = wrapper.find('a[href="/config#prompts-personas"]');
      expect(personasLink.exists()).toBe(true);
      expect(personasLink.classes()).toContain('bg-white/10');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('when route is /config, shows config subnav with /config# links', () => {
    mockUseRoute.mockReturnValue({ path: '/config', hash: '#settings' });
    const wrapper = mount(DefaultLayout, {
      slots: { default: '<div>config</div>' },
      global: {
        stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
      }
    });
    const links = wrapper.findAll('a[href^="/config#"]');
    expect(links.length).toBe(6);
    expect(links.map((l) => l.attributes('href'))).toEqual([
      '/config#settings',
      '/config#models',
      '/config#prompts-global',
      '/config#prompts-global',
      '/config#prompts-agents',
      '/config#prompts-personas'
    ]);
    expect(wrapper.text()).toContain('Settings');
    expect(wrapper.text()).toContain('Models');
    expect(wrapper.text()).toContain('Prompts');
    expect(wrapper.text()).toContain('Global');
    expect(wrapper.text()).toContain('Agents');
    expect(wrapper.text()).toContain('Personas');
  });

  it('when route is /config/ (trailing slash), shows config subnav', () => {
    mockUseRoute.mockReturnValue({ path: '/config/', hash: '#settings' });
    const wrapper = mount(DefaultLayout, {
      slots: { default: '<div>config</div>' },
      global: {
        stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
      }
    });
    expect(wrapper.findAll('a[href^="/config#"]').length).toBe(6);
  });

  it('when route is not /config, does not show config subnav links', () => {
    mockUseRoute.mockReturnValue({ path: '/docs', hash: '' });
    const wrapper = mount(DefaultLayout, {
      slots: { default: '<div>docs</div>' },
      global: {
        stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
      }
    });
    expect(wrapper.findAll('a[href^="/config#"]').length).toBe(0);
  });

  it('clicking a config section link uses router.push with full /config# path (hash-only nav)', async () => {
    mockUseRoute.mockReturnValue({ path: '/config', hash: '#models' });
    const push = vi.fn();
    mockUseRouter.mockReturnValue({ replace: vi.fn(), push });
    const wrapper = mount(DefaultLayout, {
      slots: { default: '<div>config</div>' },
      global: {
        stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
      }
    });
    const promptsLink = wrapper.find('a[href="/config#prompts-global"]');
    await promptsLink.trigger('click', { preventDefault: () => {} });
    expect(push).toHaveBeenCalledWith('/config#prompts-global');
  });

  it('clicking a doc section link calls scrollToDocSection (router.push + scrollIntoView)', async () => {
    mockUseRoute.mockReturnValue({ path: '/docs', hash: '' });
    const push = vi.fn();
    mockUseRouter.mockReturnValue({ replace: vi.fn(), push });
    const scrollIntoView = vi.fn();
    vi.spyOn(document, 'getElementById').mockReturnValue({ scrollIntoView } as unknown as HTMLElement);
    const wrapper = mount(DefaultLayout, {
      slots: { default: '<div>docs</div>' },
      global: {
        stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
      }
    });
    const quickStartLink = wrapper.findAll('a[href="#quick-start"]')[0];
    await quickStartLink.trigger('click', { preventDefault: () => {} });
    expect(push).toHaveBeenCalledWith('/docs#quick-start');
    expect(document.getElementById).toHaveBeenCalledWith('quick-start');
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('when route is /docs and docs-nav-agent-entries has items, shows agent hash links', () => {
    mockUseRoute.mockReturnValue({ path: '/docs', hash: '' });
    (globalThis as unknown as { useState: (k: string, init: () => unknown) => { value: unknown } }).useState(
      DOCS_NAV_AGENT_ENTRIES_KEY,
      () => []
    ).value = [{ id: 'tool-agent-abc', label: 'My Agent', depth: 1 }];
    const wrapper = mount(DefaultLayout, {
      slots: { default: '<div>docs</div>' },
      global: {
        stubs: { NuxtLink: nuxtLinkStub, ToastStack: true }
      }
    });
    const agentLink = wrapper.find('a[href="#tool-agent-abc"]');
    expect(agentLink.exists()).toBe(true);
    expect(agentLink.text()).toContain('My Agent');
  });
});
