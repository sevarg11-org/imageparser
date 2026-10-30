import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createThumbnailLoadQueue,
  describeGridCell,
  formatGridDate,
} from './thumbnailGridModel.ts'

const cell = (overrides = {}) => ({
  imageLabel: 'img001_a.jpg',
  date: '1991-12-25',
  isPaired: false,
  doNotUpload: false,
  isUnprocessed: false,
  ...overrides,
})

test('describeGridCell names the file, date, and pairing', () => {
  assert.equal(
    describeGridCell(cell({ isPaired: true })),
    'img001_a.jpg, dated 1991-12-25, paired',
  )
})

test('describeGridCell says "no date" and lists every badge', () => {
  assert.equal(
    describeGridCell(
      cell({ date: '', doNotUpload: true, isUnprocessed: true }),
    ),
    'img001_a.jpg, no date, do not upload, unprocessed',
  )
})

test('formatGridDate shows "No date" when there is no XMP date', () => {
  assert.equal(formatGridDate(''), 'No date')
  assert.equal(formatGridDate('2001-02-03'), '2001-02-03')
})

test('the load queue starts at most four loads at once, in order', () => {
  const queue = createThumbnailLoadQueue(4)
  const started = []
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
    queue.enqueue(key, () => started.push(key))
  }
  assert.deepEqual(started, ['a', 'b', 'c', 'd'])
  assert.equal(queue.activeCount(), 4)
  assert.equal(queue.waitingCount(), 2)

  queue.release('b')
  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e'])
})

test('releasing a waiting key drops it without starting it', () => {
  const queue = createThumbnailLoadQueue(1)
  const started = []
  queue.enqueue('a', () => started.push('a'))
  queue.enqueue('b', () => started.push('b'))
  queue.enqueue('c', () => started.push('c'))

  queue.release('b')
  queue.release('a')
  assert.deepEqual(started, ['a', 'c'])
})

test('withdraw drops a waiting key but keeps a started load in its slot', () => {
  const queue = createThumbnailLoadQueue(1)
  const started = []
  queue.enqueue('a', () => started.push('a'))
  queue.enqueue('b', () => started.push('b'))
  queue.enqueue('c', () => started.push('c'))

  queue.withdraw('a')
  queue.withdraw('b')
  assert.equal(queue.activeCount(), 1)
  assert.deepEqual(started, ['a'])

  queue.release('a')
  assert.deepEqual(started, ['a', 'c'])
})

test('enqueueing a key twice does not start it twice', () => {
  const queue = createThumbnailLoadQueue(2)
  const started = []
  queue.enqueue('a', () => started.push('a'))
  queue.enqueue('a', () => started.push('a'))
  assert.deepEqual(started, ['a'])
})

test('clear drops waiting loads so they never start', () => {
  const queue = createThumbnailLoadQueue(1)
  const started = []
  queue.enqueue('a', () => started.push('a'))
  queue.enqueue('b', () => started.push('b'))
  queue.clear()
  queue.release('a')
  assert.deepEqual(started, ['a'])
  assert.equal(queue.activeCount(), 0)
  assert.equal(queue.waitingCount(), 0)
})
