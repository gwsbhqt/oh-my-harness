/**
 * run-status 用哪台 magpie 网关：本机装了 Magpie 就用本机，否则用 session-ui 显式配的远程地址；
 * 都没有就返回 undefined，网页半不显示分段用时那一区，其余状态和统计照常。
 *
 * 公开代码里不写死任何私人域名或钥匙：远程地址和钥匙引用名都从 session-ui 的配置注入。
 *
 * @module dsh-session-ui/host/run-status/magpie-gateway
 */
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** 本机网关地址：Magpie 默认端口。 */
export const LOCAL_MAGPIE_BASE_URL = 'http://127.0.0.1:3425/v1'
/** 本机网关钥匙的凭据引用名（引用名，不是钥匙本身）。 */
export const LOCAL_MAGPIE_KEY_REF = 'MAGPIE_GATEWAY_KEY'

export interface ResolvedMagpieGateway {
  magpieBaseUrl: string
  magpieKeyRef: string
}

export interface MagpieGatewayInput {
  /** session-ui 配置里显式填的远程地址，空表示没配。 */
  baseUrl: string
  /** session-ui 配置里显式填的钥匙引用名，空表示没配。 */
  keyRef: string
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 本机是否装了 Magpie（有 magpie 可执行文件）。装了才用本机网关。 */
export function hasLocalMagpie(): boolean {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && executable(join(dir, 'magpie'))) return true
  }
  return [
    join(homedir(), '.local', 'bin', 'magpie'),
    '/opt/homebrew/bin/magpie',
    '/usr/local/bin/magpie',
    '/Applications/magpie.app/Contents/MacOS/magpie',
  ].some(executable)
}

function isLoopback(base: string): boolean {
  try {
    const host = new URL(base).hostname
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * 算出这次该用的网关。本机装了 Magpie 时用本机地址和本机钥匙（忽略远程配置）；没装时用显式配置的
 * 远程地址和引用名；都没有返回 undefined。
 */
export function resolveMagpieGateway(
  input: MagpieGatewayInput,
  localMagpie: () => boolean = hasLocalMagpie,
): ResolvedMagpieGateway | undefined {
  if (localMagpie()) return { magpieBaseUrl: LOCAL_MAGPIE_BASE_URL, magpieKeyRef: LOCAL_MAGPIE_KEY_REF }
  const configuredBase = input.baseUrl.trim()
  if (configuredBase === '') return undefined
  const url = new URL(configuredBase)
  if (!(url.protocol === 'https:' || (isLoopback(configuredBase) && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Magpie 地址只能是本机 HTTP(S)，或 HTTPS 网关，不能带账号、查询串或片段')
  }
  const key = input.keyRef.trim() || LOCAL_MAGPIE_KEY_REF
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('网关钥匙必须写凭据引用名')
  return { magpieBaseUrl: configuredBase, magpieKeyRef: key }
}
