import {
  defaultModelCategoriesIfEmpty,
  modelCategoriesFromDoc,
  normalizeModelCategoriesInput,
  normalizeModelCategoryToken
} from '../src/utils/modelCategories';

describe('modelCategories', () => {
  it('normalizes built-in tokens', () => {
    expect(normalizeModelCategoryToken('  BLEND  ')).toBe('blended');
    expect(normalizeModelCategoryToken('thinking')).toBe('thinking');
    expect(normalizeModelCategoryToken('Vision')).toBe('Vision');
  });

  it('dedupes category lists', () => {
    expect(normalizeModelCategoriesInput(['fast', 'fast', 'Vision'])).toEqual(['fast', 'Vision']);
  });

  it('defaults empty model list to fast', () => {
    expect(defaultModelCategoriesIfEmpty([])).toEqual(['fast']);
  });

  it('reads legacy category from doc', () => {
    expect(modelCategoriesFromDoc({ category: 'blended' })).toEqual(['blended']);
    expect(modelCategoriesFromDoc({ categories: ['Vision', 'fast'] })).toEqual(['Vision', 'fast']);
  });
});
