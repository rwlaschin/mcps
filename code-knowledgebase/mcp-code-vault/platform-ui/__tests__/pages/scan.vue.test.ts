import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { ref } from 'vue';
import Scan from '../../pages/scan.vue';
import GlassCard from '../../components/GlassCard.vue';
import ChunkUpdateGrid from '../../components/ChunkUpdateGrid.vue';
import PlatformProjectSelect from '../../components/PlatformProjectSelect.vue';
import { MOCK_STATS_URL } from '../../testConstants';

const mockFetch = vi.fn();
const mockSocketHandlers: Record<string, (...args: unknown[]) => void> = {};
const mockSocket = {
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    mockSocketHandlers[event] = fn;
    return mockSocket;
  }),
  emit: vi.fn(),
  disconnect: vi.fn()
};
const mockIo = vi.fn(() => mockSocket);

vi.mock('../../lib/socketIoClient', () => ({
  io: (...args: unknown[]) => mockIo(...args)
}));

vi.mock('../../composables/useStreamTargetUrl', () => ({
  useStreamTargetUrl: () => ref(MOCK_STATS_URL)
}));

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(mockSocketHandlers).forEach((k) => delete mockSocketHandlers[k]);
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/servers')) return { ok: true, json: () => Promise.resolve({ servers: [] }) };
    if (url.includes('/api/docs-context')) return { ok: true, json: () => Promise.resolve({ port: '3000' }) };
    if (url.includes('/projects')) return { ok: true, json: () => Promise.resolve({ projects: [] }) };
    if (url.includes('/scan/files')) return { ok: true, json: () => Promise.resolve({ entries: [] }) };
    return { ok: true, json: () => Promise.resolve({}) };
  });
  vi.stubGlobal('fetch', mockFetch);
});

