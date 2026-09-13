// Disposable proxy subprocess for actual process-restart E2E coverage.
const { startProxyServer } = await import(process.env.E2E_PROXY_MODULE)
const proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true })
process.send({ port: proxy.server.address().port })
let closing = false
async function close() {
  if (closing) return
  closing = true
  await proxy.close()
  process.exit(0)
}
process.on('SIGTERM', () => close().catch(error => { console.error(error); process.exit(1) }))
process.on('SIGINT', () => close().catch(error => { console.error(error); process.exit(1) }))
