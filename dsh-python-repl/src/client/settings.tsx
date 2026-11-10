import { createCardController } from '../../../tooling/runtime/card.mjs'
import { stringListField } from '../../../tooling/runtime/fields.mjs'
import { SETTINGS_FIELD_DEFS } from './settings-fields.ts'
/**
 * pythonRepl 设置卡片 浏览器半：内置插件页（插件管理）里的配置卡片。
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
 * @module dsh-python-repl/client
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
const NS = 'settings.pythonRepl'
/** 宿主侧配置命名空间 = 插件 id。 */
const PLUGIN_NS = 'python-repl'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.pythonRepl': LocaleKey
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
  | 'pythonLabel'
  | 'pythonHint'
  | 'maxFrameBytesLabel'
  | 'maxFrameBytesHint'
  | 'startupTimeoutMsLabel'
  | 'startupTimeoutMsHint'
  | 'teardownGraceMsLabel'
  | 'teardownGraceMsHint'
  | 'interruptGraceMsLabel'
  | 'interruptGraceMsHint'
  | 'toolCallTimeoutMsLabel'
  | 'toolCallTimeoutMsHint'
  | 'maxCellOutputTokensLabel'
  | 'maxCellOutputTokensHint'
  | 'maxCellTimeoutMsLabel'
  | 'maxCellTimeoutMsHint'
  | 'archiveAfterCellsLabel'
  | 'archiveAfterCellsHint'
  | 'deleteAfterCellsLabel'
  | 'deleteAfterCellsHint'
  | 'cellWaitMsLabel'
  | 'cellWaitMsHint'
  | 'idleKernelMinutesLabel'
  | 'idleKernelMinutesHint'
  | 'residentToolsLabel'
  | 'residentToolsHint'
  | 'skillRootsLabel'
  | 'skillRootsHint'
  | 'projectSkillRootsLabel'
  | 'projectSkillRootsHint'

const en: Record<LocaleKey, string> = {
  title: "Python REPL",
  description: "Persistent Python cells behind run_code; settings apply to new session kernels.",
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
  pythonLabel: "Python interpreter",
  pythonHint: "A uv-managed version such as 3.14, a name on PATH, or an absolute path; >= 3.11.",
  maxFrameBytesLabel: "Maximum kernel frame (bytes)",
  maxFrameBytesHint: "Default 64 MiB; one oversized message stops this kernel. Total output is not limited by this field.",
  startupTimeoutMsLabel: "Startup timeout (ms)",
  startupTimeoutMsHint: "Maximum time for the handshake and complete initialization, including skill imports and restoring saved variables.",
  teardownGraceMsLabel: "Teardown grace (ms)",
  teardownGraceMsHint: "Host-side ceiling on end-of-cell cleanup.",
  interruptGraceMsLabel: "Interrupt grace (ms)",
  interruptGraceMsHint: "How long a cancelled cell may take to stop before the kernel is killed.",
  toolCallTimeoutMsLabel: "Tool call timeout (ms)",
  toolCallTimeoutMsHint: "0 uses DSH tool lifetimes, including human waits.",
  maxCellOutputTokensLabel: "Cell output budget (tokens)",
  maxCellOutputTokensHint: "Longer output shows only its start and end; the whole text is saved to a file. 0 turns this off.",
  maxCellTimeoutMsLabel: "Cell timeout (ms)",
  maxCellTimeoutMsHint: "Longest a cell may run; past it the cell is cancelled like an interrupt. Default one day.",
  archiveAfterCellsLabel: "Archive after (cells)",
  archiveAfterCellsHint: "A name unused this many cells leaves the kernel for an archive file and comes back when used. 0 turns this off.",
  deleteAfterCellsLabel: "Delete after (cells)",
  deleteAfterCellsHint: "A name unused this many cells is deleted; only a record stays. 0 turns this off. Pinned names are exempt.",
  cellWaitMsLabel: "Longest wait in a cell (ms)",
  cellWaitMsHint: "Past this a command keeps running in the background and the agent is woken when it ends. 0 = no cap.",
  idleKernelMinutesLabel: "Stop idle kernels after (minutes)",
  idleKernelMinutesHint: "Frees memory; the next cell restores the variables. Never while something still runs inside. 0 = never.",
  residentToolsLabel: "Resident tools",
  residentToolsHint: "Comma-separated; declared in full in the prompt.",
  skillRootsLabel: "Skill roots",
  skillRootsHint: "Comma-separated trusted directories scanned for Python skills.",
  projectSkillRootsLabel: "Project skill roots",
  projectSkillRootsHint: "Directories inside each project scanned for Python skills; defaults to .agents/skills.",
}

