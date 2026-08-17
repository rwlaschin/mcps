<template>
  <div class="chunk-update-grid">
    <div class="mb-4">
      <!-- Full-width track = 100% scope (total); fill = processed -->
      <div
        class="scan-progress-track relative h-3.5 w-full overflow-clip rounded-full"
        role="progressbar"
        :aria-valuenow="Math.round(progressPercent)"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuetext="progressAriaText"
      >
        <!--
          Two layers inside the processed span (same total width = filesProcessed/total):
          1) Solid = up to date (filesUpdated / total), capped at processed
          2) Stripes = in progress (remainder out to filesProcessed)
        -->
        <div
          class="scan-progress-inner absolute inset-y-0 left-0 flex flex-row overflow-clip rounded-full transition-[width] duration-500 ease-out"
          :style="{ width: `${progressPercent}%` }"
        >
          <div
            class="scan-progress-done h-full shrink-0 min-w-0"
            :style="{ width: `${doneInnerPercent}%` }"
          />
          <div
            class="scan-progress-inflight h-full min-w-0 flex-1"
            :class="{ 'is-active': inflightIsStriped }"
          />
        </div>
      </div>
      <p v-if="summaryLine" class="text-sm text-gray-400 mt-2">
        {{ summaryLine }}
      </p>
    </div>
    <div
      ref="heatmapShellRef"
      class="scan-heatmap-shell overflow-auto max-h-[560px] rounded-xl p-2"
    >
      <canvas
        v-if="useCanvasHeatmap"
        ref="heatmapCanvasRef"
        class="scan-heatmap-canvas block max-w-full touch-none"
        role="img"
        :aria-label="canvasAriaLabel"
        @mousemove="onCanvasPointerMove"
        @mouseleave="onCanvasPointerLeave"
      />
      <TransitionGroup v-else name="scan-cell" tag="div" class="flex flex-wrap gap-0.5">
        <div
          v-for="(file, i) in sortedFiles"
          :key="file.relativePath + String(i)"
          class="scan-cell-block shrink-0 transition-[filter,box-shadow] duration-200"
          :class="blockClass(file.state)"
          :style="blockStyle"
          role="img"
          :aria-label="cellAriaLabel(file)"
          @mouseenter="onCellPointerEnter($event, file)"
          @mousemove="onCellPointerMove"
          @mouseleave="onCellPointerLeave"
        />
      </TransitionGroup>
    </div>
    <Teleport to="body">
      <div
        v-if="hoverTip"
        class="scan-cell-hover-tip fixed z-[10050] max-w-[min(90vw,28rem)] rounded-lg border border-white/15 bg-[var(--surface-card)]/95 px-2.5 py-1.5 text-xs font-medium text-white/95 shadow-xl backdrop-blur-md pointer-events-none flex flex-col gap-0.5"
        :style="{ left: `${hoverTip.x}px`, top: `${hoverTip.y}px` }"
        aria-hidden="true"
      >
        <span class="break-all leading-snug">{{ hoverTip.path }}</span>
        <span class="text-[11px] font-normal leading-tight text-violet-200/80">{{ hoverTip.statusLabel }}</span>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

/** DOM + TransitionGroup cost grows with N; canvas is one surface + O(N) draws. */
const CANVAS_HEATMAP_MIN_FILES = 72
const HEATMAP_GAP_PX = 2

export interface ScanFileEntry {
  relativePath: string
  state: 'new' | 'stale' | 'fresh'
}

const props = withDefaults(
  defineProps<{
    files: ScanFileEntry[]
    filesProcessed?: number
    filesUpdated?: number
    totalFiles?: number
    isActiveScan?: boolean
  }>(),
  { filesProcessed: 0, filesUpdated: 0, totalFiles: 0, isActiveScan: false }
)

const sortedFiles = computed(() => [...props.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)))

