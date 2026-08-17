<script setup lang="ts">
import { computed, useAttrs } from 'vue'

export type StyleUiButtonVariant =
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'ghost'
  | 'muted'
  | 'soft'
  | 'segment-inactive'
  | 'icon'
  | 'icon-danger'
  | 'text'
  | 'link-accent'

export type StyleUiButtonSize = 'sm' | 'md' | 'lg' | 'compact'

const props = withDefaults(
  defineProps<{
    variant?: StyleUiButtonVariant
    size?: StyleUiButtonSize
    type?: 'button' | 'submit' | 'reset'
  }>(),
  {
    variant: 'primary',
    size: 'md',
    type: 'button'
  }
)

defineOptions({ inheritAttrs: false })

const attrs = useAttrs()

const filteredAttrs = computed(() => {
  const { class: _c, ...rest } = attrs as Record<string, unknown>
  return rest
})

const baseClass = computed(() => {
  if (props.variant === 'link-accent') {
    return 'inline font-semibold transition-colors'
  }
  return 'inline-flex items-center justify-center gap-1.5 font-semibold rounded-xl transition-colors box-border'
})

const variantClass = computed(() => {
  switch (props.variant) {
    case 'primary':
      return 'text-white bg-[var(--accent)] hover:bg-[var(--accent-hover)] border border-transparent disabled:opacity-50 disabled:cursor-not-allowed'
    case 'secondary':
      return 'text-white border border-white/25 bg-transparent hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent'
    case 'danger':
      return 'text-red-200 bg-red-500/20 border border-red-500/25 hover:bg-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed'
    case 'ghost':
      return 'text-gray-300 hover:text-white hover:bg-white/10 border border-transparent'
    case 'muted':
      return 'text-gray-200 border border-white/15 bg-white/5 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed'
    case 'soft':
      return 'text-white bg-white/10 hover:bg-white/15 border border-transparent disabled:opacity-50 disabled:cursor-not-allowed'
    case 'segment-inactive':
      return 'text-gray-500 hover:text-gray-300 border border-transparent'
    case 'icon':
      return 'p-2 text-gray-400 hover:text-white hover:bg-white/10 border border-transparent disabled:opacity-40 disabled:cursor-not-allowed'
    case 'icon-danger':
      return 'p-2 text-gray-500 hover:text-red-300 hover:bg-red-500/10 border border-transparent disabled:opacity-40 disabled:cursor-not-allowed'
    case 'text':
      return 'px-1 py-0.5 text-xs text-gray-500 hover:text-gray-300 border border-transparent rounded-lg'
    case 'link-accent':
      return 'mx-0.5 text-[var(--accent)] hover:text-white hover:underline underline-offset-2 disabled:opacity-50 disabled:no-underline bg-transparent border-0 p-0 rounded-sm'
    default:
      return ''
  }
})

const sizeClass = computed(() => {
  if (
    props.variant === 'icon' ||
    props.variant === 'icon-danger' ||
    props.variant === 'text' ||
    props.variant === 'link-accent'
  ) {
    return ''
  }
  switch (props.size) {
    case 'sm':
      return 'px-3 py-1.5 text-xs'
    case 'lg':
      return 'px-5 py-2.5 text-sm'
    case 'compact':
      return 'px-2.5 py-2 min-[400px]:px-3 min-[400px]:py-1.5 text-sm shrink-0'
    default:
      return 'px-4 py-2.5 text-sm'
  }
})

const mergedClass = computed(() => {
  const a = attrs as { class?: unknown }
  return [baseClass.value, sizeClass.value, variantClass.value, a.class]
})
</script>

<template>
  <button :type="type" :class="mergedClass" v-bind="filteredAttrs">
    <slot />
  </button>
</template>
