#!/usr/bin/env node
/**
 * 把 `patches/*.patch` 装进 DSH profile —— 可重放、可核对、可卸载。
 *
 * 用法：
 *   node scripts/patch.mjs list       # 列出本仓带的补丁与目标版本
 *   node scripts/patch.mjs install    # 复制补丁 + 登记 + pnpm install + 核对
 *   node scripts/patch.mjs verify     # 只核对：登记、hash、落盘字节
 *   node scripts/patch.mjs remove     # 撤销登记与补丁文件，再 pnpm install
 *   node scripts/patch.mjs install --dry-run    # 只说要做什么，不落盘
 *   node scripts/patch.mjs verify --profile <dir>   # 指定 profile（默认 desktop）
 *
 * 为什么走 pnpm patch 而不是直接改 node_modules：
 *   改 node_modules 是**手改**——2026-10-14 实测，装一次别的插件触发重铺，
 *   连当时的 *.bak 备份一起被抹掉，等于没改。pnpm 的 `patchedDependencies`
 *   把补丁记在 `pnpm-workspace.yaml`、hash 记在 lockfile 里，任何一次
 *   install / 重铺都会**自动重打**。所以这里只做"登记与核对"，不碰源码。
 *
 * 体检逻辑全在 `lib/selfcheck.js`——那个模块给启动自检用，这里给命令行用，
 * 同一份判据服务两个入口，免得改了补丁却只更新一处、另一处开始说谎。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { listPatches, inspectProfile, describe as describeRows, installedVersion } from '../lib/selfcheck.js'
import { planEdits, EDITS, TARGET_FILES } from '../lib/edits.js'

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

function resolveProfile() {
  const explicit = argValue('--profile')
  if (explicit !== undefined) return path.resolve(explicit)
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && fs.existsSync(fromEnv)) return fromEnv
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
 * @returns {{ text: string, mode: 'added' | 'updated' | 'same' }}
 */
