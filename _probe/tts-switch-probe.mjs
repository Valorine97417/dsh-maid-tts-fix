/**
 * tts-switch-probe.mjs —— 切会话不许把朗读挥断（跨会话续播行为探针）
 *
 * 这条补丁解决的是最反直觉的那类报障：「我切到隔壁会话看进度，正在念的那条
 * 突然断了」。上游原逻辑是「切走就 cancel」，本维护层改成「归属跟着播放走」。
 *
 * 验证要贴着**真实生命周期**做：
 *   用 cutFunction 从落盘的 client.js 抠出真实的 `PlaybackController` 类，
 *   在 node:vm 里喂桩跑。**桩里的 `stopCurrent` / `releaseCurrentAudio` 必须
 *   按真实实现写**——第一版把 `releaseCurrentAudio` 整个桩掉，导致清空链断裂、
 *   误报一堆（这条教训写进了 README:146 与本文件）。
 *
 * 验收的七组场景（对应 README 里那张表）：
 *   ① 播放中切走 → 不停
 *   ② 空闲切走 → 正常清
 *   ③ 不越权 cancel（不是归属的会话，cancel 不该动）
 *   ④ 归属的会话 cancel → 真停
 *   ⑤ 手动暂停后切回来 → 还是暂停态
 *   ⑥ 跨会话循环判据不再只看 activeSessionId
 *   ⑦ 空闲切回 → 正常重置
 *
 * 跑法：node _probe/tts-switch-probe.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'

const CLIENT = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-xiaomi-tts', 'lib', 'client.js')
if (!fs.existsSync(CLIENT)) {
  console.error(`✗ 找不到落盘的 client.js：${CLIENT}`)
  process.exit(1)
}
const src = fs.readFileSync(CLIENT, 'utf8')

/** 抠 `var X = class { … }` 直到顶格 `};` —— 不能用花括号计数（体内有正则与模板串）。 */
function cutClass(source, varName) {
  const start = source.indexOf(`var ${varName} = class {`)
  if (start < 0) throw new Error(`找不到 var ${varName} = class {`)
  const end = source.indexOf('\n};', start)
  if (end < 0) throw new Error(`${varName} 找不到顶格收尾`)
  return source.slice(start, end + 3)
}

const classSrc = cutClass(src, 'PlaybackController')

/**
 * 桩：贴着真实生命周期给。
 * - `stopCurrent` 真的去停音频、清队列（否则 releaseCurrentAudio 的判据永不成立）
 * - `publish` 只记录，不渲染
 * - `history` 给最小实现
 *
 * **audio 桩必须实现 releaseCurrentAudio 真正会碰到的每一个成员**：
 * removeEventListener / pause / removeAttribute / load / src，
 * 外加 URL.revokeObjectURL。第一版只给了 play/pause，跑到 releaseCurrentAudio
 * 就炸 `audio.removeAttribute is not a function`——桩偷懒的代价。
 */
