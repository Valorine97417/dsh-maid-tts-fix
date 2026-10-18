/**
 * tts-text-probe.mjs —— 「不念 CSS / 不念卡片」行为探针
 *
 * 验 dsh-maid-tts-fix 最早期那两处补丁（0.6.0 CSS 剥离、0.6.3 卡片剥离）真的还在：
 *   ① `stripTtsStyleBlocks` —— `<style>` / `<script>` 不许被念出来；未闭合的
 *      在**流式中间帧**里截断（后面还没来的内容不能提前念）。
 *   ② `stripTtsCards`      —— `<div id="vcp-root">…</div>` 整块卡片不念（按 div 配平，
 *      不用非贪婪正则，嵌套卡片也剥得对），但**卡片外的正文必须留下**。
 *
 * **不抄源码**：从落盘的 client.js 抠真实函数。常量（三个 MARKDOWN_STYLE_*_RE）
 * 也一并从源文件抠，不手写——手写就等于验我自己抄得对不对。
 *
 * 跑法：node _probe/tts-text-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

// profile 在家目录下，别按脚本位置往上数——本仓在 D 盘、profile 在 C 盘。
const CLIENT = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-xiaomi-tts', 'lib', 'client.js')
if (!fs.existsSync(CLIENT)) {
  console.error(`✗ 找不到落盘的 client.js：${CLIENT}`)
  process.exit(1)
}
const src = fs.readFileSync(CLIENT, 'utf8')

/** 顶格收尾抠函数——不能用花括号计数（体内有正则，计数会偏）。 */
function cutFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`client.js 里找不到 function ${name}( —— 补丁可能没落盘`)
  const end = source.indexOf('\n}\n', start)
  if (end < 0) throw new Error(`function ${name} 找不到顶格收尾`)
  return source.slice(start, end + 3)
}

/** 抠一行 `const X = /…/flags;` 常量。 */
function cutConst(source, name) {
  const at = source.indexOf(`const ${name} = `)
  if (at < 0) throw new Error(`找不到常量 ${name}`)
  const eol = source.indexOf('\n', at)
  return source.slice(at, eol + 1)
}

const pieces = [
  cutConst(src, 'MARKDOWN_STYLE_BLOCK_RE'),
  cutConst(src, 'MARKDOWN_STYLE_OPEN_RE'),
  cutConst(src, 'MARKDOWN_STYLE_CLOSE_RE'),
  cutFunction(src, 'stripTtsStyleBlocks'),
  cutFunction(src, 'stripTtsCards'),
]
const context = vm.createContext({})
vm.runInContext(pieces.join('\n'), context)
const { stripTtsStyleBlocks, stripTtsCards } = context

let pass = 0
const failures = []
function check(name, actual, expect) {
  const ok = typeof expect === 'function' ? expect(actual) : JSON.stringify(actual) === JSON.stringify(expect)
  if (ok) {
    pass += 1
    console.log(`✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`✗ ${name}`)
    console.log(`    实际 ${JSON.stringify(actual)}`)
  }
}
const hasNoCss = (v) => !/<style|<\/?script|\.[a-zA-Z-]+\s*\{/.test(v)
const noCard = (v) => v.indexOf('vcp-root') < 0

console.log(`源文件：${CLIENT}\n`)

// ── ① CSS / script 剥离 ──────────────────────────────────────
check(
  '完整 <style> 块剥净，正文保留',
  stripTtsStyleBlocks('正文一。\n<style>.a{color:red}</style>\n正文二。'),
  (v) => hasNoCss(v) && v.includes('正文一。') && v.includes('正文二。'),
)

check(
  '完整 <script> 块也剥净',
  stripTtsStyleBlocks('正文。\n<script>alert(1)</script>\n后文。'),
  (v) => hasNoCss(v) && v.includes('正文。') && v.includes('后文。'),
)

check(
  '未闭合 <style>（流式中间帧）→ 从开标签处截断，不许念 CSS',
  stripTtsStyleBlocks('正文一。\n<style>.a{color:red'),
  (v) => hasNoCss(v) && v.includes('正文一。'),
)

check('没有 style 的普通文本原样返回', stripTtsStyleBlocks('正文一。\n正文二。').includes('正文二。'), true)

// ── ② 卡片剥离 ────────────────────────────────────────────────
const CARD = '<div id="vcp-root"><div class="card"><span>卡片里的字</span></div></div>'

check('整块卡片剥净', stripTtsCards(`正文。\n${CARD}\n后文。`), (v) => noCard(v) && v.includes('正文。') && v.includes('后文。'))

check('纯卡片 → 不许念成空（回退原文）', stripTtsCards(CARD), (v) => v.trim().length > 0)

check(
  '嵌套 div 只剥卡片本身',
  stripTtsCards(`前言。\n<div id="vcp-root"><div><div>x</div></div></div>\n结语。`),
  (v) => noCard(v) && v.includes('前言。') && v.includes('结语。'),
)

check('卡片在末尾时正文保留', stripTtsCards(`只有正文。\n${CARD}`), (v) => noCard(v) && v.includes('只有正文。'))

check('没有卡片的文本原样返回', stripTtsCards('正文一。'), '正文一。')

check('非字符串入参不炸', stripTtsCards(null), (v) => v === null)

// ── ③ 串联（removeTtsMarkup 的真实顺序：先卡片后样式）──────────
check(
  '串起来：CSS 与卡片都不念，正文全留',
  stripTtsCards(stripTtsStyleBlocks(`甲段。\n${CARD}\n<style>.b{}</style>\n乙段。`)),
  (v) => noCard(v) && hasNoCss(v) && v.includes('甲段。') && v.includes('乙段。'),
)

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
  console.log('\n提示：跑 node scripts/patch.mjs verify；确属未落盘就 redo。')
}

console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
