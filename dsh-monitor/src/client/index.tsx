import { createCardController } from '../../../tooling/runtime/card.mjs'
/**
 * dsh-monitor 设置卡片 浏览器半：内置插件页（插件管理）里的配置卡片。
 *
 * 0.1.7 **没有**「从 volatile 字段自动生成设置页」——volatile 只让宿主侧
 * SettingsForms.describe() 把这个命名空间端给浏览器半，GUI 入口要各家
 * client 半自己注册进插件页的 `plugins.item` 槽位，表单用 ui-primitives 的
 * 共享套件（SettingsFormModel / SettingsForm / SettingsValueField）。
 * 官方参照：dsh-client-ui-settings-agent-loop。
 *
 * `configForms.whileServed` 做门：宿主没加载本插件时卡片整个不出现。
 *
 * @module dsh-monitor/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 纯类型导入（会被擦除，不进 bundle）：
//   ctx.configForms ← ui-settings；ctx.locale ← client-locale；
//   'plugins.item' 槽位契约 ← plugin-manager 的 slot-contract。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import {
  SettingsForm,
  SettingsValueField,
  SettingsFormModel,
  settingsNumberField,
  settingsTextField,
  type SettingsFieldSpec,
  type SettingsFieldState,
  type SettingsFormShell,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

/** 本卡片自己的文案命名空间。 */
const NS = 'settings.monitor'
/** 宿主侧配置命名空间 = 插件 id。 */
const PLUGIN_NS = 'monitor'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.monitor': LocaleKey
  }
}

type LocaleKey =   | 'title'
  | 'description'
  | 'overridden'
  | 'reset'
  | 'readOnly'
  | 'unavailable'
  | 'save'
  | 'saving'
  | 'saveFailed'
  | 'invalidNumber'
  | 'deliveryLabel'
  | 'deliveryHint'
  | 'deliveryInvalid'
  | 'coalesceMsLabel'
  | 'coalesceMsHint'
  | 'maxLinesPerNoticeLabel'
  | 'maxLinesPerNoticeHint'
  | 'maxBytesPerNoticeLabel'
  | 'maxBytesPerNoticeHint'
  | 'maxLineBytesLabel'
  | 'maxLineBytesHint'
  | 'historyLinesLabel'
  | 'historyLinesHint'
  | 'stderrTailLinesLabel'
  | 'stderrTailLinesHint'
  | 'defaultTimeoutMsLabel'
  | 'defaultTimeoutMsHint'
  | 'maxTimeoutMsLabel'
  | 'maxTimeoutMsHint'
  | 'graceMsLabel'
  | 'graceMsHint'
  | 'restartLabel'
  | 'restartHint'
  | 'restartInvalid'
  | 'restartDelayMsLabel'
  | 'restartDelayMsHint'
  | 'restartMaxDelayMsLabel'
  | 'restartMaxDelayMsHint'
  | 'restartLimitLabel'
  | 'restartLimitHint'
  | 'restartResetMsLabel'
  | 'restartResetMsHint'
  | 'logDirLabel'
  | 'logDirHint'
  | 'logDirInvalid'

const en: Record<LocaleKey, string> = {
  title: "Job monitor",
  description: "Streams every output line of a long-running command into the conversation as it appears.",
  overridden: "Overridden",
  reset: "Reset to default",
  readOnly: "This deployment stores settings read-only.",
  unavailable: "This plugin is not loaded, so it cannot be configured right now.",
  save: "Save",
  saving: "Saving…",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
  invalidNumber: "Enter a number, or leave blank to use the default.",
  deliveryLabel: "Delivery",
  deliveryHint: "steer, inject or followup.",
  deliveryInvalid: "Only steer, inject or followup.",
  coalesceMsLabel: "Coalesce window (ms)",
  coalesceMsHint: "Notices inside this window merge into one.",
  maxLinesPerNoticeLabel: "Max lines per notice",
  maxLinesPerNoticeHint: "Output lines one notice may carry.",
  maxBytesPerNoticeLabel: "Max bytes per notice",
  maxBytesPerNoticeHint: "Bytes one notice may carry.",
  maxLineBytesLabel: "Max line bytes",
  maxLineBytesHint: "Bytes kept of one output line.",
  historyLinesLabel: "History lines",
  historyLinesHint: "Output lines kept per job.",
  stderrTailLinesLabel: "Stderr tail lines",
  stderrTailLinesHint: "Stderr tail lines attached to a failure notice.",
  defaultTimeoutMsLabel: "Default timeout (ms)",
  defaultTimeoutMsHint: "Timeout when the job declares none (0 = no limit).",
  maxTimeoutMsLabel: "Max timeout (ms)",
  maxTimeoutMsHint: "Upper bound of any job timeout.",
  graceMsLabel: "Grace (ms)",
  graceMsHint: "Grace period after timeout before kill.",
  restartLabel: "Restart policy",
  restartHint: "never, on-failure or always.",
  restartInvalid: "Only never, on-failure or always.",
  restartDelayMsLabel: "Restart delay (ms)",
  restartDelayMsHint: "Delay before the first restart.",
  restartMaxDelayMsLabel: "Restart max delay (ms)",
  restartMaxDelayMsHint: "Upper bound of the backoff delay.",
  restartLimitLabel: "Restart limit",
  restartLimitHint: "Restarts allowed (0 = unlimited).",
  restartResetMsLabel: "Restart reset (ms)",
  restartResetMsHint: "Stable run time that resets the restart counter.",
  logDirLabel: "Log directory",
  logDirHint: "Where job logs are written; blank uses the default.",
  logDirInvalid: "Invalid value.",
}

