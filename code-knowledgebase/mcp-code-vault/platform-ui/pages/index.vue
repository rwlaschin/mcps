<template>
  <div class="p-6 md:p-8 min-w-0 max-w-full overflow-x-hidden">
    <!-- Header: Stats + connection status (heartbeat) -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
      <h1 class="text-2xl md:text-3xl font-bold text-white">Stats</h1>
      <div class="flex items-center gap-4">
        <div
          class="flex items-center gap-2 rounded-full px-4 py-2 transition-colors duration-300"
          :class="connectionStatusClass"
          :title="connectionStatusTitle"
        >
          <span
            class="w-3 h-3 rounded-full shrink-0 ring-2 ring-white/20"
            :class="connectionDotClass"
          />
          <span class="text-sm font-medium">{{ connectionStatusLabel }}</span>
        </div>
      </div>
    </div>

    <!-- Shown when stream is not connected (connecting, error, or disconnected). -->
    <div
      v-if="streamStatus !== 'connected'"
      class="waiting-banner rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 mb-8 text-amber-200/90"
    >
      <p class="font-medium">Waiting for connection to MCP server.</p>
    </div>

    <!-- CHARTS (on top as before) -->
    <section class="mb-10 min-w-0" aria-label="Charts">
      <div class="flex gap-4 w-full flex-wrap min-w-0 items-stretch">
        <GlassCard class="mb-8 flex-[1_1_60%] min-w-0 min-h-[400px] flex flex-col">
          <div class="mb-6 shrink-0">
            <h3 class="text-xl font-bold text-white">Time series</h3>
          </div>
          <ClientOnly class="min-h-0 flex-1 flex flex-col">
            <div class="min-w-0 w-full flex-1 min-h-[320px]">
              <apexchart
                v-if="timeChartOptions"
                type="area"
                height="320"
                :options="timeChartOptions"
                :series="timeChartSeries"
              />
            </div>
            <template #fallback>
              <div class="h-[320px] flex items-center justify-center text-gray-500">Loading chart…</div>
            </template>
          </ClientOnly>
        </GlassCard>
        <GlassCard class="mb-8 flex-[1_1_min(280px,100%)] min-w-0 min-h-[400px] flex flex-col">
          <div class="mb-6 shrink-0">
            <h3 class="text-xl font-bold text-white">Requests per minute</h3>
          </div>
          <ClientOnly class="min-h-0 flex-1 flex flex-col">
            <div class="min-w-0 w-full flex-1 min-h-[320px]">
              <apexchart
                v-if="rpmChartOptions"
                type="bar"
                height="320"
                :options="rpmChartOptions"
                :series="rpmChartSeries"
              />
            </div>
            <template #fallback>
              <div class="h-[320px] flex items-center justify-center text-gray-500">Loading chart…</div>
            </template>
          </ClientOnly>
        </GlassCard>
      </div>
    </section>

    <!-- Scorecards: Queries, Documents returned, Files read, Tool calls, Errors, Cache hit rate, Scan progress -->
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-4 mb-8">
      <GlassCard v-for="stat in mcpScorecards" :key="stat.label" class="!p-4">
        <p class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider truncate">{{ stat.label }}</p>
        <p class="text-xl md:text-2xl font-bold text-white mt-1 tabular-nums">{{ stat.value }}</p>
        <p v-if="stat.sublabel" class="text-xs text-gray-500 mt-0.5">{{ stat.sublabel }}</p>
      </GlassCard>
      <GlassCard class="!p-4">
        <p class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider truncate">Files processed</p>
        <p class="text-xl md:text-2xl font-bold text-white mt-1 tabular-nums">{{ scanFilesProcessedDisplay }}</p>
      </GlassCard>
      <GlassCard class="!p-4">
        <p class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider truncate">Files updated</p>
        <p class="text-xl md:text-2xl font-bold text-white mt-1 tabular-nums">{{ scanFilesUpdatedDisplay }}</p>
      </GlassCard>
    </div>

    <!-- LLM-only: model_call metrics (duration + tokens from vault / scan analyze) -->
    <div class="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-8">
      <GlassCard>
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">LLM response time (ms)</p>
        <div class="flex flex-wrap gap-4">
          <div><span class="text-gray-500 text-sm">p50</span><span class="ml-2 font-mono font-bold text-white">{{ stats.responseTimeP50 }}</span></div>
          <div><span class="text-gray-500 text-sm">p85</span><span class="ml-2 font-mono font-bold text-white">{{ stats.responseTimeP85 }}</span></div>
          <div><span class="text-gray-500 text-sm">p99</span><span class="ml-2 font-mono font-bold text-white">{{ stats.responseTimeP99 }}</span></div>
        </div>
      </GlassCard>
      <GlassCard>
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">LLM tokens in</p>
        <div class="flex flex-wrap gap-4">
          <div><span class="text-gray-500 text-sm">p50</span><span class="ml-2 font-mono font-bold text-white">{{ stats.tokensInP50 }}</span></div>
          <div><span class="text-gray-500 text-sm">p85</span><span class="ml-2 font-mono font-bold text-white">{{ stats.tokensInP85 }}</span></div>
          <div><span class="text-gray-500 text-sm">p99</span><span class="ml-2 font-mono font-bold text-white">{{ stats.tokensInP99 }}</span></div>
        </div>
      </GlassCard>
      <GlassCard>
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">LLM tokens out</p>
        <div class="flex flex-wrap gap-4">
          <div><span class="text-gray-500 text-sm">p50</span><span class="ml-2 font-mono font-bold text-white">{{ stats.tokensOutP50 }}</span></div>
          <div><span class="text-gray-500 text-sm">p85</span><span class="ml-2 font-mono font-bold text-white">{{ stats.tokensOutP85 }}</span></div>
          <div><span class="text-gray-500 text-sm">p99</span><span class="ml-2 font-mono font-bold text-white">{{ stats.tokensOutP99 }}</span></div>
        </div>
      </GlassCard>
      <GlassCard>
        <p class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">LLM thinking out</p>
        <div class="flex flex-wrap gap-4">
          <div><span class="text-gray-500 text-sm">p50</span><span class="ml-2 font-mono font-bold text-white">{{ stats.tokensThinkingP50 }}</span></div>
          <div><span class="text-gray-500 text-sm">p85</span><span class="ml-2 font-mono font-bold text-white">{{ stats.tokensThinkingP85 }}</span></div>
          <div><span class="text-gray-500 text-sm">p99</span><span class="ml-2 font-mono font-bold text-white">{{ stats.tokensThinkingP99 }}</span></div>
        </div>
      </GlassCard>
    </div>

    <!-- Registered MCPs (discovery + stream): primary vs secondary with distinct look. -->
    <ClientOnly>
      <section class="mb-6" aria-label="Registered MCPs">
        <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-2">
          Registered MCPs
        </h2>
        <div v-if="discoveryServers.length === 0 && secondariesFromStream.length === 0" class="flex flex-wrap gap-5" aria-busy="true" aria-label="Waiting for MCPs to register">
          <span class="h-8 w-24 rounded-lg border border-white/10 bg-violet-500/[0.08] animate-pulse" aria-hidden="true" />
          <span class="h-8 w-24 rounded-lg border border-white/10 bg-violet-500/[0.08] animate-pulse" style="animation-delay: 500ms;" aria-hidden="true" />
          <span class="h-8 w-24 rounded-lg border border-white/10 bg-violet-500/[0.08] animate-pulse" style="animation-delay: 700ms;" aria-hidden="true" />
        </div>
        <div v-else class="flex flex-wrap gap-2">
          <!-- Primary: from discovery (port matches stream) -->
          <template v-for="s in discoveryServers" :key="`primary-${s.projectName}:${s.port}`">
            <span
              v-if="primaryPortFromStream != null && s.port === primaryPortFromStream"
              class="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 bg-amber-500/20 border border-amber-400/40 text-amber-300"
              title="Primary"
            >
              <Icon name="lucide:server" class="size-5 shrink-0" aria-hidden="true" />
              <span class="font-mono text-sm">{{ s.projectName }}<span class="text-amber-400/70">:</span>{{ s.port }}</span>
            </span>
          </template>
          <!-- Discovery servers that are not the primary (no stream role yet) -->
          <span
            v-for="s in discoveryServers"
            :key="`reg-${s.projectName}:${s.port}`"
            v-show="primaryPortFromStream == null || s.port !== primaryPortFromStream"
            class="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-mono bg-white/5 border border-white/10 text-gray-300"
          >
            {{ s.projectName }}<span class="text-gray-500">:</span>{{ s.port }}
          </span>
          <!-- Secondaries: from stream (connected to primary) -->
          <span
            v-for="s in secondariesFromStream"
            :key="`secondary-${s.projectName}:${s.port}`"
            class="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 bg-sky-500/20 border border-sky-400/40 text-sky-300"
            title="Secondary"
          >
            <Icon name="lucide:radio" class="size-5 shrink-0" aria-hidden="true" />
            <span class="font-mono text-sm">{{ s.projectName }}<span class="text-sky-400/70">:</span>{{ s.port }}</span>
          </span>
        </div>
      </section>
    </ClientOnly>

    <!-- Stream event log (heartbeat, connected, metric). ClientOnly to avoid hydration mismatch: server has no socket data. -->
    <ClientOnly>
      <section class="mb-8" aria-label="Stream event log">
        <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-4">Stream event log</h2>
        <GlassCard class="!p-0 overflow-clip">
          <div class="h-[320px] overflow-y-auto overscroll-contain">
            <table class="w-full text-left text-sm">
              <thead class="sticky top-0 z-10 bg-[#1A1726] border-b border-white/10">
                <tr>
                  <th class="px-4 py-3 font-medium text-gray-400">Event</th>
                  <th class="px-4 py-3 font-medium text-gray-400">Time</th>
                  <th class="px-4 py-3 font-medium text-gray-400">Data</th>
                </tr>
              </thead>
              <tbody class="text-gray-300">
              <tr v-if="displayRows.length === 0" class="border-b border-white/5">
                <td colspan="3" class="px-4 py-6 text-center text-gray-500">Logs will populate here as they are received.</td>
              </tr>
              <template v-for="row in displayRows" :key="streamDataExpandKey(row)">
                <tr class="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                  <td class="relative py-3 pl-10 pr-4">
                    <button
                      v-if="row.isGroupRow && row.count != null"
                      type="button"
                      class="absolute left-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center p-0 text-[10px] font-medium bg-violet-500/40 text-violet-200 border border-violet-400/30 hover:bg-violet-500/50 transition-colors"
                      :title="`${row.count} × ${row.event} (click to expand)`"
                      :aria-label="`${row.count} ${row.event} events grouped, click to expand`"
                      @click="toggleGroupExpanded(row.groupIndex!)"
                    >
                      {{ row.count! > 99 ? '99+' : row.count }}
                    </button>
                    <span
                      class="rounded-full pl-1.5 pr-2 py-0.5 text-xs font-medium inline-flex items-center gap-1"
                      :class="eventBadgeClass(row.event)"
                    >
                      {{ row.event }}
                    </span>
                  </td>
                  <td class="px-4 py-3 text-gray-400">{{ row.time }}</td>
                  <td class="px-4 py-3 font-mono text-xs max-w-[200px]">
                    <div class="flex items-center gap-1 min-w-0">
                      <button
                        type="button"
                        class="shrink-0 p-0.5 rounded text-gray-500 hover:text-gray-300"
                        :aria-expanded="isStreamDataExpanded(streamDataExpandKey(row))"
                        aria-label="Show full data"
                        @click.stop="toggleDataRowExpanded(streamDataExpandKey(row))"
                      >
                        <Icon
                          name="lucide:chevron-right"
                          class="size-4 transition-transform"
                          :class="{ 'rotate-90': isStreamDataExpanded(streamDataExpandKey(row)) }"
                          aria-hidden="true"
                        />
                      </button>
                      <span class="truncate min-w-0">{{ row.data }}</span>
                    </div>
                  </td>
                </tr>
                <tr v-if="isStreamDataExpanded(streamDataExpandKey(row))" class="border-b border-white/5">
                  <td colspan="3" class="px-4 py-3 font-mono text-xs">
                    <pre class="text-xs text-gray-300 whitespace-pre-wrap break-all max-h-48 overflow-auto m-0">{{ formatStreamDataForExpand(row.data) }}</pre>
                  </td>
                </tr>
              </template>
              </tbody>
            </table>
          </div>
        </GlassCard>
        <!-- Browser logs: same as console [stream] messages -->
        <div class="mt-4 p-3 rounded-lg bg-black/30 border border-white/10">
          <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Browser logs</p>
          <pre class="text-xs text-gray-400 font-mono overflow-auto max-h-96 whitespace-pre-wrap break-all">{{ streamBrowserLogs }}</pre>
        </div>
      </section>
      <template #fallback>
        <section class="mb-8" aria-label="Stream event log">
          <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-4">Stream event log</h2>
          <GlassCard class="!p-0 overflow-clip flex flex-col h-96">
            <div class="overflow-y-auto min-h-0 flex-1">
              <table class="w-full text-left text-sm">
                <thead class="sticky top-0 z-10 bg-[#1A1726] border-b border-white/10">
                  <tr>
                    <th class="px-4 py-3 font-medium text-gray-400">Event</th>
                    <th class="px-4 py-3 font-medium text-gray-400">Time</th>
                    <th class="px-4 py-3 font-medium text-gray-400">Data</th>
                  </tr>
                </thead>
                <tbody class="text-gray-300">
                  <tr class="border-b border-white/5">
                    <td colspan="3" class="px-4 py-6 text-center text-gray-500">Events will populate here as they are received.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </GlassCard>
          <div class="mt-4 p-3 rounded-lg bg-black/30 border border-white/10">
            <p class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Browser logs</p>
            <pre class="text-xs text-gray-400 font-mono overflow-auto max-h-32 whitespace-pre-wrap break-all"></pre>
          </div>
        </section>
      </template>
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, watch, onMounted, onUnmounted } from 'vue'
import type { ApexOptions } from 'apexcharts'
import { usePrimaryBaseUrl } from '../composables/usePrimaryBaseUrl'
import { useStreamTargetUrl } from '../composables/useStreamTargetUrl'

