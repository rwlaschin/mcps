<template>
  <GlassCard class="[&_input]:select-text [&_select]:select-text [&_textarea]:select-text">
    <p class="text-sm text-gray-500 mb-4">
      Each prompt has a <span class="text-gray-400">Name</span> and a <span class="text-gray-400">Type</span> (e.g. file processor, user request). Pick a row under <span class="text-gray-400">Saved</span> or use <span class="text-gray-400">+ New</span> in the page header.
      <span class="text-gray-400">Save</span> and <span class="text-gray-400">Restore default</span> are in the header too.
      <span class="text-gray-400">Seed</span> rows (e.g. default chunk processing) come from <code class="text-gray-500">configs/seed/prompts.json</code> via DB seeding.
    </p>

    <div
      class="grid grid-cols-1 gap-5 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-stretch lg:gap-6"
    >
      <aside class="order-1 rounded-2xl border border-white/10 bg-white/5 p-3 flex flex-col min-h-0 lg:max-h-[min(85vh,720px)]">
        <div class="mb-2 shrink-0">
          <div class="text-[10px] uppercase tracking-widest text-gray-400">Saved</div>
        </div>
        <div class="space-y-1.5 overflow-y-auto pr-0.5 flex-1 min-h-[140px]">
          <button
            v-for="item in prompts"
            :key="item._id"
            type="button"
            class="w-full text-left rounded-lg border px-2.5 py-2 transition-all duration-150"
            :class="selectedPromptId === item._id
              ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10'
              : 'border-white/10 bg-black/10 hover:bg-white/10 hover:border-white/20'"
            @mousedown.prevent
            @click="selectPrompt(item._id)"
          >
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="text-sm font-medium text-white truncate flex-1">{{ item.name }}</span>
              <span
                v-if="item.is_default"
                class="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-emerald-300/90"
                title="Default for this type"
              >
                def
              </span>
            </div>
            <div class="text-[10px] text-gray-500 truncate mt-0.5 tabular-nums">
              {{ item.slug || slugify(item.name) }} · {{ item.usage_type || item.prompt_type }} · {{ item.category }}<template v-if="item.structure_mode === 'structured'"> · structured</template><template v-if="item.save_to_seed"> · seed</template>
            </div>
          </button>
          <div
            v-if="!prompts.length"
            class="rounded-lg border border-dashed border-white/15 bg-black/20 px-3 py-4 text-center"
          >
            <p class="text-xs text-gray-400 mb-1">No saved prompts yet</p>
            <p class="text-[11px] text-gray-500 leading-snug">
              Tap <span class="text-gray-400">+ New</span> above, write in <span class="text-gray-400">Draft</span>, then <span class="text-gray-400">Save</span>.
            </p>
          </div>
        </div>
      </aside>

      <form
        id="config-prompts-form"
        class="order-2 rounded-2xl border border-white/10 bg-black/10 p-4 flex flex-col min-h-[min(72vh,820px)] lg:min-h-[min(86vh,920px)]"
        novalidate
        @submit.prevent="submitForm"
      >
        <button type="submit" class="sr-only" tabindex="-1" :disabled="savePending">Save</button>
        <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-3 shrink-0">Draft</div>

        <div
          class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 shrink-0 mb-3 lg:items-stretch"
        >
          <div class="sm:col-span-2 lg:col-span-5 flex flex-col justify-end min-h-0">
            <MuiOutlinedField
              id="prompt-name"
              v-model="form.name"
              label="Name"
              :maxlength="200"
              :error="fieldErrors.name"
              @update:model-value="fieldErrors.name = ''"
            />
          </div>
          <div class="sm:col-span-2 lg:col-span-4 flex flex-col gap-1 justify-end min-h-0">
            <label
              for="prompt-usage-type"
              class="text-[10px] uppercase tracking-widest text-gray-500 pl-0.5"
            >Type</label>
            <input
              id="prompt-usage-type"
              v-model="form.usage_type"
              list="vault-usage-type-options"
              autocomplete="off"
              class="mui-outlined-input select-text w-full rounded-xl border border-white/15 bg-white/5 px-2.5 py-3 text-[15px] text-white outline-none focus:border-[var(--accent)]/50"
            />
            <datalist id="vault-usage-type-options">
              <option v-for="opt in usageTypeSuggestions" :key="opt" :value="opt" />
            </datalist>
          </div>
          <div class="sm:col-span-2 lg:col-span-3 flex flex-col justify-end min-h-0">
            <MuiOutlinedField
              id="prompt-category"
              v-model="form.category"
              label="Model category"
              select
              :options="promptCategorySelectOptions"
            />
          </div>
        </div>

        <div
          class="rounded-xl border border-white/10 bg-white/[0.03] p-3 mb-4 flex min-h-0 flex-1 flex-col space-y-3"
        >
          <div class="text-[10px] uppercase tracking-widest text-gray-500">
            Output shape
          </div>
          <p class="text-[11px] text-gray-500 leading-snug">
            Unstructured is plain text. Structured marks this prompt as producing a known shape (preset + serialization) so callers can validate, preprocess, or parse it.
          </p>
          <!-- Single chrome (matches MuiOutlinedField), divider, accent fill on active half (matches primary buttons). -->
          <div
            class="inline-flex max-w-full items-stretch overflow-hidden rounded-xl border border-white/15 bg-white/5 transition-colors duration-200"
            role="group"
            aria-label="Output shape: unstructured or structured"
          >
            <button
              type="button"
              data-testid="structure-toggle-unstructured"
              class="min-w-[6.5rem] flex-1 border-0 px-4 py-2.5 text-center text-sm font-semibold transition-colors duration-200 focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/50 sm:min-w-[7.5rem]"
              :class="
                form.structure_mode === 'unstructured'
                  ? 'bg-[var(--accent)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-[var(--accent-hover)]'
                  : 'bg-transparent text-gray-400 hover:bg-white/10 hover:text-gray-200'
              "
              :aria-pressed="form.structure_mode === 'unstructured'"
              @click="form.structure_mode = 'unstructured'"
            >
              Unstructured
            </button>
            <span
              class="w-px shrink-0 self-stretch bg-white/10"
              aria-hidden="true"
            />
            <button
              type="button"
              data-testid="structure-toggle-structured"
              class="min-w-[6.5rem] flex-1 border-0 px-4 py-2.5 text-center text-sm font-semibold transition-colors duration-200 focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/50 sm:min-w-[7.5rem]"
              :class="
                form.structure_mode === 'structured'
                  ? 'bg-[var(--accent)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-[var(--accent-hover)]'
                  : 'bg-transparent text-gray-400 hover:bg-white/10 hover:text-gray-200'
              "
              :aria-pressed="form.structure_mode === 'structured'"
              @click="form.structure_mode = 'structured'"
            >
              Structured
            </button>
          </div>
          <div
            v-if="form.structure_mode === 'structured'"
            class="grid grid-cols-1 sm:grid-cols-2 gap-3"
          >
            <MuiOutlinedField
              id="prompt-structure-preset"
              v-model="form.structure_preset"
              label="Structure"
              select
              :options="structurePresetSelectOptions"
            />
            <MuiOutlinedField
              id="prompt-structure-mime"
              v-model="form.structure_mime"
              label="Serialization"
              select
              :options="structureMimeSelectOptions"
            />
          </div>
          <div class="flex min-h-0 flex-1 flex-col mt-1">
            <MuiOutlinedField
              id="prompt-body"
              v-model="form.prompt"
              label="Prompt body"
              multiline
              wrap-class="flex min-h-0 flex-1 flex-col"
              :rows="6"
              :error="fieldErrors.prompt"
              input-class="min-h-[min(42vh,440px)]"
              @update:model-value="fieldErrors.prompt = ''"
            />
          </div>
          <div
            v-if="form.structure_mode === 'structured' && activeStructurePreset"
            class="flex min-h-0 flex-col gap-2"
          >
            <div
              class="inline-flex shrink-0 rounded-lg border border-white/15 bg-black/30 p-0.5"
              role="tablist"
              aria-label="Structure preview"
            >
              <button
                type="button"
                role="tab"
                :aria-selected="structurePreviewTab === 'guide'"
                class="rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50"
                :class="
                  structurePreviewTab === 'guide'
                    ? 'bg-[var(--accent)]/25 text-white'
                    : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                "
                @click="structurePreviewTab = 'guide'"
              >
                Output Object
              </button>
              <button
                type="button"
                role="tab"
                :aria-selected="structurePreviewTab === 'example'"
                class="rounded-md px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50"
                :class="
                  structurePreviewTab === 'example'
                    ? 'bg-[var(--accent)]/25 text-white'
                    : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
                "
                @click="structurePreviewTab = 'example'"
              >
                Output Example
              </button>
            </div>
            <pre
              v-show="structurePreviewTab === 'guide'"
              class="text-[11px] leading-snug text-emerald-200/90 font-mono whitespace-pre-wrap break-all rounded-lg border border-white/10 bg-black/40 p-2.5 max-h-[min(36vh,280px)] min-h-[120px] overflow-y-auto shrink-0"
              data-testid="structure-guide-preview"
              role="tabpanel"
            >{{ structureFieldGuideText }}</pre>
            <pre
              v-show="structurePreviewTab === 'example'"
              class="text-[11px] leading-snug text-gray-200/95 font-mono whitespace-pre-wrap break-all rounded-lg border border-white/10 bg-black/40 p-2.5 max-h-[min(36vh,280px)] min-h-[120px] overflow-y-auto shrink-0"
              data-testid="structure-sample-preview"
              role="tabpanel"
            >{{ structureSamplePreviewText }}</pre>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm shrink-0 mb-3">
          <label class="inline-flex items-center gap-2 text-gray-200">
            <input v-model="form.is_default" type="checkbox" class="rounded border-white/20 bg-white/10" />
            Default for this type
          </label>
          <label
            class="inline-flex items-center gap-2 text-gray-200"
            :class="{ 'opacity-50 cursor-not-allowed': !canUseSaveToSeed }"
            :title="canUseSaveToSeed ? undefined : 'Run in Development mode to enable updating seed data.'"
          >
            <input
              v-model="form.save_to_seed"
              type="checkbox"
              class="rounded border-white/20 bg-white/10"
              :disabled="!canUseSaveToSeed"
            />
            Save to seed
          </label>
        </div>
      </form>
    </div>
  </GlassCard>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import MuiOutlinedField from './MuiOutlinedField.vue'
