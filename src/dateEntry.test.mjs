import assert from 'node:assert/strict'
import test from 'node:test'
import {
  completeDateSegment,
  getFullYearForTwoDigitYear,
  parseDateSegments,
  toIsoDate,
} from './dateEntry.ts'

test('two-digit years use the current year as the century cutoff', () => {
  const examples = [[26, 2026], [27, 1927], [0, 2000], [99, 1999], [67, 1967], [8, 2008], [88, 1988]]
  for (const [code, expected] of examples) {
    assert.equal(getFullYearForTwoDigitYear(code, 2026), expected)
  }
})

test('consecutive two-digit month, day, and year entries produce a full date', () => {
  assert.equal(toIsoDate({ month: '01', day: '01', year: '88' }), '1988-01-01')
  assert.equal(toIsoDate({ month: '01', day: '01', year: '00' }), '2000-01-01')
})

test('Tab completion pads a one-digit month or day', () => {
  assert.equal(completeDateSegment('1', 'month'), '01')
  assert.equal(completeDateSegment('5', 'day'), '05')
  assert.equal(toIsoDate({ month: '01', day: '05', year: '08' }), '2008-01-05')
})

test('loaded dates and four-digit years remain unchanged', () => {
  assert.deepEqual(parseDateSegments('1988-01-01'), { month: '01', day: '01', year: '1988' })
  assert.equal(toIsoDate({ month: '11', day: '05', year: '1988' }), '1988-11-05')
})

test('invalid or incomplete dates cannot be saved', () => {
  assert.equal(toIsoDate({ month: '02', day: '29', year: '1900' }), null)
  assert.equal(toIsoDate({ month: '02', day: '29', year: '2000' }), '2000-02-29')
  assert.equal(toIsoDate({ month: '13', day: '01', year: '88' }), null)
  assert.equal(toIsoDate({ month: '01', day: '32', year: '88' }), null)
  assert.equal(toIsoDate({ month: '1', day: '05', year: '88' }), null)
  assert.equal(toIsoDate({ month: '01', day: '01', year: '' }), null)
})
