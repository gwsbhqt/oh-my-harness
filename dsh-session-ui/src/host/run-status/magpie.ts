import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
/** 网关钥匙随请求发出：本机才允许明文 http，别的机器上的网关必须走 https。 */
export function gatewayUrl(base: string, endpoint: 'trace'): URL {
  const url = new URL(base.replace(/\/$/, '') + '/magpie/' + endpoint)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || (loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('magpie 地址只能是本机，或 https 的网关')
  }
  return url
}

/** agent:false 直接连接，避免宿主的全局 fetch 代理接管。 */
export function readGatewayJson(url: URL, key: string | undefined): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers = { accept: 'application/json', ...key ? { authorization: `Bearer ${key}` } : {} }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers, agent: false, timeout: 10_000 }, (response) => {
      const chunks: Buffer[] = []
      let length = 0
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 8 * 1024 * 1024) request.destroy(new Error('magpie 请求记录太大'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) return reject(new Error(`magpie 返回 HTTP ${status}${status === 401 || status === 403 ? '，网关钥匙不对' : ''}`))
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('magpie 返回的不是 JSON'))
        }
      })
    })
    request.once('timeout', () => request.destroy(new Error('读 magpie 超时')))
    request.once('error', reject)
    request.end()
  })
}