/** Socket type from dynamic import (client-only). */
interface SocketLike {
  on(event: string, fn: (...args: unknown[]) => void): void
  disconnect(): void
}

const primaryBaseUrl = usePrimaryBaseUrl()
const streamTargetUrlState = useStreamTargetUrl()
/** Registered MCPs (discovery); polled so list updates when MCPs register. */
const discoveryServers = ref<{ projectName: string; port: number }[]>([])
/** Stream target URL: only from registered MCPs (broadcast). No fallback to config — wait for registration. */
const streamTargetUrl = computed(() => {
  if (typeof window === 'undefined') return ''
  const servers = discoveryServers.value
  if (servers.length > 0) {
    const host = (window.location.hostname === 'localhost' || window.location.hostname === '::1') ? '127.0.0.1' : window.location.hostname
    return `http://${host}:${servers[0].port}`
  }
  return ''
})

watch(streamTargetUrl, (value) => {
  streamTargetUrlState.value = value || ''
}, { immediate: true })
/** Port from stream target for error copy. */
const backendPortForCopy = computed(() => {
  const b = streamTargetUrl.value
  if (!b) return '3000'
  try {
    const u = new URL(b)
    return u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    return '3000'
  }
})

const streamStatus = ref<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected')
const streamEventTime = ref('')
/** Server we're currently connected to (for deregister on disconnect). */
const currentStreamServer = ref<{ projectName: string; port: number } | null>(null)
/** Raw stream events (newest first); pushStreamEvent appends here. */
const streamEventsRaw = ref<{ id: string; event: string; time: string; data: string }[]>([])
let nextStreamEventId = 0

