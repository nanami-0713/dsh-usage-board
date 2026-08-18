/**
 * @dsh-external/dsh-usage-board — 按模型计价规则（host 侧）。
 *
 * 目标：费用不是"所有 token 一口价"的粗略估算，而是把每一条 usage 记录
 * 归到「模型 × 时代 × 峰谷」的具体单价上逐条计费：
 *
 * - DeepSeek V4 系列（官方公告，2026-08-17 0 点北京时间起分时计价）：
 *     高峰时段 = 北京时间每日 9:00-12:00、14:00-18:00
 *     · V4-Flash  涨价前（统一价）：输入 1.0 / 缓存命中 0.02 / 输出 2.0
 *                 涨价后空闲：输入 1.5 / 缓存命中 0.05 / 输出 4.5
 *                 涨价后高峰：输入 3.0 / 缓存命中 0.10 / 输出 9.0
 *     · V4-Pro    涨价前（统一价）：输入 3.0 / 缓存命中 0.025 / 输出 6.0
 *                 涨价后空闲：输入 4.5 / 缓存命中 0.15 / 输出 13.5
 *                 涨价后高峰：输入 9.0 / 缓存命中 0.30 / 输出 27.0
 *     （单位：元 / 百万 tokens；来源：DeepSeek 官方涨价公告）
 * - Kimi K3（Moonshot 官方刊例，四家渠道一致）：
 *     输入 $3.0 / 缓存命中 $0.30 / 输出 $15.0（每百万 tokens，不分时）
 * - GLM-5.3（官方 API 刊例未公布）：按同基座 GLM-5.2 的 bigmodel.cn 刊例价
 *     估算：输入 ¥8 / 缓存命中 ¥2 / 输出 ¥28，UI 标注"估算"，可在
 *     ~/.dsh/plugins/dsh-usage-board/config.json 用官方价覆盖。
 *
 * 缓存写入 tokens 没有独立刊例价（DeepSeek/智谱均把写缓存按未缓存输入计费），
 * 因此按输入单价计费。
 *
 * 用户覆盖：config.json 的 models.<id> 提供单时代规则，优先级最高。
 */
import type { PricingCatalogEntry, PricingResponse, PriceRuleView } from './shared.js'

/** DeepSeek 分时计价生效时刻（北京时间 2026-08-17 00:00 = UTC 2026-08-16 16:00）。 */
export const DEEPSEEK_TIME_OF_USE_SINCE_MS = Date.parse('2026-08-17T00:00:00+08:00')

/** DeepSeek 官方高峰时段（北京时区小时，[起,止)）。 */
export const DEEPSEEK_PEAK_HOURS: [number, number][] = [
  [9, 12],
  [14, 18],
]

/** 默认 USD/CNY 折算率（可在 config.json 覆盖）。 */
export const DEFAULT_RATE_USD_CNY = 7.2

export type Currency = 'CNY' | 'USD'

/** 一条可命中的单价条目。 */
export interface PriceEntry {
  currency: Currency
  inputPerMillion: number
  cacheReadPerMillion: number
  outputPerMillion: number
  source: string
  estimated: boolean
  /** 生效起点（epoch ms）；null = 有史以来。 */
  sinceMs: number | null
  /** null = 不分时；true = 高峰单价；false = 空闲单价。 */
  peak: boolean | null
}

export interface ModelRule {
  key: string
  label: string
  /** 非空 = 分时模型（按北京时区小时命中 peak/非 peak 条目）。 */
  peakHours: [number, number][] | null
  /** 按 sinceMs 升序；解析时取「sinceMs ≤ ts 的最后一条」，再按峰谷二选一。 */
  eras: PriceEntry[]
  note: string | null
}

/** config.json 中用户对某模型的覆盖规则。 */
export interface ModelOverride {
  currency: Currency
  inputPerMillion: number
  cacheReadPerMillion: number
  outputPerMillion: number
  label?: string
  source?: string
  estimated?: boolean
}

