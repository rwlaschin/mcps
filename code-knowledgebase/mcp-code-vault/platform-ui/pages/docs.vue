<template>
  <div class="flex flex-col min-h-full w-full max-w-none">
    <header
      class="sticky top-0 z-10 shrink-0 px-6 py-4 md:px-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-[#100B1A]"
    >
      <h1 class="text-2xl md:text-3xl font-bold text-white">Docs</h1>
      <div class="flex items-center gap-3 flex-1 sm:flex-initial sm:max-w-md">
        <input
          type="text"
          placeholder="Search..."
          class="flex-1 min-w-0 rounded-card px-4 py-2.5 text-sm text-gray-200 placeholder-gray-500 border border-white/10 bg-white/5 focus:outline-none focus:ring-2 focus:ring-accent/50"
          style="background-color: rgba(26, 23, 38, 0.8);"
        />
        <StyleUiButton type="button" class="shrink-0">
          Find
        </StyleUiButton>
      </div>
    </header>
    <article class="text-gray-300 space-y-10 p-6 md:p-8 pt-8">
      <!-- Quick start: MCP setup in Cursor -->
      <section id="quick-start" class="scroll-mt-28">
        <h2 class="text-xl font-semibold text-white mt-0 mb-4 border-b border-white/10 pb-2">Quick start</h2>

        <section id="setting-up-mcp-cursor" class="scroll-mt-28 docs-subsection">
          <h3 class="docs-subsection-title">Setting up MCP server</h3>
          <ol class="list-decimal list-inside space-y-3 ml-1 text-gray-400">
            <li>
              Open <strong>Projects → MCP → Add server</strong> in Cursor (or edit your MCP config file directly).
            </li>
            <li>
              <strong><code class="px-1 rounded bg-white/10">MONGO_URL</code></strong> — so the server can connect to MongoDB. Use a <code class="px-1 rounded bg-white/10">.env</code> file in the mcp-code-vault project root (e.g. <code class="px-1 rounded bg-white/10">MONGO_URL=mongodb://localhost:27017</code>) or pass it on the command line (e.g. <code class="px-1 rounded bg-white/10">cross-env MONGO_URL=mongodb://localhost:27017 npx tsx src/index.ts</code>).
            </li>
            <li>
              Paste the configuration block below. Replace placeholders as follows:
              <ul class="list-disc list-inside mt-2 space-y-1 text-gray-400">
                <li><code class="px-1 rounded bg-white/10">env.PORT</code> — port the MCP/stats server listens on (default <code class="px-1 rounded bg-white/10">3000</code>).</li>
                <li><code class="px-1 rounded bg-white/10">env.MCP_PROJECT_NAME</code> — unique identifier for this project in the database.</li>
                <li><code class="px-1 rounded bg-white/10">env.WORKING_DIRECTORY</code> — absolute path to the project/codebase to index.</li>
              </ul>
              <div class="relative mt-3">
                <pre class="p-3 pr-12 rounded-lg bg-black/30 text-gray-200 text-xs overflow-x-auto"><code>{{ mcpSnippet }}</code></pre>
                <StyleUiButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="absolute top-2 right-2"
                  @click="copySnippet"
                >
                  {{ copyLabel }}
                </StyleUiButton>
              </div>
              <p class="mt-2 text-sm text-gray-400">
                Run <code class="px-1 rounded bg-white/10">npm run build</code> in the project directory before starting the server so <code class="px-1 rounded bg-white/10">dist/index.js</code> exists.
              </p>
            </li>
            <li>Restart Cursor or reload the MCP configuration.</li>
            <li>Verify the connection by calling the <a href="#tool-ping" class="text-accent hover:underline"><code class="px-1 rounded bg-white/10">ping</code> tool</a> from a Cursor chat.</li>
          </ol>
          <div class="mt-4 p-3 rounded-lg bg-amber-950/30 border border-amber-800/40">
            <p class="text-sm text-amber-200/90 font-medium mb-1">Troubleshooting</p>
            <p class="text-sm text-amber-100/80">
              If the client reports <code class="px-1 rounded bg-white/10">Cannot find module '…/src/index.ts'</code>, the process was started with the wrong working directory. Use the wrapper entrypoint: set <code class="px-1 rounded bg-white/10">"command": "node"</code> and <code class="px-1 rounded bg-white/10">"args": ["/absolute/path/to/mcp-code-vault/run-mcp.js"]</code> (see <strong>Wrapper script</strong> below).
            </p>
          </div>

          <h4 class="text-sm font-semibold text-white mt-6 mb-2">Directory concepts</h4>
          <p class="text-gray-400 text-sm mb-2">
            <strong>Spawn cwd</strong> — Where the MCP host starts the process. If wrong, relative paths fail (ERR_MODULE_NOT_FOUND). For which codebase is indexed (project root), see <a href="#configuration" class="text-accent hover:underline">Configuration</a> → Project root / working directory.
          </p>

          <h4 class="text-sm font-semibold text-white mt-6 mb-2">Wrapper script (reliable setup)</h4>
          <p class="text-gray-400 text-sm mb-2">
            Use a single entry point with an absolute path so Cursor’s spawn cwd doesn’t matter: <code class="px-1 rounded bg-white/10">"command": "node"</code>, <code class="px-1 rounded bg-white/10">"args": ["/full/path/to/mcp-code-vault/run-mcp.js"]</code>. The wrapper runs from the repo (correct <code class="px-1 rounded bg-white/10">cwd</code> and module resolution). Put this in Cursor → Settings → MCP (or <code class="px-1 rounded bg-white/10">~/.cursor/mcp.json</code>). Restart Cursor or reload MCP.
          </p>

          <h4 class="text-sm font-semibold text-white mt-6 mb-2">Using <code class="text-accent font-mono font-normal">cwd</code> in MCP config</h4>
          <p class="text-gray-400 text-sm">
            Some clients support <code class="px-1 rounded bg-white/10">cwd</code> as the spawn working directory. You can try <code class="px-1 rounded bg-white/10">"cwd": "/full/path/to/mcp-code-vault"</code> with <code class="px-1 rounded bg-white/10">npx</code> / <code class="px-1 rounded bg-white/10">tsx</code>. If it doesn’t work, use the wrapper script above.
          </p>
        </section>
      </section>

      <!-- MCP tools reference -->
      <section id="using-the-mcp" class="scroll-mt-28">
        <h2 class="text-xl font-semibold text-white mt-0 mb-4 border-b border-white/10 pb-2">MCP tools reference</h2>
        <p class="mb-6 text-gray-400">
          The MCP server always exposes <code class="px-1 rounded bg-white/10">ping</code>,
          <code class="px-1 rounded bg-white/10">settings</code>, and
          <code class="px-1 rounded bg-white/10">config</code>. After MongoDB connects, it also registers
          <strong class="text-gray-300">one MCP tool per agent</strong> for your project
          (<code class="px-1 rounded bg-white/10">MCP_PROJECT_NAME</code>): each tool’s name is that agent’s
          <strong class="text-gray-300">Tool name</strong> from Config → Agents (letters, digits,
          <code class="px-1 rounded bg-white/10">_</code>, <code class="px-1 rounded bg-white/10">-</code>,
          <code class="px-1 rounded bg-white/10">.</code> only). Invoking an agent tool returns a JSON
          <strong class="text-gray-300">execution bundle</strong> (prompts, personas, model categories, tool flags) for the host to use.
          Use <code class="px-1 rounded bg-white/10">tools/list</code> to see built-ins plus agent tools once they appear.
        </p>

        <section id="tool-ping" class="scroll-mt-28 docs-subsection">
          <h3 class="docs-subsection-title"><code class="text-accent font-mono font-normal">ping</code></h3>
          <dl class="space-y-3 text-gray-400">
            <div>
              <dt class="font-medium text-gray-300 mb-1">Description</dt>
              <dd>Verifies that the MCP server is connected and responding. Use after setup or to confirm the connection is still active.</dd>
            </div>
            <div>
              <dt class="font-medium text-gray-300 mb-1">Parameters</dt>
              <dd>None.</dd>
            </div>
            <div>
              <dt class="font-medium text-gray-300 mb-1">Returns</dt>
              <dd>Plain text: <code class="px-1 rounded bg-white/10">pong</code>.</dd>
            </div>
            <div>
              <dt class="font-medium text-gray-300 mb-1">Example (Cursor chat)</dt>
              <dd>
                <blockquote class="pl-4 border-l-2 border-white/20 text-gray-300 not-italic mt-1">
                  Call the ping tool from mcp-code-vault.
                </blockquote>
                <p class="mt-1 text-sm">Response: <code class="px-1 rounded bg-white/10">pong</code>.</p>
              </dd>
            </div>
          </dl>
        </section>

        <section id="tool-settings" class="scroll-mt-28 docs-subsection">
          <h3 class="docs-subsection-title"><code class="text-accent font-mono font-normal">settings</code></h3>
          <dl class="space-y-3 text-gray-400">
            <div>
              <dt class="font-medium text-gray-300 mb-1">Description</dt>
              <dd>Returns the current server settings and the MCP snippet for Cursor — the same content as the Config page in the Platform UI. Read-only.</dd>
            </div>
            <div>
              <dt class="font-medium text-gray-300 mb-1">Parameters</dt>
              <dd>None.</dd>
            </div>
            <div>
              <dt class="font-medium text-gray-300 mb-1">Returns</dt>
              <dd>Plain text: <strong>Code-vault config</strong> (projectName, workingDirectory, cwd, port), then <strong>MCP snippet (for Cursor)</strong> — a ready-to-paste JSON block for Cursor MCP config.</dd>
            </div>
          </dl>
        </section>

        <section id="tool-config" class="scroll-mt-28 docs-subsection">
          <h3 class="docs-subsection-title"><code class="text-accent font-mono font-normal">config</code></h3>
          <dl class="space-y-3 text-gray-400">
            <div>
              <dt class="font-medium text-gray-300 mb-1">Description</dt>
              <dd>Sets server settings. Pass <code class="px-1 rounded bg-white/10">workingDirectory</code> (or <code class="px-1 rounded bg-white/10">cwd</code>) and/or <code class="px-1 rounded bg-white/10">port</code> to update the project root or stats port the server reports and uses. Use when you need to correct working directory or port at runtime.</dd>
            </div>
            <div>
              <dt class="font-medium text-gray-300 mb-1">Parameters</dt>
              <dd>Optional: <code class="px-1 rounded bg-white/10">workingDirectory</code> (string), <code class="px-1 rounded bg-white/10">cwd</code> (string, same as workingDirectory), <code class="px-1 rounded bg-white/10">port</code> (string). Pass only the keys you want to update.</dd>
            </div>
            <div>
              <dt class="font-medium text-gray-300 mb-1">Returns</dt>
              <dd>Plain text confirming what was set (e.g. <code class="px-1 rounded bg-white/10">Set: workingDirectory=/path, port=3000</code>) or a message if no settings were provided.</dd>
            </div>
          </dl>
        </section>

        <section
          v-for="agent in docAgents"
          :key="String(agent._id)"
          :id="`tool-agent-${String(agent._id)}`"
          class="scroll-mt-28 docs-subsection"
        >
          <h3 class="docs-subsection-title">
            <code class="text-accent font-mono font-normal">{{ agent.tool_name || '—' }}</code>
            <span class="text-gray-400 font-sans font-normal text-sm ml-2">· {{ agent.name }}</span>
          </h3>
          <dl class="space-y-3 text-gray-400">
            <div v-if="agent.description">
              <dt class="font-medium text-gray-300 mb-1">Description</dt>
              <dd>{{ agent.description }}</dd>
            </div>
            <div v-if="agent.tool_name">
              <dt class="font-medium text-gray-300 mb-1">MCP tool name</dt>
              <dd>
                <code class="px-1 rounded bg-white/10 text-gray-200">{{ agent.tool_name }}</code>
                — call this name from the host (e.g. Cursor) after it appears in <code class="px-1 rounded bg-white/10">tools/list</code>.
              </dd>
            </div>
            <div v-if="agent.model_categories?.length">
              <dt class="font-medium text-gray-300 mb-1">Model categories</dt>
              <dd>{{ agent.model_categories.join(', ') }}</dd>
            </div>
            <div v-if="agent.global_prompt_name">
              <dt class="font-medium text-gray-300 mb-1">Global prompt</dt>
              <dd>{{ agent.global_prompt_name }}</dd>
            </div>
            <div v-if="agent.persona_names?.length">
              <dt class="font-medium text-gray-300 mb-1">Personas</dt>
              <dd>{{ agent.persona_names.join(', ') }}</dd>
            </div>
            <div v-if="agent.tools">
              <dt class="font-medium text-gray-300 mb-1">Tool flags</dt>
              <dd class="font-mono text-sm">
                file_watch={{ agent.tools.file_watch }}, db_read_write={{ agent.tools.db_read_write }},
                web_search={{ agent.tools.web_search }}, run_shell={{ agent.tools.run_shell }}
              </dd>
            </div>
          </dl>
        </section>
      </section>

      <!-- Platform UI -->
      <section id="user-interface" class="scroll-mt-28">
        <h2 class="text-xl font-semibold text-white mt-0 mb-4 border-b border-white/10 pb-2">Platform UI</h2>
        <p class="mb-4 text-gray-400">
          The platform UI provides the Stats dashboard, Config view, and this documentation. To run it:
        </p>
        <ol class="list-decimal list-inside space-y-3 ml-1 text-gray-400">
          <li>From the project root, start the backend: <code class="px-1 rounded bg-white/10">PORT={{ docsContext?.port ?? '3000' }} npm run dev</code> (or set <code class="px-1 rounded bg-white/10">PORT</code> in <code class="px-1 rounded bg-white/10">.env</code>).</li>
          <li>In a separate terminal, start the UI: <code class="px-1 rounded bg-white/10">npm run dev:ui</code> or <code class="px-1 rounded bg-white/10">cd platform-ui && npm run dev</code>. The UI runs on port <code class="px-1 rounded bg-white/10">2999</code> by default.</li>
          <li>Open <NuxtLink to="/" class="text-accent hover:underline">Stats</NuxtLink>. When the backend is running, the Live stream card shows <strong>Connected</strong> and the stream event log displays heartbeat and metric events.</li>
        </ol>
        <h4 class="text-sm font-semibold text-white mt-6 mb-2">Why the backend is required</h4>
        <p class="text-gray-400 text-sm mb-2">
          The same process provides both the MCP and the UI. The UI only sees data when the HTTP backend is running. When the MCP server starts, the backend starts too. If that fails (port in use, MongoDB not reachable), the process runs in <strong>MCP-only</strong> mode: Tools work, but the UI will not update. Common causes: <code class="px-1 rounded bg-white/10">env</code> not set in MCP config (see <a href="#configuration" class="text-accent hover:underline">Configuration</a>); port in use; MongoDB not available when the host spawns the process.
        </p>
        <h4 class="text-sm font-semibold text-white mt-4 mb-2">Using the MCP process as the backend</h4>
        <p class="text-gray-400 text-sm mb-2">
          Set <code class="px-1 rounded bg-white/10">env</code> in MCP config (<code class="px-1 rounded bg-white/10">PORT</code>, <code class="px-1 rounded bg-white/10">MCP_PROJECT_NAME</code>, <code class="px-1 rounded bg-white/10">WORKING_DIRECTORY</code>); see <a href="#configuration" class="text-accent hover:underline">Configuration</a>. Ensure MongoDB is reachable. Start the UI: if backend is on 3000, run <code class="px-1 rounded bg-white/10">npm run dev:ui</code>; if on 3100, run <code class="px-1 rounded bg-white/10">NUXT_PUBLIC_UI_PORT=3100 STATS_PORT=3100 npm run dev</code> in platform-ui. After reloading MCP, the Cursor-started process should register with the UI on UDP 9255.
        </p>
        <h4 class="text-sm font-semibold text-white mt-4 mb-2">Running the backend separately</h4>
        <p class="text-gray-400 text-sm">
          If the MCP process never gets a working backend, run it yourself: in mcp-code-vault run <code class="px-1 rounded bg-white/10">PORT=3100 npm run dev</code> (or 3000); in platform-ui run <code class="px-1 rounded bg-white/10">NUXT_PUBLIC_UI_PORT=3100 STATS_PORT=3100 npm run dev</code> so the UI connects to that backend.
        </p>
      </section>

      <!-- Configuration -->
      <section id="configuration" class="scroll-mt-28">
        <h2 class="text-xl font-semibold text-white mt-0 mb-4 border-b border-white/10 pb-2">Configuration</h2>
        <p class="mb-4 text-gray-400">
          Projects, models, personas, and agents are configured in the <strong>database</strong>. Only connection secrets (e.g. <code class="px-1 rounded bg-white/10">MONGO_URL</code>, <code class="px-1 rounded bg-white/10">GEMINI_API_KEY</code>) go in <code class="px-1 rounded bg-white/10">.env</code>.
        </p>
        <ul class="list-disc list-inside space-y-2 text-gray-400 text-sm">
          <li><strong>Project identity</strong> — No global “current project”. Each MCP connection is for one project. Project name/key comes from MCP config; the project is created in the DB when first registered (UI or MCP tool).</li>
          <li><strong>Models</strong> — Defined globally in the database. Each project can have a default model. Agents pick from saved models using <strong>category tags</strong> (empty means any saved model).</li>
          <li><strong>Personas</strong> — Global; optional per agent. If no personas are assigned, no persona layer is used.</li>
          <li><strong>Agents</strong> — Global (one shared list for the platform). Configure under Config → Prompts → Agents.</li>
          <li><strong>Setup flow</strong> — Optionally edit personas → edit agents (model categories, personas, tools) → save. Changes hot-reload from DB without restart.</li>
          <li><strong>Two places to configure</strong> — Via MCP tools or via the platform UI; both read/write the same database.</li>
          <li><strong>Project root / working directory</strong> — Set <code class="px-1 rounded bg-white/10">env.WORKING_DIRECTORY</code> in MCP config to the codebase to index; fallback <code class="px-1 rounded bg-white/10">process.cwd()</code> at startup. Moving the project = update MCP config to the new path; project key in DB stays the same.</li>
        </ul>
      </section>
    </article>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { usePrimaryBaseUrl } from '../composables/usePrimaryBaseUrl'
import { useDocsNavAgentEntries } from '../composables/useDocsNavAgentEntries'

const router = useRouter()
const route = useRoute()

const baseSectionIds = [
  'quick-start',
  'setting-up-mcp-cursor',
  'using-the-mcp',
  'tool-ping',
  'tool-settings',
  'tool-config',
  'user-interface',
  'configuration'
] as const

type DocAgentRow = {
  _id: string
  name: string
  /** MCP tool id from Config → Agents (after Mongo connects). */
  tool_name?: string
  description?: string
  focus?: string
  model_categories?: string[]
  persona_names?: string[]
  global_prompt_name?: string | null
  tools?: { file_watch: boolean; db_read_write: boolean; web_search: boolean; run_shell: boolean }
}

const docAgents = ref<DocAgentRow[]>([])
const primaryBaseUrl = usePrimaryBaseUrl()
const docsNavAgentEntries = useDocsNavAgentEntries()

const agentSectionIds = computed(() => docAgents.value.map((a) => `tool-agent-${String(a._id)}`))

const allSectionIds = computed(() => [...baseSectionIds, ...agentSectionIds.value])

const scrollSpySectionIds = ref<string[]>([...baseSectionIds])

watch(
  allSectionIds,
  (ids) => {
    scrollSpySectionIds.value = ids
  },
  { immediate: true }
)

const validSectionIds = computed(() => new Set(allSectionIds.value))

function isAgentDocHash(value: string): boolean {
  return value.startsWith('tool-agent-') && value.length > 'tool-agent-'.length
}

function getHashValue(): string {
  const h = route.hash ?? (typeof window !== 'undefined' ? window.location.hash : '')
  return (h && h.startsWith('#')) ? h.slice(1).trim() : ''
}

function ensureValidHash(): void {
  if (route.path !== '/docs') return
  const hash = getHashValue()
  if (hash && !validSectionIds.value.has(hash) && !isAgentDocHash(hash)) {
    router.replace({ path: '/docs', hash: '#quick-start' })
  }
}

// If hash is present but invalid, redirect to /docs#quick-start (run on mount and when route hash changes)
onMounted(ensureValidHash)
watch([() => route.path, () => route.hash], ensureValidHash, { immediate: true })

async function loadAgentsForDocs(): Promise<void> {
  const base = (primaryBaseUrl.value || '').replace(/\/$/, '')
  if (!base) {
    docAgents.value = []
    docsNavAgentEntries.value = []
    return
  }
  try {
    const res = await fetch(`${base}/config/agents`)
    if (!res.ok) {
      docAgents.value = []
      docsNavAgentEntries.value = []
      return
    }
    const data = (await res.json()) as { agents?: DocAgentRow[] }
    const agents = data.agents ?? []
    docAgents.value = agents
    docsNavAgentEntries.value = agents.map((a) => ({
      id: `tool-agent-${String(a._id)}`,
      label: a.tool_name ? `${a.tool_name} (${a.name})` : a.name,
      depth: 1
    }))
  } catch {
    docAgents.value = []
    docsNavAgentEntries.value = []
  }
}

onMounted(() => {
  void loadAgentsForDocs()
})

watch(primaryBaseUrl, () => {
  void loadAgentsForDocs()
})

const copyLabel = ref('Copy')

type DocsContextPayload = { cwd: string; port: string; workingDirectory?: string }

const { data: docsContext } = await useAsyncData(
  'docs-context',
  () => $fetch<DocsContextPayload>('/api/docs-context'),
  { default: (): DocsContextPayload => ({ cwd: '', port: '3000' }) }
)

// Scroll-to-hash: update URL hash when user scrolls so it reflects the section in view
onMounted(() => {
  const main = document.querySelector('main')
  if (!main) return

  let mounted = true

  const updateHashFromScroll = () => {
    if (!mounted || !document.body.contains(main)) return
    const sectionIds = scrollSpySectionIds.value
    const sections = sectionIds
      .map((id) => ({ id, el: document.getElementById(id) }))
      .filter((s): s is { id: string; el: HTMLElement } => s.el != null)
    if (sections.length === 0) return
    const mainRect = main.getBoundingClientRect()
    const top = mainRect.top + 120
    let current: string = sections[0].id
    for (const { id, el } of sections) {
      if (!document.body.contains(el)) return
      const rect = el.getBoundingClientRect()
      if (rect.top <= top) current = id
    }
    const hash = route.hash ? route.hash.replace(/^#/, '') : ''
    if (hash !== current) {
      nextTick(() => {
        if (mounted) router.replace({ path: '/docs', hash: `#${current}` })
      })
    }
  }

  updateHashFromScroll()
  main.addEventListener('scroll', updateHashFromScroll, { passive: true })
  onUnmounted(() => {
    mounted = false
    if (document.body.contains(main)) {
      main.removeEventListener('scroll', updateHashFromScroll)
    }
  })
})

const mcpSnippet = computed(() => {
  const ctx = docsContext.value
  const rawCwd = ctx?.cwd || '/path/to/mcp-code-vault-repo'
  const cwd = rawCwd.replace(/\\/g, '\\\\') // escape for JSON on Windows
  const port = ctx?.port || '3000'
  const projectName = 'my-project' // user should set this to identify this repo in the DB
  const workingDirectory = ctx?.workingDirectory || ctx?.cwd || '/path/to/codebase-to-index'
  const workingDirEscaped = workingDirectory.replace(/\\/g, '\\\\')
  return `{
  "mcpServers": {
    "mcp-code-vault": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "${cwd}",
      "env": {
        "PORT": "${port}",
        "MCP_PROJECT_NAME": "${projectName}",
        "WORKING_DIRECTORY": "${workingDirEscaped}"
      }
    }
  }
}`
})

async function copySnippet() {
  try {
    await navigator.clipboard.writeText(mcpSnippet.value)
    copyLabel.value = 'Copied!'
    setTimeout(() => { copyLabel.value = 'Copy' }, 2000)
  } catch {
    copyLabel.value = 'Copy failed'
    setTimeout(() => { copyLabel.value = 'Copy' }, 2000)
  }
}
</script>
