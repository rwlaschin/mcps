<template>
  <div class="w-full" :class="wrapClass">
    <div
      class="relative rounded-xl border bg-white/5 transition-colors duration-200"
      :class="[
        multiline ? 'flex min-h-0 flex-1 flex-col' : '',
        error ? 'border-red-400/50' : focused ? 'border-[var(--accent)]/50' : 'border-white/15'
      ]"
    >
      <label
        :for="id"
        class="absolute z-[2] max-w-[calc(100%-1.25rem)] truncate transition-all duration-200 ease-[cubic-bezier(0,0,0.2,1)]"
        :class="[
          select ? 'cursor-pointer' : 'cursor-text',
          labelPositionClass,
          labelColorClass,
          labelNotchWhenFloated
        ]"
      >
        {{ label }}
      </label>
      <textarea
        v-if="multiline"
        :id="id"
        :value="modelValue"
        :rows="rows"
        :maxlength="maxlength"
        autocomplete="off"
        class="mui-outlined-input select-text w-full min-h-0 flex-1 resize-none overflow-y-auto rounded-xl bg-transparent px-2.5 text-[15px] leading-snug text-white outline-none font-mono"
        :class="[multilinePaddingClassComputed, inputClass]"
        :aria-invalid="Boolean(error)"
        :aria-describedby="error ? `${id}-err` : undefined"
        @focus="focused = true"
        @blur="focused = false"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      />
      <div v-else-if="select" class="relative">
        <select
          :id="id"
          :value="modelValue"
          autocomplete="off"
          class="mui-outlined-input select-text mui-outlined-select w-full cursor-pointer appearance-none rounded-xl bg-transparent pl-2.5 pr-12 text-[15px] leading-snug text-white outline-none"
          :class="[singlePaddingClassComputed, inputClass]"
          :aria-invalid="Boolean(error)"
          :aria-describedby="error ? `${id}-err` : undefined"
          @focus="focused = true"
          @blur="focused = false"
          @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="opt in options" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
        <span
          class="pointer-events-none absolute inset-y-0 right-2 flex w-9 items-center justify-center text-gray-400"
          aria-hidden="true"
        >
          <svg class="h-4 w-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </span>
      </div>
      <input
        v-else
        :id="id"
        :value="modelValue"
        type="text"
        :maxlength="maxlength"
        autocomplete="off"
        class="mui-outlined-input select-text w-full rounded-xl bg-transparent px-2.5 text-[15px] leading-snug text-white outline-none"
        :class="[singlePaddingClassComputed, inputClass]"
        :aria-invalid="Boolean(error)"
        :aria-describedby="error ? `${id}-err` : undefined"
        @focus="focused = true"
        @blur="focused = false"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <p v-if="error" :id="`${id}-err`" class="mt-1 text-xs text-red-300/90">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    id: string
    modelValue: string
    label: string
    multiline?: boolean
    /** Native select with same shell as single-line text (floating label, height, border). */
    select?: boolean
    options?: Array<{ value: string; label: string }>
    rows?: number
    maxlength?: number
    error?: string
    inputClass?: string
    wrapClass?: string
    /** Semi-transparent chip behind floated label so the outline “breaks” at the top edge. */
    labelNotchClass?: string
  }>(),
  {
    multiline: false,
    select: false,
    options: () => [],
    rows: 6,
    maxlength: undefined,
    error: '',
    inputClass: '',
    wrapClass: '',
    // Match app cards (--surface-card): dark black/45 + blur made accent label unreadable when focused.
    labelNotchClass: 'bg-[var(--surface-card)]'
  }
)

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const focused = ref(false)
const hasValue = computed(() => props.modelValue.trim().length > 0)
/** Select always shows a value → keep label floated like other filled fields. */
const floated = computed(() => (props.select ? true : focused.value || hasValue.value))

/** When floated: label center sits on the top border (half in / half out). */
const labelPositionClass = computed(() => {
  if (floated.value) {
    return 'left-2.5 top-0 -translate-y-1/2 scale-[0.75] origin-left'
  }
  if (props.multiline) {
    return 'left-2.5 top-3 translate-y-0 scale-100'
  }
  return 'left-2.5 top-1/2 -translate-y-1/2 scale-100'
})

/** Tight horizontal inset (≈2px) so the gap in the border is minimal; rounded to match the field. */
const labelNotchWhenFloated = computed(() =>
  floated.value ? `${props.labelNotchClass} px-px rounded-md` : ''
)

const labelColorClass = computed(() => {
  if (props.error) {
    return floated.value ? 'text-red-300/90' : 'text-red-400/70'
  }
  // Floated + focus: avoid --accent on dark notch (fails contrast); keep hue with a lighter violet.
  if (focused.value) return floated.value ? 'text-violet-200' : 'text-[var(--accent)]'
  if (floated.value) return 'text-gray-400'
  return 'text-gray-500'
})

/** Compact single-line: was pt-5 / min-h 3.25rem (~52px) — too tall for one line of text. */
const singlePaddingClassComputed = computed(() => 'pt-3.5 pb-1.5 min-h-[2.625rem]')

const multilinePaddingClassComputed = computed(() =>
  floated.value ? 'pt-4 pb-2 min-h-[8rem]' : 'pt-6 pb-2 min-h-[8rem]'
)
</script>

<style scoped>
.mui-outlined-input:focus {
  box-shadow: none;
}
.mui-outlined-select {
  background-image: none;
}
</style>