/** Matches backend FILE_READ_WINDOW_DAYS / stats chart last7Days. */
const FILE_READ_WINDOW_DAYS = 7

/** Matches server `isReadMetricOperation` (verb `read` + legacy slug). */
function isReadMetricOperationUi(operation: string | undefined): boolean {
  return operation === 'read' || operation === 'file_reads_batch'
}

/** Vault LLM rows (`postModelCallMetric` / `runFileProcessingLlm`). */
function isModelCallMetricOperationUi(operation: string | undefined): boolean {
  return String(operation ?? '').trim() === 'model_call'
}

/** Sum of file reads across all projects in the rolling local window (from GET + metric stream). */
const fileReadsWindowSum = ref<number | null>(null)
/** Grouped rows: consecutive identical event labels collapse to one row with count + newest time/data; rawEvents for expand. */
const streamEventRows = computed(() => {
  const raw = streamEventsRaw.value
  if (raw.length === 0) return []
  type Row = {
    id: string
    event: string
    time: string
    data: string
    count?: number
    rawEvents?: { id: string; time: string; data: string }[]
  }
  const out: Row[] = []
  let i = 0
  while (i < raw.length) {
    const eventName = raw[i].event
    const group: { id: string; time: string; data: string }[] = []
    while (i < raw.length && raw[i].event === eventName) {
      group.push({ id: raw[i].id, time: raw[i].time, data: raw[i].data })
      i += 1
    }
    // raw is newest-first, so group[0] is the newest in this run
    const newest = group[0]!
    out.push({
      event: eventName,
      time: newest.time,
      data: newest.data,
      id: newest.id,
      ...(group.length > 1 ? { count: group.length, rawEvents: group } : {})
    })
  }
  return out
})

/** Which grouped rows are expanded (show individual events). Set of row index in streamEventRows. */
const expandedGroupIndices = ref<Set<number>>(new Set())

/** Data accordion keys. Group summary uses stream:event-group:N (stable per slot); single-row slots use the same index scheme so prepends keep the accordion open when rows merge. */
const expandedDataRowKeys = ref<string[]>([])

type DisplayStreamRow = {
  rowId: string
  event: string
  time: string
  data: string
  count?: number
  groupIndex?: number
  isGroupRow?: boolean
  rawEvents?: { id: string; time: string; data: string }[]
  /** Index into streamEventRows for stable expand key when this row is not a multi-event group. */
  groupSlotKey?: number
}

function streamDataExpandKey(row: DisplayStreamRow): string {
  if (row.isGroupRow && row.count != null && row.groupIndex !== undefined)
    return `stream:event-group:${row.groupIndex}`
  if (row.groupSlotKey !== undefined) return `stream:event-group:${row.groupSlotKey}`
  return row.rowId
}

function isStreamDataExpanded(key: string): boolean {
  return expandedDataRowKeys.value.includes(key)
}

function toggleDataRowExpanded(expandKey: string) {
  const cur = expandedDataRowKeys.value
  const i = cur.indexOf(expandKey)
  expandedDataRowKeys.value = i >= 0 ? cur.filter((k) => k !== expandKey) : [...cur, expandKey]
}

function formatStreamDataForExpand(data: string): string {
  try {
    return JSON.stringify(JSON.parse(data), null, 2)
  } catch {
    return data
  }
}

