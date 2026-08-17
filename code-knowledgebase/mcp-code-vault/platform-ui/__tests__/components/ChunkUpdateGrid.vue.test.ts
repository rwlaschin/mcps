import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChunkUpdateGrid from '../../components/ChunkUpdateGrid.vue';

describe('ChunkUpdateGrid', () => {
  it('renders a grid of blocks for each file', () => {
    const files = [
      { relativePath: 'a.ts', state: 'new' as const },
      { relativePath: 'b.ts', state: 'stale' as const },
      { relativePath: 'c.ts', state: 'fresh' as const }
    ];
    const wrapper = mount(ChunkUpdateGrid, {
      props: { files, filesProcessed: 3, filesUpdated: 1 }
    });
    const blocks = wrapper.findAll('.scan-cell-block');
    expect(blocks.length).toBe(3);
  });

  it('applies themed state classes for new/stale/fresh', () => {
    const files = [
      { relativePath: 'a.ts', state: 'new' as const },
      { relativePath: 'b.ts', state: 'stale' as const },
      { relativePath: 'c.ts', state: 'fresh' as const }
    ];
    const wrapper = mount(ChunkUpdateGrid, {
      props: { files }
    });
    const blocks = wrapper.findAll('.scan-cell-block');
    expect(blocks[0].classes()).toContain('scan-cell-new');
    expect(blocks[1].classes()).toContain('scan-cell-stale');
    expect(blocks[2].classes()).toContain('scan-cell-fresh');
  });

  it('shows summary line with filesProcessed and filesUpdated', () => {
    const wrapper = mount(ChunkUpdateGrid, {
      props: { files: [], filesProcessed: 10, filesUpdated: 5 }
    });
    expect(wrapper.text()).toContain('10 files processed, 5 updated, 0 tracked.');
  });

  it('hides summary when no data', () => {
    const wrapper = mount(ChunkUpdateGrid, {
      props: { files: [], filesProcessed: 0, filesUpdated: 0 }
    });
    const summary = wrapper.find('p.text-sm');
    expect(summary.exists()).toBe(false);
  });

  it('uses 20px square cells for small file counts', () => {
    const wrapper = mount(ChunkUpdateGrid, {
      props: { files: [{ relativePath: 'x', state: 'new' }] }
    });
    const block = wrapper.find('.scan-cell-block');
    expect(block.attributes('style')).toContain('width: 20px;');
    expect(block.attributes('style')).toContain('height: 20px;');
    expect(block.attributes('style')).toMatch(/border-radius:\s*4px/);
  });

  it('uses 12px square cells for large file counts (minimum size)', () => {
    // Cell size uses max(totalFiles, files.length); one cell + high total avoids mounting 500 DOM nodes.
    const wrapper = mount(ChunkUpdateGrid, {
      props: {
        files: [{ relativePath: 'f-0.ts', state: 'fresh' as const }],
        totalFiles: 500
      }
    });
    const block = wrapper.find('.scan-cell-block');
    expect(block.attributes('style')).toContain('width: 12px;');
    expect(block.attributes('style')).toContain('height: 12px;');
    expect(block.attributes('style')).toMatch(/border-radius:\s*2px/);
  });

  it('does not shrink below 12px for very large lists', () => {
    const wrapper = mount(ChunkUpdateGrid, {
      props: {
        files: [{ relativePath: 'f-0.ts', state: 'fresh' as const }],
        totalFiles: 501
      }
    });
    const block = wrapper.find('.scan-cell-block');
    expect(block.attributes('style')).toContain('width: 12px;');
    expect(block.attributes('style')).toContain('height: 12px;');
  });

  it('does not set native title (custom tooltip only); aria-label has path and status', () => {
    const wrapper = mount(ChunkUpdateGrid, {
      props: {
        files: [{ relativePath: 'src/foo/bar.ts', state: 'fresh' }]
      }
    });
    const block = wrapper.find('.scan-cell-block');
    expect(block.attributes('title')).toBeUndefined();
    expect(block.attributes('aria-label')).toContain('src/foo/bar.ts');
    expect(block.attributes('aria-label')).toContain('Completed');
    expect(block.attributes('aria-label')).toContain('up to date');
  });

  it('sorts files by relativePath', () => {
    const wrapper = mount(ChunkUpdateGrid, {
      props: {
        files: [
          { relativePath: 'z.ts', state: 'fresh' },
          { relativePath: 'a.ts', state: 'fresh' }
        ]
      }
    });
    const blocks = wrapper.findAll('.scan-cell-block');
    expect(blocks[0].attributes('aria-label')).toMatch(/^a\.ts/);
    expect(blocks[1].attributes('aria-label')).toMatch(/^z\.ts/);
  });

  it('shows animated state on in-progress layer when scan is active and tail remains', () => {
    const wrapper = mount(ChunkUpdateGrid, {
      props: { files: [], filesProcessed: 1, totalFiles: 3, filesUpdated: 0, isActiveScan: true }
    });
    const inflight = wrapper.find('.scan-progress-inflight');
    expect(inflight.exists()).toBe(true);
    expect(inflight.classes()).toContain('is-active');
  });

  it('renders solid done layer and inflight layer inside processed width', () => {
    const wrapper = mount(ChunkUpdateGrid, {
      props: { files: [], filesProcessed: 100, totalFiles: 200, filesUpdated: 40, isActiveScan: true }
    });
    expect(wrapper.find('.scan-progress-done').exists()).toBe(true);
    expect(wrapper.find('.scan-progress-inflight').exists()).toBe(true);
    const inner = wrapper.find('.scan-progress-inner');
    expect(inner.attributes('style')).toContain('width: 50%');
  });

  it('uses canvas heatmap for large lists instead of hundreds of DOM cells', () => {
    const files = Array.from({ length: 80 }, (_, i) => ({
      relativePath: `pkg/f-${String(i).padStart(3, '0')}.ts`,
      state: 'fresh' as const
    }));
    const wrapper = mount(ChunkUpdateGrid, {
      props: { files, totalFiles: 80, filesProcessed: 80, filesUpdated: 80 }
    });
    expect(wrapper.find('canvas.scan-heatmap-canvas').exists()).toBe(true);
    expect(wrapper.findAll('.scan-cell-block').length).toBe(0);
    const label = wrapper.find('canvas').attributes('aria-label') ?? '';
    expect(label).toContain('80 files');
  });
});
