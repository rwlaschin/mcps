import test from 'node:test'
import assert from 'node:assert/strict'

test('circular journal appends variable records, advances exact pointers, and wraps into a consumed oldest region without clearing', async () => {
  const { advanceJournalPointer, appendJournalRecord } = await import('../semantic-checker-worker.mjs')
  const state = { memoryBuffer: new SharedArrayBuffer(128), insertionPointer: 0, oldestActivePartition: 0 }
  const bytes = new Uint8Array(state.memoryBuffer)

  const first = appendJournalRecord(state, Uint8Array.of(11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23))
  const second = appendJournalRecord(state, Uint8Array.of(31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45))
  advanceJournalPointer(state)
  const consumedBytes = [...bytes.subarray(first.offset, first.offset + first.length)]
  const third = appendJournalRecord(state, Uint8Array.of(51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63))
  const wrapped = appendJournalRecord(state, Uint8Array.of(71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83))

  const gapState = { memoryBuffer: new SharedArrayBuffer(160), insertionPointer: 0, oldestActivePartition: 0 }
  const gapView = new DataView(gapState.memoryBuffer)
  gapView.setUint16(128, 7, true)
  const consumedBeforeGap = appendJournalRecord(gapState, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15))
  const oldestBeforeGap = appendJournalRecord(gapState, Uint8Array.of(21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33))
  advanceJournalPointer(gapState)
  const lastTailRecord = appendJournalRecord(gapState, new Uint8Array(45).fill(41))
  const wrappedAcrossGap = appendJournalRecord(gapState, new Uint8Array(45).fill(61))
  advanceJournalPointer(gapState)

  const fullState = { memoryBuffer: new SharedArrayBuffer(96), insertionPointer: 0, oldestActivePartition: 0 }
  const fullBytes = new Uint8Array(fullState.memoryBuffer)
  const firstFullRecord = appendJournalRecord(fullState, new Uint8Array(45).fill(7), 0)
  const bytesBeforeFallback = [...fullBytes]
  const localFallback = appendJournalRecord(fullState, new Uint8Array(45).fill(9), 1)
  advanceJournalPointer(gapState)
  const oldestAfterTailConsumption = gapState.oldestActivePartition
  advanceJournalPointer(gapState)

  assert.deepEqual({
    first,
    second,
    third,
    wrapped,
    headersInThirtyTwoByteUnits: [new DataView(state.memoryBuffer).getUint16(0, true), new DataView(state.memoryBuffer).getUint16(32, true), new DataView(state.memoryBuffer).getUint16(64, true), new DataView(state.memoryBuffer).getUint16(96, true)],
    consumedBytes,
    wrappedBytes: [...bytes.subarray(wrapped.offset, wrapped.offset + wrapped.length)],
    secondBytes: [...bytes.subarray(second.offset, second.offset + second.length)],
    thirdBytes: [...bytes.subarray(third.offset, third.offset + third.length)],
    insertionPointer: state.insertionPointer,
    oldestActivePartition: state.oldestActivePartition,
    stateKeys: Object.keys(state).sort(),
    nonzeroTailWrap: {
      wrappedAcrossGap,
      wrapMarkerInThirtyTwoByteTail: gapView.getUint16(128, true),
      oldestAfterTailConsumption,
      oldestAfterWrappedConsumption: gapState.oldestActivePartition,
      wrappedBytes: [...new Uint8Array(gapState.memoryBuffer, wrappedAcrossGap.offset, wrappedAcrossGap.length)],
    },
    fullCapacityFallback: { firstFullRecord, localFallback, insertionPointer: fullState.insertionPointer, bytesUnchanged: [...fullBytes].every((byte, index) => byte === bytesBeforeFallback[index]) },
  }, {
    first: { offset: 2, length: 13 },
    second: { offset: 34, length: 15 },
    third: { offset: 66, length: 13 },
    wrapped: { offset: 98, length: 13 },
    headersInThirtyTwoByteUnits: [1, 1, 1, 1],
    consumedBytes: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23],
    wrappedBytes: [71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83],
    secondBytes: [31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45],
    thirdBytes: [51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63],
    insertionPointer: 0,
    oldestActivePartition: 32,
    stateKeys: ['insertionPointer', 'memoryBuffer', 'oldestActivePartition'],
    nonzeroTailWrap: {
      wrappedAcrossGap: { offset: 2, length: 45 },
      wrapMarkerInThirtyTwoByteTail: 0xFFFF,
      oldestAfterTailConsumption: 0,
      oldestAfterWrappedConsumption: 64,
      wrappedBytes: new Array(45).fill(61),
    },
    fullCapacityFallback: { firstFullRecord: { offset: 2, length: 45 }, localFallback: null, insertionPointer: 64, bytesUnchanged: true },
  })
})
