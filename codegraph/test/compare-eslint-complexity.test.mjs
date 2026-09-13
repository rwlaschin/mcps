import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEslintComplexityMessage } from '../scripts/compare-eslint-complexity.mjs'

test('comparison parser accepts every ESLint classic function label used by CodeGraph owners', () => {
  const messages = [
    ["Async function 'handle' has a complexity of 17. Maximum allowed is 0.", 'handle', 17],
    ['Private method #pinInternal has a complexity of 39. Maximum allowed is 0.', '#pinInternal', 39],
    ["Private async method #run has a complexity of 13. Maximum allowed is 0.", '#run', 13],
    ["Async generator method 'query' has a complexity of 27. Maximum allowed is 0.", 'query', 27],
    ['Arrow function has a complexity of 8. Maximum allowed is 0.', '<anonymous>', 8],
    ['Constructor has a complexity of 5. Maximum allowed is 0.', 'constructor', 5],
  ]

  assert.deepEqual(messages.map(([message]) => parseEslintComplexityMessage(message)), messages.map(([, name, complexity]) => ({ name, complexity })))
})