/** Flattened rows for table: expanded groups show a clickable group row (stays visible) then individual rows; click group row to collapse. */
const displayRows = computed(() => {
  const rows = streamEventRows.value
  const expanded = expandedGroupIndices.value
  const out: DisplayStreamRow[] = []
  rows.forEach((row, idx) => {
    if (row.count != null && row.rawEvents && expanded.has(idx)) {
      const [first, ...rest] = row.rawEvents
      out.push({
        rowId: first.id,
        event: row.event,
        time: first.time,
        data: first.data,
        groupIndex: idx,
        isGroupRow: true,
        count: row.count,
        rawEvents: row.rawEvents
      })
      rest.forEach((re) =>
        out.push({ rowId: re.id, event: row.event, time: re.time, data: re.data })
      )
    } else {
      const groupSlotKey = row.count == null ? idx : undefined
      out.push({
        ...row,
        rowId: row.id,
        ...(groupSlotKey !== undefined ? { groupSlotKey } : {}),
        ...(row.count != null ? { groupIndex: idx, isGroupRow: true, rawEvents: row.rawEvents } : {})
      })
    }
  })
  return out
})

function toggleGroupExpanded(groupIndex: number) {
  const next = new Set(expandedGroupIndices.value)
  if (next.has(groupIndex)) next.delete(groupIndex)
  else next.add(groupIndex)
  expandedGroupIndices.value = next
}

/** Browser logs visible on the page (same as console [stream] messages). */
const streamBrowserLogs = ref('')
/** Stream alive: first server `connected` event or heartbeat (backend emits both right after join). */
const hasReceivedHeartbeat = ref(false)
/** Only show the stream error banner after we've actually had a connect_error or disconnect (not on first paint). */
const hasStreamErrorOccurred = ref(false)

/** Primary port from stream (primary:identified); used to show Primary badge in Registered MCPs. */
const primaryPortFromStream = ref<number | null>(null)
/** Secondaries from stream (secondary:connected); shown in Registered MCPs with Secondary style. */
const secondariesFromStream = ref<{ port: number; projectName: string }[]>([])
let discoveryPollTimer: ReturnType<typeof setInterval> | null = null
/** Consecutive empty /api/servers responses; avoid replacing a non-empty list with a single spurious empty. */
let consecutiveEmptyDiscoveryResponses = 0

async function fetchDiscoveryServers() {
  try {
    const r = await fetch('/api/servers')
    if (r.ok) {
      const { servers } = (await r.json()) as { servers?: { projectName: string; port: number }[] }
      const list = servers ?? []
      if (list.length > 0) {
        consecutiveEmptyDiscoveryResponses = 0
        discoveryServers.value = list
      } else {
        consecutiveEmptyDiscoveryResponses += 1
        // Only replace with empty after 2 consecutive empty responses so one blip (e.g. during a new MCP registering) doesn't clear the UI
        if (consecutiveEmptyDiscoveryResponses >= 2 || discoveryServers.value.length === 0) {
          discoveryServers.value = list
        }
      }
    }
    // On non-ok response, keep current list; do not clear — we didn't lose communication with existing MCPs
  } catch {
    // On network error, keep current list; do not clear — e.g. server busy handling a new registration must not wipe the UI
  }
}

