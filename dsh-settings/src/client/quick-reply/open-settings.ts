/**
 * 打开宿主的设置面板并直接跳到某一页。
 *
 * 宿主没有给插件公开这个动作（2026-10-08，0.2.0-rc.2）：设置外壳（ui-settings-general）的状态里有
 * `openSection(id)`，但只交给了新手引导步骤。这里经公开的插槽登记表（`ctx.slots.entries`）读到外壳
 * 登记在 `sidebar.settings` 上的状态句柄，调它自己的 `openSection`。
 *
 * 只认「共享句柄」：外壳把 `create` 改成永远返回同一个实例，界面渲染的也是这一个。要是哪天换成每次
 * 新建，调用落在一个没人显示的新实例上，什么都不会发生，所以先连调两次 `create` 确认是同一个对象，
 * 不是就不调、返回 false，由调用方提示用户从设置侧栏进入。
 * 宿主哪天公开了「打开设置到某页」，换成那个接口，删掉这个文件。
 */

interface SlotEntries {
  entries(key: string): readonly { readonly store?: unknown }[]
}

interface StoreHandle {
  create(): unknown
}

/** @returns 是否已经让设置面板打开到这一页。 */
export function openSettingsSection(slots: SlotEntries, sectionId: string): boolean {
  let entries: readonly { readonly store?: unknown }[]
  try {
    entries = slots.entries('sidebar.settings')
  } catch {
    return false
  }
  for (const entry of entries) {
    const handle = entry.store as Partial<StoreHandle> | undefined
    if (handle === undefined || typeof handle.create !== 'function') continue
    let instance: unknown
    try {
      instance = handle.create()
      if (instance === undefined || instance !== handle.create()) continue
    } catch {
      continue
    }
    const open = (instance as { actions?: Record<string, unknown> }).actions?.['openSection']
    if (typeof open !== 'function') continue
    ;(open as (id: string) => void)(sectionId)
    return true
  }
  return false
}
