<template>
  <GlassCard class="[&_input]:select-text [&_select]:select-text [&_textarea]:select-text">
    <div
      class="grid grid-cols-1 gap-5 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-stretch lg:gap-6"
    >
      <aside
        class="order-1 rounded-2xl border border-white/10 bg-white/5 p-3 flex flex-col min-h-0 max-h-[min(45vh,360px)] sm:max-h-[min(55vh,440px)] lg:max-h-[min(85vh,720px)]"
      >
        <div class="mb-2 shrink-0">
          <div class="text-[10px] uppercase tracking-widest text-gray-400">Saved</div>
        </div>
        <div class="space-y-1.5 overflow-y-auto pr-0.5 flex-1 min-h-[140px]">
          <div
            v-if="agentsLoading"
            class="rounded-lg border border-white/10 bg-black/20 px-3 py-4 text-center text-xs text-gray-400"
          >
            Loading agents…
          </div>
          <template v-else>
            <button
              v-for="item in agents"
              :key="item._id"
              type="button"
              class="w-full text-left rounded-lg border px-2.5 py-2 transition-all duration-150"
              :class="selectedAgentId === item._id
                ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10'
                : 'border-white/10 bg-black/10 hover:bg-white/10 hover:border-white/20'"
              @mousedown.prevent
              @click="selectAgent(item._id)"
            >
              <div class="text-sm font-medium text-white truncate">{{ item.name }}</div>
              <div class="text-[10px] text-gray-500 truncate mt-0.5">
                {{ agentModelCategoriesSummary(item.model_categories) }} · {{ item.tool_name }}<template v-if="item.save_to_seed"> · seed</template>
              </div>
            </button>
            <div
              v-if="!agents.length"
              class="rounded-lg border border-dashed border-white/15 bg-black/20 px-3 py-4 text-center text-xs text-gray-400"
            >
              No agents in the database.
            </div>
          </template>
        </div>
      </aside>

      <form
        id="config-agents-form"
        class="order-2 rounded-2xl border border-white/10 bg-black/10 p-4 flex flex-col gap-3 min-h-[min(72vh,820px)] lg:min-h-[min(86vh,920px)]"
        novalidate
        @submit.prevent="submitForm"
      >
        <button type="submit" class="sr-only" tabindex="-1" :disabled="saveDisabled">Save</button>
        <div class="text-[10px] uppercase tracking-widest text-gray-500 shrink-0">Draft</div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 shrink-0">
          <MuiOutlinedField
            id="agent-name"
            v-model="form.name"
            wrap-class="sm:col-span-2"
            label="Name"
            :maxlength="200"
            :error="fieldErrors.name"
            @update:model-value="fieldErrors.name = ''"
          />
          <MuiOutlinedField
            id="agent-tool-name"
            v-model="form.tool_name"
            wrap-class="sm:col-span-2"
            label="Tool name"
            :maxlength="120"
            :error="fieldErrors.tool_name"
            @update:model-value="fieldErrors.tool_name = ''"
          />
          <MuiOutlinedField
            id="agent-desc"
            v-model="form.description"
            wrap-class="sm:col-span-2"
            label="Description"
            multiline
            :rows="4"
            :maxlength="400"
            :error="fieldErrors.description"
            input-class="min-h-[6.5rem]"
            @update:model-value="fieldErrors.description = ''"
          />
        </div>

        <div class="rounded-xl border border-white/10 bg-black/15 p-3 shrink-0">
          <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Model categories</div>
          <p class="text-xs text-gray-500 mb-2">
            Match tags from Config → Models (fast, blended, thinking, plus custom tags like Vision). Empty means this agent may use any saved model.
          </p>
          <ModelCategoriesInput v-model="form.model_categories" allow-empty />
        </div>

        <div class="shrink-0 max-w-xl">
          <p class="text-xs text-gray-500 mb-2 leading-snug">
            Optional: vault prompt from Config → Prompts → Global. Runs first on the user’s request; the system prompt and personas use that output as context.
          </p>
          <MuiOutlinedField
            id="agent-global-prompt"
            v-model="form.global_prompt_id"
            label="Global prompt"
            select
            wrap-class="w-full"
            :options="globalPromptSelectOptions"
          />
        </div>

        <div class="flex min-h-0 flex-1 flex-col">
          <MuiOutlinedField
            id="agent-sys"
            v-model="form.system_prompt"
            label="System prompt"
            multiline
            wrap-class="flex min-h-0 flex-1 flex-col"
            :rows="5"
            :error="fieldErrors.system_prompt"
            input-class="min-h-[min(28vh,280px)]"
            @update:model-value="fieldErrors.system_prompt = ''"
          />
        </div>

        <div class="shrink-0">
          <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-2">Personas</div>
          <PersonaNamesMultiSelect
            v-model="form.persona_names"
            :personas="availablePersonas"
            :loading="personasLoading"
            :disabled="savePending"
            placeholder="Select personas…"
            @create-request="openCreatePersonaModal"
          />
        </div>

        <div
          class="shrink-0 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-3"
          aria-label="MCP tools for this agent"
        >
          <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-2.5">Tools</div>
          <div class="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <label class="inline-flex items-center gap-2 text-gray-200">
              <input v-model="form.tools.file_watch" type="checkbox" class="rounded border-white/20 bg-white/10" />
              File watch
            </label>
            <label class="inline-flex items-center gap-2 text-gray-200">
              <input v-model="form.tools.db_read_write" type="checkbox" class="rounded border-white/20 bg-white/10" />
              DB read/write
            </label>
            <label class="inline-flex items-center gap-2 text-gray-200">
              <input v-model="form.tools.web_search" type="checkbox" class="rounded border-white/20 bg-white/10" />
              Web search
            </label>
            <label class="inline-flex items-center gap-2 text-gray-200">
              <input v-model="form.tools.run_shell" type="checkbox" class="rounded border-white/20 bg-white/10" />
              Run shell
            </label>
          </div>
        </div>

        <div
          class="shrink-0 rounded-lg border border-dashed border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5"
          aria-label="Seed export"
        >
          <div class="text-[10px] uppercase tracking-widest text-amber-200/70 mb-1.5">Seed (dev)</div>
          <label
            class="inline-flex items-center gap-2 text-xs text-amber-100/90"
            :class="{ 'opacity-50 cursor-not-allowed': !canUseSaveToSeed }"
            :title="canUseSaveToSeed ? undefined : 'Run in Development mode to enable updating seed data.'"
          >
            <input
              v-model="form.save_to_seed"
              type="checkbox"
              class="rounded border-amber-400/40 bg-black/20 accent-amber-400/90"
              :disabled="!canUseSaveToSeed"
            />
            Save to seed
          </label>
        </div>

        <div class="flex flex-wrap gap-2 shrink-0 pt-2 border-t border-white/10">
          <StyleUiButton
            v-if="selectedAgentId"
            type="button"
            variant="secondary"
            :disabled="savePending"
            @click="$emit('restore-default', selectedAgentId)"
          >
            Restore default
          </StyleUiButton>
        </div>
      </form>
    </div>

    <Teleport to="body">
      <div
        v-if="switchConfirmOpen"
        class="fixed inset-0 z-[160] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        @click.self="cancelSwitch"
      >
        <div
          class="w-full max-w-sm rounded-2xl border border-white/10 bg-[var(--surface-card)] shadow-2xl p-6 flex flex-col gap-4"
          @click.stop
        >
          <h3 class="text-base font-semibold text-white">Unsaved changes</h3>
          <p class="text-sm text-gray-300 leading-relaxed">
            <template v-if="pendingAgentName">
              Switch to <span class="text-white font-medium">{{ pendingAgentName }}</span> and discard your changes?
            </template>
            <template v-else>
              Deselect and discard your changes?
            </template>
          </p>
          <div class="flex justify-end gap-2 pt-1">
            <StyleUiButton type="button" variant="secondary" @click="cancelSwitch">Keep editing</StyleUiButton>
            <StyleUiButton type="button" @click="confirmSwitch">Discard changes</StyleUiButton>
          </div>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="createPersonaOpen"
        class="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-create-persona-title"
        @click.self="createPersonaOpen = false"
      >
        <div
          class="w-full max-w-lg max-h-[min(90vh,640px)] flex flex-col rounded-2xl border border-white/10 bg-[var(--surface-card)] shadow-2xl"
          @click.stop
        >
          <div class="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0">
            <h3 id="agent-create-persona-title" class="text-base font-semibold text-white">New persona</h3>
            <StyleUiButton type="button" variant="icon" aria-label="Close" @click="createPersonaOpen = false">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </StyleUiButton>
          </div>
          <form class="flex flex-col min-h-0 flex-1" @submit.prevent="submitCreatePersona">
            <div class="px-5 py-4 space-y-3 overflow-y-auto flex-1 min-h-0">
              <MuiOutlinedField
                id="agent-new-persona-name"
                v-model="createPersonaForm.name"
                label="Name"
                :maxlength="200"
                :error="createFieldErrors.name"
                @update:model-value="createFieldErrors.name = ''"
              />
              <MuiOutlinedField
                id="agent-new-persona-desc"
                v-model="createPersonaForm.description"
                label="Description"
                multiline
                :rows="3"
                :maxlength="400"
                :error="createFieldErrors.description"
                input-class="min-h-[5rem]"
                @update:model-value="createFieldErrors.description = ''"
              />
              <MuiOutlinedField
                id="agent-new-persona-prompt"
                v-model="createPersonaForm.prompt"
                label="Prompt"
                multiline
                :rows="5"
                :error="createFieldErrors.prompt"
                input-class="min-h-[min(28vh,220px)]"
                @update:model-value="createFieldErrors.prompt = ''"
              />
              <div
                v-if="canUseSaveToSeed"
                class="rounded-lg border border-dashed border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5"
                aria-label="Seed export"
              >
                <div class="text-[10px] uppercase tracking-widest text-amber-200/70 mb-1.5">Seed (dev)</div>
                <label class="inline-flex items-center gap-2 text-xs text-amber-100/90">
                  <input
                    v-model="createPersonaForm.save_to_seed"
                    type="checkbox"
                    class="rounded border-amber-400/40 bg-black/20 accent-amber-400/90"
                  />
                  Save to seed
                </label>
              </div>
              <p v-if="createPersonaError" class="text-xs text-red-300/90">{{ createPersonaError }}</p>
            </div>
            <div class="px-5 py-4 border-t border-white/10 flex justify-end gap-2 shrink-0">
              <StyleUiButton type="button" variant="secondary" :disabled="savePending" @click="createPersonaOpen = false">
                Cancel
              </StyleUiButton>
              <StyleUiButton type="submit" :disabled="savePending">
                {{ savePending ? 'Saving…' : 'Create' }}
              </StyleUiButton>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </GlassCard>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import MuiOutlinedField from './MuiOutlinedField.vue'
