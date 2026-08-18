/**
 * @dsh-external/dsh-usage-board — host half。
 *
 * 职责：
 *   1. 扫描 ~/.dsh/sessions 全部文件夹的会话日志（zstd jsonl），维护逐小时
 *      token 用量索引（增量缓存 ~/.dsh/plugins/dsh-usage-board/cache.json）；
 *   2. 按模型计价规则（内置目录 + 用户覆盖）逐桶折算费用，构建汇总；
 *   3. 在 DSH webserver 上暴露同源 API（client 设置页看板消费）：
 *        GET  /api/dsh-usage-board/summary?range=1d|7d|30d|all[&refresh=1]
 *        GET  /api/dsh-usage-board/pricing
 *        GET/PUT /api/dsh-usage-board/config
 *
 * client half（src/client）在设置面板注册「用量看板」页面。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { DEFAULT_RATE_USD_CNY, emptyPricingResponse, type BoardConfig, type Currency, type ModelOverride } from './pricing.js'
import { dshHomeDir, loadCache, pluginDataDir, saveCache, scanSessions, type IndexCacheFile, type ScanStats } from './indexer.js'
import { buildSummary } from './summary.js'
import type { RangeKey } from './shared.js'

export const name = '@dsh-external/dsh-usage-board'
export const inject: string[] = []

export const API_BASE = '/api/dsh-usage-board'

/** 索引缓存的复用 TTL：超过后对变更文件重扫（指纹比对，代价很小）。 */
const RESCAN_TTL_MS = 30_000

/** PUT body 上限。 */
const MAX_BODY_BYTES = 256 * 1024

/* ───────────────────────── 配置 ───────────────────────── */

function configPath(): string {
  return join(pluginDataDir(), 'config.json')
}

function normalizeOverride(value: unknown): ModelOverride | null {
  if (value === null || typeof value !== 'object') return null
  const entry = value as Record<string, unknown>
  const currency: Currency = entry.currency === 'USD' ? 'USD' : 'CNY'
  const positive = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  const inputPerMillion = positive(entry.inputPerMillion)
  const cacheReadPerMillion = positive(entry.cacheReadPerMillion)
  const outputPerMillion = positive(entry.outputPerMillion)
  if (inputPerMillion === null || cacheReadPerMillion === null || outputPerMillion === null) return null
  const override: ModelOverride = { currency, inputPerMillion, cacheReadPerMillion, outputPerMillion }
  if (typeof entry.label === 'string' && entry.label !== '') override.label = entry.label
  if (typeof entry.source === 'string' && entry.source !== '') override.source = entry.source
  if (typeof entry.estimated === 'boolean') override.estimated = entry.estimated
  return override
}

export function normalizeConfig(value: unknown): BoardConfig {
  const config: BoardConfig = { version: 1, rateUsdCny: DEFAULT_RATE_USD_CNY, models: {} }
  if (value === null || typeof value !== 'object') return config
  const raw = value as Record<string, unknown>
  if (typeof raw.rateUsdCny === 'number' && Number.isFinite(raw.rateUsdCny) && raw.rateUsdCny > 0) {
    config.rateUsdCny = raw.rateUsdCny
  }
  if (raw.models !== null && typeof raw.models === 'object' && !Array.isArray(raw.models)) {
    for (const [model, entry] of Object.entries(raw.models as Record<string, unknown>)) {
      const normalizedModel = model.trim().toLowerCase()
      if (normalizedModel === '') continue
      const override = normalizeOverride(entry)
      if (override !== null) config.models[normalizedModel] = override
    }
  }
  return config
}

let configCache: { value: BoardConfig; at: number } | null = null

async function loadConfig(): Promise<BoardConfig> {
  if (configCache !== null && Date.now() - configCache.at < 10_000) return configCache.value
  let config: BoardConfig
  try {
    config = normalizeConfig(JSON.parse(await readFile(configPath(), 'utf8')))
  } catch {
    config = normalizeConfig(null)
  }
  configCache = { value: config, at: Date.now() }
  return config
}

async function saveConfig(config: BoardConfig): Promise<void> {
  const file = configPath()
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  configCache = { value: config, at: Date.now() }
}

/* ───────────────────────── 索引 ───────────────────────── */

