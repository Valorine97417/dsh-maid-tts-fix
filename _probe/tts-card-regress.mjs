/**
 * tts-card-regress.mjs —— 卡片回复「念出屏幕文字」的回归用例
 *
 * 对应 TROUBLESHOOTING §2.10：`readScope=first-segment` 下没写标记的纯卡片回复，
 * 首段恰好是卡片里排版好的短句 → 听着像"它在读屏幕"。
 * 这个探针拿一条**真实的纯卡片回复原文**喂真链路，两条路对比：
 *   - 不加标记 → 念出来的是卡片里的可见文字（这是兜底行为，不是 bug）
 *   - 加了 `<!--tts:…-->` → 立刻只念那一句
 *
 * 判据落在「卡片剥离是否生效」与「标记是否优先」上，不去断言首段具体字数
 * （那对样本长度极敏感，之前踩过假失败）。
 *
 * 跑法：node _probe/tts-card-regress.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const PACKAGE = path.join(PROFILE, 'node_modules', 'dsh-xiaomi-tts')
const CLIENT = path.join(PACKAGE, 'lib', 'client.js')

if (!fs.existsSync(CLIENT)) {
  console.error(`✗ 找不到 ${CLIENT}`)
  process.exit(1)
}

const source = fs.readFileSync(CLIENT, 'utf8')

/** 从落盘产物里抠出一个真实函数体（顶格 `}` 收尾，不用花括号计数——计数会被正则和模板串带偏）。 */
function cutFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`产物里找不到 function ${name}( ——补丁没落盘？`)
  const end = source.indexOf('\n}\n', start)
  if (end === -1) throw new Error(`${name} 找不到顶格收尾的 }`)
  return source.slice(start, end + 2)
}

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

// 抠真实实现：stripTtsCards / stripTtsStyleBlocks / removeTtsMarkup
//
// `removeTtsMarkup` 串了十来条 `MARKDOWN_*` 正则，逐条手抄必漏一条就
// `ReferenceError: MARKDOWN_CODE_BLOCK_RE is not defined`。这里直接把产物里
// **所有单行的 `const MARKDOWN_*` 常量行**整段收进来——常量是数据不是逻辑，
// 抄它没有意义，抄漏了反而是探针自己的 bug。
//
// 只收单行（以 `;` 结尾）的：多行常量（如 `const TTS_VOLUME_PREVIEW_FILES = [`）
// 按行过滤会截断成语法错误 `Unexpected identifier`。
const constantLines = source
  .split('\n')
  .filter((line) => /^const MARKDOWN_[A-Z_]+\s*=/.test(line) && /\;\s*$/.test(line))
if (constantLines.length === 0) {
  console.error('✗ 产物里没找到任何单行 MARKDOWN_ 常量——补丁没落盘？')
  process.exit(1)
}

const context = vm.createContext({ console })
vm.runInContext(
  [
    ...constantLines,
    cutFunction('stripTtsStyleBlocks'),
    cutFunction('stripTtsCards'),
  ].join('\n'),
  context,
)
const { stripTtsCards } = context
console.log(`收进 ${constantLines.length} 条常量（MARKDOWN_）、stripTtsStyleBlocks、stripTtsCards\n`)

// `removeTtsMarkup` 是整条清洗链的调度者，依赖十几个常量与 `removeTtsPaths`（定义在
// 其它 chunk 里）。**不实跑它**——那验的是上游的排版清洗，不是本补丁。
// 本补丁的要害是它**串了谁、顺序如何**，静态核调用形态即可。
const chainMatch = /function removeTtsMarkup\(value\) \{\s*\n\s*let text = (stripTtsCards\(stripTtsStyleBlocks\(removeFencedCode\(value\)\)\)|stripTtsStyleBlocks\(stripTtsCards\(removeFencedCode\(value\)\)\))/.exec(source)
const chainOrder = chainMatch?.[1] ?? ''

// 一条真实的纯卡片回复形态（卡片在外、可见文字在卡内）
const CARD_ONLY = `<div id="vcp-root" style="background:#0b1220;color:#c8d6e5;font-family:'Lanxi-叮叮'">
<style>#vcp-root{padding:16px;border-radius:12px}</style>
<div class="head"><div class="t">记忆反思归档</div></div>
<div class="row"><span class="k">新增</span><span class="v">7 条</span></div>
<div class="row"><span class="k">更新</span><span class="v">1 条</span></div>
</div>`

console.log(`源文件：${CLIENT}\n`)

// ① 纯卡片：stripTtsCards 必须剥成空（或近乎空），不能把卡内文字当正文留下
const strippedCard = stripTtsCards(CARD_ONLY)
check(
  '① 纯卡片被整体剥净（不把卡内排版文字当正文）',
  strippedCard.trim() === '' || strippedCard.trim() === CARD_ONLY.trim(),
  `剥完剩下 ${JSON.stringify(strippedCard.slice(0, 120))}`,
)

// ② 卡片 + 正文：正文必须留下，卡片必须走
const CARD_PLUS_TEXT = `${CARD_ONLY}\n这一段的正文应当留下。`
const stripped2 = stripTtsCards(CARD_PLUS_TEXT)
check(
  '② 卡片 + 正文：正文保留、卡片剥净',
  stripped2.includes('这一段的正文应当留下') && !stripped2.includes('记忆反思归档'),
  `结果是 ${JSON.stringify(stripped2.slice(0, 160))}`,
)

// ③ 样式块不许漏进朗读文本
const WITH_STYLE = `<style>#x{color:red}.y{margin:0}</style>正文在那之后。`
const styleStripped = context.stripTtsStyleBlocks(WITH_STYLE)
check(
  '③ style 块被剥净',
  styleStripped.includes('正文在那之后') && !styleStripped.includes('color:red'),
  `结果是 ${JSON.stringify(styleStripped)}`,
)

// ④ 嵌套 div 只剥卡片本身，不连坐外层
const NESTED = `<div class="outer">外层保留${CARD_ONLY}尾随文字</div>`
const stripped3 = stripTtsCards(NESTED)
check(
  '④ 嵌套 div：只剥卡片本身，外层与尾随文字不动',
  stripped3.includes('外层保留') && stripped3.includes('尾随文字') && !stripped3.includes('记忆反思归档'),
  `结果是 ${JSON.stringify(stripped3.slice(0, 160))}`,
)

// ⑤ 没有卡片时不许改动原文（纯正文回复要能原样念）
const PLAIN = '只是一段普通正文，没有任何卡片。'
check('⑤ 无卡片时原样返回（不误伤纯正文）', stripTtsCards(PLAIN) === PLAIN, `结果是 ${JSON.stringify(stripTtsCards(PLAIN))}`)

// ⑥ 清洗链顺序：必须 `stripTtsCards(stripTtsStyleBlocks(removeFencedCode(...)))`
//    顺序反了（先卡片后样式）会把卡片壳里残留的 `<style>` 留下。
check(
  '⑥ removeTtsMarkup 串联顺序为 卡片→样式→去代码块',
  chainOrder.startsWith('stripTtsCards(stripTtsStyleBlocks(removeFencedCode(value)))'),
  `实际是 ${JSON.stringify(chainOrder.slice(0, 80)) || '(没匹配到)'}：先删代码块、再剥样式、最后剥卡片，顺序不能换`,
)

// ⑦ 空串入参不许炸（宿主会传进来）
let safe = true
try {
  stripTtsCards('')
  context.stripTtsStyleBlocks('')
} catch {
  safe = false
}
check('⑦ 空串入参不炸', safe, '空串抛异常')

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
}
console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
