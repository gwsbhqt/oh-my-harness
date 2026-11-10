import { createCardController } from '../../../tooling/runtime/card.mjs'
import { stringListField } from '../../../tooling/runtime/fields.mjs'
/**
 * messageTidy 设置卡片 浏览器半：内置插件页（插件管理）里的配置卡片。
 *
 * 0.1.7 **没有**「从 volatile 字段自动生成设置页」——volatile 只让宿主侧
 * SettingsForms.describe() 把这个命名空间端给浏览器半（值、默认值、可写性、
 * 修订号），GUI 入口要各家 client 半自己注册：往插件页的 `plugins.item` 槽位
 * 塞一张卡片，表单用 ui-primitives 的共享套件（SettingsFormModel /
 * SettingsForm / SettingsValueField）。官方参照：
 * dsh-client-ui-settings-agent-loop。
 *
 * `configForms.whileServed` 做门：宿主没加载本插件（命名空间没被端出来）时
 * 卡片整个不出现，而不是渲染一张写不动的表单。
 *
 * @module dsh-message-tidy/client
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

/** 布尔字段：接受 true/false，空串清除回默认。 */
function boolField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) => (typeof value === 'boolean' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (!trimmed) return { kind: 'clear' }
      if (trimmed !== 'true' && trimmed !== 'false') return undefined
      return { kind: 'set', value: trimmed === 'true' }
    },
  }
}

/** 本卡片自己的文案命名空间。 */
const NS = 'settings.messageTidy'
/** 宿主侧配置命名空间 = 插件 id。 */
const PLUGIN_NS = 'message-tidy'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.messageTidy': LocaleKey
  }
}

type LocaleKey =
  | 'title'
  | 'description'
  | 'overridden'
  | 'reset'
  | 'readOnly'
  | 'unavailable'
  | 'save'
  | 'saving'
  | 'saveFailed'
  | 'invalidNumber'
  | 'invalidBoolean'
  | 'invalidList'
  | 'invalidDict'
  | 'invalidText'
  | 'noticeLabelLabel'
  | 'noticeLabelHint'
  | 'noticeSourcesLabel'
  | 'noticeSourcesHint'
  | 'noticeDedupeLabel'
  | 'noticeDedupeHint'
  | 'jobLabelLabel'
  | 'jobLabelHint'
  | 'jobLabelMaxCharsLabel'
  | 'jobLabelMaxCharsHint'
  | 'instructionsDiffLabel'
  | 'instructionsDiffHint'
  | 'maxDiffRatioLabel'
  | 'maxDiffRatioHint'
  | 'contextLinesLabel'
  | 'contextLinesHint'

const en: Record<LocaleKey, string> = {
  title: "Message Tidy",
  description: "Labels repeated tool reminders and background jobs, and folds instruction diffs.",
  overridden: "Overridden",
  reset: "Reset to default",
  readOnly: "This deployment stores settings read-only.",
  unavailable: "This plugin is not loaded, so it cannot be configured right now.",
  save: "Save",
  saving: "Saving…",
  saveFailed: "The deployment did not accept these values; they were left for you to correct.",
  invalidNumber: "Enter a number, or leave blank to use the default.",
  invalidBoolean: "Only true or false, or leave blank to use the default.",
  invalidList: "Comma-separated values, or leave blank to use the default.",
  invalidDict: "Comma-separated name=value pairs, or leave blank to use the default.",
  invalidText: "Invalid value.",
  noticeLabelLabel: "Notice label",
  noticeLabelHint: "Tag repeated tool reminders in the transcript.",
  noticeSourcesLabel: "Notice sources",
  noticeSourcesHint: "Comma-separated reminder kinds to label, or * for every plugin notice.",
  noticeDedupeLabel: "Dedupe notices",
  noticeDedupeHint: "Keep only the first copy of identical notices within one step.",
  jobLabelLabel: "Job label",
  jobLabelHint: "Label background job results.",
  jobLabelMaxCharsLabel: "Job label max chars",
  jobLabelMaxCharsHint: "Longer job names are cut here and end with an ellipsis.",
  instructionsDiffLabel: "Instructions diff",
  instructionsDiffHint: "Fold unchanged instruction text into a diff.",
  maxDiffRatioLabel: "Max diff ratio",
  maxDiffRatioHint: "Above this changed ratio the full text is kept (0–1).",
  contextLinesLabel: "Context lines",
  contextLinesHint: "Unchanged lines kept around each diff hunk.",
}

