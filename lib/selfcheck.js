/**
 * 补丁体检 —— 纯函数，不写盘。
 *
 * 这个模块存在的理由是一个具体的伤口：2026-10-14 那次，CSS 剥离补丁是
 * 手改进 `node_modules/dsh-xiaomi-tts/lib/` 的，连同当时的 `*.bak` 备份一起，
 * 在装另一个插件触发的 pnpm 重铺中被**静默抹掉**——没有任何报错，直到
 * 用户点朗读、耳朵里又响起 CSS 才发现。改 node_modules 等于没改。
 *
 * 后来补丁转正成了 pnpm patch（登记在 `pnpm-workspace.yaml`，hash 在 lockfile），
 * 重铺会自动重打。但"自动"不等于"必然"：profile 换了、pnpm 版本变了、
 * 补丁文件被谁动过——都可能让它悄悄失效。所以需要一个**便宜的、随时能问的**
 * 体检：三件事各问一句，任一为否就喊。
 *
 * 三问（缺一不可，因为它们是三个独立的失效点）：
 *   1. 登记还在吗   —— `pnpm-workspace.yaml` 的 `patchedDependencies`
 *   2. hash 对得上吗 —— lockfile 的 `patch_hash` 是不是 `.patch` 正本的 sha256
 *   3. 字节落盘了吗 —— 上游包里那两处文件真的含补丁特征吗
 *
 * @module lib/selfcheck
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 补丁落盘后必然出现的特征串。改补丁时同步改这里——它是"补丁在不在"的判据。 */
export const APPLIED_MARKERS = Object.freeze([
  { file: 'lib/client.js', marker: 'function stripTtsStyleBlocks(value) {' },
  { file: 'lib/shared-DQIrhcy-.js', marker: 'function stripTtsStyleBlocks(value) {' },
  { file: 'lib/client.js', marker: 'function extractTtsSpokenOverride(value) {' },
  { file: 'lib/shared-DQIrhcy-.js', marker: 'function extractTtsSpokenOverride(value) {' },
  // 真正的入口在 messageText（只有客户端那份有）：清洗之前先看标记。
  // 少了它，标记会被 removeTtsMarkup 当 HTML 标签吃掉——2026-10-15 实测踩到。
  { file: 'lib/client.js', marker: 'const spokenOverride = extractTtsSpokenOverride(rawText);' },
])

/** 本仓带的所有补丁：`patches/<包名>@<版本>.patch`。 */
export function listPatches(patchDir) {
  if (!fs.existsSync(patchDir)) return []
  return fs.readdirSync(patchDir)
    .filter(name => name.endsWith('.patch'))
    .sort()
    .map(name => {
      const file = path.join(patchDir, name)
      const base = name.replace(/\.patch$/, '')
      const at = base.lastIndexOf('@')
      const content = fs.readFileSync(file)
      return {
        name,
        file,
        base,
        packageName: at < 0 ? base : base.slice(0, at),
        version: at < 0 ? '' : base.slice(at + 1),
        bytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      }
    })
}

