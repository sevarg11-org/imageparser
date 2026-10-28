import assert from 'node:assert/strict'
import test from 'node:test'
import { createKeyedQueue, createSerialQueue } from './imageFileQueue.js'

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

test('the keyed queue serializes operations on the same file', async () => {
  const lock = createKeyedQueue()
  const events = []
  let finishWrite
  const write = lock.run('a.jpg', async () => {
    events.push('write started')
    await new Promise((resolve) => {
      finishWrite = resolve
    })
    events.push('write finished')
  })
  const preview = lock.run('a.jpg', async () => {
    events.push('preview started')
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['write started'])

  finishWrite()
  await Promise.all([write, preview])
  assert.deepEqual(events, ['write started', 'write finished', 'preview started'])
})

test('the keyed queue does not make a preview wait behind writes to other files', async () => {
  const lock = createKeyedQueue()
  let finishWrite
  const write = lock.run(['a.jpg', 'b.jpg'], () => new Promise((resolve) => {
    finishWrite = resolve
  }))

  assert.equal(await lock.run('c.jpg', () => 'previewed'), 'previewed')
  finishWrite()
  await write
})

test('a multi-file operation waits for earlier work on any of its files', async () => {
  const lock = createKeyedQueue()
  const events = []
  let finishBack
  const backPreview = lock.run('b.jpg', async () => {
    await new Promise((resolve) => {
      finishBack = resolve
    })
    events.push('back preview finished')
  })
  const save = lock.run(['a.jpg', 'b.jpg'], async () => {
    events.push('save started')
  })
  const frontPreview = lock.run('a.jpg', async () => {
    events.push('front preview started')
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [])

  finishBack()
  await Promise.all([backPreview, save, frontPreview])
  assert.deepEqual(events, ['back preview finished', 'save started', 'front preview started'])
})

test('the keyed queue reports failures, keeps going, and forgets idle files', async () => {
  const lock = createKeyedQueue()
  const error = new Error('ExifTool could not write the file')
  const failed = lock.run('a.jpg', () => {
    throw error
  })
  const next = lock.run('a.jpg', () => 'saved')

  await assert.rejects(failed, (reason) => reason === error)
  assert.equal(await next, 'saved')
  await lock.whenIdle()
  assert.equal(lock.size(), 0)
})

test('whenIdle waits for every queued operation', async () => {
  const lock = createKeyedQueue()
  const finished = []
  lock.run('a.jpg', async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    finished.push('a')
  })
  lock.run('b.jpg', async () => {
    finished.push('b')
  })

  await lock.whenIdle()
  assert.deepEqual(finished.sort(), ['a', 'b'])
})
