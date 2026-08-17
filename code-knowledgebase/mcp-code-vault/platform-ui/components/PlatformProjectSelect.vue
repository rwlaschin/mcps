<template>
  <div class="relative isolate z-20 w-full max-w-sm">
    <select
      v-model="model"
      class="platform-project-select select-text block w-full cursor-pointer rounded-xl border border-white/20 bg-[var(--surface-card)] pl-4 py-3 pr-12
             text-white appearance-none
             focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/60 focus:border-[var(--accent)]/60
             transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      :disabled="loading"
      :aria-label="ariaLabel"
    >
      <option value="" disabled>
        {{ loading ? 'Loading…' : (projects.length ? 'Select project' : 'No projects') }}
      </option>
      <option v-for="row in optionRows" :key="row.key" :value="row.key">
        {{ row.label }}
      </option>
    </select>
    <span
      class="pointer-events-none absolute inset-y-0 right-2 flex w-10 items-center justify-center text-gray-400"
      aria-hidden="true"
    >
      <svg class="h-5 w-5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export interface PlatformProjectOption {
  key: string
  name: string
}

const model = defineModel<string>({ required: true })

const props = withDefaults(
  defineProps<{
    projects: PlatformProjectOption[]
    loading?: boolean
    ariaLabel?: string
  }>(),
  {
    loading: false,
    ariaLabel: 'Select project'
  }
)

/** How many options share this trimmed display name (empty name counts as one bucket per project key). */
const nameDupCount = computed(() => {
  const m = new Map<string, number>()
  for (const p of props.projects) {
    const labelKey = (p.name || '').trim() || `\0${p.key}`
    m.set(labelKey, (m.get(labelKey) || 0) + 1)
  }
  return m
})

/** Show `name (key)` only when the same name is used for more than one project; otherwise the key is redundant noise (e.g. "Default Project (default)"). */
const optionRows = computed(() =>
  props.projects.map((p) => {
    const name = (p.name || '').trim()
    const bucket = name || `\0${p.key}`
    const dup = (nameDupCount.value.get(bucket) || 0) > 1
    const label = !name ? p.key : dup ? `${name} (${p.key})` : name
    return { key: p.key, label }
  })
)
</script>