function addStreamLog(msg: string) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`
  console.log('[stream]', msg)
  streamBrowserLogs.value = streamBrowserLogs.value ? `${streamBrowserLogs.value}\n${line}` : line
  if (streamBrowserLogs.value.length > 4000) streamBrowserLogs.value = streamBrowserLogs.value.slice(-3500)
}

// Scan progress tiles: Socket.IO `scan:progress` (replay on connect); also from newest stream row when event is `scan` (metric socket).
const scanFilesProcessed = ref<number | null>(null)
const scanFilesUpdated = ref<number | null>(null)
const scanFilesProcessedDisplay = computed(() =>
  scanFilesProcessed.value != null ? String(scanFilesProcessed.value) : '—'
)
const scanFilesUpdatedDisplay = computed(() =>
  scanFilesUpdated.value != null ? String(scanFilesUpdated.value) : '—'
)

// Metrics: initial load from Mongo for charts/scorecards only; stream event table is Socket.IO only
interface StreamMetric {
  _id?: string
  instance_id: string
  operation: string
  kind?: 'query' | 'event'
  started_at: string
  ended_at: string
  duration_ms: number
  status: 'ok' | 'error'
  error_code?: string
  metadata?: Record<string, unknown>
}
const metricsFromStream = ref<StreamMetric[]>([])
const metricsLoading = ref(false)

// Connection status (heartbeat: last update tooltip)
const connectionStatusLabel = computed(() => {
  if (streamStatus.value === 'connected') return 'Connected'
  if (streamStatus.value === 'connecting') return 'Waiting…'
  if (streamStatus.value === 'error') return 'Disconnected'
  return 'Waiting…'
})
const connectionStatusTitle = computed(() => {
  if (streamStatus.value === 'connected' && streamEventTime.value)
    return `Last update: ${streamEventTime.value}`
  if (streamStatus.value === 'connecting') return 'Connecting to backend…'
  return ''
})
const connectionStatusClass = computed(() => {
  if (streamStatus.value === 'connected') return 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
  if (streamStatus.value === 'connecting' || streamStatus.value === 'disconnected') return 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
  return 'bg-gray-500/15 text-gray-400 border border-white/10'
})
const connectionDotClass = computed(() => {
  if (streamStatus.value === 'connected') return 'bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.5)]'
  if (streamStatus.value === 'connecting' || streamStatus.value === 'disconnected') return 'bg-amber-400 shadow-[0_0_12px_rgba(251,191,36,0.4)]'
  return 'bg-gray-500'
})

// Scorecards: metricsFromStream (GET /metrics + live Socket.IO `metric`) and file-reads window GET — unrelated to stream event table
const mcpScorecards = computed(() => {
  const m = metricsFromStream.value
  const queries = m.filter((x) => (x.kind ?? 'event') === 'query').length
  const docsReturned = m.reduce((sum, x) => sum + (Number((x.metadata as { documents?: number })?.documents) || 0), 0)
  const filesReadDisplay =
    fileReadsWindowSum.value != null ? String(fileReadsWindowSum.value) : '—'
  const toolCalls = m.filter((x) => x.operation?.toLowerCase().includes('tool') || x.operation === 'tool_call').length
  const errors = m.filter((x) => x.status === 'error').length
  const cacheHits = m.reduce((sum, x) => sum + (Number((x.metadata as { cache_hit?: number })?.cache_hit) || 0), 0)
  const totalWithCache = m.length
  const cacheRate = totalWithCache > 0 ? Math.round((cacheHits / totalWithCache) * 100) : null
  const modelCalls = m.filter((x) => isModelCallMetricOperationUi(x.operation)).length
  return [
    { label: 'Queries', value: m.length > 0 ? String(queries) : '—', sublabel: 'User-initiated' },
    { label: 'Documents returned', value: m.length > 0 ? String(docsReturned) : '—', sublabel: '' },
    { label: 'Files read', value: filesReadDisplay, sublabel: `${FILE_READ_WINDOW_DAYS}d window` },
    { label: 'Model calls', value: m.length > 0 ? String(modelCalls) : '—', sublabel: 'LLM' },
    { label: 'Tool calls', value: m.length > 0 ? String(toolCalls) : '—', sublabel: '' },
    { label: 'Errors', value: m.length > 0 ? String(errors) : '—', sublabel: '' },
    { label: 'Cache hit rate', value: cacheRate != null ? `${cacheRate}` : '—', sublabel: '%' }
  ]
})

const stats = reactive({
  responseTimeP50: '—',
  responseTimeP85: '—',
  responseTimeP99: '—',
  tokensInP50: '—',
  tokensInP85: '—',
  tokensInP99: '—',
  tokensOutP50: '—',
  tokensOutP85: '—',
  tokensOutP99: '—',
  tokensThinkingP50: '—',
  tokensThinkingP85: '—',
  tokensThinkingP99: '—'
})

function updateStatsFromStream() {
  const m = metricsFromStream.value
  if (m.length === 0) return
  const llm = m.filter((x) => isModelCallMetricOperationUi(x.operation))
  if (llm.length === 0) {
    stats.responseTimeP50 = '—'
    stats.responseTimeP85 = '—'
    stats.responseTimeP99 = '—'
    stats.tokensInP50 = '—'
    stats.tokensInP85 = '—'
    stats.tokensInP99 = '—'
    stats.tokensOutP50 = '—'
    stats.tokensOutP85 = '—'
    stats.tokensOutP99 = '—'
    stats.tokensThinkingP50 = '—'
    stats.tokensThinkingP85 = '—'
    stats.tokensThinkingP99 = '—'
    return
  }
  const durations = llm.map((x) => x.duration_ms).sort((a, b) => a - b)
  const p = (q: number) => durations[Math.floor((q / 100) * durations.length)] ?? durations[durations.length - 1]
  stats.responseTimeP50 = String(Math.round(p(50)))
  stats.responseTimeP85 = String(Math.round(p(85)))
  stats.responseTimeP99 = String(Math.round(p(99)))
  const tokensIn = llm.map((x) => Number((x.metadata as { tokens_in?: number })?.tokens_in) ?? 0).filter(Boolean)
  const tokensOut = llm.map((x) => Number((x.metadata as { tokens_out?: number })?.tokens_out) ?? 0).filter(Boolean)
  const tokensThinking = llm.map((x) => Number((x.metadata as { tokens_thinking?: number })?.tokens_thinking) ?? 0).filter(Boolean)
  if (tokensIn.length) {
    const sorted = [...tokensIn].sort((a, b) => a - b)
    const pct = (q: number) => sorted[Math.floor((q / 100) * sorted.length)] ?? sorted[sorted.length - 1]
    stats.tokensInP50 = String(pct(50))
    stats.tokensInP85 = String(pct(85))
    stats.tokensInP99 = String(pct(99))
  }
  if (tokensOut.length) {
    const sorted = [...tokensOut].sort((a, b) => a - b)
    const pct = (q: number) => sorted[Math.floor((q / 100) * sorted.length)] ?? sorted[sorted.length - 1]
    stats.tokensOutP50 = String(pct(50))
    stats.tokensOutP85 = String(pct(85))
    stats.tokensOutP99 = String(pct(99))
  }
  if (tokensThinking.length) {
    const sorted = [...tokensThinking].sort((a, b) => a - b)
    const pct = (q: number) => sorted[Math.floor((q / 100) * sorted.length)] ?? sorted[sorted.length - 1]
    stats.tokensThinkingP50 = String(pct(50))
    stats.tokensThinkingP85 = String(pct(85))
    stats.tokensThinkingP99 = String(pct(99))
  }
}

// Charts: data only from stream. vue3-apexcharts watches series and calls updateSeries() in place.
const last7Days = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - (6 - i))
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  })
)
const timeChartSeries = computed(() => {
  void streamEventsRaw.value
  const metrics = metricsFromStream.value
  const days = last7Days.value.map((_, i) => {
    const start = new Date()
    start.setDate(start.getDate() - (6 - i))
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return { start: start.getTime(), end: end.getTime() }
  })
  const count = (fn: (x: { started_at: string; kind?: string }) => boolean) =>
    days.map(({ start, end }) => metrics.filter((x) => { const t = new Date(x.started_at).getTime(); return fn(x) && t >= start && t < end }).length)
  const queries = count((x) => (x.kind ?? 'event') === 'query')
  const events = count((x) => (x.kind ?? 'event') === 'event')
  const activeProjectsCount = discoveryServers.value.length
  /** Per-metric file-activity volume (`read` counts + files touched in scan progress metrics). */
  function fileOpsVolume(x: StreamMetric): number {
    if (isReadMetricOperationUi(x.operation)) {
      const entries = (x.metadata as { entries?: { count?: unknown }[] } | undefined)?.entries
      if (!Array.isArray(entries)) return 0
      let s = 0
      for (const e of entries) {
        const c = e?.count
        if (typeof c === 'number' && Number.isFinite(c)) s += c
      }
      return s
    }
    if (x.operation === 'scan') {
      const meta = x.metadata as {
        processingRelative?: unknown[]
        processing?: unknown[]
        action?: string
      } | undefined
      if (Array.isArray(meta?.processingRelative) && meta.processingRelative.length > 0)
        return meta.processingRelative.length
      if (Array.isArray(meta?.processing) && meta.processing.length > 0) return meta.processing.length
      const action = meta?.action
      if (action != null && String(action) !== '' && String(action) !== 'complete') return 1
      return 0
    }
    return 0
  }
  const fileOps = days.map(({ start, end }) =>
    metrics.reduce((sum, x) => {
      const t = new Date(x.started_at).getTime()
      if (t < start || t >= end) return sum
      return sum + fileOpsVolume(x)
    }, 0)
  )
  return [
    { name: 'Active projects', data: queries.map(() => activeProjectsCount) },
    { name: 'Event count', data: events },
    { name: 'File ops', data: fileOps },
    { name: 'Queries', data: queries }
  ]
})

const timeChartOptions = ref<ApexOptions | null>({
  chart: { type: 'area', background: 'transparent', toolbar: { show: false }, zoom: { enabled: false }, fontFamily: 'inherit' },
  theme: { mode: 'dark' },
  colors: ['#8B5CF6', '#3B82F6', '#EC4899', '#F97316'],
  stroke: { curve: 'smooth', width: 2 },
  fill: { type: 'gradient', gradient: { opacityFrom: 0.35, opacityTo: 0.04, shadeIntensity: 1 } },
  dataLabels: { enabled: false },
  xaxis: { categories: last7Days.value, labels: { style: { colors: '#9CA3AF', fontSize: '11px' } }, axisBorder: { color: 'rgba(255,255,255,0.08)' } },
  yaxis: { min: 0, labels: { style: { colors: '#9CA3AF', fontSize: '11px' } }, axisBorder: { show: false } },
  grid: { borderColor: 'rgba(255,255,255,0.06)', xaxis: { lines: { show: false } }, yaxis: { lines: { show: true } }, padding: { top: 12, right: 12, bottom: 4, left: 4 } },
  legend: { labels: { colors: '#E5E7EB' }, position: 'top', horizontalAlign: 'right', fontSize: '12px' },
  tooltip: { theme: 'dark', x: { format: 'dd MMM' } }
})

const rpmCategories = Array.from({ length: 12 }, (_, i) => `${i * 2}:00`)
const rpmChartSeries = computed(() => {
  const m = metricsFromStream.value
  const now = new Date()
  const buckets = rpmCategories.map((_, i) => {
    const hour = i * 2
    const start = new Date(now)
    start.setHours(hour, 0, 0, 0)
    const end = new Date(start)
    end.setHours(hour + 2, 0, 0, 0)
    return m.filter((x) => {
      const t = new Date(x.started_at).getTime()
      return t >= start.getTime() && t < end.getTime()
    }).length
  })
  return [{ name: 'Requests/min', data: buckets }]
})
const rpmChartOptions = ref<ApexOptions | null>({
  chart: { type: 'bar', background: 'transparent', toolbar: { show: false }, fontFamily: 'inherit' },
  theme: { mode: 'dark' },
  colors: ['#8B5CF6'],
  plotOptions: { bar: { borderRadius: 8, columnWidth: '65%', distributed: false } },
  dataLabels: { enabled: false },
  xaxis: { categories: rpmCategories, labels: { style: { colors: '#9CA3AF', fontSize: '11px' } }, axisBorder: { color: 'rgba(255,255,255,0.08)' } },
  yaxis: { min: 0, labels: { style: { colors: '#9CA3AF', fontSize: '11px' } }, axisBorder: { show: false } },
  grid: { borderColor: 'rgba(255,255,255,0.06)', padding: { top: 8, right: 8, bottom: -30, left: 0 } },
  legend: { show: false },
  tooltip: { theme: 'dark' }
})

const STREAM_EVENT_CAP = 200

function metricEventLabelFromJson(str: string): string {
  try {
    const m = JSON.parse(str) as { operation?: string }
    if (typeof m.operation === 'string' && m.operation.trim()) return m.operation.trim()
  } catch {
    // ignore
  }
  return 'metric'
}

function eventBadgeClass(event: string): string {
  switch (event) {
    case 'connected':
      return 'bg-emerald-500/30 text-emerald-200'
    case 'heartbeat':
      return 'bg-violet-500/30 text-violet-200'
    default:
      return 'bg-white/10 text-gray-200'
  }
}

function pushStreamEvent(data: string, eventType: string) {
  const time = new Date().toLocaleString()
  streamEventTime.value = time
  const id = `se-${++nextStreamEventId}`
  const next = [{ id, event: eventType, time, data }, ...streamEventsRaw.value]
  streamEventsRaw.value = next.slice(0, STREAM_EVENT_CAP)
}

/** Scan tiles follow the stream log: when the newest row is `scan`, read counts from its payload (same JSON as `metric`). */
function applyScanTilesFromStreamRowData(data: string): void {
  try {
    const parsed = JSON.parse(data) as {
      operation?: string
      metadata?: { processedCount?: unknown; filesUpdated?: unknown }
    }
    if (parsed.operation !== 'scan' || !parsed.metadata || typeof parsed.metadata !== 'object') return
    const md = parsed.metadata
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const processed = n(md.processedCount)
    if (processed == null) return
    scanFilesProcessed.value = processed
    const updated = n(md.filesUpdated)
    scanFilesUpdated.value = updated != null ? updated : processed
  } catch {
    // ignore
  }
}

function applyFileReadsWindowSumFromMetadata(metadata: Record<string, unknown> | undefined): void {
  if (!metadata || typeof metadata !== 'object') return
  const totals = metadata.totals
  if (!Array.isArray(totals)) return
  let sum = 0
  for (const row of totals) {
    if (row && typeof row === 'object' && typeof (row as { total?: unknown }).total === 'number')
      sum += (row as { total: number }).total
  }
  fileReadsWindowSum.value = sum
}

async function fetchInitialMetrics() {
  metricsLoading.value = true
  const baseUrl = streamTargetUrl.value
  if (!baseUrl) return
  const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}/metrics?limit=500` : '/metrics?limit=500'
  try {
    const res = await fetch(url)
    if (res.ok) {
      const { metrics } = await res.json()
      const list = (metrics ?? []).map((m: { _id?: string; started_at: string; ended_at: string; [k: string]: unknown }) => ({
        _id: m._id?.toString?.() ?? (m as { id?: string }).id,
        instance_id: m.instance_id as string,
        operation: m.operation as string,
        kind: (m.kind as StreamMetric['kind']) ?? 'event',
        started_at: typeof m.started_at === 'string' ? m.started_at : new Date(m.started_at).toISOString(),
        ended_at: typeof m.ended_at === 'string' ? m.ended_at : new Date(m.ended_at).toISOString(),
        duration_ms: m.duration_ms as number,
        status: m.status as 'ok' | 'error',
        error_code: m.error_code as string | undefined,
        metadata: m.metadata as Record<string, unknown> | undefined
      }))
      metricsFromStream.value = list
      updateStatsFromStream()
    }
  } catch {
    metricsFromStream.value = []
  } finally {
    metricsLoading.value = false
  }
  await fetchFileReadsWindow()
}