const zh: Record<LocaleKey, string> = {
  title: "消息整理",
  description: "给重复工具提醒和后台任务加标注，折叠指令差异。",
  overridden: "已覆盖",
  reset: "恢复默认",
  readOnly: "本部署的设置为只读。",
  unavailable: "该插件当前未加载，暂时无法配置。",
  save: "保存",
  saving: "保存中…",
  saveFailed: "本部署没有接受这些值，已保留供你修改。",
  invalidNumber: "请填数字；留空表示使用默认值。",
  invalidBoolean: "只能填 true 或 false；留空表示使用默认值。",
  invalidList: "逗号分隔的一组值；留空表示使用默认值。",
  invalidDict: "逗号分隔的「名=值」对；留空表示使用默认值。",
  invalidText: "无效的值。",
  noticeLabelLabel: "提醒标注",
  noticeLabelHint: "在记录里给重复的工具提醒加标注。",
  noticeSourcesLabel: "提醒来源",
  noticeSourcesHint: "逗号分隔，要加标注的提醒种类；* 表示全部。",
  noticeDedupeLabel: "重复提醒去重",
  noticeDedupeHint: "同一步里一模一样的提醒只留第一条。",
  jobLabelLabel: "任务标注",
  jobLabelHint: "给后台任务的结果加标注。",
  jobLabelMaxCharsLabel: "任务标注长度上限",
  jobLabelMaxCharsHint: "任务名超过这个长度就截断，末尾加「…」。",
  instructionsDiffLabel: "指令差异折叠",
  instructionsDiffHint: "没变的指令文本折叠成差异。",
  maxDiffRatioLabel: "最大差异比例",
  maxDiffRatioHint: "改动超过这个比例就保留全文（0–1）。",
  contextLinesLabel: "上下文行数",
  contextLinesHint: "每段差异前后保留的未变行数。",
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

const SPECS: SettingsFieldSpec[] = [
  boolField('noticeLabel'),
  stringListField('noticeSources'),
  boolField('noticeDedupe'),
  boolField('jobLabel'),
  settingsNumberField('jobLabelMaxChars'),
  boolField('instructionsDiff'),
  settingsNumberField('maxDiffRatio'),
  settingsNumberField('contextLines'),
]

/** 每个字段的渲染元数据：label/hint 的文案键 + 控件类型。 */
const FIELDS: readonly { field: string; kind: 'number' | 'text' | 'bool' | 'list' | 'dict' }[] = [
  { field: 'noticeLabel', kind: 'bool' },
  { field: 'noticeSources', kind: 'list' },
  { field: 'noticeDedupe', kind: 'bool' },
  { field: 'jobLabel', kind: 'bool' },
  { field: 'jobLabelMaxChars', kind: 'number' },
  { field: 'instructionsDiff', kind: 'bool' },
  { field: 'maxDiffRatio', kind: 'number' },
  { field: 'contextLines', kind: 'number' },
]

const INVALID_LABEL = { number: 'invalidNumber', text: 'invalidText', bool: 'invalidBoolean', list: 'invalidList', dict: 'invalidDict' } as const

type CardProjection = SettingsFormShell & Record<string, SettingsFieldState | boolean>

interface CardProps {
  t: Translate<LocaleKey>
  view: 'summary' | 'page'
  useMessageTidyCard: <T>(selector: (value: CardProjection) => T) => T
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/** 列表态渲染一句话简介；点开详情渲染表单。 */
function SettingsCard(props: CardProps) {
  const { t } = props
  const state = props.useMessageTidyCard((snapshot) => snapshot)
  if (props.view === 'summary') return t('description')
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      {FIELDS.map(({ field, kind }) => (
        <SettingsValueField
          key={field}
          id={`plugin-config-message-tidy-${field}`}
          label={t(`${field}Label` as LocaleKey)}
          hint={t(`${field}Hint` as LocaleKey)}
          overriddenLabel={t('overridden')}
          resetLabel={t('reset')}
          invalidLabel={t(INVALID_LABEL[kind])}
          numeric={kind === 'number'}
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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-message-tidy: dictionaries')
  const form = new SettingsFormModel(ctx.configForms.get(PLUGIN_NS), SPECS)
  const card = createCardController(form, SPECS, 'messageTidyCard', projection => form.bind(projection))
  ctx.effect(() => () => card.dispose(), 'dsh-message-tidy: form')
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () =>
      ctx.configForms.whileServed([PLUGIN_NS], () =>
        ctx.slots.inject('plugins.item', () =>
          ctx.slots.register(
            {
              name: 'plugins.item',
              id: 'message-tidy',
              order: 34,
              label: () => t('title'),
              locale: NS,
              inject: () => card.inject(),
            },
            SettingsCard,
          ),
        ),
      ),
    'dsh-message-tidy: settings card',
  )
}
