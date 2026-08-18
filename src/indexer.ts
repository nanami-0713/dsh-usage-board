/**
 * @dsh-external/dsh-usage-board — 会话日志索引器（host 侧）。
 *
 * 扫描 ~/.dsh/sessions/<folder>/<session>/session.jsonl.zstd 的全部记录：
 *   - `session`                → 会话元信息（id / cwd / createdAt / origin）
 *   - `request/header`         → 该请求的 provider / model（一条请求一个 header）
 *   - `assistant/chunk`(usage) → 流式 usage 采样（请求失败也保留）
 *   - `assistant/message`      → 最终 usage（同一 turn/step 覆盖前者，不双计）
 * 每个 (turn, step) 只保留最后一次 usage（与 dsh-token-meter 的 last-wins 投影
 * 语义一致），再按「北京时区小时 × 模型」聚合成桶。
 *
 * 增量缓存：每个会话文件记录 mtime+size 指纹，未变化的直接复用缓存条目，
 * 缓存持久化在 ~/.dsh/plugins/dsh-usage-board/cache.json（原子写入）。
 */
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { hourKeyOf } from './pricing.js'

/** 一「模型 × 小时」桶的 token 计数。 */
export interface BucketCounts {
  /** 未缓存输入 tokens。 */
  i: number
  /** 缓存读取 tokens。 */
  c: number
  /** 缓存写入 tokens。 */
  w: number
  /** 输出 tokens。 */
  o: number
  /** 计费调用次数。 */
  n: number
}

export interface SessionIndexData {
  id: string
  folder: string
  cwd: string | null
  createdAt: number | null
  origin: string | null
  /** hourKey → model → counts。 */
  buckets: Record<string, Record<string, BucketCounts>>
  /** model → provider 路由集合（来自 request/header）。 */
  modelProviders: Record<string, string[]>
}

export interface SessionCacheEntry extends SessionIndexData {
  fp: { mtimeMs: number; size: number }
}

export interface IndexCacheFile {
  version: 1
  /** key = `<folder>/<sessionDirName>`（相对 sessions 根的稳定路径）。 */
  sessions: Record<string, SessionCacheEntry>
  indexedAt: number
}

export interface ScanStats {
  sessions: number
  folders: number
  reindexed: number
  failed: number
  bytes: number
}

export interface ScanResult {
  cache: IndexCacheFile
  stats: ScanStats
}

const LOG_FILE = 'session.jsonl.zstd'

export function dshHomeDir(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function sessionsDir(home = dshHomeDir()): string {
  return join(home, 'sessions')
}

export function pluginDataDir(home = dshHomeDir()): string {
  return join(home, 'plugins', 'dsh-usage-board')
}

export function cachePath(home = dshHomeDir()): string {
  return join(pluginDataDir(home), 'cache.json')
}

export function emptyCache(): IndexCacheFile {
  return { version: 1, sessions: {}, indexedAt: 0 }
}

export async function loadCache(home?: string): Promise<IndexCacheFile> {
  try {
    const raw = JSON.parse(await readFile(cachePath(home), 'utf8')) as IndexCacheFile
    if (raw !== null && typeof raw === 'object' && raw.version === 1 && raw.sessions !== null && typeof raw.sessions === 'object') {
      return raw
    }
  } catch {
    // 首次运行 / 缓存损坏：全量重建。
  }
  return emptyCache()
}

export async function saveCache(cache: IndexCacheFile, home?: string): Promise<void> {
  const file = cachePath(home)
  await mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(cache), 'utf8')
  await rename(tmp, file)
}


/* ─────────────────── 多帧 zstd 解码（DSH 会话日志 = 逐批追加的帧拼接） ─────────────────── */

const ZSTD_MAGIC = 4247762216

interface ZstdFrameRange {
  start: number
  end: number
}

/**
 * 扫描 zstd 帧结构定位完整帧边界（不解压块内容）。
 * 结构解析参照 zstd 格式规范（RFC 8878）：magic → 帧头描述符 →（窗口/字典/内容长度）
 * → 数据块链（3 字节块头：last/type/size）→ 可选 xxhash 校验。
 * 末尾不完整帧（正被并发写入）返回已扫描到的完整帧，等待下次扫描补齐。
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameRange[] {
  const frames: ZstdFrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break // 撕裂的尾部帧：跳过。
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid zstd frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bits at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** 解码全部完整帧并拼接；单帧文件退化为一次 zstdDecompressSync。 */
export function decompressAll(compressed: Buffer): Buffer {
  const frames = scanZstdFrames(compressed)
  if (frames.length === 0) return Buffer.alloc(0)
  if (frames.length === 1) return zstdDecompressSync(compressed.subarray(frames[0].start, frames[0].end))
  const parts = frames.map((frame) => zstdDecompressSync(compressed.subarray(frame.start, frame.end)))
  return Buffer.concat(parts)
}

