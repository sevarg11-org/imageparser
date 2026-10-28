import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeSaveFailure,
  describeUnsavedImages,
  getRemainingRotations,
  getRotatedImageBox,
  getUpdatedImageVersions,
  mapRotatedPointToImage,
  needsSaveOnLeave,
  rotatePoint,
} from './pairPersistence.ts'

const noRotation = { front: 0, back: 0 }

test('leaving an unchanged pair that already has a sidecar saves nothing', () => {
  assert.equal(needsSaveOnLeave({ hasUserChanged: false, rotations: noRotation, hasSidecar: true }), false)
})

test('leaving a pair saves it after edits, with a pending rotation, or without a sidecar', () => {
  assert.equal(needsSaveOnLeave({ hasUserChanged: true, rotations: noRotation, hasSidecar: true }), true)
  assert.equal(needsSaveOnLeave({ hasUserChanged: false, rotations: { front: 90, back: 0 }, hasSidecar: true }), true)
  assert.equal(needsSaveOnLeave({ hasUserChanged: false, rotations: { front: 0, back: 270 }, hasSidecar: true }), true)
  assert.equal(needsSaveOnLeave({ hasUserChanged: false, rotations: noRotation, hasSidecar: false }), true)
})

test('applied rotations are cleared and failed ones stay pending', () => {
  const results = [
    { field: 'front', filePath: 'a.jpg', ok: true, dateWritten: false, rotated: true, version: 'v2' },
    { field: 'back', filePath: 'b.jpg', ok: false, dateWritten: false, rotated: false, error: 'Locked.' },
  ]
  assert.deepEqual(getRemainingRotations({ front: 90, back: 180 }, results), { front: 0, back: 180 })
  assert.deepEqual(getUpdatedImageVersions(results), { 'a.jpg': 'v2' })
})

test('failure messages name the affected image', () => {
  assert.match(describeSaveFailure('IMG_001_a.jpg', ['Locked.']), /IMG_001_a\.jpg\. Locked\./)
  assert.equal(describeUnsavedImages([]), '')
  assert.equal(describeUnsavedImages(['a', 'b', 'c', 'd', 'e']), ' Unsaved changes: a, b, c and 2 more.')
})

test('a quarter-turned image is fitted to the collapsed height and the available width', () => {
  // A 400x300 landscape image turned 90 degrees shows as 300 wide by 400 tall.
  assert.deepEqual(
    getRotatedImageBox({ naturalWidth: 400, naturalHeight: 300, rotation: 90, availableWidth: 1000, targetHeight: 600 }),
    { width: 450, height: 600 },
  )
  assert.deepEqual(
    getRotatedImageBox({ naturalWidth: 400, naturalHeight: 300, rotation: 270, availableWidth: 300, targetHeight: 600 }),
    { width: 300, height: 400 },
  )
  assert.deepEqual(
    getRotatedImageBox({ naturalWidth: 400, naturalHeight: 300, rotation: 90, availableWidth: 600, targetHeight: null }),
    { width: 600, height: 800 },
  )
})

test('points on a rotated image map back to the unrotated image', () => {
  assert.deepEqual(rotatePoint({ x: 1, y: 0 }, 90), { x: -0, y: 1 })
  const layout = { width: 400, height: 300 }
  const visible = { width: 300, height: 400 }
  // After a clockwise quarter turn, the visible top-right corner is the image's top-left corner.
  assert.deepEqual(mapRotatedPointToImage({ x: 300, y: 0 }, visible, layout, 90), { x: 0, y: 0 })
  assert.deepEqual(mapRotatedPointToImage({ x: 0, y: 400 }, visible, layout, 90), { x: 400, y: 300 })
  assert.deepEqual(mapRotatedPointToImage({ x: 10, y: 20 }, layout, layout, 0), { x: 10, y: 20 })
  assert.deepEqual(mapRotatedPointToImage({ x: 0, y: 0 }, layout, layout, 180), { x: 400, y: 300 })
})