import ModelCategoriesInput from './ModelCategoriesInput.vue'
import PersonaNamesMultiSelect from './PersonaNamesMultiSelect.vue'

// ── Dirty-check confirmation dialog ─────────────────────────────────────────
const switchConfirmOpen = ref(false)
const pendingSelectId = ref<string | null>(null)

const pendingAgentName = computed(() => {
  if (pendingSelectId.value === null || pendingSelectId.value === '') return null
  return props.agents.find((a) => a._id === pendingSelectId.value)?.name ?? null
})

export interface AgentItem {
  _id: string
  name: string
  description: string
  system_prompt: string
  tool_name: string
  model_categories: string[]
  persona_names: string[]
  global_prompt_id: string | null
  global_prompt_name?: string | null
  tools: {
    file_watch: boolean
    db_read_write: boolean
    web_search: boolean
    run_shell: boolean
  }
  save_to_seed: boolean
  project_key?: string
}

const props = withDefaults(
  defineProps<{
    agents: AgentItem[]
    /** When set, duplicate `tool_name` is checked only among agents for this project. */
    projectKey?: string
    selectedAgentId: string
    agentsLoading?: boolean
    availablePersonas: Array<{ _id: string; name: string }>
    personasLoading?: boolean
    /** Processing-type vault prompts (Config → Prompts → Global). */
    globalPromptOptions: Array<{ _id: string; name: string; category: string }>
    savePending?: boolean
    seedWriteEnabled?: boolean
  }>(),
  {
    projectKey: '',
    agentsLoading: false,
    personasLoading: false,
    globalPromptOptions: () => [],
    savePending: false,
    seedWriteEnabled: false
  }
)