export interface BoardConfig {
  version: 1
  rateUsdCny: number
  models: Record<string, ModelOverride>
}

export const DEFAULT_CONFIG: BoardConfig = { version: 1, rateUsdCny: DEFAULT_RATE_USD_CNY, models: {} }

function deepseekEras(cheap: Omit<PriceEntry, 'sinceMs' | 'peak'>, offPeak: Omit<PriceEntry, 'sinceMs' | 'peak'>, peak: Omit<PriceEntry, 'sinceMs' | 'peak'>): PriceEntry[] {
  return [
    { ...cheap, sinceMs: null, peak: null },
    { ...offPeak, sinceMs: DEEPSEEK_TIME_OF_USE_SINCE_MS, peak: false },
    { ...peak, sinceMs: DEEPSEEK_TIME_OF_USE_SINCE_MS, peak: true },
  ]
}

/** 内置计价目录（截至 2026-08 官方公开刊例）。 */
export const MODEL_RULES: ModelRule[] = [
  {
    key: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    peakHours: DEEPSEEK_PEAK_HOURS,
    eras: deepseekEras(
      { currency: 'CNY', inputPerMillion: 1.0, cacheReadPerMillion: 0.02, outputPerMillion: 2.0, source: 'DeepSeek 官方（2026-08-17 涨价前统一价）', estimated: false },
      { currency: 'CNY', inputPerMillion: 1.5, cacheReadPerMillion: 0.05, outputPerMillion: 4.5, source: 'DeepSeek 官方（2026-08-17 起空闲时段）', estimated: false },
      { currency: 'CNY', inputPerMillion: 3.0, cacheReadPerMillion: 0.10, outputPerMillion: 9.0, source: 'DeepSeek 官方（2026-08-17 起高峰时段）', estimated: false },
    ),
    note: '高峰 = 北京时间 9-12 点、14-18 点；涨价前为不分时统一价',
  },
  {
    key: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    peakHours: DEEPSEEK_PEAK_HOURS,
    eras: deepseekEras(
      { currency: 'CNY', inputPerMillion: 3.0, cacheReadPerMillion: 0.025, outputPerMillion: 6.0, source: 'DeepSeek 官方（2026-08-17 涨价前统一价）', estimated: false },
      { currency: 'CNY', inputPerMillion: 4.5, cacheReadPerMillion: 0.15, outputPerMillion: 13.5, source: 'DeepSeek 官方（2026-08-17 起空闲时段）', estimated: false },
      { currency: 'CNY', inputPerMillion: 9.0, cacheReadPerMillion: 0.30, outputPerMillion: 27.0, source: 'DeepSeek 官方（2026-08-17 起高峰时段）', estimated: false },
    ),
    note: '高峰 = 北京时间 9-12 点、14-18 点；涨价前为不分时统一价',
  },
  {
    key: 'kimi-k3',
    label: 'Kimi K3',
    peakHours: null,
    eras: [
      {
        currency: 'USD', inputPerMillion: 3.0, cacheReadPerMillion: 0.3, outputPerMillion: 15.0, sinceMs: null, peak: null,
        source: 'Moonshot AI 官方刊例（$3 / $0.30 缓存 / $15 每百万 tokens）',
        estimated: false,
      },
    ],
    note: '按官方美元刊例计费，人民币金额按汇率折算',
  },
  {
    key: 'glm-5.3',
    label: 'GLM-5.3',
    peakHours: null,
    eras: [
      {
        currency: 'CNY', inputPerMillion: 8, cacheReadPerMillion: 2, outputPerMillion: 28, sinceMs: null, peak: null,
        source: '按同基座 GLM-5.2 的 bigmodel.cn 刊例价估算（GLM-5.3 官方 API 刊例未公布）',
        estimated: true,
      },
    ],
    note: '估算价：GLM-5.3 与 GLM-5.2 同为 743B 基座；官方公布后可在 config.json 覆盖',
  },
]

