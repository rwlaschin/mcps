import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import Config from '../../pages/config.vue';
import GlassCard from '../../components/GlassCard.vue';
import PlatformProjectSelect from '../../components/PlatformProjectSelect.vue';
import ConfigPromptsPanel from '../../components/ConfigPromptsPanel.vue';
import { MOCK_STATS_URL } from '../../testConstants';

const mockSocketHandlers: Record<string, (...args: unknown[]) => void> = {};

const mockSocket = {
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    mockSocketHandlers[event] = fn;
    return mockSocket;
  }),
  disconnect: vi.fn()
};

const mockIo = vi.fn(() => mockSocket);
const mockFetch = vi.fn();

const mockRoute = { path: '/config', hash: '#settings' };

const mockPush = vi.fn(() => Promise.resolve());
vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => ({ push: mockPush }),
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn()
}));

vi.mock('../../composables/usePlatformToast', () => ({
  usePlatformToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
    toasts: { value: [] }
  })
}));

vi.mock('../../lib/socketIoClient', () => ({
  io: (...args: unknown[]) => mockIo(...args)
}));

vi.mock('../../composables/useStreamTargetUrl', () => ({
  useStreamTargetUrl: () => ref(MOCK_STATS_URL)
}));

const configPageStubs = {
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  Icon: { template: '<span />' }
};

describe('Config page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPush.mockClear();
    mockFetch.mockReset();
    mockRoute.path = '/config';
    mockRoute.hash = '#settings';
    Object.keys(mockSocketHandlers).forEach((k) => delete mockSocketHandlers[k]);
    vi.stubGlobal('fetch', mockFetch);
  });

  it('renders Config title and project selector', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ projects: [] })
    });

    const wrapper = mount(Config, {
      global: {
        components: { GlassCard, PlatformProjectSelect },
        stubs: { ...configPageStubs }
      }
    });

    await flushPromises();
    expect(wrapper.text()).toContain('Config');
    expect(wrapper.text()).toContain('Settings');
    expect(wrapper.find('select').exists()).toBe(true);
  });

  it('shows Settings body (not a blank transition subtree) when hash is #settings', async () => {
    mockRoute.hash = '#settings';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ projects: [] })
    });
    const wrapper = mount(Config, {
      global: {
        components: { GlassCard, PlatformProjectSelect },
        stubs: {
          ...configPageStubs,
          ConfigPromptsPanel: true,
          ConfigModelsPanel: true,
          ConfigPersonasPanel: true,
          ConfigAgentsPanel: true
        }
      }
    });
    await flushPromises();
    expect(wrapper.text()).toMatch(/Settings/);
    expect(wrapper.text()).toMatch(/Select a project to load config/);
  });

  it('shows Prompts panel when hash is #prompts-global', async () => {
    mockRoute.hash = '#prompts-global';
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects: [] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            prompts: [],
            seedWriteEnabled: false
          })
      });
    const wrapper = mount(Config, {
      global: {
        components: { GlassCard, PlatformProjectSelect, ConfigPromptsPanel },
        stubs: {
          ...configPageStubs,
          ConfigModelsPanel: true,
          ConfigPersonasPanel: true,
          ConfigAgentsPanel: true
        }
      }
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Prompts');
  });

  it('refreshes project selector when project event is received', async () => {
    // URL-based mock: extra /projects calls (e.g. socket connect) must not consume a fixed Once chain.
    let projectsFetchCount = 0;
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/projects')) {
        projectsFetchCount += 1;
        if (projectsFetchCount === 1) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ projects: [] }) });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              projects: [{ key: 'default', name: 'Default Project' }]
            })
        });
      }
      if (url.includes('/config') && url.includes('projectKey')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ config: 'Code-vault config' })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const wrapper = mount(Config, {
      global: {
        components: { GlassCard, PlatformProjectSelect },
        stubs: { ...configPageStubs }
      }
    });

    await flushPromises();

    const cb = mockSocketHandlers['project'];
    expect(cb).toBeDefined();

    cb!('{"projectKey":"default","action":"created"}');
    await wrapper.vm.$nextTick();
    await flushPromises();

    expect(wrapper.text()).toContain('Default Project');
    expect(wrapper.text()).toContain('Code-vault config');
  });

  it('syncs section from hash when path is /config/ (trailing slash)', async () => {
    mockRoute.path = '/config/';
    mockRoute.hash = '#models';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ projects: [] })
    });

    const wrapper = mount(Config, {
      global: {
        components: { GlassCard, PlatformProjectSelect },
        stubs: {
          ...configPageStubs,
          ConfigPromptsPanel: true,
          ConfigModelsPanel: { template: '<div class="models-stub">Model providers</div>' },
          ConfigPersonasPanel: true,
          ConfigAgentsPanel: true
        }
      }
    });

    await flushPromises();
    expect(wrapper.find('.models-stub').exists()).toBe(true);
  });

  it('fetches agents from the stats API after projects load when hash is #prompts-agents', async () => {
    mockRoute.hash = '#prompts-agents';
    mockFetch.mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/projects')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ projects: [{ key: 'acme', name: 'Acme' }] })
        });
      }
      if (url.includes('/config/models') && !url.includes('discover')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ models: [] })
        });
      }
      if (url.includes('/config/personas')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ personas: [], seedWriteEnabled: false })
        });
      }
      if (url.includes('/config/agents')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ agents: [], seedWriteEnabled: false })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    mount(Config, {
      global: {
        components: { GlassCard, PlatformProjectSelect },
        stubs: {
          ...configPageStubs,
          ConfigPromptsPanel: true,
          ConfigModelsPanel: true,
          ConfigPersonasPanel: true,
          ConfigAgentsPanel: { template: '<div class="agents-stub" />' }
        }
      }
    });

    await flushPromises();
    const agentCalls = mockFetch.mock.calls.filter((c) => {
      if (typeof c[0] !== 'string') return false;
      const path = (c[0] as string).split('?')[0];
      return path.endsWith('/config/agents');
    });
    expect(agentCalls.length).toBeGreaterThanOrEqual(1);
  });
});
