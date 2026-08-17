/**
 * Integration tests for config.vue's reactive primary-URL watcher.
 *
 * Key contract under test:
 *   1. No data fetches happen when the primary URL is unknown.
 *   2. The moment `configBaseUrl` (streamTargetUrl || primaryBaseUrl) becomes truthy,
 *      the watcher fires and fetches data for the active section.
 *   3. All requests go directly to the primary URL — never through /api/stats.
 *   4. If the URL changes (primary moves ports), the socket disconnects and reconnects,
 *      and data is re-fetched from the new URL.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { ref } from 'vue';
import Config from '../../pages/config.vue';
import GlassCard from '../../components/GlassCard.vue';
import PlatformProjectSelect from '../../components/PlatformProjectSelect.vue';
import { MOCK_STATS_URL } from '../../testConstants';

// Mutable refs — tests write to these to simulate discovery events.
const streamTargetUrl = ref('');
const primaryBaseUrl = ref('');

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

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => ({ push: vi.fn() }),
  onBeforeRouteLeave: vi.fn(),
  onBeforeRouteUpdate: vi.fn()
}));

vi.mock('../../composables/usePlatformToast', () => ({
  usePlatformToast: () => ({
    success: vi.fn(), error: vi.fn(), dismiss: vi.fn(), toasts: { value: [] }
  })
}));

vi.mock('../../lib/socketIoClient', () => ({
  io: (...args: unknown[]) => mockIo(...args)
}));

// Return our mutable refs so tests can change the URL mid-test.
vi.mock('../../composables/useStreamTargetUrl', () => ({
  useStreamTargetUrl: () => streamTargetUrl
}));
vi.mock('../../composables/usePrimaryBaseUrl', () => ({
  usePrimaryBaseUrl: () => primaryBaseUrl
}));

const stubs = {
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  Icon: { template: '<span />' },
  ConfigPromptsPanel: true,
  ConfigModelsPanel: true,
  ConfigPersonasPanel: true,
  ConfigAgentsPanel: true
};
const globalOpts = { components: { GlassCard, PlatformProjectSelect }, stubs };

let lastConfigWrapper: VueWrapper | null = null;

function mountConfig(): VueWrapper {
  lastConfigWrapper?.unmount();
  lastConfigWrapper = mount(Config, { global: globalOpts }) as VueWrapper;
  return lastConfigWrapper;
}

/** Happy-path responses for all stats-server endpoints. */
function primaryResponse(url: string) {
  if (url.includes('/projects')) return { ok: true, json: () => Promise.resolve({ projects: [] }) };
  if (url.includes('/config/prompts')) return { ok: true, json: () => Promise.resolve({ prompts: [], seedWriteEnabled: false }) };
  if (url.includes('/config/personas')) return { ok: true, json: () => Promise.resolve({ personas: [], seedWriteEnabled: false }) };
  if (url.includes('/config/agents')) return { ok: true, json: () => Promise.resolve({ agents: [], seedWriteEnabled: false }) };
  if (url.includes('/config/models')) return { ok: true, json: () => Promise.resolve({ models: [] }) };
  return { ok: true, json: () => Promise.resolve({}) };
}

