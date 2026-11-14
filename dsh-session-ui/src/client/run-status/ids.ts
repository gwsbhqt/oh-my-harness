/** 宿主界面里本插件依赖的位置（`test/host-shape.test.ts` 会对着宿主代码核对）。 */
/** 输入框上方的列表插槽：只放一个不可见的锚点，用来找到同一个会话。 */
export const DOCK_SLOT = 'conversation.input.dock'
/** 一个会话的对话区和输入框的共同外层。 */
export const SESSION_ROOT = '[data-conversation-session]'
/** 宿主「深度求索中，用时 N」那一行。 */
export const RUNNING_ROW = '[data-chat-running]'
/** 那一行里放图标和文字的内容区：宿主按「读屏文字、分隔线、内容区」的顺序放三个 span，取最后一个。 */
export const RUNNING_CONTENT = ':scope > span:last-of-type'
/**
 * 输入框下方的统计插槽和宿主自带「会话统计」卡的 id、order。同 id、同 order、更低的 priority 才顶替自带卡：
 * 宿主只给动态插件自动分配优先级，本插件走 profile 静态加载，不写 priority 就和自带卡同为 0，
 * 宿主直接抛「already has an entry with id "activity" at priority 0」，整个网页半跟着失效（2026-11-09 踩过）。
 */
export const STATS_SLOT = 'conversation.composer.dock'
export const STATS_ENTRY_ID = 'activity'
export const STATS_ENTRY_ORDER = 0
export const STATS_ENTRY_PRIORITY = -1
/** 宿主半登记的整段会话统计投影。 */
export { TOTALS_KEY } from '../../host/run-status/totals.ts'
