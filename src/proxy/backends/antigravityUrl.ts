import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { AntigravityError } from './antigravityProtocol'
const denied = new BlockList()
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) denied.addSubnet(address, prefix, 'ipv4')
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) denied.addSubnet(address, prefix, 'ipv6')
export function publicAgAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !denied.check(address, 'ipv4') : family === 6 && global6.check(address, 'ipv6') && !denied.check(address, 'ipv6')
}

/** Resolve and pin every hop. Never send account/API credentials to attachment hosts. */
export async function fetchAgImage(source: string, signal?: AbortSignal, redirects = 0): Promise<{ data: string; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }> {
  const url = new URL(source)
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password) throw new AntigravityError('URL images require public HTTPS on port 443 without credentials')
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  if (!addresses.length || addresses.some(entry => !publicAgAddress(entry.address))) throw new AntigravityError('URL image resolved to a non-public address')
  const address = addresses[0]!
  const result = await new Promise<{ location?: string; bytes?: Buffer; mime?: string }>((resolve, reject) => {
    const req = request({ hostname: address.address, port: 443, servername: url.hostname, path: url.pathname + url.search, headers: { host: url.host, accept: 'image/png,image/jpeg,image/gif,image/webp' }, agent: false, signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]) }, response => {
      if (response.statusCode && [301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy()
        if (!response.headers.location) reject(new AntigravityError('Image redirect omitted Location'))
        else resolve({ location: response.headers.location })
        return
      }
      if (response.statusCode !== 200) { response.destroy(); reject(new AntigravityError(`Image host returned HTTP ${response.statusCode}`)); return }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > 6 * 1024 * 1024) { const error = new AntigravityError('URL image exceeds 6 MiB', 413); response.destroy(error); reject(error); return }
        chunks.push(Buffer.from(chunk))
      })
      response.on('error', reject)
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks), mime: response.headers['content-type']?.split(';')[0]?.trim() }))
    })
    req.on('error', reject); req.end()
  })
  if (result.location) {
    if (redirects >= 3) throw new AntigravityError('URL image exceeded three redirects')
    return fetchAgImage(new URL(result.location, url).href, signal, redirects + 1)
  }
  const mime = result.mime
  if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/gif' && mime !== 'image/webp') throw new AntigravityError('URL did not return a supported image media type')
  return { data: result.bytes!.toString('base64'), media_type: mime }
}
