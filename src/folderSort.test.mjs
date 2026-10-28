import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultFolderSort,
  describeFolderDate,
  parseFolderSort,
  sortFolders,
} from './folderSort.ts'

const folder = (name, { processed = false, createdAt = null, createdAtSource = createdAt === null ? null : 'created' } = {}) => ({
  name,
  processed,
  createdAt,
  createdAtSource,
})

const names = (folders) => folders.map((entry) => entry.name)

test('Name ascending sorts naturally, ignoring case', () => {
  const folders = [folder('Archive'), folder('10'), folder('2'), folder('archive b')]
  assert.deepEqual(names(sortFolders(folders, defaultFolderSort)), ['2', '10', 'Archive', 'archive b'])
})

test('Name descending reverses the natural order', () => {
  const folders = [folder('Archive'), folder('10'), folder('2')]
  assert.deepEqual(
    names(sortFolders(folders, { field: 'name', direction: 'descending' })),
    ['Archive', '10', '2'],
  )
})

test('Processed ascending puts unprocessed folders first, by name within each group', () => {
  const folders = [
    folder('b', { processed: true }),
    folder('c'),
    folder('a', { processed: true }),
  ]
  assert.deepEqual(
    names(sortFolders(folders, { field: 'processed', direction: 'ascending' })),
    ['c', 'a', 'b'],
  )
  assert.deepEqual(
    names(sortFolders(folders, { field: 'processed', direction: 'descending' })),
    ['a', 'b', 'c'],
  )
})

test('Date created sorts oldest first when ascending and keeps undated folders last', () => {
  const folders = [
    folder('new', { createdAt: 3000 }),
    folder('undated'),
    folder('old', { createdAt: 1000 }),
    folder('same b', { createdAt: 2000 }),
    folder('same a', { createdAt: 2000, createdAtSource: 'modified' }),
  ]
  assert.deepEqual(
    names(sortFolders(folders, { field: 'created', direction: 'ascending' })),
    ['old', 'same a', 'same b', 'new', 'undated'],
  )
  assert.deepEqual(
    names(sortFolders(folders, { field: 'created', direction: 'descending' })),
    ['new', 'same a', 'same b', 'old', 'undated'],
  )
})

test('sortFolders does not change its input', () => {
  const folders = [folder('b'), folder('a')]
  sortFolders(folders, defaultFolderSort)
  assert.deepEqual(names(folders), ['b', 'a'])
})

test('parseFolderSort restores a remembered sort', () => {
  const stored = JSON.stringify({ field: 'created', direction: 'descending' })
  assert.deepEqual(parseFolderSort(stored), { field: 'created', direction: 'descending' })
})

test('parseFolderSort falls back to Name ascending for missing or invalid values', () => {
  for (const stored of [null, '', 'not json', '[]', '{"field":"size","direction":"ascending"}', '{"field":"name"}']) {
    assert.deepEqual(parseFolderSort(stored), defaultFolderSort)
  }
})

test('describeFolderDate labels a real creation time as Created and a fallback as Modified', () => {
  const createdAt = new Date(2026, 9, 27, 15, 4, 5).getTime()
  assert.equal(describeFolderDate({ createdAt, createdAtSource: 'created' }), 'Created 2026-10-27')
  assert.equal(describeFolderDate({ createdAt, createdAtSource: 'modified' }), 'Modified 2026-10-27')
  assert.equal(describeFolderDate({ createdAt: null, createdAtSource: null }), null)
})