const zh: Record<LocaleKey, string> = {
  title: "任务监视",
  description: "把长驻命令的每一行输出实时送进会话，盯构建、盯部署用。",
  overridden: "已覆盖",
  reset: "恢复默认",
  readOnly: "本部署的设置为只读。",
  unavailable: "该插件当前未加载，暂时无法配置。",
  save: "保存",
  saving: "保存中…",
  saveFailed: "本部署没有接受这些值，已保留供你修改。",
  invalidNumber: "请填数字；留空表示使用默认值。",
  deliveryLabel: "投递方式",
  deliveryHint: "steer、inject 或 followup。",
  deliveryInvalid: "只能填 steer、inject 或 followup。",
  coalesceMsLabel: "合并窗口毫秒",
  coalesceMsHint: "这个窗口内的通知合并成一条。",
  maxLinesPerNoticeLabel: "单条通知最大行数",
  maxLinesPerNoticeHint: "一条通知最多带多少行输出。",
  maxBytesPerNoticeLabel: "单条通知最大字节",
  maxBytesPerNoticeHint: "一条通知最多带多少字节。",
  maxLineBytesLabel: "单行最大字节",
  maxLineBytesHint: "一行输出最多保留多少字节。",
  historyLinesLabel: "历史保留行数",
  historyLinesHint: "每个任务保留的输出行数。",
  stderrTailLinesLabel: "stderr 保留行数",
  stderrTailLinesHint: "失败通知里附带多少行 stderr 尾巴。",
  defaultTimeoutMsLabel: "默认超时毫秒",
  defaultTimeoutMsHint: "任务没声明时的超时（0 = 不限）。",
  maxTimeoutMsLabel: "超时上限毫秒",
  maxTimeoutMsHint: "任何任务超时的上限。",
  graceMsLabel: "宽限毫秒",
  graceMsHint: "超时后多久强杀。",
  restartLabel: "重启策略",
  restartHint: "never、on-failure 或 always。",
  restartInvalid: "只能填 never、on-failure 或 always。",
  restartDelayMsLabel: "重启延迟毫秒",
  restartDelayMsHint: "第一次重启前等多久。",
  restartMaxDelayMsLabel: "重启延迟上限毫秒",
  restartMaxDelayMsHint: "退避延迟的上限。",
  restartLimitLabel: "重启次数上限",
  restartLimitHint: "最多重启几次（0 = 不限）。",
  restartResetMsLabel: "重启计数重置毫秒",
  restartResetMsHint: "稳定跑了多久后重启计数清零。",
  logDirLabel: "日志目录",
  logDirHint: "任务日志写到哪个目录；留空用默认。",
  logDirInvalid: "无效的值。",
}

function formLabels(t: Translate<LocaleKey>) {
  return {
    unavailable: t('unavailable'),
    readOnly: t('readOnly'),
    saveFailed: t('saveFailed'),
    save: t('save'),
    saving: t('saving'),
  }
}