const selectedAgent = computed(() => props.agents.find((a) => a._id === props.selectedAgentId))

const globalPromptSelectOptions = computed(() => [
  { value: '', label: 'None' },
  ...props.globalPromptOptions.map((p) => ({
    value: p._id,
    label: `${p.name} · ${p.category}`
  }))
])

const saveDisabled = computed(() => props.savePending)

const canUseSaveToSeed = computed(() => props.seedWriteEnabled)

const isDirty = computed(() => {
  if (!props.selectedAgentId) {
    return (
      form.name.trim() !== '' ||
      form.description.trim() !== '' ||
      form.system_prompt.trim() !== '' ||
      form.tool_name.trim() !== '' ||
      form.global_prompt_id.trim() !== ''
    )
  }
  const a = selectedAgent.value
  if (!a) return false
  const gp = a.global_prompt_id ?? ''
  return (
    form.name !== a.name ||
    form.description !== a.description ||
    form.system_prompt !== a.system_prompt ||
    form.tool_name !== a.tool_name ||
    (form.global_prompt_id || '') !== gp ||
    JSON.stringify(form.model_categories) !== JSON.stringify(a.model_categories ?? []) ||
    JSON.stringify(form.persona_names) !== JSON.stringify(a.persona_names) ||
    form.tools.file_watch !== a.tools.file_watch ||
    form.tools.db_read_write !== a.tools.db_read_write ||
    form.tools.web_search !== a.tools.web_search ||
    form.tools.run_shell !== a.tools.run_shell
  )
})

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'save', payload: Omit<AgentItem, '_id' | 'project_key'> & { _id?: string }): void
  (e: 'restore-default', id: string): void
  (
    e: 'create-persona',
    payload: { name: string; description: string; prompt: string; save_to_seed: boolean }
  ): void
}>()

