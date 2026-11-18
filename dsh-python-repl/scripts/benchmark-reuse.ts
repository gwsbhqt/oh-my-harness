import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'

/** One immutable source for both turns. Count actual completed downloads at the source. */
export async function serveBenchmarkLogs(body: string) {
  let downloads = 0
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/logs.json') {
      response.writeHead(404).end()
      return
    }
    response.once('finish', () => { downloads++ })
    response.writeHead(200, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store',
    }).end(body)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/logs.json`,
    downloads: () => downloads,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

export function reuseTask() {
  const services = ['catalog', 'checkout', 'search']
  const failures = new Set([0, 1, 5, 9, 10])
  const rows = Array.from({ length: 600 }, (_, index) => ({
    seq: index + 1, service: services[index % services.length]!, status: failures.has(index % 30) ? 503 : 200,
  }))
  return {
    id: 'reuse-600', family: 'reuse', rows: rows.length, files: {},
    prompt: '从本机的 {sourceUrl} 读取一批虚构的 JSON 日志。统计总行数和 status >= 500 的行数，写到当前目录的 answer.json，格式为 {"samples":整数,"errors":整数}。这批数据稍后还要用，请保留需要的中间结果。只使用该地址和当前工作目录，最后简短说明已完成。',
    expected: { samples: 600, errors: 100 },
    reuse: {
      body: JSON.stringify(rows),
      prompt: '接着分析刚才的同一批日志。找出 status >= 500 次数最多的所有服务。将结果写到 followup.json，格式为 {"leaders":[按字母升序排列的服务名],"errorsEach":每个并列服务的错误数}。保留第一问的 answer.json，最后简短说明已完成。',
      expected: { leaders: ['catalog', 'checkout'], errorsEach: 40 },
    },
  }
}