import { slugify } from '../lib/slugify'
import { dumpYamlExtended } from '../lib/dumpYamlExtended'
import {
  AGENT_PIPELINE_STEPS_PRESET,
  getPromptStructurePreset,
  structureMimeSelectOptions,
  structurePresetSelectOptions,
  type StructureMime
} from '../lib/promptStructurePresets'

export interface PromptItem {
  _id: string
  name: string
  /** Stable vault id (unique). Derived from name when saving if absent in older rows. */
  slug?: string
  prompt: string
  usage_type: string
  /** @deprecated server still returns for older rows */
  prompt_type?: 'processing' | 'agent'
  category: 'fast' | 'blended' | 'thinking'
  is_default: boolean
  save_to_seed: boolean
  structure_mode?: 'unstructured' | 'structured'
  structure_preset?: string
  structure_mime?: StructureMime
}

const props = withDefaults(
  defineProps<{
    prompts: PromptItem[]
    selectedPromptId: string
    savePending?: boolean
    seedWriteEnabled?: boolean
  }>(),
  {
    seedWriteEnabled: false
  }
)

const canUseSaveToSeed = computed(() => props.seedWriteEnabled)

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'save', payload: Omit<PromptItem, '_id'> & { _id?: string }): void
  (e: 'restore-default', id: string): void
}>()