/** delivery：只接受 steer / inject / followup，空串清除回默认。 */
const deliveryField: SettingsFieldSpec = {
  field: 'delivery',
  format: (value) => (typeof value === 'string' ? value : ''),
  parse: (text) => {
    const trimmed = text.trim()
    if (!trimmed) return { kind: 'clear' }
    if (!['steer', 'inject', 'followup'].includes(trimmed)) return undefined
    return { kind: 'set', value: trimmed }
  },
}

/** restart：只接受 never / on-failure / always，空串清除回默认。 */
const restartField: SettingsFieldSpec = {
  field: 'restart',
  format: (value) => (typeof value === 'string' ? value : ''),
  parse: (text) => {
    const trimmed = text.trim()
    if (!trimmed) return { kind: 'clear' }
    if (!['never', 'on-failure', 'always'].includes(trimmed)) return undefined
    return { kind: 'set', value: trimmed }
  },
}

const SPECS: SettingsFieldSpec[] = [
  deliveryField,
  settingsNumberField('coalesceMs'),
  settingsNumberField('maxLinesPerNotice'),
  settingsNumberField('maxBytesPerNotice'),
  settingsNumberField('maxLineBytes'),
  settingsNumberField('historyLines'),
  settingsNumberField('stderrTailLines'),
  settingsNumberField('defaultTimeoutMs'),
  settingsNumberField('maxTimeoutMs'),
  settingsNumberField('graceMs'),
  restartField,
  settingsNumberField('restartDelayMs'),
  settingsNumberField('restartMaxDelayMs'),
  settingsNumberField('restartLimit'),
  settingsNumberField('restartResetMs'),
  settingsTextField('logDir'),
]

/** 每个字段的渲染元数据：label/hint/invalid 的文案键 + 是否数字。 */
const FIELDS: readonly { field: string; numeric?: boolean }[] = [
  { field: 'delivery' },
  { field: 'coalesceMs', numeric: true },
  { field: 'maxLinesPerNotice', numeric: true },
  { field: 'maxBytesPerNotice', numeric: true },
  { field: 'maxLineBytes', numeric: true },
  { field: 'historyLines', numeric: true },
  { field: 'stderrTailLines', numeric: true },
  { field: 'defaultTimeoutMs', numeric: true },
  { field: 'maxTimeoutMs', numeric: true },
  { field: 'graceMs', numeric: true },
  { field: 'restart' },
  { field: 'restartDelayMs', numeric: true },
  { field: 'restartMaxDelayMs', numeric: true },
  { field: 'restartLimit', numeric: true },
  { field: 'restartResetMs', numeric: true },
  { field: 'logDir' },
]

type CardProjection = SettingsFormShell & Record<string, SettingsFieldState | boolean>

interface CardProps {
  t: Translate<LocaleKey>
  view: 'summary' | 'page'
  useMonitorCard: <T>(selector: (value: CardProjection) => T) => T
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/** 列表态渲染一句话简介；点开详情渲染表单。 */
function SettingsCard(props: CardProps) {
  const { t } = props
  const state = props.useMonitorCard((snapshot) => snapshot)
  if (props.view === 'summary') return t('description')
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      {FIELDS.map(({ field, numeric }) => (
        <SettingsValueField
          key={field}
          id={`plugin-config-monitor-${field}`}
          label={t(`${field}Label` as LocaleKey)}
          hint={t(`${field}Hint` as LocaleKey)}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t(numeric ? 'invalidNumber' : (`${field}Invalid` as LocaleKey))}
          numeric={numeric ?? false}
          disabled={!state.writable}
          {...(state[field] as SettingsFieldState)}
          onEdit={(text) => props.edit(field, text)}
          onReset={() => props.resetField(field)}
        />
      ))}
    </SettingsForm>
  )
}

/** 硬依赖：slot 注册台 + locale + configForms。 */
export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-monitor: dictionaries')
  const form = new SettingsFormModel(ctx.configForms.get(PLUGIN_NS), SPECS)
  const card = createCardController(form, SPECS, 'monitorCard', projection => form.bind(projection))
  ctx.effect(() => () => card.dispose(), 'dsh-monitor: form')
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () =>
      ctx.configForms.whileServed([PLUGIN_NS], () =>
        ctx.slots.inject('plugins.item', () =>
          ctx.slots.register(
            {
              name: 'plugins.item',
              id: 'monitor',
              order: 32,
              label: () => t('title'),
              locale: NS,
              inject: () => card.inject(),
            },
            SettingsCard,
          ),
        ),
      ),
    'dsh-monitor: settings card',
  )
}