function emptyTools() {
  return {
    file_watch: false,
    db_read_write: false,
    web_search: false,
    run_shell: false
  }
}

const form = reactive({
  name: '',
  description: '',
  system_prompt: '',
  tool_name: '',
  model_categories: [] as string[],
  persona_names: [] as string[],
  global_prompt_id: '' as string,
  tools: emptyTools(),
  save_to_seed: false
})

const fieldErrors = reactive({
  name: '',
  description: '',
  system_prompt: '',
  tool_name: ''
})

watch(
  () => [props.selectedAgentId, props.agents] as const,
  () => {
    Object.assign(fieldErrors, { name: '', description: '', system_prompt: '', tool_name: '' })
    if (!props.selectedAgentId) {
      form.name = ''
      form.description = ''
      form.system_prompt = ''
      form.tool_name = ''
      form.model_categories = []
      form.persona_names = []
      form.global_prompt_id = ''
      form.tools = emptyTools()
      form.save_to_seed = false
      return
    }
    const selected = props.agents.find((a) => a._id === props.selectedAgentId)
    if (!selected) {
      form.name = ''
      form.description = ''
      form.system_prompt = ''
      form.tool_name = ''
      form.model_categories = []
      form.persona_names = []
      form.global_prompt_id = ''
      form.tools = emptyTools()
      form.save_to_seed = false
      return
    }
    form.name = selected.name
    form.description = selected.description
    form.system_prompt = selected.system_prompt
    form.tool_name = selected.tool_name
    form.model_categories = [...(selected.model_categories ?? [])]
    form.persona_names = [...selected.persona_names]
    form.global_prompt_id = selected.global_prompt_id ?? ''
    form.tools = { ...selected.tools }
    form.save_to_seed = props.seedWriteEnabled ? selected.save_to_seed : false
  },
  { deep: true, immediate: true }
)

watch(canUseSaveToSeed, (ok) => {
  if (!ok) form.save_to_seed = false
})

function agentModelCategoriesSummary(cats: string[] | undefined): string {
  if (cats?.length) return cats.join(', ')
  return 'all models'
}

const createPersonaOpen = ref(false)
const createPersonaError = ref('')
const createPersonaForm = reactive({
  name: '',
  description: '',
  prompt: '',
  save_to_seed: false
})
const createFieldErrors = reactive({ name: '', description: '', prompt: '' })

function resetCreatePersonaForm() {
  createPersonaForm.name = ''
  createPersonaForm.description = ''
  createPersonaForm.prompt = ''
  createPersonaForm.save_to_seed = false
  createFieldErrors.name = ''
  createFieldErrors.description = ''
  createFieldErrors.prompt = ''
  createPersonaError.value = ''
}

function openCreatePersonaModal() {
  resetCreatePersonaForm()
  createPersonaOpen.value = true
}

