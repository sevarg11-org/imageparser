import assert from 'node:assert/strict'
import test from 'node:test'
import { createSerialQueue } from './imageFileQueue.js'

test('image file operations run in submission order without overlapping', async () => {
  const run = createSerialQueue()
  const events = []
  let finishFirst
  const first = run(async () => {
    events.push('save started')
    await new Promise((resolve) => {
      finishFirst = resolve
    })
    events.push('save finished')
    return 'saved'
  })
  const second = run(async () => {
    events.push('preview started')
    return 'previewed'
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['save started'])

  finishFirst()
  assert.deepEqual(await Promise.all([first, second]), ['saved', 'previewed'])
  assert.deepEqual(events, ['save started', 'save finished', 'preview started'])
})

test('a failed image file operation reports its error and does not block subsequent work', async () => {
  const run = createSerialQueue()
  const error = new Error('ExifTool could not write the file')
  const failed = run(() => {
    throw error
  })
  const next = run(() => 'saved')

  await assert.rejects(failed, (reason) => reason === error)
  assert.equal(await next, 'saved')
})