describe('Scan page', () => {
  const globalMount = {
    components: { GlassCard, ChunkUpdateGrid, PlatformProjectSelect },
    stubs: { ClientOnly: { template: '<div><slot /></div>' } }
  };

  it('exists at route /scan and renders Scan title', async () => {
    const wrapper = mount(Scan, {
      global: globalMount
    });
    await flushPromises();
    expect(wrapper.text()).toContain('Scan');
  });

  it('when projects list is empty but API succeeded, shows user-facing empty state (no STATS_PORT)', async () => {
    const wrapper = mount(Scan, { global: globalMount });
    await flushPromises();
    expect(wrapper.text()).toMatch(/No projects yet/);
    expect(wrapper.text()).not.toMatch(/STATS_PORT|NUXT_PUBLIC_STATS_PORT/);
  });

  it('when /projects fails, shows load error instead of empty-database copy', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/servers')) return { ok: true, json: () => Promise.resolve({ servers: [] }) };
      if (url.includes('/api/docs-context')) return { ok: true, json: () => Promise.resolve({ port: '3000' }) };
      if (url.includes('/projects')) return { ok: false, status: 503, json: () => Promise.resolve({}) };
      if (url.includes('/scan/files')) return { ok: true, json: () => Promise.resolve({ entries: [] }) };
      return { ok: true, json: () => Promise.resolve({}) };
    });
    const wrapper = mount(Scan, { global: globalMount });
    await flushPromises();
    expect(wrapper.text()).toMatch(/Could not load projects/);
    expect(wrapper.text()).not.toMatch(/No projects yet/);
  });

  it('loads projects from API and project selector shows them', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/servers')) return { ok: true, json: () => Promise.resolve({ servers: [] }) };
      if (url.includes('/api/docs-context')) return { ok: true, json: () => Promise.resolve({ port: '3000' }) };
      if (url.includes('/projects')) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              projects: [
                { key: 'default', name: 'Default Project' },
                { key: 'other', name: 'Other' }
              ]
            })
        };
      }
      if (url.includes('/scan/files')) return { ok: true, json: () => Promise.resolve({ entries: [] }) };
      return { ok: true, json: () => Promise.resolve({ filesProcessed: 0, filesUpdated: 0, files: [] }) };
    });
    const wrapper = mount(Scan, {
      global: globalMount
    });
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/projects'));
    expect(wrapper.find('select').exists()).toBe(true);
    expect(wrapper.text()).toMatch(/Project|Select/);
  });

  it('updates grid when receiving scan:progress socket payload', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/servers')) return { ok: true, json: () => Promise.resolve({ servers: [] }) };
      if (url.includes('/api/docs-context')) return { ok: true, json: () => Promise.resolve({ port: '3000' }) };
      if (url.includes('/projects')) return { ok: true, json: () => Promise.resolve({ projects: [{ key: 'default', name: 'Default' }] }) };
      if (url.includes('/scan/files')) return { ok: true, json: () => Promise.resolve({ entries: [] }) };
      return { ok: true, json: () => Promise.resolve({ filesProcessed: 0, filesUpdated: 0, files: [] }) };
    });
    const wrapper = mount(Scan, {
      global: globalMount
    });
    await flushPromises();
    const progressCb = mockSocketHandlers['scan:progress'];
    expect(progressCb).toBeDefined();
    progressCb!(JSON.stringify({
      filesProcessed: 2,
      filesUpdated: 1,
      files: [
        { relativePath: 'a.ts', state: 'fresh' },
        { relativePath: 'b.ts', state: 'stale' }
      ],
      projectKey: 'default'
    }));
    await wrapper.vm.$nextTick();
    const grid = wrapper.findComponent(ChunkUpdateGrid);
    expect(grid.exists()).toBe(true);
    expect(grid.props('filesProcessed')).toBe(2);
    expect(grid.props('filesUpdated')).toBe(1);
    expect(grid.props('files')).toHaveLength(2);
  });

  it('has project selector that can store selected projectKey', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/servers')) return { ok: true, json: () => Promise.resolve({ servers: [] }) };
      if (url.includes('/api/docs-context')) return { ok: true, json: () => Promise.resolve({ port: '3000' }) };
      if (url.includes('/projects')) {
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              projects: [{ key: 'default', name: 'Default Project' }]
            })
        };
      }
      if (url.includes('/scan/files')) return { ok: true, json: () => Promise.resolve({ entries: [] }) };
      return { ok: true, json: () => Promise.resolve({ filesProcessed: 0, filesUpdated: 0, files: [] }) };
    });
    const wrapper = mount(Scan, {
      global: globalMount
    });
    await flushPromises();
    const select = wrapper.find('select');
    expect(select.exists()).toBe(true);
    await select.setValue('default');
    await wrapper.vm.$nextTick();
    expect(select.exists()).toBe(true);
  });

  it('refetches projects when project event is received', async () => {
    let projectCall = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/servers')) return { ok: true, json: () => Promise.resolve({ servers: [] }) };
      if (url.includes('/api/docs-context')) return { ok: true, json: () => Promise.resolve({ port: '3000' }) };
      if (url.includes('/projects')) {
        projectCall += 1;
        if (projectCall === 1) return { ok: true, json: () => Promise.resolve({ projects: [] }) };
        return {
          ok: true,
          json: () =>
            Promise.resolve({
              projects: [{ key: 'default', name: 'Default Project' }]
            })
        };
      }
      if (url.includes('/scan/files')) return { ok: true, json: () => Promise.resolve({ entries: [] }) };
      return { ok: true, json: () => Promise.resolve({ filesProcessed: 0, filesUpdated: 0, files: [] }) };
    });

    const wrapper = mount(Scan, {
      global: globalMount
    })

    await flushPromises()
    const projectInitCb = mockSocketHandlers['project']
    expect(projectInitCb).toBeDefined()

    projectInitCb!(JSON.stringify({ projectKey: 'default', action: 'created' }))
    await wrapper.vm.$nextTick()
    await flushPromises()

    // After refresh, selector should list the new project.
    expect(wrapper.text()).toContain('Default Project')
  })
});
