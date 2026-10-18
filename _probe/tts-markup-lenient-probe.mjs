/**
 * tts-markup-lenient-probe.mjs —— 残缺标记的宽容剥离行为
 *
 * 对应 TROUBLESHOOTING §4.1 / §4.2 与 README「写残也认」那一节。
 * 要同时验两侧：
 *   - **朗读侧**（本仓补丁）：写残的标记也认，走 `(?:--|>)(?=\s*(?:\n|$))` 兜底
 *   - **渲染侧**（vcp 的 stripHtmlComments）：未闭合注释不许吞掉后文
 *
 * 两侧必须一起验——只验一侧会出现「不念但显形」或「不显形但念全文」，
 * 这正是这一对补丁最经典的耦合失效（见 TROUBLESHOOTING 2.10 / 2.11 对照）。
 *
 * 跑法：node _probe/tts-markup-lenient-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const CLIENT = path.join(PROFILE, 'node_modules', 'dsh-xiaomi-tts', 'lib', 'client.js')
const VCP_INJECT = path.join('D:', 'DeepSeek Harness', 'Works', 'dsh-maid-vcp', 'patch', 'v6-inject.js')

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

// ── 朗读侧：抠真实 extractTtsSpokenOverride ────────────────────────────────
const client = fs.readFileSync(CLIENT, 'utf8')
const marker = 'function extractTtsSpokenOverride(value) {'
const start = client.indexOf(marker)
if (start === -1) {
  console.error('✗ 产物里找不到 extractTtsSpokenOverride —— 补丁没落盘')
  process.exit(1)
}
const end = client.indexOf('\n}\n', start)
const spokenSrc = client.slice(start, end + 2)

const ctx = vm.createContext({})
vm.runInContext(spokenSrc, ctx)
const extract = ctx.extractTtsSpokenOverride
console.log(`朗读侧：抠出真实 extractTtsSpokenOverride（${spokenSrc.length} 字符）`)

// 表驱动：写全 / 写残 / 行中比较符不该误认
//
// 「写残只剩 `>`」这条的期望是**能认出来**，不是认不出——因为兜底正则
// `(?:--|>)(?=\s*(?:\n|$))` 里 `>` 后面紧跟换行就成立，行尾那三个字
// 属于标记内容，会被一起念出来。这是善后行为，不是许可。
const spokenCases = [
  ['完整写全 `-->`', '正文。\n<!--tts:只念这句。-->\n后文。', '只念这句。'],
  ['写残只剩 `--`', '正文。\n<!--tts:只念这句。--\n后文。', '只念这句。'],
  ['写残只剩 `>`（行尾就是 `>`）', '正文。\n<!--tts:只念这句。>\n后文。', '只念这句。'],
  ['写残只剩 `>`（`>` 前还有字，也算）', '正文。\n<!--tts:只念这句。了。>\n后文。', '只念这句。了。'],
  ['文末残标记（无后文）', '正文。\n<!--tts:只念这句。--', '只念这句。'],
  ['多行内容压成单空格', '<!--tts:第一段\n第二段-->', '第一段 第二段'],
  ['空标记视为没写', '<!--tts:   -->', null],
  ['无标记', '就是普通正文。', null],
  ['行中比较符不当收尾', '老大 > 小困 是称呼关系。', null],
  ['只认第一个标记', '<!--tts:甲-->\n<!--tts:乙-->', '甲'],
]
for (const [name, input, expected] of spokenCases) {
  let got
  try {
    got = extract(input)
  } catch (error) {
    check(`朗读侧：${name}`, false, `抛错 ${error.message}`)
    continue
  }
  const norm = got === undefined ? null : got
  check(`朗读侧：${name}`, norm === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(norm)}`)
}

// 静态核兜底判据还在（写残容错靠的就是它）
check(
  '朗读侧：兜底判据 `(?:--|>)(?=\\s*(?:\\n|$))` 在',
  client.includes('(?:--|>)(?=\\s*(?:\\n|$))'),
  '兜底正则不见了：写残的标记会退回念全文',
)

// ── 渲染侧：抠真实 stripHtmlComments ─────────────────────────────────────
if (!fs.existsSync(VCP_INJECT)) {
  console.log(`\n（跳过渲染侧：找不到 ${VCP_INJECT}）`)
} else {
  const vcp = fs.readFileSync(VCP_INJECT, 'utf8')
  const s = vcp.indexOf('var HTML_COMMENT_RE')
  const e = vcp.indexOf('function escapeUnclosedRawtext', s)
  if (s === -1 || e === -1) {
    check('渲染侧：抠出 stripHtmlComments', false, '找不到 var HTML_COMMENT_RE 或 function escapeUnclosedRawtext')
  } else {
    const vctx = vm.createContext({})
    vm.runInContext(vcp.slice(s, e), vctx)
    const strip = vctx.stripHtmlComments
    console.log(`\n渲染侧：抠出真实 stripHtmlComments（${e - s} 字符）`)

    // 期望值全部照 `stripHtmlComments` 的实现推，不照文档字面推：
    //   - 完整标记 `<!--...-->` 被替换成**空串**，两侧换行都还在 → 留一个空行
    //   - 未闭合标记在 lenient（`lenient === true`）下吃掉所在整行含行尾换行
    //   - lenient !== true（非流式）时**从头截断**，后面全没
    // 第三参缺省表示「按流式那侧传 true」，显式传 false 才是非流式。
    const renderCases = [
      ['完整标记被剥净（两侧换行保留 → 留一个空行）', '正文。\n<!--tts:只念这句。-->\n后文。', '正文。\n\n后文。', true],
      ['未闭合标记吃掉本行（含行尾换行）', '正文。\n<!--tts:半截\n后文还在。', '正文。\n后文还在。', true],
      ['未闭合标记 + 空行分隔，后文保住', '正文。\n<!--tts:半截\n\n后文还在。', '正文。\n\n后文还在。', true],
      ['非流式（lenient=false）：从头截断，后文全没', '正文。\n<!--tts:半截\n后文还在。', '正文。\n', false],
      ['无注释原样返回', '就是普通正文。', '就是普通正文。', true],
    ]
    for (const [name, input, expected, lenient] of renderCases) {
      let got
      try {
        got = lenient === undefined ? strip(input) : strip(input, lenient)
      } catch (error) {
        check(`渲染侧：${name}`, false, `抛错 ${error.message}`)
        continue
      }
      check(`渲染侧：${name}`, got === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(got)}`)
    }
  }
}

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
  console.log('\n提醒：这条要两侧一起绿才算数——只打一侧会「不念但显形」或「不显形但念全文」。')
}
console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
