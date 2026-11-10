import { createCardController } from '../../../tooling/runtime/card.mjs'
/**
 * imageCap 设置卡片 浏览器半：内置插件页（插件管理）里的配置卡片。
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
 * @module dsh-image-cap/client
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

/** 正整数字典字段：`名=值` 逗号分隔 ↔ Record<string, number>，空串清除回默认。 */
function intDictField(field: string): SettingsFieldSpec {
  return {
    field,
    format: (value) =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join(', ')
        : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (!trimmed) return { kind: 'clear' }
      const out: Record<string, number> = {}
      for (const part of trimmed.split(',')) {
        const m = /^([^=\s][^=]*)=(\d+)$/.exec(part.trim())
        if (m === null) return undefined
        out[m[1]!.trim()] = Number(m[2])
      }
      return { kind: 'set', value: out }
    },
  }
}

/** 本卡片自己的文案命名空间。 */
const NS = 'settings.imageCap'
/** 宿主侧配置命名空间 = 插件 id。 */
const PLUGIN_NS = 'image-cap'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.imageCap': LocaleKey
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
  | 'maxLongEdgeLabel'
  | 'maxLongEdgeHint'
  | 'maxImagesPerRequestLabel'
  | 'maxImagesPerRequestHint'
  | 'imageCountQuantumLabel'
  | 'imageCountQuantumHint'
  | 'providerMaxImagesLabel'
  | 'providerMaxImagesHint'

const en: Record<LocaleKey, string> = {
  title: "Image Cap",
  description: "Shrinks oversized images before the request and caps how many ride one request.",
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
  maxLongEdgeLabel: "Max long edge (px)",
  maxLongEdgeHint: "Images with a longer edge are downscaled before sending.",
  maxImagesPerRequestLabel: "Max images per request",
  maxImagesPerRequestHint: "Oldest images beyond this are offloaded from the request.",
  imageCountQuantumLabel: "Image count quantum",
  imageCountQuantumHint: "Counting step for the per-request cap.",
  providerMaxImagesLabel: "Provider max images",
  providerMaxImagesHint: "Comma-separated provider=count overrides, e.g. claude=100.",
}

const zh: Record<LocaleKey, string> = {
  title: "图片限流",
  description: "请求前压缩超限图片，并限制单次请求携带的图片数量。",
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
  maxLongEdgeLabel: "长边上限（像素）",
  maxLongEdgeHint: "长边超过这个值的图片发送前先压缩。",
  maxImagesPerRequestLabel: "单次请求图片上限",
  maxImagesPerRequestHint: "超过这个数量时最旧的图片从请求里卸下。",
  imageCountQuantumLabel: "图片数量粒度",
  imageCountQuantumHint: "单次上限的计数粒度。",
  providerMaxImagesLabel: "按渠道的图片上限",
  providerMaxImagesHint: "逗号分隔的「渠道=数量」覆盖，例如 claude=100。",
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
  settingsNumberField('maxLongEdge'),
  settingsNumberField('maxImagesPerRequest'),
  settingsNumberField('imageCountQuantum'),
  intDictField('providerMaxImages'),
]

/** 每个字段的渲染元数据：label/hint 的文案键 + 控件类型。 */
const FIELDS: readonly { field: string; kind: 'number' | 'text' | 'bool' | 'list' | 'dict' }[] = [
  { field: 'maxLongEdge', kind: 'number' },
  { field: 'maxImagesPerRequest', kind: 'number' },
  { field: 'imageCountQuantum', kind: 'number' },
  { field: 'providerMaxImages', kind: 'dict' },
]

const INVALID_LABEL = { number: 'invalidNumber', text: 'invalidText', bool: 'invalidBoolean', list: 'invalidList', dict: 'invalidDict' } as const

type CardProjection = SettingsFormShell & Record<string, SettingsFieldState | boolean>

interface CardProps {
  t: Translate<LocaleKey>
  view: 'summary' | 'page'
  useImageCapCard: <T>(selector: (value: CardProjection) => T) => T
  edit: (field: string, text: string) => void
  resetField: (field: string) => void
  save: () => void
  discard: () => void
}

/** 列表态渲染一句话简介；点开详情渲染表单。 */
function SettingsCard(props: CardProps) {
  const { t } = props
  const state = props.useImageCapCard((snapshot) => snapshot)
  if (props.view === 'summary') return t('description')
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      {FIELDS.map(({ field, kind }) => (
        <SettingsValueField
          key={field}
          id={`plugin-config-image-cap-${field}`}
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
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-image-cap: dictionaries')
  const form = new SettingsFormModel(ctx.configForms.get(PLUGIN_NS), SPECS)
  const card = createCardController(form, SPECS, 'imageCapCard', projection => form.bind(projection))
  ctx.effect(() => () => card.dispose(), 'dsh-image-cap: form')
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () =>
      ctx.configForms.whileServed([PLUGIN_NS], () =>
        ctx.slots.inject('plugins.item', () =>
          ctx.slots.register(
            {
              name: 'plugins.item',
              id: 'image-cap',
              order: 35,
              label: () => t('title'),
              locale: NS,
              inject: () => card.inject(),
            },
            SettingsCard,
          ),
        ),
      ),
    'dsh-image-cap: settings card',
  )
}
