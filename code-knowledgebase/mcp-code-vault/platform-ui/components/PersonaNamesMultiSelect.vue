<template>
  <div ref="rootRef" class="relative w-full">
    <button
      type="button"
      class="flex w-full min-h-[2.75rem] items-center justify-between gap-2 rounded-xl border border-white/15 bg-black/20 px-3 py-2.5 text-left text-sm transition-colors
        hover:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/50
        disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="disabled || loading"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="open = !open"
    >
      <span class="min-w-0 truncate" :class="summary ? 'text-gray-200' : 'text-gray-500'">{{ summary || placeholder }}</span>
      <Icon
        name="lucide:chevron-down"
        class="size-4 shrink-0 text-gray-400 transition-transform"
        :class="{ 'rotate-180': open }"
        aria-hidden="true"
      />
    </button>

    <div
      v-show="open"
      class="absolute left-0 right-0 z-[60] mt-1 max-h-60 overflow-y-auto rounded-xl border border-white/15 bg-[var(--surface-card)] py-1 shadow-xl shadow-black/40"
      role="listbox"
      aria-multiselectable="true"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 border-b border-white/10 px-3 py-2.5 text-left text-sm font-semibold text-[var(--accent)] hover:bg-white/5"
        @click="onCreateClick"
      >
        + Create
      </button>

      <div v-if="loading" class="px-3 py-3 text-xs text-gray-500">Loading personas…</div>
      <p v-else-if="!sortedPersonas.length" class="px-3 py-3 text-xs text-gray-500">No personas yet. Use Create to add one.</p>
      <label
        v-for="p in sortedPersonas"
        :key="p._id"
        class="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:bg-white/[0.06]"
        :class="{ 'bg-white/[0.04]': isSelected(p.name) }"
      >
        <input
          type="checkbox"
          class="rounded border-white/20 bg-white/10 accent-[var(--accent)]"
          :checked="isSelected(p.name)"
          @change="toggle(p.name, ($event.target as HTMLInputElement).checked)"
          @click.stop
        />
        <span class="min-w-0 truncate">{{ p.name }}</span>
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

export interface PersonaOption {
  _id: string
  name: string
}

const modelValue = defineModel<string[]>({ default: () => [] })

const props = withDefaults(
  defineProps<{
    personas: PersonaOption[]
    loading?: boolean
    disabled?: boolean
    placeholder?: string
  }>(),
  {
    loading: false,
    disabled: false,
    placeholder: 'Select personas…'
  }
)

const emit = defineEmits<{ (e: 'create-request'): void }>()

const open = ref(false)
const rootRef = ref<HTMLElement | null>(null)

/** Same ordering as GET /config/personas (sorted by name). */
const sortedPersonas = computed(() =>
  [...props.personas].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
)

const summary = computed(() => {
  const names = modelValue.value ?? []
  if (!names.length) return ''
  if (names.length <= 2) return names.join(', ')
  return `${names.length} selected`
})

function isSelected(name: string) {
  return (modelValue.value ?? []).includes(name)
}

function toggle(name: string, on: boolean) {
  const cur = [...(modelValue.value ?? [])]
  const i = cur.indexOf(name)
  if (on && i === -1) cur.push(name)
  if (!on && i !== -1) cur.splice(i, 1)
  modelValue.value = cur
}

function onCreateClick() {
  open.value = false
  emit('create-request')
}

function onDocClick(e: MouseEvent) {
  const el = rootRef.value
  if (!el || !open.value) return
  if (!el.contains(e.target as Node)) open.value = false
}

onMounted(() => document.addEventListener('click', onDocClick, true))
onUnmounted(() => document.removeEventListener('click', onDocClick, true))
</script>
