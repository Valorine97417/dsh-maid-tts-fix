/**
 * tts-firstseg-e2e.mjs —— 「首段兜底」端到端探针（readScope=first-segment）
 *
 * 场景：回复里**没写** `<!--tts:…-->` 标记时，`readScope=first-segment` 该念什么。
 * 协议是「念首段（约 160 字，上限 240，下限 50）」，且必须在**清洗之后**的首段上算，
 * 否则会把 CSS / 卡片当首段念出来（0.6.3 那次事故就是这么来的）。
 *
 * 做法：**不抠零散函数**——本探针直接 import 落盘的真实文本模块
 * `lib/text-B7NACAYZ.js`（它有标准 ESM 导出），跑完整链路：
 *   prepareTtsText（剥 CSS/卡片/路径/符号）→ splitTtsSegments → 取首段
 * 这样验的是「上游 3.0.9 的真实切段逻辑 + 我们补丁的真实清洗逻辑」串起来的结果。
 *
 * 文件名带哈希，随上游构建变化——按内容找：含 `function removeTtsMarkup(value) {`
 * 且导出 `prepareTtsText` 的那个。
 *
 * 跑法：node _probe/tts-firstseg-e2e.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const LIB = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-xiaomi-tts', 'lib')
if (!fs.existsSync(LIB)) {
  console.error(`✗ 找不到 dsh-xiaomi-tts/lib：${LIB}`)
  process.exit(1)
}

/** 按内容找文本模块（3.0.8 是 shared-<hash>.js，3.0.9 是 text-<hash>.js）。 */
function findTextModule() {
  for (const name of fs.readdirSync(LIB)) {
    if (!name.endsWith('.js') || name === 'client.js' || name === 'index.js' || name === 'shared.js') continue
    const full = path.join(LIB, name)
    const text = fs.readFileSync(full, 'utf8')
    if (text.includes('function removeTtsMarkup(value) {') && text.includes('prepareTtsText')) return full
  }
  return null
}

const TEXT_MODULE = findTextModule()
if (!TEXT_MODULE) {
  console.error('✗ lib/ 下找不到含 removeTtsMarkup 与 prepareTtsText 的文本模块')
  console.error('  上游产物结构可能又变了，更新本探针的 findTextModule 判据。')
  process.exit(1)
}

const mod = await import(pathToFileURL(TEXT_MODULE).href)

/**
 * 上游产物用**短名导出**（rolldown 摇树后的别名）：`export { prepareTtsText as h, … }`。
 * 所以不能按原名取，得先把 `X as Y` 的映射解出来，再按原名反查。
 * 直接写 `mod.prepareTtsText` 会 undefined——这正是本探针第一版栽的地方。
 */
