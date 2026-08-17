<template>
  <GlassCard class="[&_input]:select-text [&_select]:select-text [&_textarea]:select-text">
    <div
      class="grid grid-cols-1 gap-5 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-stretch lg:gap-6"
    >
      <aside
        class="order-1 rounded-2xl border border-white/10 bg-white/5 p-3 flex flex-col min-h-0 max-h-[min(45vh,360px)] sm:max-h-[min(55vh,440px)] lg:max-h-[min(85vh,720px)]"
      >
        <div class="text-[10px] uppercase tracking-widest text-gray-400 mb-2 shrink-0">Saved</div>
        <div class="space-y-1.5 overflow-y-auto pr-0.5 flex-1 min-h-[140px]">
          <div
            v-if="props.personasLoading"
            class="rounded-lg border border-white/10 bg-black/20 px-3 py-4 text-center text-xs text-gray-400"
          >
            Loading personas…
          </div>
          <template v-else>
            <button
              v-for="item in personas"
              :key="item._id"
              type="button"
              class="w-full text-left rounded-lg border px-2.5 py-2 transition-all duration-150"
              :class="selectedPersonaId === item._id
                ? 'border-[var(--accent)]/60 bg-[var(--accent)]/10'
                : 'border-white/10 bg-black/10 hover:bg-white/10 hover:border-white/20'"
              @mousedown.prevent
              @click="selectPersona(item._id)"
            >
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="text-sm font-medium text-white truncate flex-1">{{ item.name }}</span>
              </div>
              <div class="text-[10px] text-gray-500 truncate mt-0.5">
                persona<template v-if="item.save_to_seed"> · seed</template>
              </div>
            </button>
            <div
              v-if="!personas.length"
              class="rounded-lg border border-dashed border-white/15 bg-black/20 px-3 py-4 text-center"
            >
              <p class="text-xs text-gray-400">No personas yet</p>
            </div>
          </template>
        </div>
      </aside>

      <form
        id="config-personas-form"
        class="order-2 rounded-2xl border border-white/10 bg-black/10 p-4 flex flex-col min-h-[min(72vh,820px)] lg:min-h-[min(86vh,920px)]"
        novalidate
        @submit.prevent="submitForm"
      >
        <!-- Primary Save lives in the page header next to + New; keep native submit for Enter in fields. -->
        <button type="submit" class="sr-only" tabindex="-1" :disabled="savePending">Save</button>
        <div class="text-[10px] uppercase tracking-widest text-gray-500 mb-3 shrink-0">Draft</div>

        <div class="grid grid-cols-1 gap-3 shrink-0 mb-3">
          <MuiOutlinedField
            id="persona-name"
            v-model="form.name"
            label="Name"
            :maxlength="200"
            :error="fieldErrors.name"
            @update:model-value="fieldErrors.name = ''"
          />
          <MuiOutlinedField
            id="persona-desc"
            v-model="form.description"
            label="Description"
            multiline
            :rows="4"
            :maxlength="400"
            :error="fieldErrors.description"
            input-class="min-h-[6.5rem]"
            @update:model-value="fieldErrors.description = ''"
          />
        </div>

        <div class="flex min-h-0 flex-1 flex-col mb-4">
          <MuiOutlinedField
            id="persona-prompt"
            v-model="form.prompt"
            label="Prompt"
            multiline
            wrap-class="flex min-h-0 flex-1 flex-col"
            :rows="6"
            :error="fieldErrors.prompt"
            input-class="min-h-[min(42vh,440px)]"
            @update:model-value="fieldErrors.prompt = ''"
          />
        </div>

        <div class="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm shrink-0 mb-3">
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
        <div class="flex flex-wrap gap-2 shrink-0 pt-1 border-t border-white/10">
          <StyleUiButton
            v-if="selectedPersonaId"
            type="button"
            variant="secondary"
            :disabled="savePending"
            @click="$emit('restore-default', selectedPersonaId)"
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
            <template v-if="pendingPersonaName">
              Switch to <span class="text-white font-medium">{{ pendingPersonaName }}</span> and discard your changes?
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
  </GlassCard>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import MuiOutlinedField from './MuiOutlinedField.vue'

