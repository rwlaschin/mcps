<template>
  <div class="p-6 md:p-8 max-w-4xl">
    <div class="mb-8">
      <h1 class="text-2xl md:text-3xl font-bold text-white">Scan</h1>
    </div>

    <GlassCard class="mb-8">
      <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-2">Project</h2>
      <p class="text-sm text-gray-400 mb-4">Select a project to run a scan or view progress.</p>
      <PlatformProjectSelect
        v-model="selectedProjectKey"
        :projects="projects"
        :loading="projectsLoading"
      />
      <p v-if="loadingPhase === 'ready' && projects.length === 0 && projectsResponseOk === true" class="mt-3 text-sm text-amber-200/80">
        No projects yet. They appear when Code Vault MCP has registered with this app (reload after connecting in your editor). If the database was never seeded, run the server seed once—see the setup docs.
      </p>
      <p v-else-if="loadingPhase === 'ready' && projects.length === 0 && projectsResponseOk === false" class="mt-3 text-sm text-amber-200/80">
        Could not load projects from the stats API. Ensure Code Vault MCP is running and try again.
      </p>
    </GlassCard>

    <ClientOnly>
      <GlassCard v-if="selectedProjectKey || projects.length === 0" class="mb-8">
        <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-2">Progress</h2>
        <ChunkUpdateGrid
          :files="displayFiles"
          :files-processed="displayProgress.filesProcessed"
          :files-updated="displayProgress.filesUpdated"
          :total-files="displayProgress.totalFiles"
          :is-active-scan="displayIsActiveScan"
        />
      </GlassCard>
      <template #fallback>
        <GlassCard v-if="selectedProjectKey || projects.length === 0" class="mb-8">
          <h2 class="text-lg font-semibold text-gray-400 uppercase tracking-widest mb-2">Progress</h2>
          <div class="text-gray-500">Loading grid…</div>
        </GlassCard>
      </template>
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { usePrimaryBaseUrl } from '../composables/usePrimaryBaseUrl'
import { useStreamTargetUrl } from '../composables/useStreamTargetUrl'
import { reconcileSelectedProjectKey, useSelectedProjectKey } from '../composables/useSelectedProjectKey'

export interface ProjectItem {
  key: string
  name: string
}

export interface ScanFileEntry {
  relativePath: string
  state: 'new' | 'stale' | 'fresh'
}

export interface ScanProgressPayload {
  filesProcessed: number
  filesUpdated: number
  totalFiles?: number
  isActiveScan?: boolean
  files?: ScanFileEntry[]
  projectKey?: string
}

interface ScanFilesResponse {
  entries: ScanFileEntry[]
  page?: { limit: number; hasMore: boolean; nextCursor: string | null }
}

/** Stable 500-file example heatmap (path-sorted in grid). */
const EXAMPLE_PREVIEW_FILES: ScanFileEntry[] = (() =>
  Array.from({ length: 500 }, (_, index) => {
    const mod = index % 10
    const state: ScanFileEntry['state'] = mod <= 1 ? 'new' : (mod <= 3 ? 'stale' : 'fresh')
    return { relativePath: `preview/file-${String(index + 1).padStart(4, '0')}.ts`, state }
  })
)()

/**
 * GET /scan/files returns every path as `new`. After Socket.IO has applied `stale`/`fresh`, re-fetching the listing
 * must not wipe those — only paths still `new` on disk stay new.
 */
function mergeListingPreservingFileStates(listing: ScanFileEntry[], previous: ScanFileEntry[]): ScanFileEntry[] {
  if (!previous.length) return listing
  const prevMap = new Map(previous.map((f) => [f.relativePath, f.state]))
  return listing.map((f) => {
    const st = prevMap.get(f.relativePath)
    if (st === 'stale' || st === 'fresh') return { ...f, state: st }
    return f
  })
}

