/**
 * tts-309-landed-check.mjs —— 「补丁到底落盘没有」四层核对
 *
 * 这是最该先跑的一个探针：**所有行为探针都是在这个前提上做的**。
 * 补丁没落盘，行为探针跑的可能是上游原版，会给你一堆「怎么都对」的假绿灯。
 *
 * 四层（对应 TROUBLESHOOTING 1.1 / 1.2 / 1.3 / 1.8）：
 *   ① 登记  —— profile 的 `pnpm-workspace.yaml` 里 patchedDependencies 钉的是哪个版本
 *   ② hash  —— `pnpm-lock.yaml` 里那条 patch_hash 必须等于补丁正本的 sha256
 *   ③ 落盘  —— 16 条 APPLIED_MARKERS 必须逐条命中真实文件（@client / @text 两类）
 *   ④ 版本  —— 装着的版本必须等于补丁钉的版本（不等 = 上游发新版了，该重做补丁）
 *
 * 直接复用本仓 `lib/selfcheck.js` 的 `inspectProfile`，不另写一套判据——
 * 那套逻辑就是宿主启动时真跑的，验它才叫验「线上那份」。
 *
 * 跑法：node _probe/tts-309-landed-check.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectProfile, describe as describeRows, APPLIED_MARKERS } from '../lib/selfcheck.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PATCH_DIR = path.join(HERE, '..', 'patches')
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

if (!fs.existsSync(PROFILE)) {
  console.error(`✗ 找不到 profile：${PROFILE}`)
  process.exit(1)
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

console.log(`profile：${PROFILE}`)
console.log(`补丁目录：${PATCH_DIR}\n`)

const result = inspectProfile(PROFILE, PATCH_DIR)
if (result.rows.length === 0) {
  console.error(`✗ ${PATCH_DIR} 下没找到任何补丁正本（patches/*.patch）`)
  process.exit(1)
}

console.log('—— selfcheck 原始输出 ——')
for (const line of describeRows(result.rows)) console.log('  ' + line)
console.log('')

for (const row of result.rows) {
  const tag = `${row.patch.packageName}@${row.patch.version}`
  check(`① 登记：${tag} 出现在 patchedDependencies`, row.registered, 'pnpm-workspace.yaml 里没有这条登记')
  check(
    `② hash：${tag} 的 lockfile patch_hash 与补丁正本一致`,
    row.hashMatches,
    `lockfile=${row.hash ?? '(缺失)'}  正本=${row.patch.sha256}`,
  )
  check(
    `④ 版本：装着的版本等于补丁钉的版本`,
    row.versionMatches,
    `装着 ${row.installed ?? '(未安装)'}，补丁钉 ${row.patch.version}`,
  )

  // `inspectApplied` 是**按文件聚合**的：每项 { file, state, hit?, total? }。
  // 早先这里按「每个标记一条记录」写（row2.marker），结果是永远匹配不上、
  // perFile 空、整条被判失败——判据读错库里真实返回结构，比没有判据更糟。
  const packageRoot = path.join(PROFILE, 'node_modules', row.patch.packageName)
  if (row.applied.length === 0) {
    check(`③ 落盘：${tag} 标记核对`, false, `inspectApplied 没返回任何目标文件（包目录 ${packageRoot}）`)
  }
  for (const slot of row.applied) {
    if (slot.state === 'missing-file') {
      check(`③ 落盘：${slot.file === '' || slot.file === '(未找到文本工具文件)' ? '文本工具文件' : path.basename(slot.file)} 能找到`, false, 'resolveMarkerFiles 未定位到该文件')
      continue
    }
    check(
      `③ 落盘：${path.basename(slot.file)} 标记 ${slot.hit}/${slot.total}`,
      slot.state === 'applied',
      `state=${slot.state}（not-applied = 补丁没落盘或上游改了那几行，跑 redo）`,
    )
  }
}

check('自检总判定 ok', result.ok, result.rows.filter((r) => !r.ok).map((r) => `${r.patch.packageName}@${r.patch.version}`).join(', '))

// 额外一条：16 条标记的规模本身也是判据（3.0.9 的形态）
check(`标记总数 = ${APPLIED_MARKERS.length}（3.0.9 应为 16）`, APPLIED_MARKERS.length === 16, `当前 ${APPLIED_MARKERS.length} 条`)

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
  console.log('\n处置：登记/hash 不对 → node scripts/patch.mjs install；落盘不对 → redo；版本不对 → 先升上游再 upgrade。')
}

console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
