import { describe, expect, test } from 'bun:test'
import { IncidentDetector, endpoint, version, incidents, isMeridianHealth } from '../../apps/desktop/src/core'

describe('desktop incident observation', () => {
  test('recognizes auth-degraded health from published and development installations', () => {
    for (const source of ['npm', 'local', 'dev']) expect(isMeridianHealth({ status: 'degraded', version: '1.71.1', build: { version: '1.71.1', source }, error: 'Could not verify auth status' })).toBe(true)
    expect(isMeridianHealth({ version: '1.71.1', status: 'healthy' })).toBe(false)
  })
  test('opening the app seeds existing history without replaying old system notifications', () => {
    const detector = new IncidentDetector()
    const old = { requestId:'old', status:500, timestamp:1 }
    expect(detector.collect([old], null, 2)).toEqual([])
    expect(detector.collect([old, { requestId:'new', status:500, timestamp:3 }], null, 4).map(item => item.requestId)).toEqual(['new'])
    expect(detector.collect([old, { requestId:'new', status:500 }], null, 5)).toEqual([])
  })
  test('cache misses follow account/model continuations even when SDK fork IDs change', () => {
    const detector = new IncidentDetector(); detector.collect([], null)
    const request = (id: string, profile = 'work') => ({ requestId:id, sdkSessionId:id, profileId:profile, model:'sonnet', isResume:true, cacheHitRate:0, timestamp:Number(id) })
    expect(detector.collect([request('1'),request('2','personal'),request('3')],null)).toEqual([])
    expect(detector.collect([request('4')],null).map(item => item.title)).toEqual(['Repeated cache misses'])
  })
  test('stale or failed quota reads do not trigger thresholds; fresh thresholds notify once', () => {
    const detector = new IncidentDetector(); detector.collect([], null, 100000)
    const quota = (used:number, fetchedAt=100000, error?:string) => ({ profiles:[{id:'work', fetchedAt, error, windows:[{type:'five_hour',utilization:used,resetsAt:200000}]}] })
    expect(detector.collect([], quota(.96,1),100000)).toEqual([])
    expect(detector.collect([], quota(.96,100000,'no_token'),100000)).toEqual([])
    expect(detector.collect([], quota(.81),100000)).toHaveLength(1)
    expect(detector.collect([], quota(.82),100001)).toEqual([])
    expect(detector.collect([], quota(.96),100002)).toHaveLength(1)
  })
  test('invalid persisted incidents and executable version strings are rejected', () => {
    expect(incidents([null, {}, {id:'x'}])).toEqual([])
    for (const invalid of ['latest','../1.0.0','1.0.0;echo hello','https://example.com/pkg']) expect(() => version(invalid)).toThrow()
    for (const invalid of ['https://example.com','http://user:secret@localhost:3456','http://127.0.0.1:3456/other']) expect(() => endpoint(invalid)).toThrow()
  })
})