const safeTotal = computed(() => Math.max(props.totalFiles, sortedFiles.value.length, 0))
const cellSize = computed(() => {
  const total = safeTotal.value
  if (total <= 25) return 20
  if (total <= 100) return 15
  return 12
})
/** Smaller cells → tighter radius so blocks stay square, not pill/circle. */
const cellRadiusPx = computed(() => {
  const s = cellSize.value
  return Math.max(1, Math.min(5, Math.round(s * 0.2)))
})

/** No `title` — avoids duplicate native tooltip; use Teleport tip + aria-label. */
const hoverTip = ref<{ path: string; statusLabel: string; x: number; y: number } | null>(null)
const TIP_OFFSET_X = 12
const TIP_OFFSET_Y = 10

/** Short line in hover tip (`stale` → Processing: awaiting re-index). */
function scanStatusLabel(state: ScanFileEntry['state']): string {
  if (state === 'new') return 'New'
  if (state === 'stale') return 'Processing'
  return 'Completed'
}

function cellAriaLabel(file: ScanFileEntry): string {
  const status = scanStatusLabel(file.state)
  const detail =
    file.state === 'new'
      ? 'not indexed yet'
      : file.state === 'stale'
        ? 'awaiting re-index'
        : 'up to date'
  return `${file.relativePath}. ${status}, ${detail}.`
}

function onCellPointerEnter(e: MouseEvent, file: ScanFileEntry) {
  hoverTip.value = {
    path: file.relativePath,
    statusLabel: scanStatusLabel(file.state),
    x: e.clientX + TIP_OFFSET_X,
    y: e.clientY + TIP_OFFSET_Y
  }
}

function onCellPointerMove(e: MouseEvent) {
  if (!hoverTip.value) return
  hoverTip.value = {
    ...hoverTip.value,
    x: e.clientX + TIP_OFFSET_X,
    y: e.clientY + TIP_OFFSET_Y
  }
}

function onCellPointerLeave() {
  hoverTip.value = null
}

const useCanvasHeatmap = computed(() => sortedFiles.value.length >= CANVAS_HEATMAP_MIN_FILES)

const heatmapShellRef = ref<HTMLElement | null>(null)
const heatmapCanvasRef = ref<HTMLCanvasElement | null>(null)
const canvasCellLayout = ref<{ file: ScanFileEntry; x: number; y: number }[]>([])

let resizeObserver: ResizeObserver | null = null

const canvasAriaLabel = computed(() => {
  const files = sortedFiles.value
  const n = files.length
  if (n === 0) return 'Scan heatmap: no files'
  let nNew = 0
  let nStale = 0
  let nFresh = 0
  for (const f of files) {
    if (f.state === 'new') nNew++
    else if (f.state === 'stale') nStale++
    else nFresh++
  }
  return `Scan heatmap of ${n} files (path order): ${nNew} not indexed, ${nStale} processing, ${nFresh} up to date. Hover for file path.`
})

function getShellContentWidth(shell: HTMLElement): number {
  const s = getComputedStyle(shell)
  const pl = parseFloat(s.paddingLeft) || 0
  const pr = parseFloat(s.paddingRight) || 0
  return Math.max(0, shell.clientWidth - pl - pr)
}

function buildWrappedLayout(
  innerW: number,
  files: readonly ScanFileEntry[],
  cell: number,
  gap: number
): { positions: { file: ScanFileEntry; x: number; y: number }[]; height: number } {
  const positions: { file: ScanFileEntry; x: number; y: number }[] = []
  if (files.length === 0 || innerW <= 0) return { positions, height: 0 }
  let x = 0
  let y = 0
  for (const file of files) {
    if (x > 0 && x + cell > innerW) {
      x = 0
      y += cell + gap
    }
    positions.push({ file, x, y })
    x += cell + gap
  }
  return { positions, height: y + cell }
}

