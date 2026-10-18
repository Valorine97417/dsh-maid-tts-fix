/**
 * tts-spoken-probe.mjs —— 「只念重点」标记提取行为探针
 *
 * 验的是 dsh-maid-tts-fix 最核心的那条协议：回复里写了 `<!--tts:…-->` 就只念它。
 *
 * **不抄源码**：从落盘的 `node_modules/dsh-xiaomi-tts/lib/client.js` 里按顶格 `\n}\n`
 * 抠出真实的 `extractTtsSpokenOverride`，在 node:vm 里求值后跑用例。改一行补丁，
 * 探针跟着变——这才叫「验的是这份代码」。
 *
 * 同时核三处挂载点是否都在（这是 README/TROUBLESHOOTING 反复强调的要害）：
 *   ① `messageText`               —— 手动点朗读
 *   ② `applyTtsPlaybackScope`      —— 跨会话自动播报
 *   ③ `applyTtsLivePlaybackScope`  —— 主视图流式旁路（0.6.4 补的第三处）
 * 三处都必须在 `prepareTtsText` / `prepareSpeechText` 清洗**之前**拿到原文。
 *
 * 跑法：node _probe/tts-spoken-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// profile 在家目录下，别拿 HERE 往上数——本仓在 D 盘、profile 在 C 盘。
const CLIENT = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-xiaomi-tts', 'lib', 'client.js')
// 路径写死得很丑，但 profile 就在那儿。找不到就直接说清楚，别静默跳过。
if (!fs.existsSync(CLIENT)) {
  console.error(`✗ 找不到落盘的 client.js：${CLIENT}`)
  console.error('  先确认 dsh-xiaomi-tts 已装进 profile（node scripts/patch.mjs verify）。')
  process.exit(1)
}
const src = fs.readFileSync(CLIENT, 'utf8')

/**
 * 抠一个顶格声明的函数体。
 * 不能用花括号计数——函数体里有正则与模板串，计数会被带偏（血泪教训）。
 */
function cutFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`client.js 里找不到 function ${name}( —— 补丁可能没落盘`)
  const end = source.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`function ${name} 找不到顶格收尾`)
  return source.slice(start, end + 3)
}

const fnSrc = cutFunction(src, 'extractTtsSpokenOverride')
const context = vm.createContext({})
vm.runInContext(fnSrc, context)
const extract = context.extractTtsSpokenOverride
if (typeof extract !== 'function') throw new Error('抠出来的 extractTtsSpokenOverride 不可调用')

let pass = 0
const failures = []
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass += 1
    console.log(`✓ ${name}`)
  } else {
    failures.push({ name, actual, expected })
    console.log(`✗ ${name}`)
    console.log(`    实际 ${JSON.stringify(actual)}`)
    console.log(`    期望 ${JSON.stringify(expected)}`)
  }
}

console.log(`源文件：${CLIENT}`)
console.log(`抠出 ${fnSrc.length} 字符的真实 extractTtsSpokenOverride\n`)

// ── 标记提取本身 ────────────────────────────────────────────────
check('完整标记 → 只念标记内容', extract('正文第一段。\n<!--tts:只念这句。-->\n正文第二段。'), '只念这句。')

check('标记独占一行', extract('<!--tts:就这一句-->'), '就这一句')

check('无标记 → undefined（走原逻辑）', extract('正文第一段。\n正文第二段。'), undefined)

check('空标记 → undefined（视为没写，不许念成空）', extract('正文。\n<!--tts:   -->\n后文。'), undefined)

check(
  '多行标记 → 换行与连续空白压成单空格',
  extract('正文。\n<!--tts:第一句。\n   第二句。-->\n后文。'),
  '第一句。 第二句。',
)

check('多个标记 → 只认第一个', extract('<!--tts:甲-->\n中间\n<!--tts:乙-->'), '甲')

check('标记在文末', extract('正文。\n<!--tts:结尾这句。-->'), '结尾这句。')

// ── 写残容错（收尾语 / 行内出现 ＞）──────────────────────────
check(
  '写残：结尾只剩 --（认行尾）',
  extract('正文。\n<!--tts:念这句。--\n后面的正文。'),
  '念这句。',
)

check(
  '写残：写成 了。>（认行尾的 >）',
  extract('正文。\n<!--tts:念这句。了。>\n后面的正文。'),
  '念这句。了。',
)

check(
  '普通比较符不许当收尾（老大 > 小困 在行中）',
  extract('正文。\n<!--tts:只念这句。-->\n老大 > 小困'),
  '只念这句。',
)

check(
  '行内比较符不在行尾 → 不匹配残缺形态',
  extract('<!--tts:甲 > 乙 丙-->'),
  '甲 > 乙 丙',
)

// ── 三处挂载点 ─────────────────────────────────────────────────
const mounts = [
  {
    label: '① messageText（手动朗读）',
    marker: 'const spokenOverride = extractTtsSpokenOverride(rawText);',
    before: 'prepareSpeechText(rawText)',
  },
  {
    label: '② applyTtsPlaybackScope（跨会话自动播报）',
    marker: 'const override = extractTtsSpokenOverride(value);',
    before: 'firstTtsSegments(value, 2)',
  },
  {
    label: '③ applyTtsLivePlaybackScope（主视图流式旁路）',
    marker: 'const spokenOverride = extractTtsSpokenOverride(value);',
    before: 'prepareTtsText(value)',
  },
]

for (const m of mounts) {
  const at = src.indexOf(m.marker)
  if (at < 0) {
    failures.push({ name: m.label, actual: '未找到挂载标记', expected: m.marker })
    console.log(`✗ ${m.label}：未找到挂载标记`)
    continue
  }
  // 同一行标记出现两次时（②③），用「后面紧邻的函数体里是否先于清洗调用」判断
  const window = src.slice(at, at + 400)
  const cleaningAt = window.indexOf(m.before)
  const ok = cleaningAt > 0
  if (ok) {
    pass += 1
    console.log(`✓ ${m.label}（挂载在清洗之前）`)
  } else {
    failures.push({ name: m.label, actual: window.slice(0, 120), expected: `清洗调用 ${m.before} 在标记之后` })
    console.log(`✗ ${m.label}：挂载点不在清洗之前`)
  }
}

// 三处必须各自独立存在（数量核对：定义 1 + 调用 3 = 4）
const total = src.split('extractTtsSpokenOverride').length - 1
check('extractTtsSpokenOverride 出现 4 次（1 定义 + 3 调用）', total, 4)

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const f of failures) console.log(`✗ ${f.name}`)
  console.log('\n提示：补丁可能没落盘或锚点漂了，跑 node scripts/patch.mjs verify 与 redo。')
}

console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
