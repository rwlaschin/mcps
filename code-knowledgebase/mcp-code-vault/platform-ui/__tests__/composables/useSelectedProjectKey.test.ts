import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import {
  SELECTED_PROJECT_KEY_STORAGE,
  reconcileSelectedProjectKey,
  resetSelectedProjectKeyStateForTests,
  useSelectedProjectKey
} from '../../composables/useSelectedProjectKey'

describe('reconcileSelectedProjectKey', () => {
  it('defaults to first project when empty', () => {
    const selected = ref('')
    reconcileSelectedProjectKey(selected, [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }])
    expect(selected.value).toBe('a')
  })

  it('keeps current key when it exists in the list', () => {
    const selected = ref('b')
    reconcileSelectedProjectKey(selected, [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }])
    expect(selected.value).toBe('b')
  })

  it('replaces stale key with first project', () => {
    const selected = ref('gone')
    reconcileSelectedProjectKey(selected, [{ key: 'a', name: 'A' }])
    expect(selected.value).toBe('a')
  })

  it('clears selection when project list is empty', () => {
    const selected = ref('keep')
    reconcileSelectedProjectKey(selected, [])
    expect(selected.value).toBe('')
  })
})

describe('useSelectedProjectKey', () => {
  it('persists non-empty value to localStorage as JSON string', () => {
    resetSelectedProjectKeyStateForTests()
    const selected = useSelectedProjectKey()
    selected.value = 'my-project'
    expect(localStorage.getItem(SELECTED_PROJECT_KEY_STORAGE)).toBe(JSON.stringify('my-project'))
  })

  it('resetSelectedProjectKeyStateForTests clears storage and ref', () => {
    const selected = useSelectedProjectKey()
    selected.value = 'x'
    expect(localStorage.getItem(SELECTED_PROJECT_KEY_STORAGE)).toBe(JSON.stringify('x'))
    resetSelectedProjectKeyStateForTests()
    expect(selected.value).toBe('')
    expect(localStorage.getItem(SELECTED_PROJECT_KEY_STORAGE)).toBeNull()
  })
})
