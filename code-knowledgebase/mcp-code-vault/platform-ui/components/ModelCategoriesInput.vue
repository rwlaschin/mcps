<template>
  <div class="space-y-2 min-w-0 max-w-full">
    <div class="flex flex-wrap gap-2">
      <label
        v-for="b in builtIns"
        :key="b.value"
        class="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/25 px-2 py-1 text-xs text-gray-200 cursor-pointer"
      >
        <input
          type="checkbox"
          class="rounded border-white/25 bg-white/10 accent-[var(--accent)]"
          :checked="has(b.value)"
          @change="toggleBuiltIn(b.value, ($event.target as HTMLInputElement).checked)"
        />
        {{ b.label }}
      </label>
    </div>
    <div v-if="customTags.length" class="flex flex-wrap gap-1.5">
      <span
        v-for="c in customTags"
        :key="c"
        class="inline-flex items-center gap-1 rounded-md border border-[var(--accent)]/35 bg-[var(--accent)]/10 px-2 py-0.5 text-[11px] text-gray-200"
      >
        {{ c }}
        <button
          type="button"
          class="text-gray-500 hover:text-white"
          :aria-label="`Remove ${c}`"
          @click="remove(c)"
        >
          ×
        </button>
      </span>
    </div>
    <div class="flex gap-2">
      <input
        v-model="customInput"
        type="text"
        class="min-w-0 flex-1 select-text rounded-lg border border-white/15 bg-black/30 px-2 py-1.5 text-xs text-white"
        :placeholder="allowEmpty ? 'Add tag (e.g. Vision)…' : 'Add custom tag…'"
        @keydown.enter.prevent="addCustom"
      />
      <StyleUiButton type="button" variant="secondary" size="sm" @click="addCustom">Add</StyleUiButton>
    </div>
    <p v-if="hint" class="text-[10px] text-gray-600 leading-snug">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  defaultModelCategoriesIfEmpty,
  normalizeModelCategoryToken
} from '../lib/modelCategories'

const BUILT_INS = [
  { value: 'fast', label: 'Fast' },
  { value: 'blended', label: 'Blended' },
  { value: 'thinking', label: 'Thinking' }
] as const

const props = withDefaults(
  defineProps<{
    /** API / parent may briefly omit or null this; always normalized below. */
    modelValue?: string[] | null
    /** Agent filters may be empty (= all models). Saved models require at least one tier. */
    allowEmpty?: boolean
    hint?: string
  }>(),
  { modelValue: () => [], allowEmpty: false, hint: '' }
)

const emit = defineEmits<{ (e: 'update:modelValue', v: string[]): void }>()

const customInput = ref('')

const builtIns = BUILT_INS

const tags = computed(() => (Array.isArray(props.modelValue) ? props.modelValue : []))

const customTags = computed(() =>
  tags.value.filter((c) => !BUILT_INS.some((b) => b.value === c))
)

function has(key: string): boolean {
  return tags.value.includes(key)
}

function emitNext(next: string[]) {
  emit('update:modelValue', props.allowEmpty ? next : defaultModelCategoriesIfEmpty(next))
}

function toggleBuiltIn(key: string, on: boolean) {
  const set = new Set(tags.value)
  if (on) set.add(key)
  else set.delete(key)
  emitNext([...set])
}

function remove(c: string) {
  emitNext(tags.value.filter((x) => x !== c))
}

function addCustom() {
  const n = normalizeModelCategoryToken(customInput.value)
  if (!n) return
  if (tags.value.includes(n)) {
    customInput.value = ''
    return
  }
  emitNext([...tags.value, n])
  customInput.value = ''
}
</script>
