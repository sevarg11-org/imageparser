import assert from 'node:assert/strict'
import test from 'node:test'
import {
  countImageFilterMatches,
  filterImagePairs,
  getEmptyFilterMessage,
  isImageFilter,
} from './imageFilters.ts'

const makePairs = (count, { sidecarIds = [], pairedIds = [] } = {}) =>
  Array.from({ length: count }, (_, index) => {
    const id = `p${index + 1}`
    return {
      id,
      backPath: pairedIds.includes(id) ? `${id}_b.jpg` : null,
      hasSidecar: sidecarIds.includes(id),
    }
  })

const ids = (pairs) => pairs.map((pair) => pair.id)

test('All keeps every group in order', () => {
  const pairs = makePairs(3, { sidecarIds: ['p2'] })
  assert.deepEqual(ids(filterImagePairs(pairs, 'all', new Set())), ['p1', 'p2', 'p3'])
})

test('Pairs keeps only groups with a B file', () => {
  const pairs = makePairs(4, { pairedIds: ['p2', 'p4'] })
  assert.deepEqual(ids(filterImagePairs(pairs, 'pairs', new Set())), ['p2', 'p4'])
})

test('Unprocessed hides groups with a sidecar: 10 groups, 4 processed, 6 shown', () => {
  const pairs = makePairs(10, { sidecarIds: ['p1', 'p3', 'p5', 'p7'] })
  const visible = filterImagePairs(pairs, 'unprocessed', new Set())
  assert.equal(visible.length, 6)
  assert.deepEqual(ids(visible), ['p2', 'p4', 'p6', 'p8', 'p9', 'p10'])
})

test('a group saved this session counts as processed', () => {
  const pairs = makePairs(3)
  assert.deepEqual(ids(filterImagePairs(pairs, 'unprocessed', new Set(['p2']))), ['p1', 'p3'])
})

test('the retained group stays visible after it is saved, then drops out when selection moves', () => {
  const pairs = makePairs(6)
  const saved = new Set(['p1'])
  assert.deepEqual(ids(filterImagePairs(pairs, 'unprocessed', saved, 'p1')), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])

  const afterNext = filterImagePairs(pairs, 'unprocessed', saved, 'p2')
  assert.equal(afterNext.length, 5)
  assert.equal(afterNext.findIndex((pair) => pair.id === 'p2'), 0)
})

test('counts reflect every option', () => {
  const pairs = makePairs(5, { sidecarIds: ['p1'], pairedIds: ['p1', 'p2'] })
  assert.deepEqual(countImageFilterMatches(pairs, new Set(['p3'])), {
    all: 5,
    pairs: 2,
    unprocessed: 3,
  })
})

test('isImageFilter accepts only known filters', () => {
  assert.equal(isImageFilter('unprocessed'), true)
  assert.equal(isImageFilter('pairs'), true)
  assert.equal(isImageFilter('done'), false)
})

test('empty-state messages explain an empty filter', () => {
  assert.equal(getEmptyFilterMessage('unprocessed', 4), 'All images in this folder have been processed.')
  assert.match(getEmptyFilterMessage('pairs', 4), /both an A and a B/)
  assert.match(getEmptyFilterMessage('all', 0), /Choose a folder/)
})