/** Socket payloads often include only the in-flight batch; merge into the existing heatmap instead of replacing it. */
function mergeScanFilesFromPatch(
  existing: ScanFileEntry[],
  incoming: ScanFileEntry[] | undefined
): ScanFileEntry[] {
  if (!incoming?.length) return existing
  if (!existing.length) {
    return incoming.slice().sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  }
  const map = new Map(existing.map((f) => [f.relativePath, { ...f }]))
  for (const f of incoming) {
    const cur = map.get(f.relativePath)
    map.set(f.relativePath, cur ? { ...cur, state: f.state } : f)
  }
  return [...map.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

const projects = ref<ProjectItem[]>([])
/** null = before first fetch finished */
const projectsResponseOk = ref<boolean | null>(null)
const projectsLoading = ref(true)
const loadingPhase = ref<'idle' | 'loadingProjects' | 'loadingScanState' | 'ready'>('idle')
const selectedProjectKey = useSelectedProjectKey()

const scanProgress = ref<ScanProgressPayload>({
  filesProcessed: 0,
  filesUpdated: 0,
  totalFiles: 0,
  isActiveScan: false,
  files: []
})

const scanFiles = computed(() => scanProgress.value.files ?? [])
const isActiveScan = computed(() => Boolean(scanProgress.value.isActiveScan))
const useDemoMode = computed(() => projects.value.length === 0)
const shouldUseExampleFallback = computed(() => {
  if (useDemoMode.value || !selectedProjectKey.value) return true
  const files = scanProgress.value.files ?? []
  return files.length === 0
})
const displayProgress = computed<ScanProgressPayload>(() => {
  if (shouldUseExampleFallback.value) {
    return {
      filesProcessed: 312,
      filesUpdated: 114,
      totalFiles: 500,
      isActiveScan: true,
      files: EXAMPLE_PREVIEW_FILES
    }
  }
  return scanProgress.value
})
const displayFiles = computed(() => displayProgress.value.files ?? [])
const displayIsActiveScan = computed(() => Boolean(displayProgress.value.isActiveScan))

interface SocketLike {
  on(event: string, fn: (...args: unknown[]) => void): void
  emit(event: string, ...args: unknown[]): void
  disconnect(): void
}
let socket: SocketLike | null = null
let projectsRefreshInFlight = false
const primaryBaseUrl = usePrimaryBaseUrl()
const streamTargetUrl = useStreamTargetUrl()
/** Same as Config: direct HTTP to the discovered Fastify stats host (not `/api/stats/*`, which uses server-side STATS_PORT default). */
const scanBaseUrl = computed(() => streamTargetUrl.value || primaryBaseUrl.value)

function statsApiOrigin(): string {
  return (scanBaseUrl.value || '').replace(/\/$/, '')
}

async function ensureScanBaseUrl(): Promise<string> {
  const existing = scanBaseUrl.value
  if (existing) return existing
  try {
    const res = await fetch('/api/servers')
    if (!res.ok) return ''
    const payload = (await res.json()) as { servers?: Array<{ port?: number }> }
    let firstPort = payload.servers?.[0]?.port
    if (!firstPort) {
      const docsRes = await fetch('/api/docs-context')
      if (docsRes.ok) {
        const docsPayload = (await docsRes.json()) as { port?: string | number }
        const maybePort = Number(docsPayload.port)
        if (Number.isFinite(maybePort) && maybePort > 0) firstPort = maybePort
      }
    }
    if (!firstPort) return ''
    const host = (window.location.hostname === 'localhost' || window.location.hostname === '::1')
      ? '127.0.0.1'
      : window.location.hostname
    const resolved = `http://${host}:${firstPort}`
    streamTargetUrl.value = resolved
    primaryBaseUrl.value = resolved
    return resolved
  } catch {
    return ''
  }
}

async function fetchProjects() {
  if (projectsRefreshInFlight) return
  projectsRefreshInFlight = true
  projectsLoading.value = true
  loadingPhase.value = 'loadingProjects'
  try {
    const origin = statsApiOrigin()
    if (!origin) {
      projectsResponseOk.value = false
      return
    }
    const res = await fetch(`${origin}/projects`)
    if (res.ok) {
      projectsResponseOk.value = true
      const { projects: list } = await res.json()
      projects.value = list ?? []
      reconcileSelectedProjectKey(selectedProjectKey, projects.value)
    } else {
      projectsResponseOk.value = false
    }
  } catch {
    projectsResponseOk.value = false
  } finally {
    projectsLoading.value = false
    projectsRefreshInFlight = false
    if (loadingPhase.value === 'loadingProjects') loadingPhase.value = 'ready'
  }
}

/** File paths for the heatmap (disk enumeration). Live counts/states: Socket.IO `scan:progress` + `scan:replay` only. */
async function fetchScanFileListing() {
  const key = selectedProjectKey.value
  if (!key) return
  const origin = statsApiOrigin()
  if (!origin) return
  loadingPhase.value = 'loadingScanState'
  try {
    const filesRes = await fetch(
      `${origin}/scan/files?projectKey=${encodeURIComponent(key)}&limit=1000`
    )
    if (filesRes.ok) {
      const filesPayload = (await filesRes.json()) as ScanFilesResponse
      const listing = (filesPayload.entries ?? []).slice().sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      const prevFiles = scanProgress.value.files ?? []
      const merged = mergeListingPreservingFileStates(listing, prevFiles)
      scanProgress.value = {
        ...scanProgress.value,
        files: merged,
        totalFiles: Math.max(scanProgress.value.totalFiles ?? 0, listing.length)
      }
    }
  } catch {
    // keep previous state
  } finally {
    loadingPhase.value = 'ready'
  }
}

function onScanProgress(data: unknown) {
  if (useDemoMode.value) return
  try {
    const str = typeof data === 'string' ? data : JSON.stringify(data)
    const payload = JSON.parse(str) as ScanProgressPayload
    if (payload.projectKey && payload.projectKey !== selectedProjectKey.value) return
    const mergedFiles = mergeScanFilesFromPatch(scanProgress.value.files ?? [], payload.files)
    scanProgress.value = {
      ...scanProgress.value,
      ...payload,
      files: mergedFiles,
      totalFiles: Math.max(
        payload.totalFiles ?? 0,
        mergedFiles.length,
        scanProgress.value.totalFiles ?? 0
      ),
      isActiveScan:
        typeof payload.isActiveScan === 'boolean'
          ? payload.isActiveScan
          : (payload.filesProcessed ?? 0) <
            Math.max(payload.totalFiles ?? 0, mergedFiles.length, scanProgress.value.totalFiles ?? 0)
    }
  } catch {
    // ignore
  }
}

watch(selectedProjectKey, (key, prev) => {
  if (useDemoMode.value) return
  if (!key) return
  /** Initial reconcile `'' → key` is handled in onMounted; only react to real project switches. */
  if (prev === '' || prev === key) return
  scanProgress.value = {
    filesProcessed: 0,
    filesUpdated: 0,
    totalFiles: 0,
    isActiveScan: false,
    files: []
  }
  void fetchScanFileListing().then(() => {
    socket?.emit('scan:replay', key)
  })
})

onMounted(async () => {
  loadingPhase.value = 'loadingProjects'
  await ensureScanBaseUrl()
  await fetchProjects()
  if (selectedProjectKey.value) await fetchScanFileListing()

  const baseUrl = scanBaseUrl.value
  const base = baseUrl ? baseUrl.replace(/\/$/, '') : ''
  if (base) {
    const { io } = await import('../lib/socketIoClient')
    socket = io(base || undefined, { autoConnect: true, reconnection: true })
    primaryBaseUrl.value = base || ''
    socket.on('connect', () => {
      void fetchProjects()
      /** Server replays cached `scan:progress` on attach; refresh path listing only (heatmap scope). */
      if (!useDemoMode.value && selectedProjectKey.value) void fetchScanFileListing()
    })
    socket.on('project', () => {
      fetchProjects()
    })
    socket.on('scan:progress', onScanProgress)
  }
})

onUnmounted(() => {
  if (socket) socket.disconnect()
  socket = null
})
</script>