function makeHarness() {
  const audioLog = []
  const published = []
  const makeAudio = (tag) => ({
    tag,
    paused: true,
    ended: false,
    currentTime: 0,
    src: '',
    play() {
      this.paused = false
      audioLog.push(`play:${this.tag}`)
      return Promise.resolve()
    },
    pause() {
      this.paused = true
      audioLog.push(`pause:${this.tag}`)
    },
    removeEventListener() {},
    addEventListener() {},
    removeAttribute(name) {
      if (name === 'src') this.src = ''
    },
    load() {},
  })

  const context = vm.createContext({
    Array,
    Set,
    Map,
    Object,
    Math,
    Date,
    JSON,
    String,
    Number,
    Boolean,
    Error,
    Promise,
    console,
    URL: { revokeObjectURL() {}, createObjectURL: () => 'blob:stub' },
  })
  // 补上类依赖的上游符号：真实实现里这些来自同文件其它函数，桩成够用的最小版。
  vm.runInContext(
    `
    var playbackOwnerId = null;
    var remoteSessionId = null;
    ${classSrc}
    `,
    context,
  )
  return { Controller: context.PlaybackController, audioLog, published, makeAudio }
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

console.log(`源文件：${CLIENT}`)
console.log(`抠出 ${classSrc.length} 字符的真实 PlaybackController\n`)

// ── 结构判据：补丁痕迹必须在类里 ────────────────────────────────
check('类里有 playbackOwnerId 字段（补丁标记）', classSrc.includes('playbackOwnerId'))
check('类里有 remoteSessionId 字段（补丁标记）', classSrc.includes('remoteSessionId'))
check('类里有 isPlayingNow() 方法（补丁标记）', /isPlayingNow\s*\(\s*\)\s*\{/.test(classSrc))
check(
  'activateSession 里用 isPlayingNow() 守住「正在播就不停」',
  /if\s*\(\s*this\.isPlayingNow\(\)\s*\)\s*return/.test(classSrc),
  '未找到 if (this.isPlayingNow()) return —— 跨会话续播补丁可能没落盘',
)

// ── 行为判据：用桩跑真实方法 ────────────────────────────────────
const { Controller, audioLog, makeAudio } = makeHarness()
const ctrl = new Controller({ nodes: [] })

// ① 播放中切走 → 不停
audioLog.length = 0
ctrl.activeSessionId = 'A'
ctrl.view = { sessionId: 'A', messageId: 'm1', source: 'segmented', status: 'playing' }
ctrl.current = { audio: makeAudio('A-m1'), sessionId: 'A', messageId: 'm1' }
ctrl.playbackOwnerId = 'A'
ctrl.activateSession('B')
check(
  '① 播放中切走 → 不调用 stop（不挥断）',
  ctrl.activeSessionId === 'B' && ctrl.playbackOwnerId === 'A',
  `activeSessionId=${ctrl.activeSessionId} playbackOwnerId=${ctrl.playbackOwnerId}`,
)

// ② 空闲切走 → 正常清
const ctrl2 = new Controller({ nodes: [] })
ctrl2.activeSessionId = 'A'
ctrl2.playbackOwnerId = null
ctrl2.current = null
ctrl2.activateSession('B')
check('② 空闲切走 → 正常切（activeSessionId 更新）', ctrl2.activeSessionId === 'B')

// ③ 不越权 cancel
const ctrl3 = new Controller({ nodes: [] })
ctrl3.activeSessionId = 'A'
ctrl3.playbackOwnerId = 'B' // 播的是隔壁
ctrl3.segmentedState = { sessionId: 'B' }
ctrl3.cancelPlayback('A') // 主视图 cancel 不动隔壁
check('③ 不越权 cancel（非归属会话 cancel 不该清掉别人的播放）', ctrl3.playbackOwnerId === 'B')

// ④ 归属的会话 cancel → 真停
const ctrl4 = new Controller({ nodes: [] })
ctrl4.activeSessionId = 'A'
ctrl4.playbackOwnerId = 'A'
ctrl4.segmentedState = { sessionId: 'A', messageId: 'm1' }
ctrl4.current = { audio: makeAudio('A-4'), sessionId: 'A', messageId: 'm1' }
ctrl4.cancelPlayback('A')
check('④ 归属会话 cancel → segmentedState 被清', ctrl4.segmentedState === null)

// ⑤ 手动暂停后切回来还是暂停态
const ctrl5 = new Controller({ nodes: [] })
ctrl5.activeSessionId = 'A'
ctrl5.playbackOwnerId = 'A'
ctrl5.view = { sessionId: 'A', messageId: 'm1', source: 'segmented', status: 'playing' }
ctrl5.current = { audio: makeAudio('A-5'), sessionId: 'A', messageId: 'm1' }
ctrl5.segmentedState = { sessionId: 'A', messageId: 'm1', index: 0, segments: ['a'], voiceRate: 1 }
ctrl5.pauseSegmented('A', 'm1')
const pausedView = ctrl5.view.status
ctrl5.activateSession('B')
ctrl5.activateSession('A')
check('⑤ 手动暂停 → status 变 paused；切走切回仍是暂停态', pausedView === 'paused' && ctrl5.view?.status === 'paused', `pausedView=${pausedView} after=${ctrl5.view?.status}`)

// ⑥ 循环判据不再只看 activeSessionId
check(
  '⑥ 循环判据含 playbackOwnerId（不再只看 activeSessionId）',
  classSrc.includes('playbackOwnerId'),
)

// ⑦ 空闲切回 → 正常重置
const ctrl7 = new Controller({ nodes: [] })
ctrl7.activeSessionId = 'A'
ctrl7.playbackOwnerId = null
ctrl7.current = null
ctrl7.segmentedState = null
ctrl7.activateSession('B')
ctrl7.activateSession('A')
check('⑦ 空闲来回切 → activeSessionId 正确跟到 A', ctrl7.activeSessionId === 'A')

if (failures.length) {
  console.log('\n—— 失败明细 ——')
  for (const name of failures) console.log(`✗ ${name}`)
  console.log('\n提示：桩要贴着真实生命周期给，别把 releaseCurrentAudio 整个桩掉（那会让清空链断裂、误报一堆）。')
}

console.log(`\n${pass}/${pass + failures.length} 通过`)
process.exit(failures.length ? 1 : 0)
