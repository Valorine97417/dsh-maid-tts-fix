/**
 * tts-cross-session-probe.mjs —— 跨会话自动播报的结构与接线验证
 *
 * 对应 TROUBLESHOOTING §2.7「隔壁会话跑完不念」与 §2.6「切会话挥断朗读」。
 * 这两条是同一个补丁的两面：`installCrossSessionAutoPlay` 让**非当前视图的会话**
 * 跑完也能念，同时 `isPlayingNow()` 守住切会话不许挥断正在播的。
 *
 * 这个探针**不跑真实播放**（那要真音频、真 DOM、真网络），只验三件事：
 *   ① 落盘产物里 `installCrossSessionAutoPlay` 的定义存在且形态对
 *      （挂载前提 `entry.running === true` 且 `retainedBy.mainView === 0`）
 *   ② 挂载点真的被调用了（定义存在但没人调 = 死代码，最常见的假绿灯）
 *   ③ `PlaybackController` 上的跨会话字段与方法齐备（playbackOwnerId / remoteSessionId / isPlayingNow）
 *
 * 为什么值得单独一个探针：这条链路的失效是**静默**的——不报错、
 * 只是"隔壁会话跑完了，没声音"。靠听是发现不了的，只能靠核接线。
 *
 * 跑法：node _probe/tts-cross-session-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const CLIENT = path.join(PROFILE, 'node_modules', 'dsh-xiaomi-tts', 'lib', 'client.js')

if (!fs.existsSync(CLIENT)) {
  console.error(`✗ 找不到 ${CLIENT}`)
  process.exit(1)
}
const source = fs.readFileSync(CLIENT, 'utf8')

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
const count = (needle) => source.split(needle).length - 1

console.log(`源文件：${CLIENT}（${source.length} 字符）\n`)

// ① 定义存在且唯一
const defMarker = 'function installCrossSessionAutoPlay(ctx, playback, scope) {'
check('① installCrossSessionAutoPlay 有定义', count(defMarker) === 1, `出现 ${count(defMarker)} 次（应为 1）`)

// 抠出函数体，静态核挂载前提
const defStart = source.indexOf(defMarker)
let body = ''
if (defStart !== -1) {
  const end = source.indexOf('\n}\n', defStart)
  body = end === -1 ? '' : source.slice(defStart, end + 2)
}

// ② 挂载前提：只在「会话正在跑」且「主视图没占着」时挂
//    真实形态在 `scan()` 里：
//      for (const entry of Object.values(list.byId)) {
//        if ((entry.retainedBy?.mainView ?? 0) > 0) continue;
//        if (entry.running === true) watch(entry.id);
//      }
//    所以判据是 `> 0` 跳过（不是 `=== 0` 才挂）——按 `=== 0` 找会假失败。
check(
  '② 挂载前提含 running === true（只对运行中的会话挂）',
  /\.running\s*===\s*true/.test(body),
  `函数体里没找到 .running === true：\n    ${body.slice(0, 300)}`,
)
check(
  '③ 挂载前提排除主视图会话（retainedBy.mainView 已占用则跳过）',
  /retainedBy\?\.mainView\s*\?\?\s*0\)\s*>\s*0\)\s*continue/.test(body),
  `函数体里没找到 "(entry.retainedBy?.mainView ?? 0) > 0) continue"：主视图那边的自动播报走另一条路，这里挂重了会念两遍`,
)

// ④ 不许是死代码：定义之外必须有调用点
const callCount = count('installCrossSessionAutoPlay(') - 1 // 减掉定义自身
check('④ 有真实调用点（不是死代码）', callCount >= 1, `只有定义没有调用：这是最典型的假绿灯——补丁"在"，但从不执行`)

// ⑤ PlaybackController 的跨会话字段/方法齐备
check('⑤ 类字段 playbackOwnerId 在（播放归属跟着会话走）', count('playbackOwnerId = null;') >= 1, '缺 playbackOwnerId 字段：切走会把别人的播放挥断')
check('⑥ 类字段 remoteSessionId 在（记住隔壁会话）', count('remoteSessionId = null;') >= 1, '缺 remoteSessionId 字段')
check('⑦ isPlayingNow() 方法在', /isPlayingNow\(\)\s*\{/.test(source), '缺 isPlayingNow()：切会话无法判断"正在播"')
check('⑧ activateSession 用 isPlayingNow() 守住不挥断', /if\s*\(this\.isPlayingNow\(\)\)\s*return;/.test(source), '缺 `if (this.isPlayingNow()) return;`：切会话会挥断正在播的')

// ⑨ 循环/续播判据必须用 playbackOwnerId 而不是 activeSessionId
const ownerUses = count('this.playbackOwnerId !== sessionId')
const ownerEqUses = count('this.playbackOwnerId === sessionId')
check(
  '⑨ 播放归属判据用 playbackOwnerId（不再只看 activeSessionId）',
  ownerUses + ownerEqUses >= 3,
  `playbackOwnerId 比较共 ${ownerUses + ownerEqUses} 处（应为 ≥ 3）：判据还留在 activeSessionId 上，隔壁会话就别想播`,
)

// ⑩ 输入节点白名单（反思轮识别用，和 §2.8 联动）
check('⑩ INPUT_NODE_KINDS 白名单在（反思轮识别的底座）', source.includes('const INPUT_NODE_KINDS = new Set'), '缺 INPUT_NODE_KINDS：反思轮跳过会失效')
check('⑪ isReflectInjection 定义在（记忆反思轮不念）', /function isReflectInjection\(node\)\s*\{/.test(source), '缺 isReflectInjection：记忆反思轮会被念出来')

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
  console.log('\n注意：这条链路的失效不报错，只是「隔壁会话跑完没声音」。接线缺一处就等于没有。')
}
console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