async function fetchFileReadsWindow() {
  const baseUrl = streamTargetUrl.value
  if (!baseUrl) return
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/metrics/file-reads/window?days=${FILE_READ_WINDOW_DAYS}`
    const res = await fetch(url)
    if (!res.ok) return
    const json = (await res.json()) as { totals?: { project?: string; total?: number }[] }
    const totals = json.totals ?? []
    const sum = totals.reduce(
      (s, x) => s + (typeof x.total === 'number' && Number.isFinite(x.total) ? x.total : 0),
      0
    )
    fileReadsWindowSum.value = sum
  } catch {
    // keep fileReadsWindowSum
  }
}

function onMetric(data: string) {
  try {
    const m = JSON.parse(data) as StreamMetric
    const id = m._id ?? (m as { id?: string }).id
    const existing = metricsFromStream.value
    if (id && existing.some((x) => (x._id ?? (x as { id?: string }).id) === id)) return
    metricsFromStream.value = [m, ...existing.slice(0, 498)]
    updateStatsFromStream()
  } catch {
    // ignore
  }
}

let socket: SocketLike | null = null
/** Bumps on each connectStream() so overlapping calls (watch + onMounted) cannot each create a Socket.IO client — orphaned clients would double heartbeats in the log. */
let connectStreamGeneration = 0
/** Backend sends heartbeat every 5s; if we get nothing for this long, treat connection as dead so UI updates (e.g. after server Ctrl-C). */
const STREAM_DEAD_MS = 6_000
/** Debounce before showing Disconnected after a disconnect event so flaky connections don't flip/flop. */
// Unit tests assert immediate UI state changes on disconnect; in test mode we disable debounce.
const DISCONNECT_DEBOUNCE_MS = process.env.NODE_ENV === 'test' ? 0 : 4_000
let streamDeadTimer: ReturnType<typeof setTimeout> | null = null
let disconnectDebounceTimer: ReturnType<typeof setTimeout> | null = null

function clearDisconnectDebounce() {
  if (disconnectDebounceTimer) {
    clearTimeout(disconnectDebounceTimer)
    disconnectDebounceTimer = null
  }
}

function scheduleStreamDeadCheck() {
  if (streamDeadTimer) clearTimeout(streamDeadTimer)
  streamDeadTimer = setTimeout(() => {
    streamDeadTimer = null
    if (streamStatus.value === 'connected') {
      streamStatus.value = 'error'
      hasReceivedHeartbeat.value = false
      if (socket) socket.disconnect()
      socket = null
    }
  }, STREAM_DEAD_MS)
}

function onStreamEvent() {
  if (streamStatus.value === 'connected') scheduleStreamDeadCheck()
}

async function connectStream(baseUrl: string) {
  const gen = ++connectStreamGeneration
  if (socket) {
    socket.disconnect()
    socket = null
  }
  const base = baseUrl ? baseUrl.replace(/\/$/, '') : ''
  // Make this available to other pages (config/scan) for HTTP requests.
  primaryBaseUrl.value = base || ''
  const servers = discoveryServers.value
  const first = servers.length > 0 ? servers[0] : null
  if (first && base) {
    try {
      const u = new URL(base)
      if (u.port === String(first.port)) currentStreamServer.value = { projectName: first.projectName, port: first.port }
      else currentStreamServer.value = null
    } catch {
      currentStreamServer.value = null
    }
  } else {
    currentStreamServer.value = null
  }
  streamStatus.value = 'connecting'
  hasReceivedHeartbeat.value = false
  clearDisconnectDebounce()
  const { io } = await import('../lib/socketIoClient')
  if (gen !== connectStreamGeneration) return
  addStreamLog(`Socket.IO connecting to ${base || window.location.origin}`)
  socket = io(base || undefined, { autoConnect: true, reconnection: true })
  socket.on('connect', () => {
    addStreamLog('Socket.IO connect')
    clearDisconnectDebounce()
    streamStatus.value = 'connecting'
  })
  async function onStreamDisconnect() {
    const server = currentStreamServer.value
    currentStreamServer.value = null
    if (server) {
      try {
        await fetch('/api/servers/deregister', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(server) })
      } catch {
        // ignore
      }
      await fetchDiscoveryServers()
      const nextUrl = streamTargetUrl.value
      if (nextUrl) setTimeout(() => { if (streamTargetUrl.value) connectStream(streamTargetUrl.value) }, 1000)
    }
  }
  socket.on('connect_error', async (...args: unknown[]) => {
    const err = args[0] as Error
    hasStreamErrorOccurred.value = true
    addStreamLog(`Socket.IO connect_error: ${err?.message ?? String(args)}. ${base ? `Is the backend running on ${base}?` : 'Could not resolve the MCP stats URL yet—reload after Code Vault registers.'}`)
    streamStatus.value = 'error'
    hasReceivedHeartbeat.value = false
    await onStreamDisconnect()
  })
  socket.on('disconnect', async (...args: unknown[]) => {
    const reason = (args[0] as string) ?? 'unknown'
    hasStreamErrorOccurred.value = true
    addStreamLog(`Socket.IO disconnect: ${reason}`)
    if (streamDeadTimer) clearTimeout(streamDeadTimer)
    streamDeadTimer = null
    hasReceivedHeartbeat.value = false
    // Clear primary so pages don't make HTTP requests against a dead primary.
    primaryBaseUrl.value = ''
    if (disconnectDebounceTimer) return
    const runDisconnect = async () => {
      disconnectDebounceTimer = null
      if (streamStatus.value === 'connected' || streamStatus.value === 'connecting') {
        streamStatus.value = 'error'
        await onStreamDisconnect()
      }
    }

    if (DISCONNECT_DEBOUNCE_MS === 0) {
      await runDisconnect()
      return
    }

    disconnectDebounceTimer = setTimeout(runDisconnect, DISCONNECT_DEBOUNCE_MS)
  })
  socket.on('connected', (data: unknown) => {
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=connected ${str.slice(0, 80)}`)
    pushStreamEvent(str, 'connected')
    fetchInitialMetrics()
    // Same proof of life as first heartbeat: backend emits this immediately after join (see src/index.ts).
    // Relying only on heartbeat left the badge stuck on "Waiting…" after reload if the first heartbeat was missed.
    if (!hasReceivedHeartbeat.value) {
      hasReceivedHeartbeat.value = true
      clearDisconnectDebounce()
      streamStatus.value = 'connected'
      scheduleStreamDeadCheck()
    }
  })
  socket.on('heartbeat', (data: unknown) => {
    if (!hasReceivedHeartbeat.value) {
      hasReceivedHeartbeat.value = true
      clearDisconnectDebounce()
      streamStatus.value = 'connected'
      scheduleStreamDeadCheck()
    } else {
      onStreamEvent()
    }
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    pushStreamEvent(str, 'heartbeat')
  })
  socket.on('metric', (data: unknown) => {
    onStreamEvent()
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=metric ${str.slice(0, 80)}`)
    const eventLabel = metricEventLabelFromJson(str)
    pushStreamEvent(str, eventLabel)
    onMetric(str)
  })
  socket.on('scan:progress', (data: unknown) => {
    try {
      const str = typeof data === 'string' ? data : JSON.stringify(data)
      const p = JSON.parse(str) as { filesProcessed?: unknown; filesUpdated?: unknown }
      if (typeof p.filesProcessed === 'number' && Number.isFinite(p.filesProcessed)) {
        scanFilesProcessed.value = p.filesProcessed
      }
      if (typeof p.filesUpdated === 'number' && Number.isFinite(p.filesUpdated)) {
        scanFilesUpdated.value = p.filesUpdated
      } else if (typeof p.filesProcessed === 'number' && Number.isFinite(p.filesProcessed)) {
        scanFilesUpdated.value = p.filesProcessed
      }
    } catch {
      // ignore
    }
  })
  socket.on('primary:identified', (data: unknown) => {
    onStreamEvent()
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=primary:identified ${str.slice(0, 80)}`)
    pushStreamEvent(str, 'Primary identified')
    try {
      const payload = JSON.parse(str) as { port?: number }
      if (typeof payload.port === 'number') primaryPortFromStream.value = payload.port
    } catch {
      // ignore
    }
  })
  socket.on('secondary:connected', (data: unknown) => {
    onStreamEvent()
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=secondary:connected ${str.slice(0, 80)}`)
    pushStreamEvent(str, 'Secondary connected')
    try {
      const payload = JSON.parse(str) as { port?: number; projectName?: string }
      if (typeof payload.port === 'number' && typeof payload.projectName === 'string') {
        const next = [...secondariesFromStream.value]
        if (!next.some((s) => s.port === payload.port && s.projectName === payload.projectName)) {
          next.push({ port: payload.port, projectName: payload.projectName })
          secondariesFromStream.value = next
        }
      }
    } catch {
      // ignore
    }
  })
  socket.on('secondary:disconnected', (data: unknown) => {
    onStreamEvent()
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=secondary:disconnected ${str.slice(0, 80)}`)
    pushStreamEvent(str, 'Secondary disconnected')
    try {
      const payload = JSON.parse(str) as { port?: number; projectName?: string }
      if (typeof payload.port === 'number' && typeof payload.projectName === 'string') {
        secondariesFromStream.value = secondariesFromStream.value.filter(
          (s) => !(s.port === payload.port && s.projectName === payload.projectName)
        )
      }
    } catch {
      // ignore
    }
  })
  socket.on('primary:disconnected', (data: unknown) => {
    onStreamEvent()
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=primary:disconnected ${str.slice(0, 80)}`)
    pushStreamEvent(str, 'Primary disconnected')
  })
  socket.on('query:received', (data: unknown) => {
    onStreamEvent()
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=query:received ${str.slice(0, 80)}`)
    pushStreamEvent(str, 'Query received')
  })
  socket.on('db:connected', (data: unknown) => {
    onStreamEvent()
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=db:connected ${str.slice(0, 80)}`)
    pushStreamEvent(str, 'DB connected')
  })
  socket.on('seed:checked', (data: unknown) => {
    onStreamEvent()
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=seed:checked ${str.slice(0, 80)}`)
    pushStreamEvent(str, 'Seed checked')
  })
  socket.on('project', (data: unknown) => {
    onStreamEvent()
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    addStreamLog(`event=project ${str.slice(0, 80)}`)
    pushStreamEvent(str, 'Project ensured')
  })
}