/** lockfile 里记的 `patch_hash`（同一键会出现多次，取第一个即可）。 */
export function lockPatchHash(lockText, packageName, version) {
  if (typeof lockText !== 'string') return undefined
  const escaped = `${packageName}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = lockText.match(new RegExp(`^\\s+${escaped}:\\s+([0-9a-f]{64})\\s*$`, 'm'))
  return match ? match[1] : undefined
}

/** `pnpm-workspace.yaml` 的 `patchedDependencies` 里有没有这条登记。 */
export function isRegistered(workspaceText, packageName, version) {
  if (typeof workspaceText !== 'string') return false
  const escaped = `${packageName}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s+${escaped}\\s*:\\s*\\S+`, 'm').test(workspaceText)
}

/**
 * 上游包目录里，补丁特征是否真的在。
 *
 * 按**文件**聚合，不是按标记——同一个文件上可能挂着多个标记（每个补丁编辑
 * 一个），逐个报会把同一个文件说两遍，人看输出会以为有两份补丁。文件缺了
 * 报 missing-file，只要有一个标记没命中就是 not-applied。
 */
export function inspectApplied(packageRoot) {
  const byFile = new Map()
  for (const { file, marker } of APPLIED_MARKERS) {
    if (!byFile.has(file)) byFile.set(file, [])
    byFile.get(file).push(marker)
  }
  return [...byFile].map(([file, markers]) => {
    const target = path.join(packageRoot, file)
    if (!fs.existsSync(target)) return { file, state: 'missing-file' }
    const text = fs.readFileSync(target, 'utf8')
    const hit = markers.filter(marker => text.includes(marker)).length
    return { file, state: hit === markers.length ? 'applied' : 'not-applied', hit, total: markers.length }
  })
}

/** profile 里实际装的上游版本（读它的 package.json）。读不到返回 undefined。 */
export function installedVersion(packageRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 对一个 profile 做全套体检。
 *
 * 只读文件、不抛异常：任何读不到的路径都折成 `false` 与一句人话，
 * 因为调用它的人（启动自检）没有资格让应用起不来。
 *
 * @param {string} profile DSH profile 目录。
 * @param {string} patchDir 补丁正本目录。
 * @returns {{ ok: boolean, rows: Array<object>, patches: Array<object> }}
 */
export function inspectProfile(profile, patchDir) {
  const patches = listPatches(patchDir)
  const workspaceFile = path.join(profile, 'pnpm-workspace.yaml')
  const lockFile = path.join(profile, 'pnpm-lock.yaml')

  let workspaceText
  let lockText
  try { workspaceText = fs.readFileSync(workspaceFile, 'utf8') } catch { workspaceText = undefined }
  try { lockText = fs.readFileSync(lockFile, 'utf8') } catch { lockText = undefined }

  const rows = []
  for (const patch of patches) {
    const packageRoot = path.join(profile, 'node_modules', patch.packageName)
    const registered = isRegistered(workspaceText, patch.packageName, patch.version)
    const hash = lockPatchHash(lockText, patch.packageName, patch.version)
    const applied = inspectApplied(packageRoot)
    // 装着的版本与补丁钉的版本不一致 —— 上游发新版了。这不是"补丁坏了"，
    // 是"补丁该重做了"，得用不同的话告诉人。
    const installed = installedVersion(packageRoot)
    const versionMatches = installed === undefined || installed === patch.version

    rows.push({
      patch,
      registered,
      hash,
      hashMatches: hash === patch.sha256,
      applied,
      installed,
      versionMatches,
      ok: registered && versionMatches && hash === patch.sha256 && applied.every(row => row.state === 'applied'),
    })
  }

  return { ok: rows.length > 0 && rows.every(row => row.ok), rows, patches }
}

/** 把体检结果折成给日志看的一行行说明（不含 ANSI，宿主日志未必吃颜色）。 */
export function describe(rows) {
  const lines = []
  for (const row of rows) {
    const { patch } = row
    // 版本不符排在最前：此时 pnpm 的报错是 ERR_PNPM_UNUSED_PATCH，
    // 与"补丁没打上"是两回事，先把它讲清楚，免得照着修错方向。
    if (!row.versionMatches) {
      lines.push(
        `${patch.packageName} 已升到 ${row.installed}，本仓补丁钉的是 ${patch.version}` +
          ` —— 补丁不会生效（pnpm 会报 ERR_PNPM_UNUSED_PATCH）。` +
          `跑 node scripts/patch.mjs upgrade 重新生成补丁`,
      )
      continue
    }
    if (!row.registered) {
      lines.push(`${patch.base}：未登记到 patchedDependencies —— 跑 node scripts/patch.mjs install`)
      continue
    }
    if (row.hash === undefined) {
      lines.push(`${patch.base}：lockfile 里没有 patch_hash —— 跑一次 pnpm install`)
      continue
    }
    if (!row.hashMatches) {
      lines.push(`${patch.base}：lockfile 的 hash 与补丁正本不符（补丁改过但没重打）—— 跑 node scripts/patch.mjs install`)
      continue
    }
    const bad = row.applied.filter(item => item.state !== 'applied')
    if (bad.length > 0) {
      const missing = bad.every(item => item.state === 'missing-file')
      lines.push(
        missing
          ? `${patch.base}：整个包目录不见了（pnpm install 会假装已装好跳过它）—— 跑 node scripts/patch.mjs install，它会用 pnpm add 重新解析`
          : `${patch.base}：${bad.map(item => `${item.file} ${item.hit}/${item.total} 处特征`).join('、')} —— 补丁没落到包里，跑 node scripts/patch.mjs install`,
      )
      continue
    }
    lines.push(`${patch.base}：登记、hash、落盘三项齐备`)
  }
  return lines
}
