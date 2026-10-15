# dsh-maid-tts-fix

DSH 小困插件 · **朗读与音色维护层**：给 [dsh-xiaomi-tts](https://github.com/ppy-web/dsh-plugin-xiaomi-mimo-tts) 装上能跨行的 `style`/`script` 剥离，让 VCP 卡片的 CSS 不再被念出来；切会话不掐断朗读；**隔壁会话跑完也自动念一遍**；**记忆反思轮不念、改念上一条**；并**盯着这个补丁别掉**。音色提示词的定稿与参照样本说明也收在这里。

## 一、病根：漂亮的卡片，念出来是 CSS

插件剥 HTML 用的是单行正则：

```js
const MARKDOWN_HTML_TAG_RE = /<[^>\r\n]*>/g;   // [^>\r\n] —— 跨不过换行
```

VCP 卡片的样式写在 `<style>` 块里，而 CSS 是**多行**的。这个正则匹配不到换行，于是 `<style>` 与 `</style>` 之间的整段原样留下，被当作正文送进语音合成。点一次朗读，耳朵里是：

```
#vcp-rootbox-sizing:border-box;max-width:760px;padding:26px 28px;...
```

不是"不知道念哪一段"，是**念了不该念的**——卡片做得越精致，念出来的垃圾越多。

补丁做四件事：**别念出 CSS**（改两处文件各一遍）、**只念重点**（见第一节之二）、**切会话不打断且隔壁跑完也念**（见第一节之三、之一之四）、**记忆反思轮不念、改念上一条**（见第一节之五）。`lib/client.js` 与 `lib/shared-DQIrhcy-.js` 是同一个函数的两个副本，漏一个就等于没修（跨会话与反思跳过那几段只在 `client.js`——`PlaybackController` 与 `latestAssistantMessageId` 只存在于客户端那份）。

| 改动 | 做什么 |
| --- | --- |
| 加三个常量 + `stripTtsStyleBlocks()` | 先按**块**删 `<style>`/`<script>` 整段，再走原来的行内清洗 |
| 改 `removeTtsMarkup` 首行 | 把新函数接在链首——函数写在旁边不等于会被调用 |
| 加 `extractTtsSpokenOverride()` | 认 `<!--tts:…-->` 标记，把里面的文本抽出来 |
| 接进 `messageText` 的**清洗之前** | 真正的入口。清洗会把标记当 HTML 标签吃掉（见第一节之二） |
| 接进 `applyTtsPlaybackScope` | 双保险：自动播报那条链路不经过 `messageText` |
| 新增 `playbackOwnerId`（播放归属） | 把「UI 在看哪个会话」和「播放属于谁」拆开——切会话不再掐断朗读（见第一节之三） |
| 新增 `remoteSessionId` + `playRemote()` | 给**不是当前在看的那个会话**播一段——隔壁会话跑完自动念一遍的入口（见第一节之四） |
| 改 `latestAssistantMessageId` | 认**记忆反思轮**，那一轮不念、改念上一条（见第一节之五） |

流式中间帧也照顾到了：`<style>` 已开、`</style>` 还没到时，从开标签处截断，宁可少念半句也不念 CSS。

## 一之二、只念重点：`<!--tts:…-->`

上游的「朗读范围」只有两档：全文，或者**按 160 字硬切的第一段**。第二档不是摘要，是截断——它不知道重点在哪。

只有写回复的人知道重点在哪。所以约定一个标记：

```markdown
老大，补丁已升级，朗读现在只念这一句。

<!--tts:老大，补丁已升级，朗读现在只念这一句。-->

后面是长篇正文，卡片、表格、细节……
```

点了朗读，耳朵里只有标记里那句话。**没写标记就完全退回原逻辑**——这个补丁不改变任何既有行为，只是多给一条路。

挂了**两处**，因为两条链路：

| 挂在哪 | 管什么 | 为什么必须在这 |
| --- | --- | --- |
| `messageText`（清洗**之前**） | 手动点朗读按钮 | 这是真正的入口。它下面紧接着 `prepareTtsText` → `removeTtsMarkup`，而清洗用的 `MARKDOWN_HTML_TAG_RE = /<[^>\r\n]*>/g` 会把 `<!--tts:…-->` 整条当标签吃掉——挂晚了标记早没了 |
| `applyTtsPlaybackScope` | 自动播报那条链路（不经过 `messageText`） | 它拿到的也是原始文本，标记还在 |

第一版只挂了后者，结果手动朗读照旧念全文——白装一次。**清洗之前**四个字是这条补丁的全部要害。

三条细节：

- 标记内容会**压掉换行与连续空白**再念（`\s+` → 单空格），所以可以为了好读写成多行
- 空白标记（`<!--tts:   -->`）视为没写，退回原逻辑
- 有标记时**不加** smart 模式的收尾语（"后面还有内容…"）——摘要本就是完整的一段，后面没有"还有内容"
- 标记写残也认（0.6.3）：结尾只剩 `--`、或文档末尾就断在那儿，照样把里面的文本抽出来念。**这不是洁癖，是事故善后**——见下节

### 渲染侧也得配合：注释不能显形

TTS 侧剥完标记只是让它**不被念**；正文里那行 `<!--tts:…-->` 会不会**显示出来**是另一码事，归渲染层管。

2026-10-15 实测：注释经 `DOMParser` 变成 comment 节点，再交给 vdom 转换时被转成**带尖括号的文本**渲染出来——于是卡片底下明晃晃挂着一行 `<!--tts:老大，……-->`。

修在 `dsh-maid-vcp` 的 `patch/v6-inject.js`，**两版才修对**：

| 版本 | 挂在哪 | 结果 |
| --- | --- | --- |
| v6.40 | `parseFrag` 里，进 DOM 之前 `stripHtmlComments()` | **无效**，注释照样显形 |
| v6.41 | `render` 入口最上游剥注释；剥完为空时返回**空 Fragment** | 生效 |
| v6.42 | 同上，但**未闭合注释不再一刀切到末尾** | 修掉「正文被吞」 |

v6.40 为什么没用：`<!--tts:…-->` 前后有空行时，会被切成**独立的 HTML 注释块**单独交给 `render`。这时处理链走完 `v` 已是空串，`if (!v) return null` 在 `parseFrag` **之前**就短路了——剥注释那行根本轮不到；而 `render` 返回 `null` 的语义是「我不渲染」，宿主随即 `return e.value`，**把注释原文当内容渲染**。

所以 v6.41 两处一起改：① 剥注释**提到 `render` 入口**；② 剥完为空时返回**空 Fragment** 而非 `null`（判据是「原文有东西、剥完没东西」才返空；真空消息仍返 `null`——不吞内容）。`<pre><code>` 里的注释示例已在 `protectCodeEntities` 转义成 `&lt;!--`，不受影响。

**v6.42 修的是一起真实事故**（2026-10-15）：v6.41 对未闭合注释的处理是「按 HTML 规范截断到末尾」——护住了流式中间帧，却埋了个雷。小困有三次回复把标记写残了（一次写成 `了。>`，两次结尾只剩 `--`），于是：

```
<!--tts:老大，两个问题。……不是同一件事。--     ← 少了 >
                                    ↑ 从这里到消息末尾全被切掉
```

**正文连同下面的卡片一起消失**，界面上只剩「已完成，用时 21 秒」那行工具提示。老大连着看见两次，报「你两次回复我都是这样」。

v6.42 把剥法改成**宽容模式**：遇到未闭合的 `<!--`，吃掉**它所在的整行**（标记协议上独占一行，删整行才不会把它两侧的正文粘成一行），然后继续处理剩下的；只有 `lenient !== true` 的老调用点（流式中间帧）才保留原来的截断行为。行尾没有换行时仍吃到末尾——那种情况标记后面本来也没东西了。

同一处事故 TTS 侧也补了一道：`extractTtsSpokenOverride` 原来只认 `-->`，标记写残就匹配失败 → 退回念全文。0.6.3 起放宽成「`-->` 优先，匹配不到就认行尾/文末的 `--`」——**两道保险各管一头：渲染侧保证正文不消失，TTS 侧保证写残也照样念对**。


**铁律：钩子挂点必须在调用链入口，不是下游。** 这条在 TTS 侧（第一版挂在 `applyTtsPlaybackScope`）和渲染侧（v6.40 挂在 `parseFrag`）各栽了一次。

**两个补丁必须配套**：只打 TTS 侧 → 注释不念但显形；只打渲染侧 → 注释不显形但照旧念全文。

## 一之三、切会话不打断：`playbackOwnerId`

上游的 `PlaybackController` 把两件事挤在 `activeSessionId` 一个字段里：**UI 正在看哪个会话**，和**这段播放属于谁**。后果是切会话即停——`activateSession` / `deactivateSession` 一进来就 `stopCurrent()`，播放循环里十几处 `this.activeSessionId !== sessionId` 判据也会在切走后自己 `return`。想在隔壁会话里干活，这条朗读就得断。

拆开：新增 **`playbackOwnerId`** 字段＝播放归属。

| 路径 | 以前看 | 现在看 |
| --- | --- | --- |
| 播放循环判据（`segmented` / `toggle` 体内十几处） | `activeSessionId` | **`playbackOwnerId`** |
| 播放入口（接管所有权） | 只设 `activeSessionId` | 同时设 `playbackOwnerId = sessionId`（新朗读仍会打断旧的——单声道，这是对的） |
| `activateSession` / `deactivateSession` | 直接 `stopCurrent()` | **正在响就只换 UI 会话，不停播**（`isPlayingNow()` 判据：current / 队列 / 分段状态 / 合成请求任一活着） |
| `cancelPlayback` | 谁都能停 | **归属会话才能停**（别会话在播就不越权） |
| UI 记账（`observeSession` / `claimAutomaticPlayback` / `updateLivePlayback`） | `activeSessionId` | 照旧，不动 |

行为结果：

- 播放中切走 → **继续播**；切回来 → 按钮 还是「播放中 / 暂停」态（view 不被清空）
- 点那条消息的朗读按钮暂停 → 暂停；切走再切回 → 还是暂停态，可续播
- 归属会话自己点停 / 开始新一轮朗读 → 停
- `cancelPlayback`（新回复开始时上游会调）→ 只停归属会话的，不越权

行为探针：`_probe/tts-switch-probe.mjs`——用 `cutFunction` 从落盘的 client.js 抠出**真实的** `PlaybackController` 类，在 `node:vm` 沙箱里喂桩，7 组场景 20 用例全过（播放中切走不停 / 空闲切走正常清 / 不越权 cancel / 归属 cancel 停 / 手动暂停后切回来还是暂停态 / 循环判据不再看 activeSessionId / 空闲切回正常重置）。探针第一版把 `releaseCurrentAudio` 桩掉了，结果 `stopCurrent` 清空链断了、误报一堆——**桩要贴着真实生命周期给，别图省事**。

一句边界：这一节管的是**已经开播之后**不被切会话掐断；「**隔壁会话跑完了自动念一遍**」是另一套全局观察者，见第一节之四（2026-10-15 补上，原先这里写的是"没顺手做"）。

## 一之四、隔壁会话跑完也念一遍：跨会话自动播报

上游的自动播报触发器挂在**当前渲染着的那条消息组件**里（`conversation.chat.assistant-actions` 槽位的 `ReadAloudAction`）。切走 = 组件卸载 = 触发器没了。所以「在隔壁会话里干活，跑完了念一声」上游做不到。

补丁补上这一段：一个与「当前在看哪个会话」无关的全局观察者。

```
sessions.list 里发现 running 且非主视图的会话
  → sessions.retain(id, { source }) 拿 binding
  → conversation.binding(binding).target("chat")
  → 订阅 binding.session，盯 running 的 落边沿（true → false）
  → 取最后一条带 text 的 assistant 正文
  → playback.playRemote(id, messageId, text) 排队播
  → release retain
```

**`playRemote` 就是第一节之三那套的解药**：它临时把 `remoteSessionId` 设成目标会话，`ownsSession()` 因此放行，播完还原——`activeSessionId`（UI 在看哪个会话）全程不动。运行时实测：播隔壁时 `activeSessionId` 仍是主视图会话，`playbackOwnerId` 切到隔壁，合成请求 `POST /plugins/xiaomi-mimo-tts/synthesize` 与 blob 播放都真的发生。

主视图会话**跳过**——它归上游 `ReadAloudAction` 管，两边都来会念两遍。

### 三条实测约束（写错任何一条都拿不到正文）

| 约束 | 症状 | 为什么 |
| --- | --- | --- |
| chat target 拿到后**必须先 `subscribe` 一次** | 首次 `getSnapshot()` 恒为 `undefined`，等 1.5s 也没用 | 快照是订阅驱动的，不订阅不产出 |
| **必须等 running 落下去再取，且留一拍** | 运行中的会话，58 条 assistant 只有 1 条带 text 块 | 正文是跑完才落进 nodes 的 |
| retain **必须 release** | 那个会话永远不会 retire，内存与列表都留着 | retain 是引用计数，计数不归零 scope 不回收 |

第一条最反直觉：`await ref.ready` 之后直接 `getSnapshot()` 还是 `undefined`，容易误判成"拿不到正文"。

### 与上游 `installTaskSoundWatcher` 的关系

上游已经有一个跨会话观察者——**音效**那个（`installTaskSoundWatcher`）。它用同一套 `binding.session.subscribe` + running 边沿检测，但只盯 `retainedBy.mainView > 0` 的会话（当前在看的），因为它服务的是"你正在等的那个回合跑完了"。本补丁的观察者是它的**跨会话版**：按会话列表里的 `running` 发现目标，不看 mainView。

**实测证据**（2026-10-15，真实渲染进程）：watcher 挂上后，两个正在跑的隔壁会话都被 retain，`retainedBy` 里出现 `xiaomi-mimo-tts-cross-session`；手动对隔壁已跑完会话调 `playRemote`，合成与播放全通、当前会话不被抢。

### 队列

同一时刻只有一路播放（单声道）。watcher 内部排队：正在播就等它完，播完续跑下一条。`autoPlay` 关掉时队列清空不播。

## 一之五、记忆反思轮不念：改念上一条

meow-memory 会定时往会话里插一条「记忆反思任务」，那一轮的回复（通常是一张"记忆反思·本轮封存"卡）是给系统看的记录，不是给人听的话。自动播报要是把它念出来，耳朵里就是一串记账。

老大原话（2026-10-15）：**「如果最新一条是记忆反思任务就改为念上一条。」**

### 怎么认出"这一条是反思产物"

反思任务以 `agent/inbox/spliced`（target `next-turn`）注入。它在 chat 视图里确实存在——`snap.nodes.byKey` 里能看到，kind 是 `context`（被 next-turn claim 时是 `turn-trigger`），`content` 数组里的文本以 `[meow-memory-reflect] 记忆反思任务` 开头，`source.kind` 是 `plugin:meow-memory`。

**但插件拿不到它。** 上游插件走的是 `useChat` 的 `legacy` 投影，而 `ui-chat-client.js` 的 `legacyContribution` 只认 `user` / `steering` / `context` / `command` 这几种 kind —— `turn-trigger` 不在其中，投影时直接返回 EMPTY。于是 `legacy.nodes` 里**根本没有那条注入**，任何"文本里找 `meow-memory-reflect`"的判据都永远命中不了。

（0.6.0 就是栽在这里：判据写得没错，但它依赖的那条节点早被投影丢了，线上完全不生效。）

### 实际可用的判据：看这一轮前面有没有"可见输入"

既然注入不可见，就换个角度——**真人说话必然留下可见的 `user` 节点，而不可见的注入不会**：

```
从本轮的起点 assistant 往前扫
  先撞见别的 assistant      → 这一轮没有可见输入 → 是反思轮（返回 true）
  先撞见 meow-memory 的反思注入 → 也是反思轮（返回 true）
  先撞见 user/steering/context/turn-trigger → 有可见输入 → 正常轮（返回 false）
  model-retry / turn-max-tokens 这类系统节点不是输入，跳过继续往前找
```

一轮多 step 时同 turn 有多条 assistant，要先回退到本轮**最早**那条再往前扫，否则"同 turn 的更早 assistant"会被误当成"别的轮的 assistant"。

**第二道判据是 0.6.2 补的。** 上面那条"撞见 `context` 就算有输入"有个缺口：**没被 claim 的反思注入本身就以 `context` 形态留在 `legacy` 里**——会话第一轮的反思任务就是这种。这时往前扫先撞见的就是它自己，被判成"有可见输入"，于是首轮反思照念。补法是先加一道 `isReflectInjection(previous)`：输入型节点若本身就是 `source.kind === "plugin:meow-memory"` 且文本含 `meow-memory-reflect`，也算反思轮。

### 落点为什么在 `latestAssistantMessageId`

那是"最新一条该念的 assistant"的唯一出口：主视图的 `ReadAloudAction`（自动播报判据 `message.latestMessageId === messageId`）与 `SessionPlaybackObserver` 都走它，改一处两条路一起生效。跨会话观察者的 `collect` 是自扫 nodes 的，在那边补了同样一行。

### 边界

- **去重仍然生效。** 上一条若已经被播过（`automaticallyPlayed` / 跨会话的 `played`），不会因为这次"改念上一条"而重念一遍——净效果是**这一轮不响**。老大要的是"别念反思废话"，这条边界正是那个效果。想强制重念，得再要一个开关。
- **连着一轮一轮反思**时一路往前取，直到撞到非反思轮为止。

### 实测

- 真值对照：以 `snap.nodes.byKey` 里 `source.kind === "plugin:meow-memory"` 且文本含 `meow-memory-reflect` 的注入节点的 `anchorSeq` 为真值（那份投影里注入还在），在 **42 个会话 / 21 个含反思的会话 / 28 个反思轮**上比对新判据——**零假阳、零假阴**。第一版判据（只有 INPUT_NODE_KINDS 那一道）漏 2 处（`dee6e427` 的 turn 84、`df8018f8` 的 turn 18，都是首轮 `context` 形态），加 `isReflectInjection` 后归零。
- 顺带否掉了两个更简单的候选：只看"前一个节点不是输入型"会误判 `model-retry`（1 处假阳），只看"前一个节点是 assistant"会漏掉 `turn-max-tokens` / `model-retry`（2 处假阴）。
- 真值口径踩过的坑：一开始拿 `legacy.nodes` 里"文本含 `meow-memory-reflect`"当真值，结果把老大自己打的字（"还是会读[meow-memory-reflect]…"）和一堆 tool-result 里的回显全算进去了，报出 130 处假阳。**真值必须取自 `snap.nodes.byKey` 且带 `source.kind` 过滤。**
- 端到端：42 个会话里 13 个的 `latestAssistantMessageId` 结果真的回退到了上一轮，且这 13 个全部来自含反思的会话。
- 离线：从落盘的 `client.js` 抠出真实的 `isReflectInjection` / `isMemoryReflectTurn` / `latestAssistantMessageId` 喂桩，全用例通过。

## 二、为什么走 pnpm patch，而不是改 node_modules

这是**教训**，不是偏好。

2026-10-14 第一版补丁是手改进 `node_modules/dsh-xiaomi-tts/lib/` 的。当晚装另一个插件触发了 pnpm 重铺，补丁连同当时的 `*.bak-*` 备份一起被**静默抹掉**——没有报错、没有提示，直到用户点朗读、耳朵里又响起 CSS 才发现。

改 node_modules 等于没改。所以现在：

- 补丁正本在本仓 `patches/dsh-xiaomi-tts@3.0.8.patch`
- 登记进 profile 的 `pnpm-workspace.yaml` → `patchedDependencies`
- hash 落进 `pnpm-lock.yaml` → `patch_hash`（**就是 `.patch` 文件的 sha256**）
- 此后任何 install / 重铺都会自动重打

## 三、用法

```bash
node scripts/patch.mjs list       # 本仓带哪些补丁、目标版本、sha256
node scripts/patch.mjs install    # 复制补丁 + 登记 + pnpm install + 核对
node scripts/patch.mjs verify     # 只核对：登记 / hash / 落盘
node scripts/patch.mjs remove     # 撤销登记与补丁文件，再 pnpm install
node scripts/patch.mjs upgrade    # 上游升版后重做补丁（见下节）
node scripts/patch.mjs redo       # 版本不变，按 lib/edits.js 重出补丁（改了补丁意图后跑）
node scripts/patch.mjs install --dry-run      # 只说要做什么
node scripts/patch.mjs verify --profile <dir> # 换 profile（默认 desktop）
node scripts/patch.mjs upgrade --to 3.1.0     # 指定目标版本，默认按已装的
```

`verify` 输出长这样：

```
✓ 登记：pnpm-workspace.yaml 的 patchedDependencies → dsh-xiaomi-tts@3.0.8
✓ lockfile hash 与补丁正本一致：e90c3ae2fc828203…
✓ 落盘：lib/client.js 已应用
✓ 落盘：lib/shared-DQIrhcy-.js 已应用
```

### 一个 pnpm 的盲区（install 会假装成功）

2026-10-15 实测：如果有人从外部删掉整包目录（`rm -rf node_modules/dsh-xiaomi-tts`），
`pnpm install` 会回一句 `Already up to date` 直接跳过——**连 `--force`、删掉
`node_modules/.modules.yaml` 都不管用**。pnpm 的账本仍认为它装好了，于是补丁文件、
登记、lockfile 全对，包里却一个字都没有，朗读又开始念 CSS。

唯一的出路是让 pnpm 重新解析这个包：`pnpm add <包名>@<版本>`。同版本重装不改
`dependencies`，只补回目录。`install` 子命令已内置这个回退——它先跑 `pnpm install`，
发现是 `missing-file`（目录整个没了）就自动补一发 `pnpm add`，不用人记。

## 四、上游升版了怎么办：`upgrade`

这是本仓存在的一半理由。**补丁不影响上游更新，但前提是升完得重做补丁。**

`patchedDependencies` 的键是**精确版本**（`dsh-xiaomi-tts@3.0.8`）。上游一发新版，
这个键就悬空——实测（2026-10-15）pnpm 会直接报 `ERR_PNPM_UNUSED_PATCH` 并
**中止整个 install**。这其实是好事（不会假装成功），但意味着不重做补丁就升不动。

`upgrade` 就是那条路，全程不需要人碰源码：

```
pnpm patch <包>@<新版本>       → 解出一棵"上游原样"的源码树
按 lib/edits.js 重放编辑       → 锚点命中数不对就整体中止，绝不半打
node --check 两处文件          → 语法错就绝不 commit
pnpm patch-commit              → 生成新版本的 .patch 并登记
清掉旧版本的 .patch 与登记     → 否则旧键又会触发 UNUSED_PATCH
verify                         → 四项核对
```

**补丁的"意图"写在 `lib/edits.js`，`.patch` 文件是它的产物。** 上游改动了
锚点所在的那几行时，重放会明确报出是哪一条、期望命中几次、实际几次，而不是
甩一个上下文对不上的 diff 让人自己啃——照着源码把锚点更新一下再跑即可。

### 改了补丁意图、但版本没变：`redo`

往 `lib/edits.js` 里加了新编辑（比如加那条 `spoken-override`），上游版本却没动，
这时跑 `upgrade` 会被"补丁已是 3.0.8，无需重做"挡回来。用 `redo`——流程一模一样，
只差在**不检查版本变化**。

**这里有个坑，卡了整整一轮（2026-10-15 实测）**：`pnpm patch` 对已经登记在
`patchedDependencies` 里的包，解出来的是**打过补丁的版本**——它从虚拟 store 里
取现成产物，不是从 registry 下原始 tarball。于是重放阶段看到树里已经有
`stripTtsStyleBlocks`，走幂等分支跳过，**改了 `edits.js` 等于白改，还打印成功**。

所以 `redo` 的流程是：

```
临时摘掉 patchedDependencies 登记   → 不然 pnpm 取的是已打过补丁的树
清掉上次残留的暂存目录              → 不然沿用上一轮的树，同样走幂等跳过
pnpm patch <包>@<版本>              → 这回才是干净的上游原样
按 lib/edits.js 重放 → node --check → patch-commit
```

摘掉登记是**临时**的：失败时脚本自己还原，成功时 `patch-commit` 会写回。
若摘掉登记后解出来的树**仍含**补丁特征，脚本会中止并提示 `pnpm store prune`——
那说明 store 里的包已经被污染（补丁产物被当成原包缓存了），重放会叠第二遍。

### 锚点为什么这么难写（三次实测教训）

同一个坑踩了三回，都记在 `lib/edits.js` 的注释里：

| 次 | 症状 | 原因 |
| --- | --- | --- |
| 1 | 命中 0 次 | 锚点写成带 `\t` 前缀，源码那行是顶格的 |
| 2 | 替换后缩进叠成两层 | 替换串自带 `\t`，源码行已有缩进 |
| 3 | 逐字全不匹配，但肉眼看"明明一样" | **上游那两个文件是 CRLF 行尾**，锚点写的是 `\n` |

第三条最阴。现在的写法是：锚点一律用 `\n` 书写，由 `normalizeEol()` 在匹配前
按目标文件的行尾风格折算——不手写 `\r`，也不假设上游用什么行尾。

### 这套重放可信吗

可信，而且是被证明的。`_probe/tts-fix-replay-test.mjs` 拿**真实上游源码**做验证：

1. 把已打补丁的那份拷出来，`git apply -R` 反向撤成"上游原样"
2. 让 `planEdits` 从零重放一遍
3. 逐字节比对重放结果与 patch-commit 出来的版本

结果是**完全一致**。端到端演练（把补丁文件名伪装成旧版本、逼 `upgrade` 走完整
流程）生成的补丁，sha256 与原正本逐字节相同。补丁从 4120 字节一路长到现在的
23575 字节（`spoken-override` → 6144、`spoken-override-entry` → 6921、切会话不打断
→ 14883、跨会话自动播报 → 21868、反思轮跳过初版 → 23356、判据修正 → 23082、
首轮反思补判据 → 23463、标记收尾容错 → 23575），每一次 `redo` 都是一次实测，
重放始终逐字节可复现。

## 五、启动自检：它不会悄悄死掉

`index.js` 在每次启动时把同样三项问一遍，掉哪一项就 `warn` 出来并附上修它的命令。三条路径互相独立，因为它们是三个独立的失效点：

| 问什么 | 掉了会怎样 |
| --- | --- |
| 登记还在吗 | profile 换过 / 被谁清过 → 补丁根本不参与 install |
| hash 对得上吗 | 补丁改过但没重打 → 生效的是旧版本 |
| 字节落盘了吗 | install 失败 / 包被换版本 → 补丁文件在，包里没有 |

它**不修、不拦、不抛**——一个体检器没有资格让应用起不来。宿主没装 `dsh-xiaomi-tts` 时，它也不过是白问一遍。

## 六、边界

- **只做朗读这一件事。** 补丁只碰朗读的文本清洗、播放归属与自动播报触发，不碰音色、不碰插件配置、不碰插件其余部分。（音色提示词存在本仓 `voice-refs/`，但那是**文档**，不是补丁的一部分——补丁本身一个字节都不涉及它。）
- **不改上游一个字节以外的任何东西。** 补丁全部内容都在 `patches/*.patch` 里，`install`/`remove` 之外不写 profile。
- **补丁随包分发。** `patches/` 在 `package.json` 的 `files` 白名单里——这个包的意义就是携带补丁正本，丢了它就没意义。
- 上游哪天自己修好了，`verify` 会报「落盘：未应用」而不是假装成功——那正是该退休的信号。

### 上游停更了怎么办

本仓的定位是**两段式**：上游活着时只做补丁、跟随更新、不锁版本；上游一旦停更，
就整体收录接管（形态参照 `dsh-maid-preset` 内置 `meow-memory` 的做法）。

判断信号：`verify` 报「落盘：未应用」且上游仓库长期无提交 —— 说明上游自己修好了，
或者不再维护。前者退休，后者转收录。

## 七、音色：小困的声音也归这儿

补丁管的是「别念出 CSS」，音色管的是「念出来像谁」。两件事都发生在同一个插件 `dsh-xiaomi-tts` 身上，所以**音色相关的知识也统一收在本仓**（2026-10-15 从 `dsh-maid-preset` 迁来）：

| 文件 | 用途 |
| --- | --- |
| `voice-refs/prompt.md` | 音色提示词定稿全文、落点与生效条件、四组 AB 实测数据、两条硬约束 |
| `voice-refs/README.json` | 本地参照样本的生成条件、md5、声学数据 |

`voice-refs/*.wav`（挑中的三个参照样本，约 8.7MB）**不入库**（`.gitignore` 已排除）——它们是「靶子」不是运行时依赖，且本仓库为 public。换机器要复刻，用同文本 + `prompt.md` 的提示词直连 API 重抽即可。

> **提示词写在哪、怎么生效，见 `voice-refs/prompt.md`。** 一句话版：写进 **profile 的** `cordis.patch.yml` 的 `xiaomi-mimo-tts` 段（`voiceDesignPrompt` 与 `voiceDesignCustomPrompt` 两处必须一致），改完**重启 DSH**，且插件设置面板里的本地值会盖过文件。
>
> 那个段里带着 API 密钥，所以**不进任何仓库**——本仓只存「怎么调」，不存「调到哪台机器上」。

## 八、和 dsh-maid-preset 的关系

**人设归人设，环境归环境。**

- `dsh-maid-preset` 只专注两件事：**人设预设 + 记忆系统**。
- 本仓管 TTS 这一摊：**补丁 + 音色提示词 + 参照样本说明**——都是围绕第三方插件 `dsh-xiaomi-tts` 的维护件。

两边**无代码依赖**，删掉任一个，另一个照常跑。人设包那边只在 README 里留了一句指向本仓的话，免得找补丁的人翻错仓库。

## License

MIT
