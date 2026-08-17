import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import Index from '../../pages/index.vue';
import GlassCard from '../../components/GlassCard.vue';
import { MOCK_STATS_URL, MOCK_STATS_PORT } from '../../testConstants';

const mockSocketHandlers: Record<string, (...args: unknown[]) => void> = {};
const mockSocket = {
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    mockSocketHandlers[event] = fn;
    return mockSocket;
  }),
  disconnect: vi.fn()
};
const mockIo = vi.fn(() => mockSocket);

/** Shared mount options: stub Icon (Nuxt Icon / lucide) and other components not resolved in test env. */
const globalMountOptions = {
  global: {
    components: { GlassCard },
    stubs: {
      ClientOnly: { template: '<div><slot /></div>' },
      apexchart: true,
      Icon: { template: '<span />' }
    }
  }
};

vi.mock('../../lib/socketIoClient', () => ({
  io: (...args: unknown[]) => mockIo(...args)
}));

/** Mock /api/servers with a registered MCP so the UI connects from broadcast (not config fallback). */
function mockServersWithPort(port: number) {
  return {
    ok: true,
    json: () => Promise.resolve({ servers: [{ projectName: 'mcp', port }] })
  } as Response;
}

function statsFetchMock(url: string): Promise<Response> {
  if (typeof url === 'string' && url.includes('/api/servers')) {
    return Promise.resolve(mockServersWithPort(MOCK_STATS_PORT));
  }
  if (typeof url === 'string' && url.includes('/metrics/file-reads/window')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ days: 7, totals: [] })
    } as Response);
  }
  if (typeof url === 'string' && url.includes('/metrics') && url.includes('limit=')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ metrics: [] })
    } as Response);
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve([]) } as Response);
}

beforeEach(() => {
  globalThis.fetch = vi.fn(statsFetchMock);
});

