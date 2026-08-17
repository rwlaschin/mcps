<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed bottom-4 right-4 z-[200] flex max-w-[min(100vw-2rem,22rem)] flex-col gap-2 md:right-8"
      aria-live="polite"
      aria-relevant="additions removals"
    >
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="pointer-events-auto rounded-xl border px-4 py-3 text-sm font-medium shadow-lg backdrop-blur-md"
          :class="t.variant === 'error'
            ? 'border-red-400/35 bg-red-950/90 text-red-100'
            : 'border-emerald-400/30 bg-[var(--surface-card)]/95 text-gray-100'"
          role="status"
        >
          {{ t.message }}
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { usePlatformToast } from '../composables/usePlatformToast'

const { toasts } = usePlatformToast()
</script>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
.toast-move {
  transition: transform 0.2s ease;
}
</style>