function resolveExports(moduleNs, source) {
  const table = {}
  for (const m of source.matchAll(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    table[m[1]] = m[2]
  }
  return (longName) => {
    if (typeof moduleNs[longName] === 'function') return moduleNs[longName]
    const alias = table[longName]
    return alias && typeof moduleNs[alias] === 'function' ? moduleNs[alias] : undefined
  }
}

const textSource = fs.readFileSync(TEXT_MODULE, 'utf8')
const pick = resolveExports(mod, textSource)
const prepareTtsText = pick('prepareTtsText')
const splitTtsSegments = pick('splitTtsSegments')
const countTtsSpeechCharacters = pick('countTtsSpeechCharacters')
const firstTtsSegment = pick('firstTtsSegment')
for (const [name, fn] of Object.entries({ prepareTtsText, splitTtsSegments, countTtsSpeechCharacters, firstTtsSegment })) {
  if (typeof fn !== 'function') {
    console.error(`✗ 文本模块缺少导出 ${name}（短名别名表里也没有）`)
    process.exit(1)
  }
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

console.log(`文本模块：${path.basename(TEXT_MODULE)}\n`)

// ── ① 无标记长文：首段不超过 240 字（上限），且明显短于全文 ─────────
// 别断言「段数 > 1」——那是切段实现的内部细节，对样本长度极敏感，很容易报假失败
// （被坑过两次）。协议真正承诺的是：**念出来的东西受 240 字上限约束**。
// 所以给一个远超上限的长文，断言「首段 ≤ 240 且明显短于全文」才是稳的判据。
const PARAGRAPH =
  '第一句说明这件事的起因，写得长一点让它够一个完整语义段，顺便把当时的环境也交代清楚。'
const LONG = Array.from({ length: 8 }, (_, i) => `第${i + 1}句${PARAGRAPH}`).join('')

const cleaned = prepareTtsText(LONG)
const first = firstTtsSegment(cleaned)
const firstLen = countTtsSpeechCharacters(first)
const fullLen = countTtsSpeechCharacters(cleaned)
check(
  '无标记长文：首段不超过 240 个可念字符（上限契约）',
  firstLen <= 240,
  `首段 ${firstLen} 字 / 全文 ${fullLen} 字：「${first.slice(0, 40)}…」`,
)
check(
  '无标记长文：首段明显短于全文（证明确实只念了开头）',
  firstLen < fullLen,
  `首段 ${firstLen} 字 / 全文 ${fullLen} 字`,
)
check('无标记长文：首段不是空串', firstLen > 0, `首段「${first}」`)
check('无标记长文：首段以句读收尾，不是拦腰截断', /[。！？.!?]$/.test(first.trim()), `结尾「${first.slice(-6)}」`)

// ── ② 带 CSS / 卡片的回复：首段里不许有标题栏样式 ────────────────
const CARD = '<div id="vcp-root"><div style="background:linear-gradient(#123,#456)"><span>卡片大字标题</span><p>卡片里的说明</p></div></div>'
const DIRTY = `正文第一句，讲的是正经事。\n${CARD}\n<style>.x-9f{display:flex;color:#fff}</style>\n正文第二句，继续讲。`
const dirtyFirst = firstTtsSegment(prepareTtsText(DIRTY))
check('带 CSS/卡片：首段里没有 CSS 残留', !/<style|display:|linear-gradient|\.x-9f/.test(dirtyFirst), `首段「${dirtyFirst}」`)
check('带 CSS/卡片：首段里没有卡片文字', dirtyFirst.indexOf('卡片大字标题') < 0, `首段「${dirtyFirst}」`)
check('带 CSS/卡片：首段仍保留了正文', dirtyFirst.includes('正文第一句'), `首段「${dirtyFirst}」`)

// ── ③ 纯卡片回复：不许念成空 ────────────────────────────────────
const ONLY_CARD = `只有一张卡片，前面没正文。\n${CARD}`
const onlyFirst = firstTtsSegment(prepareTtsText(ONLY_CARD))
check('纯卡片回复：结果非空（不许念成空）', onlyFirst.trim().length > 0, `结果「${onlyFirst}」`)
check('纯卡片回复：剩下的必须是卡片外的正文，不是卡片内文字', !onlyFirst.includes('卡片大字标题'), `结果「${onlyFirst}」`)

// ── ④ 标记已被上游剥掉（清洗入口在标记提取之后，所以标记不该出现在这里）──
const MARKED = '正文前半。\n<!--tts:这句才是要念的。-->\n正文后半。'
const markedCleaned = prepareTtsText(MARKED)
check('清洗后标记不再存在（标记在更上游被提取，这里只剩正文）', markedCleaned.indexOf('tts:') < 0, `结果「${markedCleaned}」`)

// ── ⑤ 英文长段也不许无限念 ──────────────────────────────────────
const EN = 'This is a deliberately long English paragraph meant to test that the first segment limiter also applies to Latin text without cutting in the middle of a word, which would sound broken when spoken aloud by the synthesizer.'
const enFirst = firstTtsSegment(prepareTtsText(EN))
check('英文长段：首段不超过 240 个可念字符', countTtsSpeechCharacters(enFirst) <= 240, `${countTtsSpeechCharacters(enFirst)} 字`)
check('英文长段：不在单词中间截断', /\w$/.test(enFirst.trim()) === false || /[\s.,!?]$/.test(enFirst), `结尾「${enFirst.slice(-12)}」`)

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
  console.log('\n提示：先 node scripts/patch.mjs verify 确认补丁落盘；切段行为属上游，别乱改。')
}

console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
