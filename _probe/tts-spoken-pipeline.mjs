/**
 * tts-spoken-pipeline.mjs —— 「只念重点」走完整清洗链的三段对照
 *
 * 比 `tts-spoken-probe.mjs` 更进一步：那个只验 `extractTtsSpokenOverride` 单函数，
 * 本探针验**它在真实处理链里的位置**——三段输入各喂一遍，看最终念什么。
 *
 * 三段：
 *   ① 有标记 + 有卡片 + 有 CSS  → 只念标记里那句（其余全被剥、且标记优先）
 *   ② 无标记 + 有卡片 + 有 CSS  → 走 readScope 兜底（念首段），卡片与 CSS 不许漏
 *   ③ 有标记但写残           → 仍认标记（善后，不是许可）
 *
 * 判据的核心是**顺序**：`extractTtsSpokenOverride` 必须在 `prepareSpeechText` 清洗之前跑。
 * 顺序反了的话，标记里的 `<!--tts:` 会被当成 HTML 注释剥掉 → 标记失效、退回念全文。
 * 这是这条链路唯一真正脆弱的地方（见 TROUBLESHOOTING §2.9「流式旁路漏挂」）。
 *
 * 跑法：node _probe/tts-spoken-pipeline.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const CLIENT = path.join(PROFILE, 'node_modules', 'dsh-xiaomi-tts', 'lib', 'client.js')
const source = fs.readFileSync(CLIENT, 'utf8')

function cutFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`产物里找不到 function ${name}(`)
  const end = source.indexOf('\n}\n', start)
  return source.slice(start, end + 2)
}

const constantLines = source
  .split('\n')
  .filter((line) => /^const MARKDOWN_[A-Z_]+\s*=/.test(line) && /;\s*$/.test(line))

const context = vm.createContext({ console })
vm.runInContext(
  [
    ...constantLines,
    cutFunction('extractTtsSpokenOverride'),
    cutFunction('stripTtsStyleBlocks'),
    cutFunction('stripTtsCards'),
  ].join('\n'),
  context,
)
const { extractTtsSpokenOverride, stripTtsStyleBlocks, stripTtsCards } = context

let pass = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    pass += 1
    console.log(`✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

/** 模拟补丁在 messageText 里的真实顺序：先取标记，取到就直接用；取不到才走清洗链。 */
function whatGetsRead(raw) {
  const override = extractTtsSpokenOverride(raw)
  if (override !== undefined) return { source: '标记', text: override }
  const cleaned = stripTtsCards(stripTtsStyleBlocks(raw))
  return { source: '兜底（清洗后全文）', text: cleaned }
}

const CARD = '<div id="vcp-root"><style>#vcp-root{color:red}</style><div class="row">卡内可见文字</div></div>'

console.log(`源文件：${CLIENT}\n`)

// ① 有标记：只念标记，卡片与 CSS 都别想漏进来
const case1 = `正文开头。\n<!--tts:这一句才是要念的。-->\n${CARD}\n正文结尾。`
const r1 = whatGetsRead(case1)
check('① 有标记 → 念标记那句', r1.source === '标记' && r1.text === '这一句才是要念的。', `实际来自 ${r1.source}，内容是 ${JSON.stringify(r1.text)}`)
check('① 标记内容里不含卡片文字', !r1.text.includes('卡内可见文字'), `念出来的内容含卡片文字：${JSON.stringify(r1.text)}`)
check('① 标记内容里不含 CSS', !r1.text.includes('color:red'), `念出来的内容含 CSS：${JSON.stringify(r1.text)}`)

// ② 无标记：走兜底，但卡片与 CSS 必须已经剥净
const case2 = `第一段正文。\n${CARD}\n第二段正文。`
const r2 = whatGetsRead(case2)
check('② 无标记 → 走兜底路径', r2.source.startsWith('兜底'), `实际来自 ${r2.source}`)
check('② 兜底内容不含卡片文字', !r2.text.includes('卡内可见文字'), `兜底内容含卡片文字：${JSON.stringify(r2.text)}`)
check('② 兜底内容不含 CSS', !r2.text.includes('color:red'), `兜底内容含 CSS：${JSON.stringify(r2.text)}`)
check('② 兜底内容保留正文', r2.text.includes('第一段正文') && r2.text.includes('第二段正文'), `兜底内容丢了正文：${JSON.stringify(r2.text)}`)

// ③ 写残的标记也认
const case3 = `开头。\n<!--tts:写残了也要念这句。--\n${CARD}`
const r3 = whatGetsRead(case3)
check('③ 写残标记 → 仍认标记（善后行为）', r3.source === '标记' && r3.text.includes('写残了也要念这句'), `实际来自 ${r3.source}，内容是 ${JSON.stringify(r3.text)}`)

// ④ 顺序契约：三处挂载点都必须早于清洗
// 三处挂载点里接收变量名各不相同，照抄时容易张冠李戴（写错过一次）：
//   messageText            → const spokenOverride = ...
//   applyTtsPlaybackScope  → const override = ...
//   applyTtsLivePlaybackScope → const spokenOverride = ...
const mounts = [
  ['messageText', /const spokenOverride = extractTtsSpokenOverride\(rawText\);[\s\S]{0,400}?prepareSpeechText/],
  ['applyTtsPlaybackScope', /const override = extractTtsSpokenOverride\(value\);[\s\S]{0,400}?firstTtsSegments/],
  ['applyTtsLivePlaybackScope', /const spokenOverride = extractTtsSpokenOverride\(value\);[\s\S]{0,400}?prepareTtsText/],
]
for (const [name, re] of mounts) {
  check(`④ ${name} 里标记提取早于清洗`, re.test(source), '顺序反了：标记会被当 HTML 注释剥掉 → 退回念全文')
}

// ⑤ 提取函数必须恰好被调用三次（三处挂载点，少一处就有一条路漏）
const calls = source.split('extractTtsSpokenOverride(').length - 1
const definitions = source.split('function extractTtsSpokenOverride(').length - 1
check('⑤ 三处挂载点都在（调用 3 次 + 定义 1 次）', calls === 4 && definitions === 1, `出现 ${calls} 次（应为 4 = 1 定义 + 3 调用），定义 ${definitions} 处`)

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
  console.log('\n要害：标记提取必须早于 HTML 注释剥离，否则标记形同没写。')
}
console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
