#!/usr/bin/env node
/**
 * 把 `patches/*.patch` 装进 DSH profile —— 可重放、可核对、可卸载。
 *
 * 用法：
 *   node scripts/patch.mjs install      # 复制补丁 + 登记 + pnpm install + 核对
 *   node scripts/patch.mjs install --dry-run   # 只说要做什么，不落盘
 *   node scripts/patch.mjs verify       # 只核对：登记、hash、落盘字节
 *   node scripts/patch.mjs remove       # 撤销登记与补丁文件，再 pnpm install
 *   node scripts/patch.mjs list         # 列出本仓带的补丁与目标版本
 *   node scripts/patch.mjs --profile <dir>   # 指定 profile（默认 desktop）
 *
 * 为什么走 pnpm patch 而不是直接改 node_modules：
 *   改 node_modules 是**手改**——2026-10-14 实测，装一次别的插件触发重铺，
 *   连当时的 *.bak 备份一起被抹掉，等于没改。pnpm 的 `patchedDependencies`
 *   把补丁记在 `pnpm-workspace.yaml`、hash 记在 lockfile 里，任何一次
 *   install / 重铺都会**自动重打**。所以这里只做"登记与核对"，不碰源码。
 *
 * 为什么要 hash 核对：
 *   `patch_hash` 就是 `.patch` 文件的 sha256。两边一对，就能确认"仓库里
 *   这份正本"和"profile 里真正生效的那份"是同一份——改了补丁却忘了重打，
 *   这一步会当场抓住。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PATCH_DIR = path.join(REPO, 'patches')
const BACKUP_DIR = path.join(REPO, '.patch-backups')

/** DSH 自带的 pnpm。找不到就退回 PATH 上的 pnpm。 */
const BUNDLED_PNPM = 'D:/DeepSeek Harness/resources/runtime/pnpm/bin/pnpm.cjs'

const has = flag => process.argv.includes(flag)
function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** 本仓带的所有补丁：`<包名>@<版本>.patch`。 */
function listPatches() {
  if (!fs.existsSync(PATCH_DIR)) return []
  return fs.readdirSync(PATCH_DIR)
    .filter(name => name.endsWith('.patch'))
    .map(name => {
      const file = path.join(PATCH_DIR, name)
      const base = name.replace(/\.patch$/, '')
      const at = base.lastIndexOf('@')
      return {
        file,
        name,
        base,
        packageName: at < 0 ? base : base.slice(0, at),
        version: at < 0 ? '' : base.slice(at + 1),
        bytes: fs.statSync(file).size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      }
    })
}

function resolveProfile() {
  const explicit = argValue('--profile')
  if (explicit !== undefined) return path.resolve(explicit)
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
}

const profile = resolveProfile()
const workspaceFile = path.join(profile, 'pnpm-workspace.yaml')
const lockFile = path.join(profile, 'pnpm-lock.yaml')
const profilePatchDir = path.join(profile, 'patches')

/**
 * 在 `pnpm-workspace.yaml` 的 `patchedDependencies` 下写入/更新一条登记。
 *
 * 手写而不是引 yaml 库：这个文件结构固定（顶层块 + 缩进列表），引一个依赖
 * 只为了改两行不划算，而且**注释会丢**——pnpm 自己重写时也一样丢，但我们
 * 至少不该主动毁掉人家写的东西。所以走文本替换，块不存在才追加。
 *
 * @returns {{ text: string, changed: boolean, mode: 'added' | 'updated' | 'same' }}
 */
function upsertPatchedDependency(text, packageName, version, patchRelPath) {
  const key = `${packageName}@${version}`
  const entry = `  ${key}: ${patchRelPath}`
  const lines = text.split('\n')
  const headerAt = lines.findIndex(line => /^patchedDependencies:\s*$/.test(line))

  if (headerAt < 0) {
    const tail = text.endsWith('\n') || text === '' ? '' : '\n'
    return { text: `${text}${tail}\npatchedDependencies:\n${entry}\n`, changed: true, mode: 'added' }
  }

  // 块的范围：从表头到下一个非缩进非空行为止。
  let endAt = headerAt + 1
  while (endAt < lines.length && (/^\s+\S/.test(lines[endAt]) || lines[endAt].trim() === '')) endAt += 1
  while (endAt > headerAt + 1 && lines[endAt - 1].trim() === '') endAt -= 1

  const keyRe = new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const at = lines.slice(headerAt + 1, endAt).findIndex(line => keyRe.test(line))

  if (at < 0) {
    lines.splice(endAt, 0, entry)
    return { text: lines.join('\n'), changed: true, mode: 'added' }
  }
  const index = headerAt + 1 + at
  if (lines[index] === entry) return { text, changed: false, mode: 'same' }
  lines[index] = entry
  return { text: lines.join('\n'), changed: true, mode: 'updated' }
}

