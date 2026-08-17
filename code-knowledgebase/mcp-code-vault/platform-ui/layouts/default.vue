<template>
  <div class="h-screen flex overflow-clip text-gray-100 bg-[#100B1A] relative">
    <!-- Background light that tracks the mouse (soft spotlight) -->
    <div
      class="pointer-events-none fixed inset-0 z-0"
      aria-hidden="true"
      :style="backgroundLightStyle"
    />
    <!-- Sidebar: primary nav with rounded active state -->
    <aside class="w-[240px] shrink-0 flex flex-col min-h-0 border-r border-white/5 bg-[#0f0b14] relative z-10 overflow-y-auto">
      <nav class="p-3 flex flex-col gap-0.5 flex-1">
        <NuxtLink
          to="/"
          class="rounded-card px-3 py-2.5 flex items-center gap-3 text-gray-400 hover:bg-white/5 hover:text-gray-200 transition-colors"
          active-class="!bg-[#1A1726] !text-white"
        >
          <span class="w-5 h-5 flex items-center justify-center shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg></span>
          Stats
        </NuxtLink>
        <NuxtLink
          to="/config"
          class="rounded-card px-3 py-2.5 flex items-center gap-3 text-gray-400 hover:bg-white/5 hover:text-gray-200 transition-colors"
          active-class="!bg-[#1A1726] !text-white"
        >
          <span class="w-5 h-5 flex items-center justify-center shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg></span>
          Config
        </NuxtLink>
        <template v-if="isConfigPath(route.path)">
          <div class="pl-8 pr-2 py-1 flex flex-col gap-0.5">
            <template v-for="entry in configNavStructure" :key="entry.kind === 'link' ? entry.id : 'nav-prompts-group'">
              <a
                v-if="entry.kind === 'link'"
                :href="`/config#${entry.id}`"
                class="rounded-card px-2.5 py-1.5 text-sm transition-colors cursor-pointer"
                :class="configActiveSectionId === entry.id ? 'bg-white/10 text-white' : 'text-gray-500 hover:bg-white/5 hover:text-gray-300'"
                @click.prevent="goToConfigSection(entry.id)"
              >
                {{ entry.label }}
              </a>
              <div v-else class="flex flex-col gap-0.5">
                <a
                  :href="`/config#${entry.children[0]!.id}`"
                  class="rounded-card px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-300 hover:bg-white/5 hover:text-white transition-colors cursor-pointer"
                  @click.prevent="goToConfigSection(entry.children[0]!.id)"
                >
                  {{ entry.label }}
                </a>
                <a
                  v-for="c in entry.children"
                  :key="c.id"
                  :href="`/config#${c.id}`"
                  class="rounded-card px-2.5 py-1.5 text-sm transition-colors pl-4 cursor-pointer"
                  :class="configActiveSectionId === c.id ? 'bg-white/10 text-white' : 'text-gray-500 hover:bg-white/5 hover:text-gray-300'"
                  @click.prevent="goToConfigSection(c.id)"
                >
                  {{ c.label }}
                </a>
              </div>
            </template>
          </div>
        </template>
        <NuxtLink
          to="/scan"
          class="rounded-card px-3 py-2.5 flex items-center gap-3 text-gray-400 hover:bg-white/5 hover:text-gray-200 transition-colors"
          active-class="!bg-[#1A1726] !text-white"
        >
          <span class="w-5 h-5 flex items-center justify-center shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg></span>
          Scan
        </NuxtLink>
        <NuxtLink
          to="/docs"
          class="rounded-card px-3 py-2.5 flex items-center gap-3 text-gray-400 hover:bg-white/5 hover:text-gray-200 transition-colors"
          active-class="!bg-[#1A1726] !text-white"
        >
          <span class="w-5 h-5 flex items-center justify-center shrink-0"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" /></svg></span>
          Docs
        </NuxtLink>
        <template v-if="route.path === '/docs'">
          <div class="pl-8 pr-2 py-1 flex flex-col gap-0.5">
            <a
              v-for="s in docSections"
              :key="s.id"
              :href="`#${s.id}`"
              class="rounded-card py-1.5 transition-colors border-l-2 border-transparent"
              :class="[
                docsActiveSectionId === s.id ? 'bg-white/10 text-white border-accent/40' : 'text-gray-500 hover:bg-white/5 hover:text-gray-300',
                s.depth === 0 ? 'px-2.5 text-sm font-medium text-gray-300' : 'pl-5 pr-2.5 ml-1 text-xs border-l-white/10'
              ]"
              @click.prevent="scrollToDocSection(s.id)"
            >
              {{ s.label }}
            </a>
          </div>
        </template>
      </nav>
    </aside>
    <main class="flex-1 min-h-0 overflow-auto min-w-0 relative z-10 scroll-smooth">
      <slot />
    </main>
    <ToastStack />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  isConfigPath,
  CONFIG_HASH_ALIASES,
  configHashFragment,
  normalizeConfigSectionHash
} from '../composables/useConfigRoute'
import { useDocsNavAgentEntries } from '../composables/useDocsNavAgentEntries'

