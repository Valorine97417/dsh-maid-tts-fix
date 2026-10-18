/**
 * tts-mark-audit.mjs —— 统计真实会话里「写了标记」的回复占比
 *
 * 用途：验证 TROUBLESHOOTING §2.3 那个论断——**纪律型机制（"每条回复都写标记"）必漏**。
 * 光靠感觉说"经常漏"没有说服力；把历史会话日志解出来数一遍，漏多少一目了然。
 *
 * 数据源：`$DSH_HOME/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd`
 *
 * **两个坑（都踩过）**：
 *   1. 文件名带版本号：`session.v4.jsonl.zstd`，不是 `session.jsonl.zstd`。
 *   2. 这是 **append-only 多帧 zstd**：每写一次追加一个独立帧，一个 20MB 会话有上万帧。
 *      `zstdDecompressSync` **只解第一帧**（于是只拿到 `{"type":"session",...}` 一行）；
 *      Node 的流式 Zstd 也不暴露「这帧吃了多少字节」（`bytesWritten` 恒为 0）。
 *      正确做法是按帧 magic `28 B5 2F FD` 切分，从每个 magic 起尝试解到下一个 magic。
 *      压缩数据内部也可能出现同样的字节序列，所以解失败就扩到更远的 magic 重试。
 *   3. 记录类型是 `assistant/message`，不是 `message`（早期版本形态不同，两种都认）。
 *
 * 判据：正文里出现 `<!-- tts:` 或 `<!--tts:` 即算"写了标记"。
 * 注意这是**宽松判据**——写了但写错位置也算"写了"，真实覆盖率只会更低。
 *
 * 跑法：
 *   node _probe/tts-mark-audit.mjs                 # 扫最近 20 个会话
 *   node _probe/tts-mark-audit.mjs --limit 100     # 扫最近 100 个
 *   node _probe/tts-mark-audit.mjs --session <id>  # 只看一个会话
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const LIMIT = Number(argValue('--limit') ?? 20)
const ONLY = argValue('--session')

if (!fs.existsSync(SESSIONS_ROOT)) {
  console.error(`✗ 找不到会话目录：${SESSIONS_ROOT}`)
  console.error('  可用 DSH_HOME 环境变量指定 DSH 根目录。')
  process.exit(1)
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解一个多帧 zstd 文件。
 * @param {Buffer} buf
 * @returns {string}
 */
function decompressAllFrames(buf) {
  const positions = []
  let cursor = 0
  while (cursor < buf.length) {
    const at = buf.indexOf(ZSTD_MAGIC, cursor)
    if (at === -1) break
    positions.push(at)
    cursor = at + 4
  }
  if (positions.length === 0) return ''

  const parts = []
  let index = 0
  while (index < positions.length) {
    const start = positions[index]
    let advanced = false
    for (let probe = index + 1; probe <= positions.length; probe += 1) {
      const stop = probe < positions.length ? positions[probe] : buf.length
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(start, stop)))
        index = probe
        advanced = true
        break
      } catch {
        // 切分点落在压缩数据内部，扩到下一个 magic 再试
      }
    }
    if (!advanced) break
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 递归找出所有 session*.jsonl.zstd。 */
function findSessions(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      findSessions(full, out)
    } else if (/^session.*\.jsonl\.zstd$/.test(entry.name)) {
      out.push({ file: full, mtime: fs.statSync(full).mtimeMs })
    }
  }
  return out
}

/** 从一条记录里取 assistant 正文；不是 assistant 正文返回 undefined。 */
function assistantText(record) {
  // 现行形态（v4 日志）：
  //   { type:'assistant/message', seq, time, data:{ turn, step, message:{ role, content:[...] } } }
  // 正文在 **data.message** 下，不在 record.message 下——早先按 record.message 取，
  // 结果是「扫了 12 个会话、0 条回复」的静默空转。content 里混着 reasoning 文本，
  // 只收 type === 'text' 的部分（reasoning 不该被念，也不该被要求写标记）。
  // 旧形态：{ type:'message', message:{ role:'assistant', content } }
  let content
  if (record?.type === 'assistant/message') {
    content = record.data?.message?.content ?? record.message?.content ?? record.content
  } else if (record?.type === 'message' && record.message?.role === 'assistant') {
    content = record.message.content
  } else {
    return undefined
  }
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
  return parts.length === 0 ? undefined : parts.join('\n')
}

const MARK_RE = /<!--\s*tts\s*:/
const sessions = findSessions(SESSIONS_ROOT)
  .sort((a, b) => b.mtime - a.mtime)
  .filter((s) => (ONLY === undefined ? true : s.file.includes(ONLY)))
  .slice(0, LIMIT)

if (sessions.length === 0) {
  console.error('✗ 没找到任何 session*.jsonl.zstd')
  process.exit(1)
}

let totalReplies = 0
let marked = 0
const perSession = []

for (const session of sessions) {
  let text
  try {
    text = decompressAllFrames(fs.readFileSync(session.file))
  } catch (error) {
    console.log(`  （跳过 ${path.basename(path.dirname(session.file))}：${error.message}）`)
    continue
  }
  let replies = 0
  let withMark = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const body = assistantText(record)
    if (body === undefined) continue
    if (body.includes('meow-memory-reflect')) continue
    replies += 1
    if (MARK_RE.test(body)) withMark += 1
  }
  if (replies === 0) continue
  totalReplies += replies
  marked += withMark
  perSession.push({
    id: path.basename(path.dirname(session.file)),
    replies,
    withMark,
  })
}

perSession.sort((a, b) => b.replies - a.replies)

console.log(`会话根目录：${SESSIONS_ROOT}`)
console.log(`扫描会话数：${perSession.length}（上限 ${LIMIT}）\n`)

console.log('—— 回复最多的 10 个会话 ——')
for (const row of perSession.slice(0, 10)) {
  const pct = ((row.withMark / row.replies) * 100).toFixed(0)
  console.log(`  ${row.withMark}/${row.replies} 条写标记（${pct}%）  ${row.id}`)
}

const missing = totalReplies - marked
const pct = totalReplies === 0 ? 0 : (marked / totalReplies) * 100

console.log('\n—— 汇总 ——')
console.log(`  assistant 正文回复总数：${totalReplies}`)
console.log(`  写了标记的：          ${marked}（${pct.toFixed(1)}%）`)
console.log(`  没写标记的：          ${missing}（${(100 - pct).toFixed(1)}%）`)

// 这不是"失败"，是测量结果——覆盖率本来就该被看见，而不是被断言成 100%。
if (missing > 0) {
  console.log(`\n结论：${missing} 条回复没写标记，会退回"念首段"兜底。`)
  console.log('      这正是 TROUBLESHOOTING §2.3 说的：纪律型机制必漏，得靠机制兜底（readScope=first-segment + 卡片剥离）。')
  console.log('      **本探针不判失败**——它测量现状，不给纪律打分。')
} else if (totalReplies === 0) {
  console.log('\n没扫到任何 assistant 正文（会话日志形态可能又变了，核对 assistantText 的判据）。')
} else {
  console.log('\n结论：全部回复都写了标记。')
}