function submitCreatePersona() {
  createFieldErrors.name = ''
  createFieldErrors.description = ''
  createFieldErrors.prompt = ''
  createPersonaError.value = ''
  const name = createPersonaForm.name.trim()
  const description = createPersonaForm.description.trim()
  const prompt = createPersonaForm.prompt.trim()
  let ok = true
  if (!name) {
    createFieldErrors.name = 'Name is required.'
    ok = false
  }
  if (!description) {
    createFieldErrors.description = 'Description is required.'
    ok = false
  }
  if (!prompt) {
    createFieldErrors.prompt = 'Prompt is required.'
    ok = false
  }
  if (!ok) return
  emit('create-persona', {
    name,
    description,
    prompt,
    save_to_seed: canUseSaveToSeed.value && createPersonaForm.save_to_seed
  })
}

/** Called by parent after POST /config/personas succeeds (or fails). */
function onCreatePersonaFinished(name: string | null, errorMessage?: string) {
  if (name) {
    createPersonaOpen.value = false
    resetCreatePersonaForm()
    const n = name.trim()
    if (n && !form.persona_names.includes(n)) form.persona_names.push(n)
    return
  }
  if (errorMessage) createPersonaError.value = errorMessage
}

function selectAgent(id: string) {
  const next = id === props.selectedAgentId ? '' : id
  if (isDirty.value) {
    pendingSelectId.value = next
    switchConfirmOpen.value = true
    return
  }
  Object.assign(fieldErrors, { name: '', description: '', system_prompt: '', tool_name: '' })
  emit('select', next)
}

function confirmSwitch() {
  const id = pendingSelectId.value ?? ''
  switchConfirmOpen.value = false
  pendingSelectId.value = null
  Object.assign(fieldErrors, { name: '', description: '', system_prompt: '', tool_name: '' })
  if (!id) {
    form.name = ''
    form.description = ''
    form.system_prompt = ''
    form.tool_name = ''
    form.model_categories = []
    form.persona_names = []
    form.global_prompt_id = ''
    form.tools = emptyTools()
    form.save_to_seed = false
  }
  emit('select', id)
}

function cancelSwitch() {
  switchConfirmOpen.value = false
  pendingSelectId.value = null
}

function startNewDraft() {
  emit('select', '')
  form.name = ''
  form.description = ''
  form.system_prompt = ''
  form.tool_name = ''
  form.model_categories = []
  form.persona_names = []
  form.global_prompt_id = ''
  form.tools = emptyTools()
  form.save_to_seed = false
  Object.assign(fieldErrors, { name: '', description: '', system_prompt: '', tool_name: '' })
}

function submitForm() {
  Object.assign(fieldErrors, { name: '', description: '', system_prompt: '', tool_name: '' })
  const name = form.name.trim()
  const description = form.description.trim()
  const system_prompt = form.system_prompt.trim()
  const tool_name = form.tool_name.trim()
  let valid = true
  if (!name) {
    fieldErrors.name = 'Name is required.'
    valid = false
  }
  if (!description) {
    fieldErrors.description = 'Description is required.'
    valid = false
  }
  if (!system_prompt) {
    fieldErrors.system_prompt = 'System prompt is required.'
    valid = false
  }
  if (!tool_name) {
    fieldErrors.tool_name = 'Tool name is required.'
    valid = false
  }
  if (!valid) return

  const pk = props.projectKey?.trim()
  const peerAgents = pk ? props.agents.filter((a) => a.project_key === pk) : props.agents
  if (
    peerAgents.some(
      (a) => a.tool_name.trim() === tool_name && a._id !== (props.selectedAgentId || '')
    )
  ) {
    fieldErrors.tool_name = 'This tool name is already used by another agent in this project.'
    return
  }

  const gp = form.global_prompt_id.trim()
  emit('save', {
    _id: props.selectedAgentId || undefined,
    name,
    description,
    system_prompt,
    tool_name,
    model_categories: [...form.model_categories],
    persona_names: [...form.persona_names],
    global_prompt_id: gp ? gp : null,
    tools: { ...form.tools },
    save_to_seed: props.seedWriteEnabled && form.save_to_seed
  })
}

defineExpose({ startNewDraft, submitDraft: submitForm, onCreatePersonaFinished })
</script>
