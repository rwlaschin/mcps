import {
  formatLocalHourKey,
  localCalendarHourKeyRange,
  parseFileReadBatchEntries,
  FILE_READ_WINDOW_DAYS
} from '../src/stats/fileReadHourBuckets';

describe('fileReadHourBuckets helpers', () => {
  it('formatLocalHourKey zero-pads and uses local wall clock', () => {
    const d = new Date(2026, 2, 9, 7, 30, 0); // Mar 9 2026 07:30 local
    expect(formatLocalHourKey(d)).toBe('2026/03/09 07');
  });

  it('localCalendarHourKeyRange spans FILE_READ_WINDOW_DAYS and is lexicographically comparable', () => {
    const { minKey, maxKey } = localCalendarHourKeyRange(FILE_READ_WINDOW_DAYS);
    expect(minKey.length).toBe(13);
    expect(maxKey.length).toBe(13);
    expect(maxKey > minKey).toBe(true);
    expect(maxKey.endsWith(' 23')).toBe(true);
    expect(minKey.endsWith(' 00')).toBe(true);
  });

  it('parseFileReadBatchEntries filters invalid rows', () => {
    expect(
      parseFileReadBatchEntries({
        entries: [
          { projectKey: 'a', count: 3 },
          { projectKey: '', count: 1 },
          { projectKey: 'b', count: 0 },
          { projectKey: 'c', count: 2.7 }
        ]
      })
    ).toEqual([
      { projectKey: 'a', count: 3 },
      { projectKey: 'c', count: 2 }
    ]);
  });
});