const route = useRoute()
const router = useRouter()

/**
 * Hash is not available during SSR; reading window during client VDOM would disagree with server HTML.
 * Defer config subnav "active" styling until after mount so hydration matches (no highlight), then apply hash.
 */
const configSubnavHydrated = ref(false)
onMounted(() => {
  configSubnavHydrated.value = true
})
type DocNavSection = { id: string; label: string; depth: number }

const docSectionsStatic: DocNavSection[] = [
  { id: 'quick-start', label: 'Quick start', depth: 0 },
  { id: 'setting-up-mcp-cursor', label: 'MCP setup in Cursor', depth: 1 },
  { id: 'using-the-mcp', label: 'MCP tools reference', depth: 0 },
  { id: 'tool-ping', label: 'ping', depth: 1 },
  { id: 'tool-settings', label: 'settings', depth: 1 },
  { id: 'tool-config', label: 'config', depth: 1 },
  { id: 'user-interface', label: 'Platform UI', depth: 0 },
  { id: 'configuration', label: 'Configuration', depth: 0 }
]

const docsNavAgentEntries = useDocsNavAgentEntries()

const docSections = computed(() => [...docSectionsStatic, ...docsNavAgentEntries.value])

const validDocIds = computed(() => new Set(docSections.value.map((s) => s.id)))

/** Agent anchors load after `/config/agents`; keep deep links valid while the list hydrates. */
function isAgentDocHash(value: string): boolean {
  return value.startsWith('tool-agent-') && value.length > 'tool-agent-'.length
}

type ConfigNavLink = { kind: 'link'; id: string; label: string }
type ConfigNavGroup = { kind: 'group'; id: string; label: string; children: Array<{ id: string; label: string }> }

const configNavStructure: Array<ConfigNavLink | ConfigNavGroup> = [
  { kind: 'link', id: 'settings', label: 'Settings' },
  { kind: 'link', id: 'models', label: 'Models' },
  {
    kind: 'group',
    id: 'prompts',
    label: 'Prompts',
    children: [
      { id: 'prompts-global', label: 'Global' },
      { id: 'prompts-agents', label: 'Agents' },
      { id: 'prompts-personas', label: 'Personas' }
    ]
  }
]

// Redirect invalid / missing hash on /config (same pattern as docs).
// Uses configHashFragment so a full reload with #fragment still works when route.hash lags window.location.
watch(
  () => (isConfigPath(route.path) ? route.hash : ''),
  () => {
    if (!isConfigPath(route.path)) return
    const value = configHashFragment(route.path, route.hash)
    if (value === 'project-config') {
      void router.replace('/config#settings')
      return
    }
    if (value === 'prompts') {
      void router.replace('/config#prompts-global')
      return
    }
    if (value === 'personas') {
      void router.replace('/config#prompts-personas')
      return
    }
    if (!value || !CONFIG_HASH_ALIASES.has(value)) {
      void router.replace('/config#settings')
      return
    }
    const routerOnly = (route.hash ?? '').replace(/^#/, '').trim()
    if (!routerOnly && value) {
      const canonical = normalizeConfigSectionHash(value)
      void router.replace(`/config#${canonical}`)
    }
  },
  { immediate: true }
)

// Redirect invalid hash on /docs so URL always has a valid section (avoids null refs and broken state)
watch(
  () => (route.path === '/docs' ? route.hash : ''),
  (hash) => {
    if (route.path !== '/docs') return
    const value = hash ? hash.replace(/^#/, '').trim() : ''
    if (value && !validDocIds.value.has(value) && !isAgentDocHash(value)) {
      void router.replace('/docs#quick-start')
    }
  },
  { immediate: true }
)

const docsActiveSectionId = computed(() => {
  if (route.path !== '/docs') return null
  const hash = route.hash ? route.hash.replace(/^#/, '') : ''
  if (validDocIds.value.has(hash) || isAgentDocHash(hash)) return hash
  return docSectionsStatic[0]?.id ?? null
})

const configActiveSectionId = computed(() => {
  if (!isConfigPath(route.path)) return null
  if (!configSubnavHydrated.value) return null
  const raw = configHashFragment(route.path, route.hash)
  return normalizeConfigSectionHash(raw)
})

/** Same-path hash changes: vue-router often ignores `{ path, hash }` replace; string `push` updates the hash reliably. */
function goToConfigSection(id: string) {
  void router.push(`/config#${id}`)
}

function scrollToDocSection(id: string) {
  // String location so hash updates when already on /docs (object + hash can be a no-op in vue-router).
  void router.push(`/docs#${id}`)
  nextTick(() => {
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
}

// Background spotlight that follows cursor (--mouse-x, --mouse-y from mouse-tracking plugin).
// Purple only (#8B5CF6 = 139,92,246) – no cyan, no green, no blue.
const backgroundLightStyle = {
  background: 'radial-gradient(circle at calc(var(--mouse-x) * 100%) calc(var(--mouse-y) * 100%), rgba(139, 92, 246, 0.18) 0%, rgba(139, 92, 246, 0.06) 40%, transparent 60%)'
}
</script>
