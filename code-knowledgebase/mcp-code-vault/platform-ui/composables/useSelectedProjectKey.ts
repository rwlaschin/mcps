import { ref, watch, effectScope, type Ref } from 'vue'

/** Owns the localStorage sync watcher so it survives component unmount / route changes. */
const persistScope = effectScope(true)

/** Browser localStorage key for the platform project selector (shared across pages). */
export const SELECTED_PROJECT_KEY_STORAGE = 'platform-ui:selectedProjectKey'

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

function readStoredProjectKey(): string {
  if (!isBrowser()) return ''
  try {
    const raw = localStorage.getItem(SELECTED_PROJECT_KEY_STORAGE)
    if (raw == null || raw === '') return ''
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'string' ? parsed : ''
  } catch {
    return ''
  }
}

let selectedSingleton: Ref<string> | null = null

/**
 * App-wide selected project key, persisted in `localStorage` so navigation and reload keep it.
 * Call {@link reconcileSelectedProjectKey} after fetching `/projects` so a stale stored key is replaced.
 */
export function useSelectedProjectKey() {
  if (!selectedSingleton) {
    selectedSingleton = ref(readStoredProjectKey())
    if (isBrowser()) {
      persistScope.run(() => {
        watch(
          selectedSingleton!,
          (v) => {
            try {
              if (v) localStorage.setItem(SELECTED_PROJECT_KEY_STORAGE, JSON.stringify(v))
              else localStorage.removeItem(SELECTED_PROJECT_KEY_STORAGE)
            } catch {
              /* private mode / quota */
            }
          },
          { flush: 'sync' }
        )
      })
    }
  }
  return selectedSingleton
}

/**
 * If the current selection is missing from the loaded project list, pick the first project.
 * If nothing is selected yet, default to the first project when the list is non-empty.
 */
export function reconcileSelectedProjectKey(selected: Ref<string>, projects: { key: string }[]): void {
  const keys = projects.map((p) => p.key).filter(Boolean)
  if (!keys.length) {
    // Avoid a persisted key with an empty `/projects` list: when projects load later, '' → key
    // triggers downstream watchers (e.g. fetchConfig) that a no-op assignment would skip.
    selected.value = ''
    return
  }
  const set = new Set(keys)
  if (selected.value && !set.has(selected.value)) {
    selected.value = keys[0]!
    return
  }
  if (!selected.value) selected.value = keys[0]!
}

/** Clears persisted and in-memory selection (Vitest isolation). */
export function resetSelectedProjectKeyStateForTests(): void {
  try {
    localStorage.removeItem(SELECTED_PROJECT_KEY_STORAGE)
  } catch {
    /* ignore */
  }
  if (selectedSingleton) selectedSingleton.value = ''
}