function paintCellCanvas(
  ctx: CanvasRenderingContext2D,
  state: ScanFileEntry['state'],
  x: number,
  y: number,
  cell: number,
  r: number
) {
  const pad = 0.5
  const w = cell - 1
  const h = cell - 1
  const g = ctx.createLinearGradient(x, y, x + cell, y + cell)
  let stroke = ''
  if (state === 'new') {
    g.addColorStop(0, '#16101f')
    g.addColorStop(1, '#07050d')
    stroke = 'rgba(139,92,246,0.28)'
  } else if (state === 'stale') {
    g.addColorStop(0, '#4a3668')
    g.addColorStop(1, '#351c55')
    stroke = 'rgba(196,181,253,0.22)'
  } else {
    g.addColorStop(0, '#e9d5ff')
    g.addColorStop(0.45, '#a78bfa')
    g.addColorStop(1, '#5b21b6')
    stroke = 'rgba(255,255,255,0.38)'
  }
  ctx.fillStyle = g
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x + pad, y + pad, w, h, r)
  } else {
    ctx.rect(x + pad, y + pad, w, h)
  }
  ctx.fill()
  ctx.strokeStyle = stroke
  ctx.lineWidth = 1
  ctx.stroke()
}

function paintHeatmapCanvas() {
  const shell = heatmapShellRef.value
  const canvas = heatmapCanvasRef.value
  if (!shell || !canvas || !useCanvasHeatmap.value) return

  const innerW = getShellContentWidth(shell)
  const files = sortedFiles.value
  const cell = cellSize.value
  const gap = HEATMAP_GAP_PX
  const { positions, height } = buildWrappedLayout(innerW, files, cell, gap)
  canvasCellLayout.value = positions

  if (innerW <= 0 || files.length === 0) {
    canvas.style.width = '0px'
    canvas.style.height = '0px'
    canvas.width = 0
    canvas.height = 0
    return
  }

  const cssW = innerW
  const cssH = Math.max(height, 1)
  const dpr =
    typeof window !== 'undefined' ? Math.min(window.devicePixelRatio ?? 1, 2.5) : 1

  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
  canvas.width = Math.max(1, Math.round(cssW * dpr))
  canvas.height = Math.max(1, Math.round(cssH * dpr))

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssW, cssH)

  const r = cellRadiusPx.value
  for (const { file, x, y } of positions) {
    paintCellCanvas(ctx, file.state, x, y, cell, r)
  }
}

function canvasHitTest(mx: number, my: number): ScanFileEntry | null {
  const cell = cellSize.value
  const layout = canvasCellLayout.value
  for (let i = layout.length - 1; i >= 0; i--) {
    const { file, x, y } = layout[i]
    if (mx >= x && my >= y && mx < x + cell && my < y + cell) return file
  }
  return null
}

function onCanvasPointerMove(e: MouseEvent) {
  const canvas = heatmapCanvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const mx = e.clientX - rect.left
  const my = e.clientY - rect.top
  const file = canvasHitTest(mx, my)
  if (!file) {
    hoverTip.value = null
    return
  }
  hoverTip.value = {
    path: file.relativePath,
    statusLabel: scanStatusLabel(file.state),
    x: e.clientX + TIP_OFFSET_X,
    y: e.clientY + TIP_OFFSET_Y
  }
}

function onCanvasPointerLeave() {
  hoverTip.value = null
}

watch(
  () => [
    sortedFiles.value,
    cellSize.value,
    cellRadiusPx.value,
    useCanvasHeatmap.value
  ] as const,
  () => {
    if (!useCanvasHeatmap.value) {
      canvasCellLayout.value = []
      return
    }
    nextTick(() => paintHeatmapCanvas())
  },
  { flush: 'post' }
)

onMounted(() => {
  resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          if (useCanvasHeatmap.value) paintHeatmapCanvas()
        })
      : null
  requestAnimationFrame(() => {
    const shell = heatmapShellRef.value
    if (shell && resizeObserver) resizeObserver.observe(shell)
    paintHeatmapCanvas()
  })
})