/** 从 `pnpm-workspace.yaml` 摘掉一条登记（卸载用）。 */
function removePatchedDependency(text, key) {
  const lines = text.split('\n')
  const keyRe = new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const index = lines.findIndex(line => keyRe.test(line))
  if (index < 0) return { text, changed: false }
  lines.splice(index, 1)
  return { text: lines.join('\n'), changed: true }
}

/** lockfile 里记录的 patch_hash（同一条会出现多次，取第一个即可）。 */
function lockPatchHash(packageName, version) {
  if (!fs.existsSync(lockFile)) return undefined
  const text = fs.readFileSync(lockFile, 'utf8')
  const re = new RegExp(`^\\s+${packageName}@${version}:\\s+([0-9a-f]{64})\\s*$`, 'm')
  const match = text.match(re)
  return match ? match[1] : undefined
}

function runPnpm(args) {
  const useBundled = fs.existsSync(BUNDLED_PNPM)
  const command = useBundled ? process.execPath : 'pnpm'
  const argv = useBundled ? [BUNDLED_PNPM, ...args] : args
  console.log(`\n$ ${useBundled ? 'pnpm' : 'pnpm'} ${args.join(' ')}   （cwd: ${profile}）`)
  const result = spawnSync(command, argv, { cwd: profile, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  return result.status ?? 1
}

function backupOnce(file, tag) {
  if (!fs.existsSync(file)) return undefined
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const target = path.join(BACKUP_DIR, `${path.basename(file)}.bak-${tag}-${stamp}`)
  fs.copyFileSync(file, target)
  return target
}

/** 检查上游包文件里是否真带补丁特征。 */
function checkApplied(patches) {
  const rows = []
  for (const patch of patches) {
    const root = path.join(profile, 'node_modules', patch.packageName)
    const markers = [
      { file: 'lib/client.js', marker: 'function stripTtsStyleBlocks(value) {' },
      { file: 'lib/shared-DQIrhcy-.js', marker: 'function stripTtsStyleBlocks(value) {' },
    ]
    for (const { file, marker } of markers) {
      const target = path.join(root, file)
      if (!fs.existsSync(target)) {
        rows.push({ patch: patch.base, file, state: '文件缺失' })
        continue
      }
      const hit = fs.readFileSync(target, 'utf8').includes(marker)
      rows.push({ patch: patch.base, file, state: hit ? '已应用' : '未应用' })
    }
  }
  return rows
}

// ---------------------------------------------------------------- 子命令

function cmdList() {
  const patches = listPatches()
  if (patches.length === 0) {
    console.log('patches/ 下没有补丁文件。')
    return 0
  }
  console.log(`本仓补丁（${patches.length} 个）：`)
  for (const patch of patches) {
    console.log(`  ${patch.name}`)
    console.log(`    目标：${patch.packageName}@${patch.version}   ${patch.bytes} 字节`)
    console.log(`    sha256：${patch.sha256}`)
  }
  return 0
}

function cmdInstall() {
  const patches = listPatches()
  if (patches.length === 0) {
    console.error('patches/ 下没有补丁文件，无事可做。')
    return 1
  }
  if (!fs.existsSync(workspaceFile)) {
    console.error(`找不到 ${workspaceFile}，profile 路径对吗？（用 --profile 指定）`)
    return 1
  }
  const dry = has('--dry-run')
  console.log(`profile：${profile}`)

  let workspace = fs.readFileSync(workspaceFile, 'utf8')
  const plans = []

  for (const patch of patches) {
    const rel = `patches/${patch.name}`
    const upsert = upsertPatchedDependency(workspace, patch.packageName, patch.version, rel)
    workspace = upsert.text
    const target = path.join(profilePatchDir, patch.name)
    const inPlace = fs.existsSync(target) && fs.readFileSync(target).equals(fs.readFileSync(patch.file))
    plans.push({ patch, rel, upsert, target, inPlace })
  }

  for (const plan of plans) {
    const action = plan.upsert.mode === 'same' ? '登记已就位' : `登记${plan.upsert.mode === 'added' ? '新增' : '更新'}`
    const copy = plan.inPlace ? '补丁文件已一致' : '补丁文件待复制'
    console.log(`  · ${plan.patch.name}：${action}；${copy}`)
  }

  if (dry) {
    console.log('\n（--dry-run，未写盘）')
    return 0
  }

  const workspaceBackup = backupOnce(workspaceFile, 'ttsfix')
  const lockBackup = backupOnce(lockFile, 'ttsfix')
  if (workspaceBackup) console.log(`\n备份：${path.relative(REPO, workspaceBackup)}`)
  if (lockBackup) console.log(`备份：${path.relative(REPO, lockBackup)}`)

  fs.mkdirSync(profilePatchDir, { recursive: true })
  for (const plan of plans) {
    if (!plan.inPlace) {
      fs.copyFileSync(plan.patch.file, plan.target)
      console.log(`  复制 ${plan.rel}（${plan.patch.bytes} 字节）`)
    }
  }
  fs.writeFileSync(workspaceFile, workspace, 'utf8')
  console.log(`  写入 pnpm-workspace.yaml`)

  const status = runPnpm(['install'])
  if (status !== 0) {
    console.error(`\npnpm install 退出码 ${status}，补丁可能没打上。核对：node scripts/patch.mjs verify`)
    return status
  }
  return cmdVerify()
}

function cmdVerify() {
  const patches = listPatches()
  let ok = true

  console.log(`profile：${profile}\n`)

  const workspace = fs.existsSync(workspaceFile) ? fs.readFileSync(workspaceFile, 'utf8') : ''
  for (const patch of patches) {
    const key = `${patch.packageName}@${patch.version}`
    const registered = new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*patches/${patch.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(workspace)
    console.log(`${registered ? '✓' : '✗'} 登记：pnpm-workspace.yaml 的 patchedDependencies → ${key}`)
    if (!registered) ok = false

    const hash = lockPatchHash(patch.packageName, patch.version)
    if (hash === undefined) {
      console.log(`✗ lockfile：没有 ${key} 的 patch_hash（跑一次 pnpm install）`)
      ok = false
    } else if (hash !== patch.sha256) {
      console.log(`✗ lockfile hash 与补丁正本不符\n    正本：${patch.sha256}\n    锁内：${hash}\n    → 补丁改过但没重打：node scripts/patch.mjs install`)
      ok = false
    } else {
      console.log(`✓ lockfile hash 与补丁正本一致：${hash.slice(0, 16)}…`)
    }

    for (const row of checkApplied([patch])) {
      const good = row.state === '已应用'
      console.log(`${good ? '✓' : '✗'} 落盘：${row.file} ${row.state}`)
      if (!good) ok = false
    }
  }

  console.log(ok ? '\n全部核对通过。' : '\n有未通过项，见上。')
  return ok ? 0 : 1
}

function cmdRemove() {
  const patches = listPatches()
  let workspace = fs.existsSync(workspaceFile) ? fs.readFileSync(workspaceFile, 'utf8') : ''
  let changed = false
  for (const patch of patches) {
    const result = removePatchedDependency(workspace, `${patch.packageName}@${patch.version}`)
    workspace = result.text
    changed = changed || result.changed
    const target = path.join(profilePatchDir, patch.name)
    if (fs.existsSync(target)) {
      if (!has('--dry-run')) {
        fs.unlinkSync(target)
        console.log(`  删除 ${path.relative(profile, target)}`)
      } else {
        console.log(`  将删除 ${path.relative(profile, target)}`)
      }
    }
  }
  if (has('--dry-run')) {
    console.log('\n（--dry-run，未写盘）')
    return 0
  }
  if (changed) {
    backupOnce(workspaceFile, 'ttsfix-remove')
    fs.writeFileSync(workspaceFile, workspace, 'utf8')
    console.log('  已从 patchedDependencies 摘除登记')
  } else {
    console.log('  登记本就不在')
  }
  return runPnpm(['install'])
}

const COMMANDS = { list: cmdList, install: cmdInstall, verify: cmdVerify, remove: cmdRemove }
const command = process.argv[2]
if (command === undefined || !(command in COMMANDS)) {
  console.log('用法：node scripts/patch.mjs <list|install|verify|remove> [--dry-run] [--profile <dir>]')
  process.exit(command === undefined ? 0 : 1)
}
process.exit(COMMANDS[command]())