function upsertPatchedDependency(text, packageName, version, patchRelPath) {
  const key = `${packageName}@${version}`
  const entry = `  ${key}: ${patchRelPath}`
  const lines = text.split('\n')
  const headerAt = lines.findIndex(line => /^patchedDependencies:\s*$/.test(line))

  if (headerAt < 0) {
    const tail = text.endsWith('\n') || text === '' ? '' : '\n'
    return { text: `${text}${tail}\npatchedDependencies:\n${entry}\n`, mode: 'added' }
  }

  // 块的范围：从表头到下一个非缩进非空行为止。
  let endAt = headerAt + 1
  while (endAt < lines.length && (/^\s+\S/.test(lines[endAt]) || lines[endAt].trim() === '')) endAt += 1
  while (endAt > headerAt + 1 && lines[endAt - 1].trim() === '') endAt -= 1

  const keyRe = new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`)
  const at = lines.slice(headerAt + 1, endAt).findIndex(line => keyRe.test(line))

  if (at < 0) {
    lines.splice(endAt, 0, entry)
    return { text: lines.join('\n'), mode: 'added' }
  }
  const index = headerAt + 1 + at
  if (lines[index] === entry) return { text, mode: 'same' }
  lines[index] = entry
  return { text: lines.join('\n'), mode: 'updated' }
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

function runPnpm(args) {
  const useBundled = fs.existsSync(BUNDLED_PNPM)
  const command = useBundled ? process.execPath : 'pnpm'
  const argv = useBundled ? [BUNDLED_PNPM, ...args] : args
  console.log(`\n$ pnpm ${args.join(' ')}   （cwd: ${profile}）`)
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

// ---------------------------------------------------------------- 子命令

function cmdList() {
  const patches = listPatches(PATCH_DIR)
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
  const patches = listPatches(PATCH_DIR)
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

  const original = fs.readFileSync(workspaceFile, 'utf8')
  let workspace = original
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

  // 只在真会改动时备份与写盘：登记本就正确却重写一遍，只会无谓地动 mtime，
  // 让人误以为"补丁刚被改过"。
  const workspaceChanged = workspace !== original
  const copiesNeeded = plans.filter(plan => !plan.inPlace)

  if (workspaceChanged) {
    const workspaceBackup = backupOnce(workspaceFile, 'ttsfix')
    const lockBackup = backupOnce(lockFile, 'ttsfix')
    if (workspaceBackup) console.log(`\n备份：${path.relative(REPO, workspaceBackup)}`)
    if (lockBackup) console.log(`备份：${path.relative(REPO, lockBackup)}`)
    fs.writeFileSync(workspaceFile, workspace, 'utf8')
    console.log(`  写入 pnpm-workspace.yaml`)
  } else {
    console.log('\n登记无变化，跳过写盘')
  }

  if (copiesNeeded.length > 0) {
    fs.mkdirSync(profilePatchDir, { recursive: true })
    for (const plan of copiesNeeded) {
      fs.copyFileSync(plan.patch.file, plan.target)
      console.log(`  复制 ${plan.rel}（${plan.patch.bytes} 字节）`)
    }
  }

  const status = runPnpm(['install'])
  if (status !== 0) {
    console.error(`\npnpm install 退出码 ${status}，补丁可能没打上。核对：node scripts/patch.mjs verify`)
    return status
  }

  const first = inspectProfile(profile, PATCH_DIR)
  if (first.ok) return cmdVerify()

  // `pnpm install` 有一处盲区（2026-10-15 实测）：如果有人把整包目录从外部删掉
  // （rm -rf node_modules/<pkg>），pnpm 的账本仍认为"已装好"，于是回一句
  // 「Already up to date」直接跳过——连 --force、删 .modules.yaml 都不管用。
  // 补丁文件、登记、lockfile 全对，包里却一个字都没有，verify 报 missing-file。
  // 唯一的出路是让 pnpm 重新解析这个包：`pnpm add <name>@<version>`。
  // 同版本重装不会改 dependencies，只会补回目录。
  const broken = first.rows.filter(row => row.applied.some(item => item.state === 'missing-file'))
  if (broken.length === 0) return cmdVerify()

  console.log('\npnpm install 跳过了缺失的包（账本以为已装好），改用 pnpm add 重新解析：')
  for (const row of broken) {
    const spec = `${row.patch.packageName}@${row.patch.version}`
    console.log(`  · ${spec}`)
    const code = runPnpm(['add', spec])
    if (code !== 0) {
      console.error(`\npnpm add ${spec} 退出码 ${code}，得手动看看了。`)
      return code
    }
  }
  return cmdVerify()
}

function cmdVerify() {
  const { ok, rows, patches } = inspectProfile(profile, PATCH_DIR)

  console.log(`profile：${profile}\n`)

  if (patches.length === 0) {
    console.error(`✗ patches/ 下没有补丁正本（${PATCH_DIR}）`)
    return 1
  }

  for (const row of rows) {
    const { patch } = row
    if (!row.versionMatches) {
      console.log(`✗ 版本：装着 ${row.installed}，补丁钉的是 ${patch.version}`)
      console.log(`    → pnpm 会报 ERR_PNPM_UNUSED_PATCH 并中止 install。重做补丁：node scripts/patch.mjs upgrade`)
      continue
    }
    console.log(`${row.registered ? '✓' : '✗'} 登记：pnpm-workspace.yaml 的 patchedDependencies → ${patch.base}`)
    if (row.hash === undefined) {
      console.log(`✗ lockfile：没有 ${patch.base} 的 patch_hash（跑一次 pnpm install）`)
    } else if (!row.hashMatches) {
      console.log(`✗ lockfile hash 与补丁正本不符\n    正本：${patch.sha256}\n    锁内：${row.hash}\n    → 补丁改过但没重打：node scripts/patch.mjs install`)
    } else {
      console.log(`✓ lockfile hash 与补丁正本一致：${row.hash.slice(0, 16)}…`)
    }
    for (const item of row.applied) {
      console.log(`${item.state === 'applied' ? '✓' : '✗'} 落盘：${item.file} ${item.state === 'applied' ? '已应用' : item.state === 'missing-file' ? '文件缺失' : '未应用'}`)
    }
  }

  console.log(ok ? '\n全部核对通过。' : '\n有未通过项，见上。')
  if (!ok) for (const line of describeRows(rows)) console.log(`  · ${line}`)
  return ok ? 0 : 1
}

function cmdRemove() {
  const patches = listPatches(PATCH_DIR)
  let workspace = fs.existsSync(workspaceFile) ? fs.readFileSync(workspaceFile, 'utf8') : ''
  const original = workspace
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
  if (changed && workspace !== original) {
    backupOnce(workspaceFile, 'ttsfix-remove')
    fs.writeFileSync(workspaceFile, workspace, 'utf8')
    console.log('  已从 patchedDependencies 摘除登记')
  } else {
    console.log('  登记本就不在')
  }
  return runPnpm(['install'])
}

/**
 * 上游升版后把补丁重新打一遍。
 *
 * 为什么需要它：`patchedDependencies` 的键是**精确版本**（`<包>@<版本>`）。
 * 上游一发新版，旧键就悬空——实测（2026-10-15）pnpm 会直接报
 * `ERR_PNPM_UNUSED_PATCH` 并**中止整个 install**，不是静默降级。
 * 这其实是好事（不会假装成功），但意味着升级路径被堵死了：
 * 不重做补丁，就没法升上游。所以老大那句"不影响它本身的更新"要成立，
 * 必须有一条一键重做的路。
 *
 * 流程：patch 出新临时目录 → 按 lib/edits.js 的声明重放 → node --check →
 * patch-commit → 清掉旧版本的补丁文件与登记 → verify。
 */
function cmdUpgrade() {
  const patches = listPatches(PATCH_DIR)
  if (patches.length === 0) {
    console.error('patches/ 下没有补丁文件，不知道要重做哪个。')
    return 1
  }
  if (!fs.existsSync(workspaceFile)) {
    console.error(`找不到 ${workspaceFile}，profile 路径对吗？（用 --profile 指定）`)
    return 1
  }
  const dry = has('--dry-run')
  const target = argValue('--to')

  let failedAny = false
  for (const patch of patches) {
    const installed = target ?? installedVersion(path.join(profile, 'node_modules', patch.packageName))
    if (installed === undefined) {
      console.error(`✗ ${patch.packageName}：读不到已装版本，装了吗？`)
      failedAny = true
      continue
    }
    if (installed === patch.version) {
      console.log(`· ${patch.packageName}：补丁已是 ${installed}，无需重做。`)
      continue
    }

    console.log(`\n${patch.packageName}：${patch.version} → ${installed}`)
    if (dry) {
      console.log(`  将 patch 出 ${installed} 的临时目录，按 ${EDITS.length} 条编辑重放，再 patch-commit。`)
      continue
    }

    const status = runPnpm(['patch', `${patch.packageName}@${installed}`])
    if (status !== 0) {
      // 最常见的失败：临时目录还在（pnpm patch-commit **不会**自动删它）。
      // 报错原文是 ERR_PNPM_EDIT_DIR_NOT_EMPTY。那不是故障，是残留——
      // 清掉重来即可，所以这里自己收拾，不把残局丢给人。
      const staging = path.join(profile, 'node_modules', '.pnpm_patches', `${patch.packageName}@${installed}`)
      if (fs.existsSync(staging)) {
        console.log(`  临时目录有残留，清掉重来：${path.relative(profile, staging)}`)
        fs.rmSync(staging, { recursive: true, force: true })
        const retry = runPnpm(['patch', `${patch.packageName}@${installed}`])
        if (retry !== 0) {
          console.error(`  pnpm patch 重试仍失败（退出码 ${retry}）`)
          failedAny = true
          continue
        }
      } else {
        console.error(`  pnpm patch 退出码 ${status}`)
        failedAny = true
        continue
      }
    }

    const staging = path.join(profile, 'node_modules', '.pnpm_patches', `${patch.packageName}@${installed}`)
    const plan = planEdits(staging, file => fs.readFileSync(file, 'utf8'))
    if (plan.already) {
      console.log('  这棵树已经含补丁特征，跳过重放（幂等）——直接 patch-commit 收口。')
    }
    if (!plan.ok) {
      console.error('  锚点对不上，补丁没重放。逐条说明：')
      for (const item of plan.failed) {
        console.error(`    · ${item.edit.file} / ${item.edit.id}：期望命中 ${item.edit.expect} 次，实际 ${item.found} 次`)
        console.error(`      ${item.edit.why}`)
      }
      console.error('  上游多半改了那块代码——对着源码把 lib/edits.js 里的锚点更新一下，再跑一次。')
      failedAny = true
      continue
    }
    if (plan.contents !== undefined) {
      for (const [file, text] of plan.contents) fs.writeFileSync(file, text, 'utf8')
      console.log(`  重放 ${plan.applied.length} 条编辑：${plan.applied.join('、')}`)
    }

    // 语法不过就绝不 commit——一个语法错的补丁会把插件整个弄哑。
    let syntaxOk = true
    for (const rel of TARGET_FILES) {
      const check = spawnSync(process.execPath, ['--check', path.join(staging, rel)], { encoding: 'utf8' })
      if (check.status !== 0) {
        console.error(`  ✗ 语法检查失败：${rel}\n${check.stderr.trim()}`)
        syntaxOk = false
      }
    }
    if (!syntaxOk) {
      failedAny = true
      continue
    }
    console.log('  node --check 通过')

    const commit = runPnpm(['patch-commit', staging])
    if (commit !== 0) {
      console.error(`  patch-commit 退出码 ${commit}`)
      failedAny = true
      continue
    }

    // patch-commit 已经生成了新版本的 .patch 并把登记指向它；旧的得清掉，
    // 否则 pnpm 会因为旧键找不到对应版本而报 ERR_PNPM_UNUSED_PATCH。
    const newName = `${patch.packageName}@${installed}.patch`
    const oldInProfile = path.join(profilePatchDir, patch.name)
    if (fs.existsSync(oldInProfile)) {
      fs.unlinkSync(oldInProfile)
      console.log(`  清掉旧补丁 ${path.relative(profile, oldInProfile)}`)
    }
    const repoOld = path.join(PATCH_DIR, patch.name)
    const repoNew = path.join(PATCH_DIR, newName)
    if (fs.existsSync(repoNew)) fs.unlinkSync(repoNew) // 用 patch-commit 生成的那份
    if (fs.existsSync(repoOld)) fs.renameSync(repoOld, repoNew)
    const fromProfile = path.join(profilePatchDir, newName)
    if (fs.existsSync(fromProfile)) fs.copyFileSync(fromProfile, repoNew)
    console.log(`  新补丁入库：patches/${newName}`)
  }

  if (dry) {
    console.log('\n（--dry-run，未写盘）')
    return 0
  }
  const verify = cmdVerify()
  if (failedAny) console.error('\n有步骤失败，见上。')
  return failedAny ? 1 : verify
}

const COMMANDS = { list: cmdList, install: cmdInstall, verify: cmdVerify, remove: cmdRemove, upgrade: cmdUpgrade }
const command = process.argv[2]
if (command === undefined || !(command in COMMANDS)) {
  console.log('用法：node scripts/patch.mjs <list|install|verify|remove|upgrade> [--dry-run] [--profile <dir>]')
  console.log('  upgrade [--to <版本>]   上游升版后重做补丁（默认按 profile 里已装的版本）')
  process.exit(command === undefined ? 0 : 1)
}
process.exit(COMMANDS[command]())