/** 走 Coding Plan 订阅（费用为刊例价折算，仅供参考）的 provider 特征。 */
export const CODING_PLAN_PROVIDER_HINTS: { match: (provider: string) => boolean; label: string }[] = [
  { match: (p) => p === 'zai-coding-cn' || p.includes('zai-coding') || p === 'zai', label: 'GLM Coding Plan（订阅计费，看板金额为按量刊例价折算）' },
  { match: (p) => p === 'moonshotai-cn' || p.includes('kimi-coding') || p.includes('moonshot-coding'), label: 'Kimi Coding Plan（订阅计费，看板金额为按量刊例价折算）' },
]

/* ───────────────────────── 北京时区工具 ───────────────────────── */

const beijingHour = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
})

const beijingPartsCache = new Map<number, { year: string; month: string; day: string; hour: string }>()

/** 把 epoch ms 对齐到整点后格式化为北京时区字段（按小时缓存）。 */
export function beijingParts(tsMs: number): { year: string; month: string; day: string; hour: string } {
  const hourBucket = Math.floor(tsMs / 3_600_000)
  const cached = beijingPartsCache.get(hourBucket)
  if (cached !== undefined) return cached
  const parts = { year: '', month: '', day: '', hour: '' }
  for (const part of beijingHour.formatToParts(new Date(hourBucket * 3_600_000))) {
    if (part.type === 'year') parts.year = part.value
    else if (part.type === 'month') parts.month = part.value
    else if (part.type === 'day') parts.day = part.value
    else if (part.type === 'hour') parts.hour = part.value
  }
  if (beijingPartsCache.size > 100_000) beijingPartsCache.clear()
  beijingPartsCache.set(hourBucket, parts)
  return parts
}

/** 北京时区小时 key："2026-08-18T14"。 */
export function hourKeyOf(tsMs: number): string {
  const p = beijingParts(tsMs)
  return `${p.year}-${p.month}-${p.day}T${p.hour}`
}

/** 北京时区天 key："2026-08-18"。 */
export function dayKeyOf(tsMs: number): string {
  const p = beijingParts(tsMs)
  return `${p.year}-${p.month}-${p.day}`
}

/** 北京时区的小时数（0-23）。 */
export function beijingHourOf(tsMs: number): number {
  return Number(beijingParts(tsMs).hour)
}

/* ───────────────────────── 规则解析 ───────────────────────── */

function normalizeModel(model: string | undefined | null): string {
  return (model ?? '').trim().toLowerCase()
}

/** 精确匹配 → 目录 key 前缀匹配（如 deepseek-v4-pro-0813 → deepseek-v4-pro）。 */
export function matchRuleKey(model: string | undefined | null): string | null {
  const normalized = normalizeModel(model)
  if (normalized === '') return null
  for (const rule of MODEL_RULES) {
    if (normalized === rule.key) return rule.key
  }
  for (const rule of MODEL_RULES) {
    if (normalized.startsWith(`${rule.key}-`)) return rule.key
  }
  return null
}

export interface ResolvedPrice {
  /** 命中的规则 key（内置目录或用户覆盖的模型 id）。 */
  ruleKey: string
  label: string
  entry: PriceEntry
  /** 用户覆盖标记。 */
  overridden: boolean
}