/** Draft always carries normalized structure fields (selects require definite strings). */
type PromptDraft = Omit<PromptItem, '_id' | 'structure_mode' | 'structure_preset' | 'structure_mime' | 'usage_type'> & {
  usage_type: string
  structure_mode: 'unstructured' | 'structured'
  structure_preset: string
  structure_mime: StructureMime
}

const usageTypeSuggestions = ['file processor', 'user request', 'platform assistant'] as const

const form = reactive<PromptDraft>({
  name: '',
  prompt: '',
  usage_type: 'file processor',
  category: 'fast',
  is_default: false,
  save_to_seed: true,
  structure_mode: 'unstructured',
  structure_preset: AGENT_PIPELINE_STEPS_PRESET,
  structure_mime: 'application/json'
})

watch(canUseSaveToSeed, (ok) => {
  if (!ok) form.save_to_seed = false
})

const fieldErrors = reactive({ name: '', prompt: '' })

/** Tab for structure preview: one panel height instead of two stacked. */
const structurePreviewTab = ref<'guide' | 'example'>('guide')

const activeStructurePreset = computed(() => getPromptStructurePreset(form.structure_preset ?? ''))

const structureFieldGuideText = computed(() => {
  const g = activeStructurePreset.value?.fieldGuide
  if (!g) return ''
  return JSON.stringify(g, null, 2)
})

const structureSamplePreviewText = computed(() => {
  const doc = activeStructurePreset.value?.sampleDocument
  if (doc === undefined || doc === null) return ''
  const mime = form.structure_mime ?? 'application/json'
  if (mime === 'application/x-yaml-extended') {
    return dumpYamlExtended(doc)
  }
  return JSON.stringify(doc, null, 2)
})

