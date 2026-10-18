/**
 * tts-fix-replay-test.mjs —— 补丁意图的可重放性验证（**最有价值的那个探针**）
 *
 * 为什么它最能说明问题：其它探针验的是「落盘产物对不对」，这个验的是
 * 「**给定干净上游，我们的编辑清单能不能一字不差地重放出来**」。
 * 只有它能在改过 `lib/edits-v309.js` 之后、还没来得及 redo 之前，
 * 就告诉你这份意图是否还能落在锚点上。
 *
 * 做法：
 *   ① 拿干净上游（未经补丁的 dsh-xiaomi-tts@<版本> 原始产物）
 *   ② 用本仓 `planEdits()` 的真实编辑清单在内存里逐条 apply
 *   ③ 把结果与 profile 里**已落盘**的补丁产物逐字节比较
 *   ④ 顺带核每条编辑的 `expect` 命中数，以及产物语法（node --check）
 *
 * 干净上游来源按优先级找：
 *   - `--upstream <目录>` 显式指定
 *   - `D:\Works By DSH\update-audit-artifacts\dsh-xiaomi-tts\package`（审计时留的 npm 解包）
 *   - `pnpm store` 里解不出来就跳过，别假装验过
 *
 * 跑法：node _probe/tts-fix-replay-test.mjs [--upstream <dir>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { planEdits, packageVersionOf } from '../lib/edits.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(HERE, '..')
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const PACKAGE = 'dsh-xiaomi-tts'

const UPSTREAM_CANDIDATES = [
  path.join('D:', 'Works By DSH', 'update-audit-artifacts', PACKAGE, 'package'),
]

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function findUpstream() {
  const explicit = argValue('--upstream')
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined
  return UPSTREAM_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'package.json')))
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

const installedRoot = path.join(PROFILE, 'node_modules', PACKAGE)
if (!fs.existsSync(installedRoot)) {
  console.error(`✗ 找不到已安装的 ${PACKAGE}：${installedRoot}`)
  process.exit(1)
}

const upstream = findUpstream()
if (upstream === undefined) {
  console.error('✗ 找不到干净上游（--upstream <dir> 指定，或把 npm 解包放到 update-audit-artifacts/）')
  console.error('  没有干净基线就没法验重放——跳过比假装验过好。')
  process.exit(1)
}

const upstreamVersion = JSON.parse(fs.readFileSync(path.join(upstream, 'package.json'), 'utf8')).version
const installedVersion = packageVersionOf(installedRoot)
console.log(`干净上游：${upstream}（${upstreamVersion}）`)
console.log(`已安装：  ${installedRoot}（${installedVersion}）\n`)

check(`上游版本与已安装版本一致（${upstreamVersion}）`, upstreamVersion === installedVersion, `上游 ${upstreamVersion} ≠ 已安装 ${installedVersion}：基线拿错版本，重放对比没有意义`)
if (upstreamVersion !== installedVersion) {
  console.log('\n中止：版本不一致时不继续，否则比对的是两个不同上游。')
  process.exit(1)
}

// ① 干净上游里必须**没有**补丁标记（否则这目录本身已被污染）
const upstreamClient = fs.readFileSync(path.join(upstream, 'lib', 'client.js'), 'utf8')
check('上游是干净的（不含补丁标记）', !upstreamClient.includes('function stripTtsStyleBlocks(value) {'), '该目录已被打过补丁，不能当基线')

// ② 用真实编辑清单在内存里重放
//    `planEdits(dir, load)` 的返回结构是
//    { ok, already, applied, failed, contents, targetFiles }：
//    - `contents` 是 Map<绝对路径, 重放后文本>（只在 ok && !already 时给）
//    - `applied` 是已应用编辑的 id 数组
//    - `failed` 每项 { edit, found, eol }
//    `already: true` 表示目标目录里该补丁已全应用（用干净上游时不该出现）。
const readFile = (file) => fs.readFileSync(file, 'utf8')
let plan
try {
  plan = planEdits(upstream, readFile)
} catch (error) {
  console.error(`✗ planEdits 抛错：${error.message}`)
  process.exit(1)
}

if (plan.already === true) {
  console.error('✗ 上游目录已经打好了全部标记（planEdits 走 already 短路）——这个目录不是干净基线')
  process.exit(1)
}

const targetList = Array.isArray(plan.targetFiles) ? plan.targetFiles : Object.values(plan.targetFiles ?? {})
console.log(`编辑清单：${plan.applied.length + plan.failed.length} 条（已应用 ${plan.applied.length} / 失败 ${plan.failed.length}）`)
console.log(`目标文件：${targetList.map((p) => path.basename(p)).join('  ')}\n`)

// ③ 逐条编辑的锚点命中数
for (const f of plan.failed) {
  console.log(`  ✗ [${f.edit.id}] ${f.edit.file}：期望命中 ${f.edit.expect} 处，实际 ${f.found} 处（eol=${f.eol}）`)
  console.log(`      ${f.edit.why ?? ''}`)
}
check(
  '每条编辑的 expect 命中数全部对上',
  plan.failed.length === 0,
  `${plan.failed.length} 条对不上：上游改了这几行，锚点已失效，得改 lib/edits-v309.js`,
)

if (plan.ok !== true) {
  console.error('\n中止：重放失败，没有产物可比对。')
  process.exit(1)
}

// ④ 重放结果 == 已落盘产物（逐字节）
//
// 两个形态细节必须照实现来，不能凭直觉：
//   - `targetFiles` 是**数组**（`[targets.client, targets.text]`），不是 {client, text}
//   - `contents` 的键是 `` `${packageRoot}/${file}` `` **字符串拼接**（正斜杠），
//     不是 path.join 出来的反斜杠路径。用 path.join 取键会永远取不到 → 假失败。
const replayed = new Map()
for (const realRel of plan.targetFiles) {
  const key = `${upstream}/${realRel}`
  const produced = plan.contents.get(key)
  const logical = path.basename(realRel)
  if (produced === undefined) {
    check(`④ ${logical} 重放产物存在`, false, `contents 里没有键 ${key}（现有键：${[...plan.contents.keys()].join(', ')}）`)
    continue
  }
  replayed.set(realRel, { output: produced, source: readFile(path.join(upstream, realRel)) })

  const installedPath = path.join(installedRoot, realRel)
  if (!fs.existsSync(installedPath)) {
    check(`④ ${logical} 重放产物 == 已落盘产物`, false, `已落盘文件不存在：${installedPath}`)
    continue
  }
  const installed = readFile(installedPath)
  const same = installed === produced
  check(`④ ${logical} 重放产物 == 已落盘产物`, same, same ? '' : detailDiff(produced, installed))
}

function detailDiff(replayed, installed) {
  const a = crypto.createHash('sha256').update(replayed).digest('hex').slice(0, 16)
  const b = crypto.createHash('sha256').update(installed).digest('hex').slice(0, 16)
  const lines = [`重放 ${replayed.length} 字符 sha=${a}`, `落盘 ${installed.length} 字符 sha=${b}`]
  // 找第一处差异，给出上下文（比整份 diff 好读）
  const limit = Math.min(replayed.length, installed.length)
  for (let i = 0; i < limit; i += 1) {
    if (replayed[i] !== installed[i]) {
      lines.push(`首处差异 @${i}：重放 ${JSON.stringify(replayed.slice(Math.max(0, i - 40), i + 40))}`)
      lines.push(`                  落盘 ${JSON.stringify(installed.slice(Math.max(0, i - 40), i + 40))}`)
      break
    }
  }
  if (replayed.length !== installed.length && limit === Math.min(replayed.length, installed.length)) {
    lines.push('（前缀相同，长度不同——落盘产物可能是旧版本补丁重做的）')
  }
  lines.push('处置：node scripts/patch.mjs redo 让落盘产物回到当前编辑清单')
  return lines.join('\n    ')
}

// ⑤ 重放产物语法必须过
for (const [realRel, slot] of replayed) {
  const label = path.basename(realRel)
  const tmp = path.join(os.tmpdir(), `tts-replay-${label}-${process.pid}.js`)
  fs.writeFileSync(tmp, slot.output, 'utf8')
  let ok = true
  let message = ''
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
  } catch (error) {
    ok = false
    message = String(error.stderr ?? error.message).split('\n').slice(0, 4).join('\n    ')
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
  check(`⑤ 重放产物 node --check（${label}）`, ok, message)
}

// ⑥ 编辑条数不小于 3.0.9 的已知形态
const editTotal = plan.applied.length + plan.failed.length
check(`编辑条数 = ${editTotal}（3.0.9 应 ≥ 32）`, editTotal >= 32, `只有 ${editTotal} 条：编辑清单可能被截断`)

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
}

console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
