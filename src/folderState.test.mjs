import assert from 'node:assert/strict'
import test from 'node:test'
import { describeFolderState, unprocessedFolderState } from './folderState.ts'

test('describeFolderState names who marked the folder and the local date', () => {
  const processedAt = new Date(2026, 9, 27, 15, 4, 5).toISOString()
  assert.equal(
    describeFolderState({ processed: true, processedAt, processedBy: 'dennis' }),
    'Processed by dennis on 2026-10-27',
  )
})

test('describeFolderState leaves out a missing user or date', () => {
  assert.equal(
    describeFolderState({ processed: true, processedAt: null, processedBy: null }),
    'Processed',
  )
  assert.equal(
    describeFolderState({ processed: true, processedAt: 'not a date', processedBy: 'alice' }),
    'Processed by alice',
  )
})

test('describeFolderState reports an unprocessed folder', () => {
  assert.equal(describeFolderState(unprocessedFolderState), 'Not processed')
})