/** Simulates ensureConfigBaseUrl() finding no server (discovery calls succeed but return no port). */
function noDiscoveryResponse(url: string) {
  if (url.includes('/api/servers')) return { ok: true, json: () => Promise.resolve({ servers: [] }) };
  if (url.includes('/api/docs-context')) return { ok: true, json: () => Promise.resolve({}) };
  // Any stats-endpoint call during this phase is a bug — fail loudly.
  return { ok: false, status: 503, json: () => Promise.resolve({ error: 'not ready' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  streamTargetUrl.value = '';
  primaryBaseUrl.value = '';
  mockRoute.path = '/config';
  mockRoute.hash = '#settings';
  Object.keys(mockSocketHandlers).forEach((k) => delete mockSocketHandlers[k]);
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  lastConfigWrapper?.unmount();
  lastConfigWrapper = null;
});

describe('Config page — reactive primary URL', () => {
  it('makes no data fetches when the primary URL is not yet known', async () => {
    mockFetch.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(noDiscoveryResponse(String(input)))
    );

    mountConfig();
    await flushPromises();

    const dataCalls = mockFetch.mock.calls.filter(([url]) => {
      const u = String(url);
      return u.includes('/projects') || u.includes('/config/');
    });
    expect(dataCalls).toHaveLength(0);
    expect(mockIo).not.toHaveBeenCalled();
  });

  it('fetches data and connects socket the moment the primary URL becomes known', async () => {
    // Phase 1: mount with no URL — discovery finds nothing.
    mockFetch.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(noDiscoveryResponse(String(input)))
    );
    mountConfig();
    await flushPromises();

    expect(mockIo).not.toHaveBeenCalled();
    const callsBefore = mockFetch.mock.calls.filter(([url]) =>
      String(url).includes('/projects') || String(url).includes('/config/')
    );
    expect(callsBefore).toHaveLength(0);

    // Phase 2: primary comes online — URL is set reactively.
    mockFetch.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(primaryResponse(String(input)))
    );
    streamTargetUrl.value = MOCK_STATS_URL;
    await flushPromises();

    expect(mockIo).toHaveBeenCalledWith(MOCK_STATS_URL, expect.objectContaining({ autoConnect: true }));
    const projectCalls = mockFetch.mock.calls.filter(([url]) =>
      String(url).startsWith(MOCK_STATS_URL) && String(url).includes('/projects')
    );
    expect(projectCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('routes all requests directly to the primary URL — never through /api/stats', async () => {
    streamTargetUrl.value = MOCK_STATS_URL;
    mockFetch.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(primaryResponse(String(input)))
    );

    mountConfig();
    await flushPromises();

    const dataCalls = mockFetch.mock.calls.filter(([url]) => {
      const u = String(url);
      return u.includes('/projects') || u.includes('/config/');
    });
    expect(dataCalls.length).toBeGreaterThanOrEqual(1);
    for (const [url] of dataCalls) {
      expect(String(url)).toMatch(new RegExp(`^${MOCK_STATS_URL}`));
      expect(String(url)).not.toContain('/api/stats');
    }
  });

  it('fetches active section data (prompts) when URL is discovered mid-session', async () => {
    mockRoute.hash = '#prompts-global';

    // Start with no URL — prompts endpoint must not be called yet.
    mockFetch.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(noDiscoveryResponse(String(input)))
    );
    mountConfig();
    await flushPromises();

    const promptsBefore = mockFetch.mock.calls.filter(([url]) =>
      String(url).includes('/config/prompts')
    );
    expect(promptsBefore).toHaveLength(0);

    // Primary discovered — watcher fires, sees section = 'prompts-global', calls /config/prompts.
    mockFetch.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(primaryResponse(String(input)))
    );
    streamTargetUrl.value = MOCK_STATS_URL;
    await flushPromises();

    const promptsAfter = mockFetch.mock.calls.filter(([url]) =>
      String(url).startsWith(MOCK_STATS_URL) && String(url).includes('/config/prompts')
    );
    expect(promptsAfter.length).toBeGreaterThanOrEqual(1);
  });

  it('disconnects old socket and reconnects to the new URL when the primary URL changes', async () => {
    const firstUrl = 'http://127.0.0.1:3000';
    const secondUrl = 'http://127.0.0.1:3001';

    mockFetch.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(primaryResponse(String(input)))
    );
    streamTargetUrl.value = firstUrl;
    mountConfig();
    await flushPromises();

    expect(mockIo).toHaveBeenCalledWith(firstUrl, expect.anything());

    // Baseline: record any disconnects that happened during initial setup / prior test teardown.
    const disconnectsBefore = mockSocket.disconnect.mock.calls.length;

    // Primary moves to a different port.
    streamTargetUrl.value = secondUrl;
    await flushPromises();

    // Must have disconnected at least once MORE than before the URL change.
    expect(mockSocket.disconnect.mock.calls.length).toBeGreaterThan(disconnectsBefore);
    expect(mockIo).toHaveBeenCalledWith(secondUrl, expect.anything());
    const refetchCalls = mockFetch.mock.calls.filter(([url]) =>
      String(url).startsWith(secondUrl) && String(url).includes('/projects')
    );
    expect(refetchCalls.length).toBeGreaterThanOrEqual(1);
  });
});
