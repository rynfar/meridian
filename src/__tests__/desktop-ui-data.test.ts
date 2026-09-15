import { describe, expect, test } from 'bun:test'
import { filterLogs, filterRequests } from '../../apps/desktop/src/uiData'

describe('desktop request exploration', () => {
  const data = [
    { requestId: 'new', timestamp: 1, adapter: 'openai', status: 200, lineageType: 'new', cacheHitRate: 0 },
    { requestId: 'missing', timestamp: 3, adapter: 'pi', status: 500, lineageType: 'continuation' },
    { requestId: 'low', timestamp: 2, profileId: 'work', status: 200, lineageType: 'continuation', cacheHitRate: .05 },
    { requestId: 'cached', timestamp: 4, adapter: 'pi', status: 200, lineageType: 'continuation', cacheHitRate: .9 },
  ]
  test('low-cache view excludes new conversations and absent cache measurements', () => {
    expect(filterRequests(data, '', 'low-cache').map(row => row.requestId)).toEqual(['low'])
  })
  test('combines metadata search with status filters and sorts newest first', () => {
    expect(filterRequests(data, ' PI ', 'errors').map(row => row.requestId)).toEqual(['missing'])
    expect(filterRequests(data, 'pi', 'all').map(row => row.requestId)).toEqual(['cached', 'missing'])
    expect(data[0]?.requestId).toBe('new')
  })
  test('search does not match arbitrary hidden content, and empty data stays empty', () => {
    expect(filterRequests([{requestId:'id', payload:'private text'}], 'private', 'all')).toEqual([])
    expect(filterRequests(null, '', 'all')).toEqual([])
  })
})

test('diagnostic search retains recent matches and orders newest first', () => {
  const data = Array.from({length: 500}, (_, timestamp) => ({timestamp, category: 'session', message: `event ${timestamp}`})).reverse()
  expect(filterLogs(data, '').length).toBe(500)
  expect(filterLogs(data, ' EVENT 49 ').map(row => row.timestamp)).toEqual([499, 498, 497, 496, 495, 494, 493, 492, 491, 490, 49])
  expect(data[0]?.timestamp).toBe(499)
})