onMounted(async () => {
  await fetchDiscoveryServers()
  discoveryPollTimer = setInterval(fetchDiscoveryServers, 5000)

  // Load persisted metrics from DB on mount so reload shows saved queries/events
  await fetchInitialMetrics()

  const baseUrl = streamTargetUrl.value
  if (!baseUrl) {
    addStreamLog('Waiting for MCP to register.')
    streamStatus.value = 'disconnected'
    return
  }
  if (baseUrl) await connectStream(baseUrl)
})

watch(
  () => streamEventsRaw.value[0],
  (head) => {
    if (!head) return
    try {
      const parsed = JSON.parse(head.data) as {
        operation?: string
        metadata?: Record<string, unknown>
      }
      if (parsed.operation === 'scan') applyScanTilesFromStreamRowData(head.data)
      if (isReadMetricOperationUi(parsed.operation))
        applyFileReadsWindowSumFromMetadata(parsed.metadata)
    } catch {
      // ignore
    }
  }
)

watch(discoveryServers, (servers, prev) => {
  if (servers.length === 0 && prev && prev.length > 0) {
    // No servers registered anymore (all stopped or pruned) — disconnect so status matches reality
    if (socket) {
      socket.disconnect()
      socket = null
    }
    currentStreamServer.value = null
    streamStatus.value = 'disconnected'
    hasReceivedHeartbeat.value = false
    clearDisconnectDebounce()
    if (streamDeadTimer) clearTimeout(streamDeadTimer)
    streamDeadTimer = null
    return
  }
  if (prev?.length === 0 && servers.length > 0 && (streamStatus.value === 'error' || streamStatus.value === 'disconnected')) {
    const url = streamTargetUrl.value
    if (url) connectStream(url)
  }
}, { deep: true })

onUnmounted(() => {
  if (discoveryPollTimer) clearInterval(discoveryPollTimer)
  discoveryPollTimer = null
  if (streamDeadTimer) clearTimeout(streamDeadTimer)
  streamDeadTimer = null
  clearDisconnectDebounce()
  if (socket) socket.disconnect()
  socket = null
})
</script>

<style scoped>
.waiting-banner {
  animation: waiting-pulse 2.5s ease-in-out infinite;
}
@keyframes waiting-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.82; }
}

</style>
