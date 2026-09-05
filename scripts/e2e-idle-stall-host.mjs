// Fault injection holds actual SDK iterator output; recovery delegates unchanged.
import { spyOn } from 'bun:test'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendFileSync, existsSync } from 'node:fs'
const require = createRequire(fileURLToPath(process.env.E2E_PROXY_MODULE))
const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
const actual = sdk.query
const record = event => appendFileSync(process.env.E2E_IDLE_LOG, JSON.stringify(event)+'\n')
spyOn(sdk, 'query').mockImplementation(input => {
  const stalled = existsSync(process.env.E2E_IDLE_FLAG) && (input.options.allowedTools?.length ?? 0) > 0
  const inner = actual(input)
  record({event:'query',stalled})
  if (!stalled) return inner
  let started = false
  const iterator = inner[Symbol.asyncIterator]()
  return new Proxy(inner, {get(target,key) {
    if (key === Symbol.asyncIterator) return () => ({
      async next() {
        if (!started) {
          started = true
          const first = await iterator.next()
          record({event:'real-startup',type:first.value?.type,done:first.done ?? false})
        }
        return new Promise(() => {})
      },
      async return() {
        inner.close()
        record({event:'closed-stalled-query'})
        return {done:true,value:undefined}
      },
    })
    const value = Reflect.get(target,key,target)
    return typeof value === 'function' ? value.bind(target) : value
  }})
})
const { startProxyServer } = await import(process.env.E2E_PROXY_MODULE)
const proxy = await startProxyServer({ port:0,host:'127.0.0.1',silent:true })
process.send({port:proxy.server.address().port})
process.on('SIGTERM',async()=>{try {await proxy.close();process.exit(0)} catch(error){console.error(error);process.exit(1)}})