onUnmounted(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

const blockStyle = computed(() => {
  const px = `${cellSize.value}px`
  const r = `${cellRadiusPx.value}px`
  return {
    width: px,
    height: px,
    minWidth: px,
    minHeight: px,
    borderRadius: r,
  }
})
const progressPercent = computed(() => {
  if (safeTotal.value <= 0) return 0
  const pct = (Math.max(0, props.filesProcessed) / safeTotal.value) * 100
  return Math.max(0, Math.min(100, pct))
})

/** Portion of track that is fully synced (updated), never beyond processed. */
const donePercentOfTrack = computed(() => {
  if (safeTotal.value <= 0) return 0
  const u = (Math.max(0, props.filesUpdated) / safeTotal.value) * 100
  return Math.max(0, Math.min(100, Math.min(u, progressPercent.value)))
})

/** Share of the *processed* strip for the solid “done” layer (rest = in-flight). */
const doneInnerPercent = computed(() => {
  if (progressPercent.value <= 0.0001) return 0
  return Math.min(100, (donePercentOfTrack.value / progressPercent.value) * 100)
})

const activeScan = computed(() => props.isActiveScan || (safeTotal.value > 0 && props.filesProcessed < safeTotal.value))

/** Striped “in progress” overlay only when scan is active and there is tail beyond solid done. */
const inflightIsStriped = computed(
  () => activeScan.value && progressPercent.value > donePercentOfTrack.value + 0.05
)

const progressAriaText = computed(() => {
  const t = safeTotal.value
  if (t <= 0) return 'No files tracked'
  const p = Math.max(0, props.filesProcessed)
  const u = Math.max(0, props.filesUpdated)
  return `${p} of ${t} processed, ${u} up to date`
})

function blockClass(state: 'new' | 'stale' | 'fresh'): string {
  if (state === 'new') return 'scan-cell-new'
  if (state === 'stale') return 'scan-cell-stale'
  return 'scan-cell-fresh'
}

const summaryLine = computed(() => {
  const p = props.filesProcessed
  const u = props.filesUpdated
  const total = safeTotal.value
  if (p === 0 && u === 0 && total === 0) return null
  return `${p} files processed, ${u} updated, ${total} tracked.`
})
</script>

<style scoped>
/* Track: full-width “total” rail — reads clearly on dark UI */
.scan-progress-track {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.14) 0%, rgba(255, 255, 255, 0.05) 45%, rgba(0, 0, 0, 0.28) 100%);
  border: 1px solid rgba(255, 255, 255, 0.22);
  box-shadow:
    inset 0 0 0 1px rgba(0, 0, 0, 0.45),
    inset 0 2px 4px rgba(0, 0, 0, 0.35),
    inset 0 -1px 0 rgba(255, 255, 255, 0.06),
    0 1px 3px rgba(0, 0, 0, 0.35);
}

