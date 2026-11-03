import { describe, expect, test } from 'bun:test'
import { ApiError, classifyConnection, failureCode } from '../../apps/desktop/src/core'

const health = { status: 'healthy', version: '1.86.0', build: { source: 'npm', version: '1.86.0' } }
const base = { baseUrl: 'http://127.0.0.1:3456', hasApiKey: false }

describe('connection status classification', () => {
  test('ECONNREFUSED (Node and Bun) is stopped', () => {
    const node = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    const bun = Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), { code: 'ConnectionRefused' })
    expect(failureCode(node)).toBe('refused')
    expect(failureCode(bun)).toBe('refused')
    const status = classifyConnection({ ...base, healthError: new ApiError('/health: connection refused', '/health', 'refused') })
    expect(status.kind).toBe('stopped')
    expect(status.message).toContain('127.0.0.1:3456')
    expect(classifyConnection({ ...base, managed: true, healthError: node }).fix).toContain('app-managed copy')
  })
  test('timeouts are stopped with their own message', () => {
    expect(failureCode(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))).toBe('timeout')
    expect(classifyConnection({ ...base, healthError: new ApiError('t', '/health', 'timeout') }).message).toContain('did not answer in time')
  })
  test('401 on telemetry is unauthorized, naming the fix', () => {
    expect(classifyConnection({ ...base, hasApiKey: true, health, dataStatus: 401 })).toEqual({ kind: 'unauthorized', message: 'Meridian on 127.0.0.1:3456 rejected the API key (401).', fix: 'Enter the key in Service → Connection.' })
    expect(classifyConnection({ ...base, health, dataStatus: 401 }).message).toBe('Meridian on 127.0.0.1:3456 requires an API key (401).')
  })
  test('non-Meridian health is not-meridian', () => {
    expect(classifyConnection({ ...base, health: { status: 'ok' } }).kind).toBe('not-meridian')
    expect(classifyConnection({ ...base, healthError: new ApiError('/health: HTTP 404 (not JSON)', '/health', 'http', 404) }).message).toContain('HTTP 404')
  })
  test('a failing endpoint with another verified Meridian is wrong-port', () => {
    const status = classifyConnection({ ...base, baseUrl: 'http://127.0.0.1:3489', alternative: 'http://127.0.0.1:3456', healthError: new ApiError('x', '/health', 'refused') })
    expect(status.kind).toBe('wrong-port')
    expect(status.message).toBe('Nothing is answering on 127.0.0.1:3489, but Meridian is running on 127.0.0.1:3456.')
  })
  test('a readable Meridian is ok', () => {
    expect(classifyConnection({ ...base, health })).toEqual({ kind: 'ok', message: 'Viewing Meridian 1.86.0 on 127.0.0.1:3456.', fix: '' })
  })
})