interface IndexState {
  cache: IndexCacheFile
  scannedAt: number
  stats: ScanStats
  scanning: Promise<void> | null
}

async function rescan(state: IndexState): Promise<void> {
  const result = await scanSessions(dshHomeDir(), state.cache)
  state.cache = result.cache
  state.stats = result.stats
  state.scannedAt = Date.now()
  await saveCache(result.cache).catch(() => undefined)
}

async function ensureIndex(state: IndexState, force: boolean): Promise<void> {
  if (state.scanning !== null) {
    // 已有扫描在跑：等它完成即可（它用的是最新指纹）。
    await state.scanning
    return
  }
  if (!force && Date.now() - state.scannedAt < RESCAN_TTL_MS) return
  const job = rescan(state).finally(() => {
    state.scanning = null
  })
  state.scanning = job
  await job
}

/* ───────────────────────── HTTP plumbing ───────────────────────── */

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体超过上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const RANGE_SET = new Set<string>(['1d', '7d', '30d', 'all'])

export function apply(ctx: Context): void {
  const state: IndexState = {
    cache: { version: 1, sessions: {}, indexedAt: 0 },
    scannedAt: 0,
    stats: { sessions: 0, folders: 0, reindexed: 0, failed: 0, bytes: 0 },
    scanning: null,
  }

  ctx.inject(['webServer'], (httpCtx) => {
    const web = httpCtx.webServer
    httpCtx.effect(() => {
      // 启动后预热索引（失败不阻塞服务）。
      void loadCache().then((cached) => {
        state.cache = cached
        void ensureIndex(state, false).catch(() => undefined)
      })

      const disposeSummary = web.register({
        kind: 'exact',
        path: `${API_BASE}/summary`,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            const url = new URL(req.url ?? '/', 'http://dsh-usage-board.local')
            if (req.method !== 'GET') {
              res.setHeader('allow', 'GET')
              sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'method not allowed' })
              return
            }
            const range = url.searchParams.get('range') ?? '7d'
            if (!RANGE_SET.has(range)) {
              sendJson(res, 400, { error: 'BAD_RANGE', message: 'range 必须是 1d / 7d / 30d / all 之一' })
              return
            }
            const refresh = url.searchParams.get('refresh') === '1'
            const config = await loadConfig()
            const started = Date.now()
            await ensureIndex(state, refresh)
            const summary = buildSummary(state.cache, { range: range as RangeKey, config })
            summary.tookMs = Date.now() - started
            summary.scanned.reindexed = state.stats.reindexed
            sendJson(res, 200, summary)
          } catch (error) {
            sendJson(res, 500, { error: 'INTERNAL', message: error instanceof Error ? error.message : String(error) })
          }
        },
      })

      const disposePricing = web.register({
        kind: 'exact',
        path: `${API_BASE}/pricing`,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (req.method !== 'GET') {
              res.setHeader('allow', 'GET')
              sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'method not allowed' })
              return
            }
            sendJson(res, 200, emptyPricingResponse(await loadConfig()))
          } catch (error) {
            sendJson(res, 500, { error: 'INTERNAL', message: error instanceof Error ? error.message : String(error) })
          }
        },
      })

      const disposeConfig = web.register({
        kind: 'exact',
        path: `${API_BASE}/config`,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          try {
            if (req.method === 'GET') {
              sendJson(res, 200, await loadConfig())
              return
            }
            if (req.method === 'PUT') {
              let parsed: unknown
              try {
                parsed = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8'))
              } catch (error) {
                sendJson(res, 400, { error: 'INVALID_JSON', message: error instanceof Error ? error.message : '请求体不是合法 JSON' })
                return
              }
              const config = normalizeConfig(parsed)
              await saveConfig(config)
              sendJson(res, 200, config)
              return
            }
            res.setHeader('allow', 'GET, PUT')
            sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'method not allowed' })
          } catch (error) {
            sendJson(res, 500, { error: 'INTERNAL', message: error instanceof Error ? error.message : String(error) })
          }
        },
      })

      ctx.logger?.info?.(`[${name}] API ready: ${API_BASE}/summary | /pricing | /config`)
      return () => {
        disposeSummary()
        disposePricing()
        disposeConfig()
      }
    }, `${name}: board api`)
  })
}
