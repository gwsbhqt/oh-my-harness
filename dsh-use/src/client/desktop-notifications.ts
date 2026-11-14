const PATH = '/api/dsh-use.desktop-notification'

export function receiveDesktopNotifications(): () => void {
  if (location.protocol !== 'dsh-app:' || location.hostname !== 'app' || typeof EventSource === 'undefined') return () => {}
  const source = new EventSource(`${PATH}-stream`)
  const active = new Set<Notification>()
  source.onmessage = (event) => {
    void (async () => {
      let id: string | undefined
      const acknowledge = async (status: 'shown' | 'failed', error?: string): Promise<void> => {
        if (id === undefined) return
        await fetch(`${PATH}-ack`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, status, ...(error === undefined ? {} : { error }) }),
        })
      }
      try {
        const data: unknown = JSON.parse(event.data)
        if (typeof data !== 'object' || data === null) return
        const message = data as Record<string, unknown>
        if (typeof message.id !== 'string' || typeof message.title !== 'string' || typeof message.body !== 'string') return
        id = message.id
        if (typeof Notification === 'undefined') throw new Error('桌面窗口不支持系统通知')
        const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
        if (permission !== 'granted') throw new Error('DSH 没有系统通知权限')
        const notification = new Notification(message.title, { body: message.body, silent: true })
        active.add(notification)
        notification.onshow = () => { void acknowledge('shown').catch(() => {}) }
        notification.onerror = () => { active.delete(notification); void acknowledge('failed', 'macOS 没有接受系统通知').catch(() => {}) }
        notification.onclose = () => { active.delete(notification) }
      } catch (error) {
        await acknowledge('failed', error instanceof Error ? error.message : String(error)).catch(() => {})
      }
    })()
  }
  return () => { source.close(); active.clear() }
}