interface UsageSample {
  turn: number
  step: number
  time: number
  model: string | null
  provider: string | null
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

interface ParsedSession {
  data: SessionIndexData
  bytes: number
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 解压并折叠一份会话日志（纯函数，供测试直接调用）。 */
export function parseSessionLog(buffer: Buffer, folder: string): SessionIndexData {
  const text = buffer.toString('utf8')
  let id = ''
  let cwd: string | null = null
  let createdAt: number | null = null
  let origin: string | null = null
  let model: string | null = null
  let provider: string | null = null
  /** `${turn}:${step}` → 最后一次 usage。 */
  const samples = new Map<string, UsageSample>()

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let record: any
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    const type: string = record.type
    const data = record.data
    if (type === 'session') {
      // 真实日志中 id/cwd/createdAt/origin 在记录顶层（data 为空），兼容两种位置。
      const pickStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
      id = pickStr(record.id) ?? pickStr(data?.id) ?? id
      cwd = pickStr(record.cwd) ?? pickStr(data?.cwd)
      const created = typeof record.createdAt === 'number' ? record.createdAt : data?.createdAt
      if (typeof created === 'number' && created > 0) createdAt = created
      origin = pickStr(record.origin) ?? pickStr(data?.origin)
    } else if (type === 'request/header') {
      const config = data?.header?.config
      if (typeof config?.model === 'string' && config.model !== '') model = config.model
      if (typeof config?.provider === 'string' && config.provider !== '') provider = config.provider
    } else if (type === 'assistant/chunk') {
      const chunk = data?.chunk
      if (chunk?.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') {
        const usage = chunk.usage
        samples.set(`${data?.turn}:${data?.step}`, {
          turn: num(data?.turn),
          step: num(data?.step),
          time: typeof record.time === 'number' ? record.time : 0,
          model,
          provider,
          input: num(usage.inputTokens),
          cacheRead: num(usage.cacheReadTokens),
          cacheWrite: num(usage.cacheWriteTokens),
          output: num(usage.outputTokens),
        })
      }
    } else if (type === 'assistant/message') {
      const usage = data?.usage
      if (usage !== null && typeof usage === 'object') {
        // 最终 usage 覆盖同 (turn,step) 的流式采样，避免双计。
        samples.set(`${data?.turn}:${data?.step}`, {
          turn: num(data?.turn),
          step: num(data?.step),
          time: typeof record.time === 'number' ? record.time : 0,
          model,
          provider,
          input: num(usage.inputTokens),
          cacheRead: num(usage.cacheReadTokens),
          cacheWrite: num(usage.cacheWriteTokens),
          output: num(usage.outputTokens),
        })
      }
    }
  }

  const buckets: Record<string, Record<string, BucketCounts>> = {}
  const modelProviders: Record<string, string[]> = {}
  for (const sample of samples.values()) {
    if (sample.time <= 0 || (sample.model === null && sample.input + sample.cacheRead + sample.cacheWrite + sample.output === 0)) continue
    const hourKey = hourKeyOf(sample.time)
    const modelName = sample.model ?? '(unknown)'
    if (sample.provider !== null && !((modelProviders[modelName] ??= []).includes(sample.provider))) {
      modelProviders[modelName].push(sample.provider)
    }
    const byModel = (buckets[hourKey] ??= {})
    const counts = (byModel[modelName] ??= { i: 0, c: 0, w: 0, o: 0, n: 0 })
    counts.i += sample.input
    counts.c += sample.cacheRead
    counts.w += sample.cacheWrite
    counts.o += sample.output
    counts.n += 1
  }

  return { id, folder, cwd, createdAt, origin, buckets, modelProviders }
}

/** 读取并解析一个会话日志文件。 */
async function indexSessionFile(file: string, folder: string): Promise<ParsedSession | null> {
  let buffer: Buffer
  try {
    const compressed = await readFile(file)
    buffer = decompressAll(compressed)
  } catch {
    return null
  }
  return { data: parseSessionLog(buffer, folder), bytes: buffer.byteLength }
}

/**
 * 扫描 sessions 根下所有文件夹的全部会话；未变化的复用缓存。
 * 单个文件解析失败（正在写入 / 损坏）跳过并计入 failed，不中断整体。
 */
export async function scanSessions(home: string, previous: IndexCacheFile, forceSessionKey?: string): Promise<ScanResult> {
  const sessions: Record<string, SessionCacheEntry> = {}
  const stats: ScanStats = { sessions: 0, folders: 0, reindexed: 0, failed: 0, bytes: 0 }
  const root = sessionsDir(home)

  let folderNames: string[] = []
  try {
    folderNames = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { cache: { ...previous, indexedAt: Date.now() }, stats }
  }

  for (const folder of folderNames) {
    let sessionDirNames: string[] = []
    try {
      sessionDirNames = (await readdir(join(root, folder), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }
    stats.folders += 1

    for (const sessionDirName of sessionDirNames) {
      const file = join(root, folder, sessionDirName, LOG_FILE)
      const key = `${folder}/${sessionDirName}`
      let fp: { mtimeMs: number; size: number }
      try {
        const info = await stat(file)
        fp = { mtimeMs: Math.floor(info.mtimeMs), size: info.size }
      } catch {
        continue // 无日志文件的目录（如仅剩元数据）。
      }
      stats.sessions += 1

      const cached = previous.sessions[key]
      if (
        cached !== undefined && forceSessionKey !== key &&
        cached.fp.mtimeMs === fp.mtimeMs && cached.fp.size === fp.size &&
        cached.folder === folder
      ) {
        sessions[key] = cached
        continue
      }

      const parsed = await indexSessionFile(file, folder)
      if (parsed === null) {
        stats.failed += 1
        // 保留旧缓存条目，避免半写文件把已有数据冲掉。
        if (cached !== undefined) sessions[key] = cached
        continue
      }
      stats.reindexed += 1
      stats.bytes += parsed.bytes
      sessions[key] = { ...parsed.data, fp }
    }
  }

  return { cache: { version: 1, sessions, indexedAt: Date.now() }, stats }
}
