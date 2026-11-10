import { PANEL_PREVIEW_PATH, type PanelPreview, type PanelPreviewRequest } from '../panel-types.ts'

const MAX_BYTES = 96 * 1024

export async function loadPreview(request: PanelPreviewRequest, signal: AbortSignal): Promise<PanelPreview> {
  const query = new URLSearchParams({ session: request.session, name: request.name, epoch: String(request.epoch) })
  const response = await fetch(`${PANEL_PREVIEW_PATH}?${query}`, { cache: 'no-store', signal })
  if (!response.ok) throw new Error(`暂时无法读取（${response.status}），请重试。`)
  if (!response.body) throw new Error('没有收到预览内容。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_BYTES) {
        await reader.cancel()
        throw new Error('预览超过大小限制，已停止接收。')
      }
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
  } finally { reader.releaseLock() }
  const value: PanelPreview = JSON.parse(text)
  if (value.session !== request.session || value.name !== request.name || value.epoch !== request.epoch) {
    throw new Error('内核状态已改变，请重新读取。')
  }
  return value
}