const zh: Record<LocaleKey, string> = {
  title: "Python REPL",
  description: "run_code 背后的持久 Python 内核；设置只对新会话内核生效。",
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
  pythonLabel: "Python 解释器",
  pythonHint: "uv 管理的版本号（如 3.14）、PATH 上的命令名或绝对路径，版本必须 >= 3.11。",
  maxFrameBytesLabel: "最大单条内核消息（字节）",
  maxFrameBytesHint: "默认 64 MiB。单条消息超限会停止该内核；不限制所有消息的总量。",
  startupTimeoutMsLabel: "启动超时（毫秒）",
  startupTimeoutMsHint: "握手与完整初始化的总时限，包含技能导入和恢复已保存的变量。",
  teardownGraceMsLabel: "收尾宽限（毫秒）",
  teardownGraceMsHint: "格结束清理的宿主侧上限。",
  interruptGraceMsLabel: "中断宽限（毫秒）",
  interruptGraceMsHint: "取消后多久还没停下就强杀内核。",
  toolCallTimeoutMsLabel: "工具调用超时（毫秒）",
  toolCallTimeoutMsHint: "0 表示沿用 DSH 工具生命周期（含等人回复）。",
  maxCellOutputTokensLabel: "单格输出上限（token）",
  maxCellOutputTokensHint: "超出时只给模型看开头和结尾，全文存进文件。填 0 关闭。",
  maxCellTimeoutMsLabel: "单格最长运行时间（毫秒）",
  maxCellTimeoutMsHint: "超过就像中断一样取消这一格；默认一天。",
  archiveAfterCellsLabel: "多少格没用就归档",
  archiveAfterCellsHint: "名字连续这么多格没用，就移出内核存进归档文件，用到时自动取回。填 0 关闭。",
  deleteAfterCellsLabel: "多少格没用就删除",
  deleteAfterCellsHint: "名字连续这么多格没用就删除，只留一条记录。填 0 关闭。钉住的名字不受影响。",
  cellWaitMsLabel: "一格里最多等多久（毫秒）",
  cellWaitMsHint: "命令或后台任务超过这个时间还没完，就留在后台继续跑，跑完叫醒模型。填 0 不限制。",
  idleKernelMinutesLabel: "内核闲置多久自动关闭（分钟）",
  idleKernelMinutesHint: "释放内存，下一格自动恢复变量。里面还有东西在跑时不关。填 0 不关。",
  residentToolsLabel: "常驻工具",
  residentToolsHint: "逗号分隔；这些工具的完整契约常驻提示词。",
  skillRootsLabel: "技能目录",
  skillRootsHint: "逗号分隔的可信目录，启动时扫描 Python 技能。",
  projectSkillRootsLabel: "项目技能目录",
  projectSkillRootsHint: "每个项目内扫描 Python 技能的目录；默认 .agents/skills。",
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

const SPECS: SettingsFieldSpec[] = SETTINGS_FIELD_DEFS.map(([field, kind]) =>
  kind === 'text' ? settingsTextField(field)
    : kind === 'list' ? stringListField(field)
      : settingsNumberField(field),
)

/** 每个字段的渲染元数据：label/hint 的文案键 + 控件类型。 */
const FIELDS: readonly { field: string; kind: 'number' | 'text' | 'bool' | 'list' | 'dict' }[] = SETTINGS_FIELD_DEFS.map(
  ([field, kind]) => ({ field, kind }),
)

const INVALID_LABEL = { number: 'invalidNumber', text: 'invalidText', bool: 'invalidBoolean', list: 'invalidList', dict: 'invalidDict' } as const

type CardProjection = SettingsFormShell & Record<string, SettingsFieldState | boolean>

interface CardProps {
  t: Translate<LocaleKey>
  view: 'summary' | 'page'
  usePythonReplCard: <T>(selector: (value: CardProjection) => T) => T
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/** 列表态渲染一句话简介；点开详情渲染表单。 */
function SettingsCard(props: CardProps) {
  const { t } = props
  const state = props.usePythonReplCard((snapshot) => snapshot)
  if (props.view === 'summary') return t('description')
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      {FIELDS.map(({ field, kind }) => (
        <SettingsValueField
          key={field}
          id={`plugin-config-python-repl-${field}`}
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

/** 宿主端出 `python-repl` 命名空间期间，把卡片挂进插件页。由 client/index.tsx 的 apply 调用。 */
export function registerSettingsCard(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-python-repl: dictionaries')
  const form = new SettingsFormModel(ctx.configForms.get(PLUGIN_NS), SPECS)
  const card = createCardController(form, SPECS, 'pythonReplCard', projection => form.bind(projection))
  ctx.effect(() => () => card.dispose(), 'dsh-python-repl: form')
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () =>
      ctx.configForms.whileServed([PLUGIN_NS], () =>
        ctx.slots.inject('plugins.item', () =>
          ctx.slots.register(
            {
              name: 'plugins.item',
              id: 'python-repl',
              order: 32,
              label: () => t('title'),
              locale: NS,
              inject: () => card.inject(),
            },
            SettingsCard,
          ),
        ),
      ),
    'dsh-python-repl: settings card',
  )
}
