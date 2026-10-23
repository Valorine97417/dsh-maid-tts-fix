/**
 * 补丁意图的**分发器**：按 profile 里实际装着的上游版本，挑对应的意图模块。
 *
 * 为什么需要分发（2026-10-18）：上游 3.0.9 换了打包器（rolldown），产物形态与
 * 3.0.8 不是同一棵树——文本工具被拆进**带构建哈希**的独立 chunk（原
 * `lib/shared-DQIrhcy-.js` 消失），流式旁路从 `scopedLiveText` 换成了
 * `applyTtsLivePlaybackScope`，`PlaybackController` 的两个方法也多了一行。
 * 锚点是逐字的，跨版本必然整批失配——所以意图要按版本分家，**不能一份走天下**。
 *
 * 两个版本模块的共同契约（分发器只依赖这三样）：
 *   - `planEdits(packageRoot, readFile)` → `{ ok, already, applied, failed, contents, targetFiles }`
 *   - `buildEdits(targets)` / 各自的 `EDITS` 常量（条数供 CLI 打印）
 *   - `normalizeEol(text, needle)`
 *
 * 分派依据是**包自身的 `package.json` 版本**（不是 profile 里声明的版本号）——
 * 那才是磁盘上真实的代码。
 *
 * @module lib/edits
 */
import fs from 'node:fs'
import path from 'node:path'

import * as v308 from './edits-v308.js'
import * as v309 from './edits-v309.js'

/** 版本 → 意图模块。键是上游 `dsh-xiaomi-tts` 的**主次版本前缀**。 */
const BY_MINOR = new Map([
  ['3.0.8', v308],
  ['3.0.9', v309],
  // 4.2.0 与 3.0.9 共用一份意图：2026-10-22 实测 33 条里 32 条锚点逐字相同，唯一
  // 失配的挂载行已收窄成 `local.setStateChangeListener(...)`（两版逐字相同）→ 复制
  // 一整份 900 行的 edits-v420.js 得不偿失。见 TROUBLESHOOTING §1.17。
  ['4.2.0', v309],
])

/**
 * 读上游包自己的版本号。读不到返回 undefined。
 *
 * @param {string} packageRoot 上游包目录。
 */
export function packageVersionOf(packageRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 为某个版本挑意图模块。
 *
 * 未登记的版本回落到**最新的那个模块**：那样锚点失配时 `planEdits` 会明确
 * 报出「哪一条期望几次、实际几次」，而不是静默走旧模块把补丁打歪。宁可 loudly
 * 失败，也不要拿一份语义已经不匹配的锚点去猜。
 *
 * @param {string|undefined} version 上游包版本。
 * @returns {typeof v308}
 */
export function moduleFor(version) {
  if (typeof version === 'string') {
    // 先精确匹配，再退化到 `major.minor`（补丁常常跨 patch 版本仍然有效）。
    const minor = version.split('.').slice(0, 2).join('.')
    if (BY_MINOR.has(minor)) return BY_MINOR.get(minor)
  }
  return v309
}

/** 已知的意图模块（`list` 打印用）。 */
export function knownEditModules() {
  return [...BY_MINOR.keys()]
}

/**
 * 按磁盘上的上游版本重放补丁。这是 `patch.mjs` 唯一的入口。
 *
 * @param {string} packageRoot 解开的包目录。
 * @param {(file: string) => string} readFile 读文件（收绝对路径）。
 */
export function planEdits(packageRoot, readFile) {
  const version = packageVersionOf(packageRoot)
  return moduleFor(version).planEdits(packageRoot, readFile)
}

/**
 * 某个包目录对应的编辑条数（CLI 打印用）。
 *
 * `--dry-run` 时暂存树还没解出来，按内容发现目标会落空、算出偏小的假数字；
 * 那种情况优先用模块的名义条数。
 *
 * @param {string} packageRoot 包目录（可以是尚未解开的 staging）。
 * @param {(file: string) => string} [readFile]
 */
export function editCountOf(packageRoot, readFile) {
  const version = packageVersionOf(packageRoot)
  const mod = moduleFor(version)
  if (typeof mod.nominalEditCount === 'function') {
    const targets = typeof mod.discoverTargets === 'function'
      ? mod.discoverTargets(readFile ?? ((f) => fs.readFileSync(f, 'utf8')), safeLibFiles(packageRoot))
      : undefined
    // 两份文件都认出来了才按真实清单算，否则退回名义条数。
    if (targets !== undefined && targets.client !== '' && targets.text !== '') return mod.editCount(targets)
    return mod.nominalEditCount()
  }
  return Array.isArray(mod.EDITS) ? mod.EDITS.length : 0
}

/** `lib/*.js` 清单（读不到返回空数组）。 */
function safeLibFiles(packageRoot) {
  try {
    return fs.readdirSync(path.join(packageRoot, 'lib'))
      .filter((name) => name.endsWith('.js'))
      .map((name) => `lib/${name}`)
  } catch { return [] }
}

/**
 * 兼容出口：3.0.8 时代的 `TARGET_FILES`。**新代码不要用**——
 * 真实目标文件请从 `planEdits()` 返回的 `targetFiles` 里取（哈希名会变）。
 */
export const TARGET_FILES = v308.TARGET_FILES

/** 兼容出口：3.0.8 时代的静态编辑清单。新代码请用 `planEdits()`。 */
export const EDITS = v308.EDITS

export { normalizeEol } from './edits-v308.js'