const switchConfirmOpen = ref(false)
const pendingSelectId = ref<string | null>(null)

const pendingPersonaName = computed(() => {
  if (pendingSelectId.value === null || pendingSelectId.value === '') return null
  return props.personas.find((p) => p._id === pendingSelectId.value)?.name ?? null
})

export interface PersonaItem {
  _id: string
  name: string
  description: string
  prompt: string
  save_to_seed: boolean
}

const props = withDefaults(
  defineProps<{
    personas: PersonaItem[]
    selectedPersonaId: string
    savePending?: boolean
    personasLoading?: boolean
    seedWriteEnabled?: boolean
  }>(),
  {
    personasLoading: false,
    seedWriteEnabled: false
  }
)

const canUseSaveToSeed = computed(() => props.seedWriteEnabled)

const selectedPersona = computed(() => props.personas.find((p) => p._id === props.selectedPersonaId))

const isDirty = computed(() => {
  if (!props.selectedPersonaId) {
    return form.name.trim() !== '' || form.description.trim() !== '' || form.prompt.trim() !== ''
  }
  const p = selectedPersona.value
  if (!p) return false
  return form.name !== p.name || form.description !== p.description || form.prompt !== p.prompt
})

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'save', payload: Omit<PersonaItem, '_id'> & { _id?: string }): void
  (e: 'restore-default', id: string): void
}>()

const form = reactive({
  name: '',
  description: '',
  prompt: '',
  save_to_seed: false
})

const fieldErrors = reactive({ name: '', description: '', prompt: '' })

watch(
  () => [props.selectedPersonaId, props.personas] as const,
  () => {
    fieldErrors.name = ''
    fieldErrors.description = ''
    fieldErrors.prompt = ''
    if (!props.selectedPersonaId) {
      form.name = ''
      form.description = ''
      form.prompt = ''
      form.save_to_seed = false
      return
    }
    const selected = props.personas.find((p) => p._id === props.selectedPersonaId)
    if (!selected) {
      form.name = ''
      form.description = ''
      form.prompt = ''
      form.save_to_seed = false
      return
    }
    form.name = selected.name
    form.description = selected.description
    form.prompt = selected.prompt
    form.save_to_seed = props.seedWriteEnabled ? selected.save_to_seed : false
  },
  { deep: true, immediate: true }
)

watch(canUseSaveToSeed, (ok) => {
  if (!ok) form.save_to_seed = false
})

function selectPersona(id: string) {
  const next = id === props.selectedPersonaId ? '' : id
  if (isDirty.value) {
    pendingSelectId.value = next
    switchConfirmOpen.value = true
    return
  }
  fieldErrors.name = ''
  fieldErrors.description = ''
  fieldErrors.prompt = ''
  emit('select', next)
}

function confirmSwitch() {
  const id = pendingSelectId.value ?? ''
  switchConfirmOpen.value = false
  pendingSelectId.value = null
  fieldErrors.name = ''
  fieldErrors.description = ''
  fieldErrors.prompt = ''
  if (!id) {
    form.name = ''
    form.description = ''
    form.prompt = ''
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
  form.prompt = ''
  form.save_to_seed = false
  fieldErrors.name = ''
  fieldErrors.description = ''
  fieldErrors.prompt = ''
}

function submitForm() {
  fieldErrors.name = ''
  fieldErrors.description = ''
  fieldErrors.prompt = ''
  const name = form.name.trim()
  const description = form.description.trim()
  const prompt = form.prompt.trim()
  let valid = true
  if (!name) {
    fieldErrors.name = 'Name is required.'
    valid = false
  }
  if (!description) {
    fieldErrors.description = 'Description is required.'
    valid = false
  }
  if (!prompt) {
    fieldErrors.prompt = 'Prompt is required.'
    valid = false
  }
  if (!valid) return

  emit('save', {
    _id: props.selectedPersonaId || undefined,
    name,
    description,
    prompt,
    save_to_seed: props.seedWriteEnabled && form.save_to_seed
  })
}

defineExpose({ startNewDraft, submitDraft: submitForm })
</script>
