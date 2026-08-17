import { ref } from 'vue'

export type ToastVariant = 'success' | 'error'

export interface PlatformToast {
  id: number
  message: string
  variant: ToastVariant
}

const toasts = ref<PlatformToast[]>([])
let nextId = 0

/** Fixed-position toasts; singleton so any page can call without prop drilling. */
export function usePlatformToast() {
  function dismiss(id: number) {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  function push(message: string, variant: ToastVariant, durationMs = 4800) {
    const id = ++nextId
    toasts.value = [...toasts.value, { id, message, variant }]
    if (durationMs > 0 && typeof window !== 'undefined') {
      window.setTimeout(() => dismiss(id), durationMs)
    }
    return id
  }

  return {
    toasts,
    success: (message: string) => push(message, 'success'),
    error: (message: string) => push(message, 'error'),
    dismiss
  }
}
