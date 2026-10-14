/**
 * dsh-maid-tts-fix —— 给 `dsh-xiaomi-tts` 的朗读文本清洗打补丁，并**盯着它别掉**。
 *
 * 病根：插件剥 HTML 用的是单行正则 `/<[^>\r\n]*>/g`，跨不过换行；而 VCP 卡片
 * 的样式写在多行 `<style>` 块里，于是整段 CSS 被当成正文送进语音合成——点一次
 * 朗读，耳朵里是 `#vcp-rootbox-sizing:border-box;max-width:760px;...`。
 *
 * 修法是 pnpm patch：补丁正本在 `patches/`，登记进 profile 的
 * `pnpm-workspace.yaml`，hash 落进 lockfile，任何一次 install / 重铺都会自动重打。
 * 这条路不是首选而是**教训**——早先手改 node_modules，被一次重铺连备份一起
 * 静默抹掉，直到用户点朗读才发现。
 *
 * 所以本插件在启动时做一件很便宜的事：把"登记、hash、落盘"三项问一遍，
 * 任何一项掉了就 warn 出来，附上修它的那一条命令。它不修、不拦、不抛——
 * 一个体检器没有资格让应用起不来（宿主没装 xiaomi-tts 时它也不过是白问一遍）。
 *
 * @module dsh-maid-tts-fix
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inspectProfile, describe as describeRows } from './lib/selfcheck.js'

export const name = 'tts-fix'
/** 无必需服务：纯启动自检 + 提示，不注册路由、不依赖 settings。 */
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 找 profile：优先宿主给的环境变量，退回 desktop 的默认落点。 */
function resolveProfile() {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && fs.existsSync(fromEnv)) return fromEnv
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
}

/**
 * 装配：跑一次补丁体检，有问题就 warn。
 *
 * 为什么放在 apply 而不是做成命令：这份体检的价值全在"**没人想起来的时候**
 * 它也在跑"。补丁失效是静默的，静默的故障只能靠主动巡检发现。
 *
 * @param {object} ctx cordis 上下文。
 */
export function apply(ctx) {
  const warn = (message) => {
    try { ctx.logger?.warn?.(`[${name}] ${message}`) } catch { /* 日志不是失败理由 */ }
  }
  const info = (message) => {
    try { ctx.logger?.info?.(`[${name}] ${message}`) } catch { /* 同上 */ }
  }

  try {
    const profile = resolveProfile()
    const patchDir = path.join(HERE, 'patches')
    const { ok, rows, patches } = inspectProfile(profile, patchDir)

    if (patches.length === 0) {
      warn(`patches/ 下没有补丁正本（${patchDir}），本插件此刻什么也没做`)
      return
    }
    if (ok) {
      info(`补丁齐备：${patches.map(p => p.base).join('、')}（profile: ${profile}）`)
      return
    }
    for (const line of describeRows(rows)) warn(line)
    warn('补丁掉了朗读就会念出 CSS。修：node scripts/patch.mjs install，然后重启 DSH')
  } catch (error) {
    warn(`体检失败，跳过（不影响运行）：${error instanceof Error ? error.message : String(error)}`)
  }
}
