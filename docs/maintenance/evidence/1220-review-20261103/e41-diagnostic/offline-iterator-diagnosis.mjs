// Offline control only. Imports pure idle guard and copies frozen observer verbatim.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root = process.env.E2E_MERIDIAN_ROOT
assert(root)
const here = dirname(fileURLToPath(import.meta.url))
const helperPath = join(here, 'helper.mjs')
const helper = readFileSync(helperPath, 'utf8')
const sha = text => createHash('sha256').update(text).digest('hex')
assert.equal(sha(helper), '8514c16b9dd4d93fe3c4425d24eb1eeffe4b60bbfee67b525af4749ef970899c')
const {guardUpstreamIdle} = await import(pathToFileURL(join(root, 'src/proxy/streamIdleGuard.ts')).href)
function observeIterator(iterator, onValue, onDone = () => {}, onError = () => {}) {
  let proxy
  proxy = new Proxy(iterator, { get(target, key) {
    if (key === Symbol.asyncIterator) return () => proxy
    const value = Reflect.get(target, key, target)
    if (["next", "return", "throw"].includes(key) && typeof value === "function") return async (...args) => {
      try {
        const step = await Reflect.apply(value, target, args)
        if (!step.done) onValue(step.value)
        else onDone(key)
        return step
      } catch (error) { onError(); throw error }
    }
    return typeof value === "function" ? value.bind(target) : value
  } })
  return proxy
}
const sentinel = new Error('OFFLINE-CLEANUP-SENTINEL')
function distinctQuery() {
  const calls = []
  const inner = {
    index: 0,
    [Symbol.asyncIterator]() { calls.push('inner.asyncIterator'); return this },
    async next() { calls.push('inner.next'); return this.index++ === 0 ? {done:false,value:{type:'result',subtype:'error_max_turns'}} : {done:true} },
    async return(value) { calls.push('inner.return'); return {done:true,value} },
    async throw(error) { calls.push('inner.throw'); throw error },
  }
  const query = {
    [Symbol.asyncIterator]() { calls.push('query.asyncIterator'); return inner },
    next(...args) { calls.push('query.next'); return inner.next(...args) },
    async return(value) { calls.push('query.return'); await this.cleanup(); return inner.return(value) },
    async throw(error) { calls.push('query.throw'); await this.cleanup(); return inner.throw(error) },
    async cleanup() { calls.push('query.cleanup'); throw sentinel },
    close() { calls.push('query.close') },
  }
  return {query,inner,calls}
}
async function consumeOne(source) { for await (const value of source) { assert.equal(value.type,'result'); break } }
const raw = distinctQuery()
await consumeOne(raw.query)
assert.deepEqual(raw.calls, ['query.asyncIterator','inner.next','inner.return'])
let stopped = false
const changed = distinctQuery()
const changedProxy = observeIterator(changed.query, ()=>{}, ()=>{}, ()=>{stopped=true})
assert.notEqual(changedProxy[Symbol.asyncIterator](), changed.inner)
await assert.rejects(consumeOne(changedProxy), error=>error===sentinel)
assert.equal(stopped,true)
assert.deepEqual(changed.calls,['query.next','inner.next','query.return','query.cleanup'])
let guardStopped=false, returnDone=0
const guarded = distinctQuery()
await consumeOne(guardUpstreamIdle(observeIterator(guarded.query, ()=>{}, ()=>{returnDone++}, ()=>{guardStopped=true}),10000))
await new Promise(resolve=>setImmediate(resolve))
assert.equal(guardStopped,true)
assert.equal(returnDone,0)
assert.deepEqual(guarded.calls,['query.next','inner.next','query.return','query.cleanup'])
// Separate classification defect: a callback failure and a native next failure
// call the same argument-free onError callback. Neither is distinguishable in
// the frozen helper's report.
const failures=[]
const callback = observeIterator({async next(){return {done:false,value:{}}}},()=>{throw sentinel},()=>{},(...args)=>failures.push({kind:'callback',args:args.length}))
await assert.rejects(callback.next(),error=>error===sentinel)
const native = observeIterator({async next(){throw sentinel}},()=>{},()=>{},(...args)=>failures.push({kind:'native',args:args.length}))
await assert.rejects(native.next(),error=>error===sentinel)
assert.deepEqual(failures,[{kind:'callback',args:0},{kind:'native',args:0}])
// Diagnostic control only, not a modification of the escrowed helper. Respect
// the actual distinct iterator while keeping Query methods bound to Query.
function preserveDistinct(query,onError){
  return new Proxy(query,{get(target,key){
    if(key===Symbol.asyncIterator)return ()=>observeIterator(target[Symbol.asyncIterator](),()=>{},()=>{},onError)
    const value=Reflect.get(target,key,target)
    return typeof value==='function'?value.bind(target):value
  }})
}
const faithful=distinctQuery();let faithfulStopped=false
await consumeOne(guardUpstreamIdle(preserveDistinct(faithful.query,()=>{faithfulStopped=true}),10000))
await new Promise(resolve=>setImmediate(resolve))
assert.equal(faithfulStopped,false)
assert.deepEqual(faithful.calls,['query.asyncIterator','inner.next','inner.return'])
const report={
 result:'PASS',scope:'offline distinct-iterator diagnostic only',modelCalls:0,credentialReads:0,
 frozenHelperSha256:sha(helper),
 rawDistinctIterator:raw.calls,frozenWrapper:changed.calls,
 frozenWrapperRejectsSyntheticCleanupSentinel:true,
 realIdleGuardSwallowsSyntheticReturnRejectionButObserverStopPersists:guardStopped,
 distinctIteratorPreservedControl:faithful.calls,
 distinctIteratorPreservedControlStopped:faithfulStopped,
 onErrorLosesMethodAndPhase:failures,
 originalRunExactRejectionCauseEstablished:false,
 limitations:'Synthetic cleanup rejection discriminates custody change only. Original live error/phase/method was not retained, so its exact cause remains unknown.',
 completedAt:new Date().toISOString(),bun:Bun.version,platform:`${process.platform}/${process.arch}`,
}
assert.equal(sha(readFileSync(helperPath,'utf8')),report.frozenHelperSha256)
writeFileSync(join(here,'instrumented-e41-offline-iterator-diagnosis.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600})
console.log(JSON.stringify(report))