/* Layer 1 — completed / up to date (solid glass, no stripes) */
.scan-progress-done {
  background: linear-gradient(
    180deg,
    color-mix(in oklab, var(--accent, #c4b5fd) 35%, #3b2f55) 0%,
    color-mix(in oklab, var(--accent, #8b5cf6) 72%, #1a1028) 48%,
    color-mix(in oklab, var(--accent-hover, #7c3aed) 65%, #0f0818) 100%
  );
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.38),
    inset 0 -2px 4px rgba(0, 0, 0, 0.32);
}

/* Layer 2 — in progress tail: calmer when idle, barbershop when scan active */
.scan-progress-inflight {
  position: relative;
  background: linear-gradient(
    90deg,
    color-mix(in oklab, var(--accent, #8b5cf6) 55%, #241830),
    color-mix(in oklab, var(--accent-hover, #7c3aed) 50%, #1a1224)
  );
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

.scan-progress-inflight.is-active {
  background-color: rgba(255, 255, 255, 0.06);
  background-image:
    linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.55) 0%,
      rgba(255, 255, 255, 0.12) 32%,
      transparent 48%,
      rgba(0, 0, 0, 0.18) 100%
    ),
    linear-gradient(
      90deg,
      rgba(255, 255, 255, 0.12) 0%,
      transparent 40%,
      transparent 60%,
      rgba(255, 255, 255, 0.08) 100%
    ),
    repeating-linear-gradient(
      -45deg,
      color-mix(in oklab, var(--accent, #a78bfa) 55%, transparent) 0px,
      color-mix(in oklab, var(--accent, #a78bfa) 55%, transparent) 5px,
      color-mix(in oklab, var(--accent, #6d28d9) 65%, rgba(15, 8, 25, 0.85)) 5px,
      color-mix(in oklab, var(--accent, #6d28d9) 65%, rgba(15, 8, 25, 0.85)) 10px
    );
  background-size:
    100% 100%,
    100% 100%,
    14px 14px;
  background-blend-mode: overlay, soft-light, normal;
  animation: scan-barber-pole 850ms linear infinite;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.45),
    inset 0 -2px 6px rgba(0, 0, 0, 0.25),
    0 0 16px color-mix(in oklab, var(--accent, #8b5cf6) 40%, transparent);
}

.scan-progress-inflight.is-active::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.28) 0%,
    transparent 42%,
    transparent 58%,
    rgba(120, 80, 200, 0.12) 100%
  );
  mix-blend-mode: soft-light;
}

.scan-cell-enter-active {
  transition: opacity 220ms ease, transform 220ms ease;
}
.scan-cell-enter-from {
  opacity: 0;
  transform: scale(0.9);
}

/* Heatmap shell — glass panel consistent with dashboard */
.scan-heatmap-shell {
  background: linear-gradient(
    165deg,
    color-mix(in oklab, var(--surface-card, #1a1726) 92%, var(--accent, #8b5cf6) 8%) 0%,
    rgba(255, 255, 255, 0.03) 45%,
    color-mix(in oklab, var(--surface, #100b1a) 95%, transparent) 100%
  );
  border: 1px solid color-mix(in oklab, var(--accent, #8b5cf6) 22%, rgba(255, 255, 255, 0.12));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.09),
    inset 0 -1px 0 rgba(0, 0, 0, 0.35),
    0 6px 28px rgba(0, 0, 0, 0.28);
}

/* new: darkest — not started (surface → deep void) */
.scan-cell-new {
  background: linear-gradient(
    152deg,
    var(--surface, #100b1a) 0%,
    color-mix(in oklab, var(--surface-card, #1a1726) 82%, var(--accent, #8b5cf6) 5%) 48%,
    #06040c 100%
  );
  border: 1px solid color-mix(in oklab, var(--accent, #8b5cf6) 16%, rgba(0, 0, 0, 0.45));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    inset 0 -2px 3px rgba(0, 0, 0, 0.5);
}

/* stale: secondary accent — needs update / “in flight” before snapping to complete */
.scan-cell-stale {
  background: linear-gradient(
    148deg,
    color-mix(in oklab, var(--accent, #8b5cf6) 22%, var(--surface-card, #1a1726)) 0%,
    color-mix(in oklab, var(--accent, #8b5cf6) 42%, var(--surface-card, #1a1726)) 45%,
    color-mix(in oklab, var(--accent-hover, #7c3aed) 58%, #1a0f28) 100%
  );
  border: 1px solid color-mix(in oklab, var(--accent, #8b5cf6) 48%, rgba(255, 255, 255, 0.06));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    inset 0 -1px 0 rgba(0, 0, 0, 0.28),
    0 0 10px color-mix(in oklab, var(--accent, #8b5cf6) 18%, transparent);
}

/* fresh: brightest — completed (lit glass, accent highlight) */
.scan-cell-fresh {
  background: linear-gradient(
    158deg,
    color-mix(in oklab, white 38%, var(--accent, #8b5cf6)) 0%,
    color-mix(in oklab, var(--accent, #8b5cf6) 72%, white) 42%,
    color-mix(in oklab, var(--accent-hover, #7c3aed) 62%, #12081f) 100%
  );
  border: 1px solid color-mix(in oklab, white 32%, var(--accent, #8b5cf6));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.55),
    inset 0 -2px 5px color-mix(in oklab, var(--accent-hover, #7c3aed) 35%, transparent),
    0 0 12px color-mix(in oklab, var(--accent, #8b5cf6) 32%, transparent);
}

@keyframes scan-barber-pole {
  from {
    background-position: 0 0, 0 0, 0 0;
  }
  to {
    background-position: 0 0, 0 0, 14px 0;
  }
}
</style>
