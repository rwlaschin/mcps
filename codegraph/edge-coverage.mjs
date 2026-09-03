// Edge coverage as codes, not free-floating strings. This value is a cache key and a persisted
// manifest field, so a typo used to degrade silently into a cold rebuild instead of throwing.
// Bit values: COMPLETE is a superset of CALLS, so a future coverage can be added without
// renumbering, and `code & CALLS` stays meaningful.
export const EDGE_COVERAGE = { CALLS: 8, COMPLETE: 16 }

const NAME_BY_CODE = { [EDGE_COVERAGE.CALLS]: 'calls', [EDGE_COVERAGE.COMPLETE]: 'complete' }
const CODE_BY_NAME = { calls: EDGE_COVERAGE.CALLS, complete: EDGE_COVERAGE.COMPLETE }

// Accepts either representation: generations written before this change store the name, and the
// MCP request schema takes a name from the caller.
export const coverageCode = (value) =>
  typeof value === 'number' ? (NAME_BY_CODE[value] ? value : null) : (CODE_BY_NAME[value] ?? null)

export const coverageName = (value) => NAME_BY_CODE[coverageCode(value)] ?? null

export const requireCoverage = (value) => {
  const code = coverageCode(value)
  if (!code) throw new Error(`unknown edge coverage: ${JSON.stringify(value)}`)
  return code
}
