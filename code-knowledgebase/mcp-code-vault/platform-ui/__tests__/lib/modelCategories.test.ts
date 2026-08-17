import { describe, expect, it } from 'vitest'
import {
  categoriesFromSavedModel,
  defaultModelCategoriesIfEmpty,
  normalizeModelCategoriesInput,
  normalizeModelCategoryToken
} from '../../lib/modelCategories'

describe('modelCategories (platform-ui)', () => {
  it('normalizes built-in tokens', () => {
    expect(normalizeModelCategoryToken('blend')).toBe('blended')
    expect(normalizeModelCategoryToken('Vision')).toBe('Vision')
  })

  it('dedupes category lists', () => {
    expect(normalizeModelCategoriesInput(['fast', 'fast', 'Vision'])).toEqual(['fast', 'Vision'])
  })

  it('defaults empty model list to fast', () => {
    expect(defaultModelCategoriesIfEmpty([])).toEqual(['fast'])
  })

  it('reads legacy category from saved model', () => {
    expect(categoriesFromSavedModel({ category: 'thinking' })).toEqual(['thinking'])
    expect(categoriesFromSavedModel({ categories: ['Vision'] })).toEqual(['Vision'])
  })
})