const promptCategorySelectOptions = [
  { value: 'fast', label: 'Fast' },
  { value: 'blended', label: 'Blended' },
  { value: 'thinking', label: 'Thinking' }
]

watch(
  () => [props.selectedPromptId, props.prompts] as const,
  () => {
    fieldErrors.name = ''
    fieldErrors.prompt = ''
    if (!props.selectedPromptId) {
      form.name = ''
      form.prompt = ''
      form.usage_type = 'file processor'
      form.category = 'fast'
      form.is_default = false
      form.save_to_seed = props.seedWriteEnabled
      form.structure_mode = 'unstructured'
      form.structure_preset = AGENT_PIPELINE_STEPS_PRESET
      form.structure_mime = 'application/json'
      return
    }
    const selected = props.prompts.find((p) => p._id === props.selectedPromptId)
    if (!selected) {
      form.name = ''
      form.prompt = ''
      form.usage_type = 'file processor'
      form.category = 'fast'
      form.is_default = false
      form.save_to_seed = props.seedWriteEnabled
      form.structure_mode = 'unstructured'
      form.structure_preset = AGENT_PIPELINE_STEPS_PRESET
      form.structure_mime = 'application/json'
      return
    }
    form.name = selected.name
    form.prompt = selected.prompt
    form.usage_type = selected.usage_type?.trim() ? selected.usage_type : (selected.prompt_type === 'agent' ? 'user request' : 'file processor')
    form.category = selected.category
    form.is_default = selected.is_default
    form.save_to_seed = props.seedWriteEnabled ? selected.save_to_seed : false
    form.structure_mode = selected.structure_mode === 'structured' ? 'structured' : 'unstructured'
    form.structure_preset = selected.structure_preset?.trim()
      ? selected.structure_preset
      : AGENT_PIPELINE_STEPS_PRESET
    form.structure_mime =
      selected.structure_mime === 'application/x-yaml-extended'
        ? 'application/x-yaml-extended'
        : 'application/json'
    if (!getPromptStructurePreset(form.structure_preset ?? '')) {
      form.structure_preset = AGENT_PIPELINE_STEPS_PRESET
    }
  },
  { deep: true, immediate: true }
)

function selectPrompt(id: string) {
  fieldErrors.name = ''
  fieldErrors.prompt = ''
  emit('select', id)
}

function startNewDraft() {
  emit('select', '')
  form.name = ''
  form.prompt = ''
  form.usage_type = 'file processor'
  form.category = 'fast'
  form.is_default = false
  form.save_to_seed = props.seedWriteEnabled
  form.structure_mode = 'unstructured'
  form.structure_preset = AGENT_PIPELINE_STEPS_PRESET
  form.structure_mime = 'application/json'
  fieldErrors.name = ''
  fieldErrors.prompt = ''
}

function promptSlugKey(p: PromptItem): string {
  const s = (p.slug ?? '').trim()
  if (s) return s
  return slugify(p.name)
}

function submitForm() {
  fieldErrors.name = ''
  fieldErrors.prompt = ''
  const name = form.name.trim()
  const prompt = form.prompt.trim()
  let valid = true
  if (!name) {
    fieldErrors.name = 'Name is required.'
    valid = false
  }
  if (!prompt) {
    fieldErrors.prompt = 'Prompt body is required.'
    valid = false
  }
  if (!valid) return

  const nextSlug = slugify(name)
  if (!nextSlug) {
    fieldErrors.name = 'Name must contain at least one letter or digit.'
    return
  }
  const dup = props.prompts.some(
    (p) => promptSlugKey(p) === nextSlug && p._id !== (props.selectedPromptId || '')
  )
  if (dup) {
    fieldErrors.name = `Another prompt already uses slug "${nextSlug}". Change the name.`
    return
  }

  emit('save', {
    _id: props.selectedPromptId || undefined,
    name,
    prompt,
    usage_type: form.usage_type.trim() || 'file processor',
    category: form.category,
    is_default: form.is_default,
    save_to_seed: props.seedWriteEnabled && form.save_to_seed,
    structure_mode: form.structure_mode ?? 'unstructured',
    structure_preset: form.structure_preset?.trim() || AGENT_PIPELINE_STEPS_PRESET,
    structure_mime:
      form.structure_mime === 'application/x-yaml-extended'
        ? 'application/x-yaml-extended'
        : 'application/json'
  })
}

defineExpose({ startNewDraft, submitDraft: submitForm })
</script>