describe('Index page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSocketHandlers).forEach((k) => delete mockSocketHandlers[k]);
    globalThis.fetch = vi.fn(statsFetchMock);
  });

  it('renders and sets up Socket.IO on mount', async () => {
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    expect(wrapper.text()).toContain('Stats');
    expect(wrapper.text()).toContain('Time series');
    expect(mockIo).toHaveBeenCalledWith(MOCK_STATS_URL, expect.objectContaining({ autoConnect: true, reconnection: true }));
  });

  it('uses discovered server port as backend URL for Socket.IO', async () => {
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes('/api/servers')) return Promise.resolve(mockServersWithPort(3100));
      return statsFetchMock(url);
    });
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    expect(mockIo).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/.+:3100$/),
      expect.objectContaining({ autoConnect: true, reconnection: true })
    );
  });

  it('shows Connected when server emits connected event (even if first heartbeat is missed)', async () => {
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    const connectedCb = mockSocketHandlers['connected'];
    expect(connectedCb).toBeDefined();
    connectedCb!('{"ts":"2025-01-01T00:00:00.000Z"}');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Connected');
  });

  it('updates streamStatus and lastStreamEvent when socket fires connected and heartbeat', async () => {
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    const connectedCb = mockSocketHandlers['connected'];
    const heartbeatCb = mockSocketHandlers['heartbeat'];
    const disconnectCb = mockSocketHandlers['disconnect'];
    expect(connectedCb).toBeDefined();
    expect(heartbeatCb).toBeDefined();
    expect(disconnectCb).toBeDefined();

    connectedCb!('{"ts":"2025-01-01T00:00:00.000Z"}');
    await wrapper.vm.$nextTick();
    heartbeatCb!('{"ts":"2025-01-01T00:00:00.000Z"}');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Connected');

    disconnectCb!();
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Waiting for connection to MCP server');
  });

  it('shows "—" for Files processed and Files updated when no scan data', async () => {
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    expect(wrapper.text()).toContain('Files processed');
    expect(wrapper.text()).toContain('Files updated');
    expect(wrapper.text()).toMatch(/—/);
  });

  it('updates Files processed / Files updated when scan row becomes newest stream event (via metric)', async () => {
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    const metricCb = mockSocketHandlers['metric'];
    expect(metricCb).toBeDefined();
    metricCb!(
      JSON.stringify({
        operation: 'scan',
        metadata: { projectKey: 'default', action: 'update', total: 100, processedCount: 42, filesUpdated: 10 }
      })
    );
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('42');
    expect(wrapper.text()).toContain('10');
  });

  it('shows connection title with last update when connected and heartbeat received', async () => {
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    const connectedCb = mockSocketHandlers['connected'];
    const heartbeatCb = mockSocketHandlers['heartbeat'];
    connectedCb!('{"ts":"2025-01-01T12:00:00.000Z"}');
    await wrapper.vm.$nextTick();
    heartbeatCb!('{"ts":"2025-01-01T12:00:00.000Z"}');
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Connected');
  });

  it('does not add GET /metrics or file-reads REST responses to the stream event table', async () => {
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes('/api/servers')) return Promise.resolve(mockServersWithPort(MOCK_STATS_PORT));
      if (url.includes('/metrics/file-reads/window')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ days: 7, totals: [{ project: 'p1', total: 99 }] })
        } as Response);
      }
      if (url.includes('/metrics') && url.includes('limit=')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              metrics: [
                {
                  _id: 'm1',
                  instance_id: 'i1',
                  operation: 'scan',
                  kind: 'event',
                  started_at: '2025-06-01T15:00:00.000Z',
                  ended_at: '2025-06-01T15:00:01.000Z',
                  duration_ms: 20,
                  status: 'ok',
                  metadata: {}
                }
              ]
            })
        } as Response);
      }
      return statsFetchMock(url);
    });
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    const text = wrapper.text();
    expect(text).not.toMatch(/Hydrated stream log from GET \/metrics/);
    expect(text).not.toContain('file_reads_window');
    expect(text).toContain('99');
    expect(text).toContain('Files read');
  });

  it('updates LLM stats from stream when metric is model_call with duration and tokens', async () => {
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    const metricCb = mockSocketHandlers['metric'];
    expect(metricCb).toBeDefined();
    metricCb!(JSON.stringify({
      instance_id: 'i1',
      operation: 'model_call',
      started_at: '2025-01-01T00:00:00.000Z',
      ended_at: '2025-01-01T00:00:01.000Z',
      duration_ms: 100,
      status: 'ok',
      metadata: { tokens_in: 50, tokens_out: 20, tokens_thinking: 5, projectKey: 'p', caller: 'test' }
    }));
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('100');
    expect(wrapper.text()).toContain('50');
    expect(wrapper.text()).toContain('Model calls');
  });

  it('groups consecutive stream rows with the same event label (e.g. query)', async () => {
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    const metricCb = mockSocketHandlers['metric'];
    expect(metricCb).toBeDefined();
    const base = {
      instance_id: 'i1',
      operation: 'query',
      started_at: '2025-01-01T00:00:00.000Z',
      ended_at: '2025-01-01T00:00:01.000Z',
      duration_ms: 10,
      status: 'ok',
      metadata: {}
    };
    metricCb!(JSON.stringify({ ...base, _id: 'a' }));
    await wrapper.vm.$nextTick();
    metricCb!(JSON.stringify({ ...base, _id: 'b' }));
    await wrapper.vm.$nextTick();
    expect(
      wrapper.find('button[aria-label="2 query events grouped, click to expand"]').exists()
    ).toBe(true);
  });

  it('stream event log data accordion stays open when another heartbeat prepends (grouped top row)', async () => {
    const wrapper = mount(Index, globalMountOptions);
    await flushPromises();
    const connectedCb = mockSocketHandlers['connected'];
    const heartbeatCb = mockSocketHandlers['heartbeat'];
    expect(connectedCb).toBeDefined();
    expect(heartbeatCb).toBeDefined();

    connectedCb!('{}');
    await wrapper.vm.$nextTick();
    heartbeatCb!(JSON.stringify({ ts: '2025-01-01T00:00:01.000Z' }));
    await wrapper.vm.$nextTick();
    heartbeatCb!(JSON.stringify({ ts: '2025-01-01T00:00:02.000Z' }));
    await wrapper.vm.$nextTick();

    const dataToggles = wrapper.findAll('button[aria-label="Show full data"]');
    expect(dataToggles.length).toBeGreaterThan(0);
    await dataToggles[0]!.trigger('click');
    await wrapper.vm.$nextTick();
    expect(dataToggles[0]!.attributes('aria-expanded')).toBe('true');

    heartbeatCb!(JSON.stringify({ ts: '2025-01-01T00:00:03.000Z' }));
    await wrapper.vm.$nextTick();

    const after = wrapper.findAll('button[aria-label="Show full data"]');
    expect(after[0]!.attributes('aria-expanded')).toBe('true');
  });
});
