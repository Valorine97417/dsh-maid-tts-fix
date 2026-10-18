/**
 * tts-card-strip-probe.mjs —— 卡片剥离的**原型级**探针（比 tts-card-regress 更细）
 *
 * 分工，别搞混：
 *   - `tts-card-strip-probe.mjs`（本文件）：只验 `stripTtsCards` 这一个函数的边界，
 *     逐条对形态。改这个函数时先跑它——它不是端到端，是手术刀。
 *   - `tts-card-regress.mjs`：拿真实回复形态走「卡片 + 样式」的串联链路，验组合。
 *
 * 为什么单独留一个原型级：`stripTtsCards` 用 **div 配平**而非非贪婪正则
 * （见 TROUBLESHOOTING §2.10），配平逻辑的边界是嵌套、无闭合、空 div。
 * 这类细节在端到端用例里被稀释，只有单函数级用例才看得出来。
 *
 * **期望值全部照实现推，不照直觉推**。真实实现有三条容易被想当然的契约：
 *   ① 只对含 `vcp-root` 的文本动手（`value.indexOf("vcp-root") < 0` 直接原样返回）
 *   ② 按 `<div>` / `</div>` 深度配平，找不齐闭合就整个放弃（`if (end < 0) break`）
 *   ③ **剥完只剩空白时回退原文**（`joined.trim().length === 0 ? value : joined`）——
 *      这是有意的：纯卡片回复交给后续 `MARKDOWN_HTML_TAG_RE` 把标签去掉、留下可见文字。
 *      代价就是 §2.10 记的那个现象「听着像它在读屏幕」。想改这条行为要先改事故单。
 *
 * 跑法：node _probe/tts-card-strip-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const CLIENT = path.join(PROFILE, 'node_modules', 'dsh-xiaomi-tts', 'lib', 'client.js')

const source = fs.readFileSync(CLIENT, 'utf8')
const marker = 'function stripTtsCards(value) {'
const start = source.indexOf(marker)
if (start === -1) {
  console.error('✗ 产物里找不到 stripTtsCards —— 补丁没落盘')
  process.exit(1)
}
const end = source.indexOf('\n}\n', start)
const fnSrc = source.slice(start, end + 2)

const context = vm.createContext({})
vm.runInContext(fnSrc, context)
const stripTtsCards = context.stripTtsCards

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
const norm = (s) => s.replace(/\s+/g, ' ').trim()

console.log(`抠出真实 stripTtsCards（${fnSrc.length} 字符）\n`)

const CARD = '<div id="vcp-root"><div class="a">卡内</div></div>'
const CARD2 = '<div id="vcp-root"><div class="row">新增 7 条</div></div>'

const cases = [
  // ① 有正文兜着 → 卡片被剥净、正文都在
  ['① 卡片 + 前置正文：卡片剥净、正文留下', `前${CARD}`, '前'],
  ['② 卡片 + 后置正文：卡片剥净、正文留下', `${CARD}后`, '后'],
  // 实现是 `kept.join(" ")`，两张之间的结合处必然留一个空格——朗读时无害，
  // 但比对时要把这条算进去（按"无空格"写期望会报假失败）。
  ['③ 卡片夹在中间：两侧正文拼接（中间留一个空格）', `甲${CARD}乙`, '甲 乙'],
  // ② 不含 vcp-root 的 div 一律不动
  ['④ 不含 vcp-root 的 div 原样返回（不乱剥普通 HTML）', '<div class="x">普通</div>', '<div class="x">普通</div>'],
  ['⑤ 无卡片纯正文原样返回', '纯正文一段。', '纯正文一段。'],
  // ③ 纯卡片 → 回退原文（有意为之，交给后续 HTML 标签剥离）
  ['⑥ 纯卡片回退原文（有意：交给 MARKDOWN_HTML_TAG_RE 收尾）', CARD2, CARD2],
  // ④ 配不平就整个放弃，不许剥一半把正文吃掉
  ['⑦ 未闭合卡片：配不平则原样返回（不吞正文）', '<div id="vcp-root">卡里没闭合', '<div id="vcp-root">卡里没闭合'],
  ['⑧ 空字符串原样返回', '', ''],
  ['⑨ 纯空白原样返回', '   ', '   '],
]

for (const [name, input, expected] of cases) {
  let got
  try {
    got = stripTtsCards(input)
  } catch (error) {
    check(name, false, `抛错 ${error.message}`)
    continue
  }
  check(name, norm(got) === norm(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got)}`)
}

// ⑩ 关键：卡片与正文共存时，卡内可见文字**必须**一起走（这是 §2.10 的修法）
const mixed = `说明一句。${CARD2}收尾一句。`
const mixedOut = stripTtsCards(mixed)
check(
  '⑩ 卡片与正文共存时卡内文字一起剥净',
  !mixedOut.includes('新增 7 条') && mixedOut.includes('说明一句') && mixedOut.includes('收尾一句'),
  `结果是 ${JSON.stringify(mixedOut)}：卡内文字漏出来就会被念成"它在读屏幕"`,
)

// ⑪ 多张卡片都要剥（配平循环不能只处理第一张）
const twoCards = `甲${CARD}乙${CARD2}丙`
const twoOut = stripTtsCards(twoCards)
check(
  '⑪ 多张卡片全部剥净（配平循环不只处理第一张）',
  !twoOut.includes('卡内') && !twoOut.includes('新增 7 条') && twoOut.includes('甲') && twoOut.includes('丙'),
  `结果是 ${JSON.stringify(twoOut)}`,
)

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
  console.log('\n提醒：⑥「纯卡片回退原文」是设计不是 bug——它把收尾交给 MARKDOWN_HTML_TAG_RE。')
  console.log('      真要改这条，先改 TROUBLESHOOTING §2.10，别在探针里改期望值糊过去。')
}
console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