/** 解析「模型 × 时刻」的单价；未知模型返回 null（tokens 照计、费用不计）。 */
export function resolvePrice(
  model: string | undefined | null,
  tsMs: number,
  config: BoardConfig = DEFAULT_CONFIG,
): ResolvedPrice | null {
  const normalized = normalizeModel(model)
  if (normalized === '') return null

  const override = config.models[normalized]
  if (override !== undefined) {
    return {
      ruleKey: normalized,
      label: override.label ?? normalized,
      overridden: true,
      entry: {
        currency: override.currency,
        inputPerMillion: override.inputPerMillion,
        cacheReadPerMillion: override.cacheReadPerMillion,
        outputPerMillion: override.outputPerMillion,
        source: override.source ?? '用户覆盖（config.json）',
        estimated: override.estimated ?? false,
        sinceMs: null,
        peak: null,
      },
    }
  }

  const ruleKey = matchRuleKey(normalized)
  if (ruleKey === null) return null
  const rule = MODEL_RULES.find((r) => r.key === ruleKey)
  if (rule === undefined) return null

  // 时代：取 sinceMs ≤ ts 的最后一条（数组按 sinceMs 升序）。
  let era: PriceEntry | null = null
  for (const candidate of rule.eras) {
    if (candidate.sinceMs === null || tsMs >= candidate.sinceMs) era = candidate
  }
  if (era === null) return null

  // 峰谷：仅当命中时代属于分时计价（同一 sinceMs 同时挂着 peak=true/false 两条）。
  let entry = era
  const hasTimeOfUse = rule.eras.some((e) => e.sinceMs === era?.sinceMs && e.peak === true)
  if (hasTimeOfUse && rule.peakHours !== null) {
    const hour = beijingHourOf(tsMs)
    const peak = rule.peakHours.some(([from, to]) => hour >= from && hour < to)
    const matched = rule.eras.find((e) => e.sinceMs === era?.sinceMs && e.peak === peak)
    if (matched !== undefined) entry = matched
  }

  return { ruleKey: rule.key, label: rule.label, overridden: false, entry }
}

/** 一桶用量（input/cacheRead/cacheWrite/output，单位 tokens）按单价折算成双边金额。 */
export function costOf(
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number },
  price: ResolvedPrice,
  rateUsdCny: number,
): { cny: number; usd: number } {
  const native =
    ((usage.input + usage.cacheWrite) * price.entry.inputPerMillion +
      usage.cacheRead * price.entry.cacheReadPerMillion +
      usage.output * price.entry.outputPerMillion) /
    1_000_000
  return price.entry.currency === 'CNY'
    ? { cny: native, usd: native / rateUsdCny }
    : { cny: native * rateUsdCny, usd: native }
}

/** 给 API 用的目录视图（含用户覆盖标记）。 */
export function pricingCatalog(config: BoardConfig): PricingCatalogEntry[] {
  const overriddenKeys = new Set(Object.keys(config.models))
  const entries: PricingCatalogEntry[] = MODEL_RULES.map((rule) => ({
    model: rule.key,
    label: rule.label,
    peakHours: rule.peakHours,
    note: rule.note,
    overridden: overriddenKeys.has(rule.key),
    eras: rule.eras.map((e) => ({
      since: e.sinceMs === null ? null : new Date(e.sinceMs).toISOString(),
      peak: e.peak,
      currency: e.currency,
      inputPerMillion: e.inputPerMillion,
      cacheReadPerMillion: e.cacheReadPerMillion,
      outputPerMillion: e.outputPerMillion,
      source: e.source,
      estimated: e.estimated,
    })),
  }))
  for (const [model, o] of Object.entries(config.models)) {
    if (MODEL_RULES.some((r) => r.key === model)) continue
    entries.push({
      model,
      label: o.label ?? model,
      peakHours: null,
      note: null,
      overridden: true,
      eras: [{
        since: null, peak: null, currency: o.currency,
        inputPerMillion: o.inputPerMillion,
        cacheReadPerMillion: o.cacheReadPerMillion,
        outputPerMillion: o.outputPerMillion,
        source: o.source ?? '用户覆盖（config.json）',
        estimated: o.estimated ?? false,
      }],
    })
  }
  return entries
}

export function emptyPricingResponse(config: BoardConfig): PricingResponse {
  return { ok: true, rateUsdCny: config.rateUsdCny, catalog: pricingCatalog(config), codingPlanProviders: CODING_PLAN_PROVIDER_HINTS.map((h) => h.label) }
}

/** PriceRuleView 的聚合 key（label+单价完全一致视为同一条）。 */
export function ruleViewKey(view: Omit<PriceRuleView, 'requests'>): string {
  return [
    view.label, view.currency, view.inputPerMillion, view.cacheReadPerMillion, view.outputPerMillion,
    view.source, view.estimated, view.since, view.peak,
  ].join('|')
}
