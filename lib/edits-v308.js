/**
 * 补丁的**声明式定义** —— 上游升版时靠它把补丁重新打一遍。
 *
 * 为什么不用 .patch 文件本身来重做：`.patch` 是**结果**，不是**意图**。
 * 上游一改那块代码，上下文行就对不上，`git apply` 直接失败，人得手工
 * 对着 diff 猜当初想干什么。这里写的是意图——"在哪个锚点后面插什么"、
 * "把哪一行换成什么"——锚点还在就能重放，锚点没了就明确报错说清是
 * 哪一条失效，而不是甩一个上下文对不上的 diff 让人自己啃。
 *
 * 锚点纪律（踩过坑）：**锚点串必须与源码逐字相同，包括缩进和行尾**。
 * 2026-10-14 第一次打补丁时两次栽在这上面：锚点写成带 `\t` 前缀而源码那行
 * 是顶格的，命中 0 次；替换串自带 `\t` 而源码行已有缩进，叠成两层。
 * 2026-10-15 重做时又栽第三次——**上游那两个文件是 CRLF 行尾**，本文件里的
 * 锚点写的是 `\n`，于是逐字匹配全线落空。所以下面所有锚点一律用 `\n` 书写，
 * 由 `normalizeEol()` 在匹配前统一折算成目标文件的行尾风格；锚点与插入内容
 * 都跟着走，不手写 `\r`。
 *
 * 每条 edit 都带 `expect`：命中次数必须**恰好**等于它，多了少了都停，
 * 绝不"尽力而为"地半打——半打的补丁比没打更难查。
 *
 * @module lib/edits
 */

// 幂等判据的唯一事实源：补丁落盘特征全集定义在 selfcheck.js（cmdVerify 的
// 落盘体检用的就是它）。planEdits 的 already 判定必须与它同判据，见 planEdits。
import { APPLIED_MARKERS, resolveMarkerFiles } from './selfcheck.js'

/** 补丁作用的两个文件（同一函数的两个副本，必须都改）。 */
export const TARGET_FILES = Object.freeze(['lib/client.js', 'lib/shared-DQIrhcy-.js'])

/** 要插入的常量 + 函数（不含首尾换行；缩进用 \t，与源码一致）。 */
const STYLE_HELPERS = [
  'const MARKDOWN_STYLE_BLOCK_RE = /<(style|script)\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>/gi;',
  'const MARKDOWN_STYLE_OPEN_RE = /<(style|script)\\b[^>]*>/i;',
  'const MARKDOWN_STYLE_CLOSE_RE = /<\\/(?:style|script)\\s*>/i;',
  'function stripTtsStyleBlocks(value) {',
  '\tconst withoutBlocks = value.replace(MARKDOWN_STYLE_BLOCK_RE, " ");',
  '\tconst open = withoutBlocks.search(MARKDOWN_STYLE_OPEN_RE);',
  '\tif (open < 0) return withoutBlocks;',
  '\tconst rest = withoutBlocks.slice(open);',
  '\treturn MARKDOWN_STYLE_CLOSE_RE.test(rest) ? withoutBlocks : withoutBlocks.slice(0, open);',
  '}',
  // 卡片剥离（0.6.5）：把整块 <div id="vcp-root">…</div> 从朗读文本里摘掉。
  //
  // 为什么需要它（2026-10-17 老大报障「现在朗读又开始读卡片了」）：readScope=
  // first-segment 的兜底是「念首段」，而小困的视觉卡片回复**卡片就排在正文最前**，
  // 于是首段天然是卡片的可见文字——漏写标记时，念出来的是「JASNA · 关机问答
  // 可以关，而且已经替你验证过了…」。CSS 早被 stripTtsStyleBlocks 剥干净了，
  // 剩下的是**卡片里的可见文字**，剥 CSS 那道管不着。
  //
  // 做法：按 div 配平找块边界（不能靠非贪婪正则——卡片里有嵌套 div），
  // 剥掉**所有** vcp-root 块；剥完若一个字不剩（纯卡片消息）就原样返回，
  // 退回老行为，绝不把朗读内容变成空。未闭合的卡片（流式中间帧）不动，
  // 宁可多念半句，也不能把卡片后面的正文吃掉。
  'function stripTtsCards(value) {',
  '\tif (typeof value !== "string" || value.indexOf("vcp-root") < 0) return value;',
  '\tconst openRe = /<div\\s+id=["\']vcp-root["\'][^>]*>/i;',
  '\tconst kept = [];',
  '\tlet cursor = 0;',
  '\twhile (cursor < value.length) {',
  '\t\tconst openMatch = openRe.exec(value.slice(cursor));',
  '\t\tif (openMatch === null) break;',
  '\t\tconst openAt = cursor + openMatch.index;',
  '\t\tconst tagRe = /<div\\b[^>]*>|<\\/div\\s*>/gi;',
  '\t\ttagRe.lastIndex = openAt;',
  '\t\tlet depth = 0;',
  '\t\tlet match;',
  '\t\tlet end = -1;',
  '\t\twhile ((match = tagRe.exec(value)) !== null) {',
  '\t\t\tif (match[0][1] === "/") {',
  '\t\t\t\tdepth -= 1;',
  '\t\t\t\tif (depth === 0) { end = tagRe.lastIndex; break; }',
  '\t\t\t} else {',
  '\t\t\t\tdepth += 1;',
  '\t\t\t}',
  '\t\t}',
  '\t\tif (end < 0) break;',
  '\t\tkept.push(value.slice(cursor, openAt));',
  '\t\tcursor = end;',
  '\t}',
  '\tif (kept.length === 0) return value;',
  '\tkept.push(value.slice(cursor));',
  '\tconst joined = kept.join(" ");',
  '\treturn joined.trim().length === 0 ? value : joined;',
  '}',
].join('\n')

/**
 * 朗读摘要的提取器 + 接进播放范围解析。
 *
 * 为什么需要它：上游的「朗读范围」只有全文 / 首段两档，首段是按 160 字硬切
 * 的第一段——**它不会挑重点**。想让朗读只念重点，只有写回复的人知道重点在
 * 哪，所以约定：回复里写 `<!--tts:要念的那段-->`，插件优先念它；没写就
 * 退回原来的范围逻辑（不改变任何既有行为）。
 *
 * 为什么挂在 `applyTtsPlaybackScope` 上：手动点朗读按钮走的就是它
 * （`playbackText(false)` → `applyTtsPlaybackScope`），而它拿到的是**未经
 * 清洗的原始消息文本**——此时 `<!--tts:…-->` 还在，还没被 removeTtsMarkup
 * 剥掉。挂在清洗之后的任何一步都拿不到标记。
 *
 * 覆盖只在有标记时生效，且**不加** smart 模式的收尾语——摘要本就是完整的
 * 一段话，后面没有"还有内容"。
 *
 * 收尾容错（2026-10-15）：标记写残时（结尾只剩 `--`、或写成 `了。>`），原来只认
 * `-->` 的正则会匹配失败 → 退回原逻辑念全文；而渲染侧同一条残缺标记会把正文
 * 整段吞掉（v6.42 才修）。这里放宽成「`-->` 优先，匹配不到就认**行尾/文末**的
 * `--` 或 `>`」，让标记写残也照样念得对——两道保险各管一头。
 * 锚在行尾是必须的：不锚的话，内容里正常的 `>`（如 `老大 > 小困`）会被当成收尾，
 * 把摘要拦腰截断。
 */
const SPOKEN_OVERRIDE = [
  '/** 回复里写了 <!--tts:…--> 就念它，没写返回 undefined 走原逻辑。 */',
  'function extractTtsSpokenOverride(value) {',
  '\tconst match = /<!--\\s*tts:([\\s\\S]*?)-->/.exec(value) ?? /<!--\\s*tts:([\\s\\S]*?)(?:--|>)(?=\\s*(?:\\n|$))/.exec(value);',
  '\tif (match === null) return void 0;',
  '\tconst spoken = match[1].replace(/\\s+/g, " ").trim();',
  '\treturn spoken.length === 0 ? void 0 : spoken;',
  '}',
].join('\n')

const PLAYBACK_SCOPE_FIND = [
  'function applyTtsPlaybackScope(value, scope, automatic, random = Math.random) {',
  '\tconst scoped = applyTtsReadScope(value, resolveTtsReadScope(scope, automatic));',
].join('\n')

const PLAYBACK_SCOPE_REPLACE = [
  `${SPOKEN_OVERRIDE}`,
  'function applyTtsPlaybackScope(value, scope, automatic, random = Math.random) {',
  '\tconst override = extractTtsSpokenOverride(value);',
  '\tif (override !== void 0) return override;',
  '\tconst scoped = applyTtsReadScope(value, resolveTtsReadScope(scope, automatic));',
].join('\n')

/**
 * 在 `messageText` 里**清洗之前**提取标记。
 *
 * 为什么必须在这里，而不是只在 `applyTtsPlaybackScope` 里（2026-10-15 实测踩到）：
 * `messageText` 先调 `prepareTtsText`，而它内部的 `removeTtsMarkup` 用
 * `MARKDOWN_HTML_TAG_RE = /<[^>\r\n]*>/g` 剥 HTML——`<!--tts:…-->` 正好是一行内
 * 的尖括号对，**整条被当标签吃掉**。等文本流到 `applyTtsPlaybackScope` 时标记
 * 早没了，于是退回原逻辑、照旧念全文。第一版就栽在这，白装了一次。
 *
 * 所以真正的入口是这里：先拿**原始文本**看有没有标记，有就直接返回标记内容
 * ——它本身就是最终朗读文本，不需要再走 markdown 清洗（标记里写纯文本）。
 *
 * 这条只对 `lib/client.js` 生效：`messageText` 只存在于客户端那份，
 * `shared-DQIrhcy-.js` 里没有这个函数（expect 对不上就整批中止，
 * 所以用 filter 把这条限定在 client.js）。
 */
const MESSAGE_TEXT_FIND = [
  'function messageText(legacy, messageId) {',
  '\tfor (const node of legacy.nodes) {',
  '\t\tif (node.kind !== "assistant" || node.messageId !== messageId) continue;',
  '\t\treturn (0, __deepseek_ai_dsh_client_ui_primitives.extractMarkdownPlainText)(prepareTtsText(node.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\\n\\n"))).trim();',
  '\t}',
  '\treturn "";',
  '}',
].join('\n')

const MESSAGE_TEXT_REPLACE = [
  'function messageText(legacy, messageId) {',
  '\tfor (const node of legacy.nodes) {',
  '\t\tif (node.kind !== "assistant" || node.messageId !== messageId) continue;',
  '\t\tconst rawText = node.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\\n\\n");',
  '\t\tconst spokenOverride = extractTtsSpokenOverride(rawText);',
  '\t\tif (spokenOverride !== void 0) return spokenOverride;',
  '\t\treturn (0, __deepseek_ai_dsh_client_ui_primitives.extractMarkdownPlainText)(prepareTtsText(rawText)).trim();',
  '\t}',
  '\treturn "";',
  '}',
].join('\n')

/**
 * 流式实时播报的第四个入口（2026-10-16 · 老大实测报障「只念重点没实现，
 * 念的是输出内容和卡片内容」后定位）。
 *
 * `scopedLiveText` 是主视图里**边生成边播**那条路：每帧拿 partial 的累积文本，
 * 走 `extractMarkdownPlainText(prepareTtsText(value))` 清洗后喂 limiter。
 * 它和 messageText 一样在清洗前不吃标记——`<!--tts:…-->` 被当 HTML 标签吃掉，
 * 于是自动播报念的是整段正文 + 卡片文字。三条路（手动 messageText、
 * 跨会话 pump→applyTtsPlaybackScope、范围解析）都挂了标记提取，唯独漏了它：
 * **改判据要改唯一出口，旁路得逐个补**（见 lesson「改唯一出口」）。
 *
 * 标记检查放在函数**第一行**（在 full 短路之前）：老大若把 readScope 切回
 * full，标记依然优先——标记内容本身就是最终朗读文本，与范围模式无关。
 * 有标记时每帧返回同一稳定字符串，limiter 的单调性天然满足。
 * 只存在于 client.js（shared 两份都没有 scopedLiveText，实测 grep=0）。
 */
const LIVE_TEXT_FIND = [
  'function scopedLiveText(value, scope, limiter, final = false) {',
  '\tif (resolveTtsReadScope(scope, true) === "full") return value;',
].join('\n')

const LIVE_TEXT_REPLACE = [
  'function scopedLiveText(value, scope, limiter, final = false) {',
  '\tconst spokenOverride = extractTtsSpokenOverride(value);',
  '\tif (spokenOverride !== void 0) return spokenOverride;',
  '\tif (resolveTtsReadScope(scope, true) === "full") return value;',
].join('\n')

/**
 * 记忆反思轮不念（2026-10-15 · 老大原话「如果最新一条是记忆反思任务就改为念上一条」）。
 *
 * meow-memory 的反思任务以 `agent/inbox/spliced`（target `next-turn`）注入，
 * 在 chat nodes 里落成一条 **非 assistant** 节点（实测 kind 为 `context`，
 * 被 next-turn claim 时是 `turn-trigger`；真人消息是 `user`），
 * 其 `content` 数组里的文本以 `[meow-memory-reflect] 记忆反思任务` 开头。
 * 那条注入触发的 assistant 回复就是"反思产物"——给系统看的记录，不是给老大听的话。
 *
 * 判据不能只看文本标记（0.6.0 就是这么写的，**线上没生效**）：那条注入在
 * `legacy` 投影里会被整个丢掉 —— `ui-chat-client.js:8546` 的 legacyContribution
 * 只认 `kind === "user" | "steering" | "context" | "command"` 等少数几种，
 * 而被 next-turn claim 的注入是 `turn-trigger`，投影时直接返回 EMPTY。
 * 于是插件拿到的 `legacy.nodes` 里根本没有那条注入，文本匹配永远命中不了。
 *
 * 换成只看"这一轮前面有没有可见的输入"：
 *   本轮的起点 assistant 往前扫 —— 先撞见别的 assistant ⇒ 这一轮没有可见输入
 *   （是被不可见注入触发的）⇒ 反思轮；先撞见 user/steering/context/turn-trigger
 *   ⇒ 有可见输入（真人说话或可见注入）⇒ 正常轮。
 * `model-retry` / `turn-max-tokens` 这类系统节点不是输入，直接跳过继续往前找。
 *
 * 一个补丁（0.6.2）：**没被 claim 的反思注入本身就以 `context` 形态留在 legacy 里**
 * （会话第一轮的反思注入就是这种），上面那条"撞见 context 就算有输入"会把它放过去。
 * 所以先加一道 `isReflectInjection(previous)`：输入型节点若本身是 meow-memory 的
 * 反思注入，也算反思轮。
 * 实测 42 个会话 / 21 个含反思的会话 / 27 个反思轮：v1 漏 2 处（dee6e427:84、
 * df8018f8:18，正是首轮 context 形态），v2 零假阳零假阴。
 *
 * 一轮多 step 时同 turn 有多条 assistant：先回退到本轮**最早**那条再往前扫，
 * 否则"同 turn 的更早 assistant"会被误当成"别的轮的 assistant"。
 *
 * 落点选 `latestAssistantMessageId` —— 主视图的 ReadAloudAction 与
 * SessionPlaybackObserver 都走它，改一处两条路一起生效。跨会话观察者的
 * collect 是自扫的，另在那边补一行同样判据。
 */
const REFLECT_SKIP_FIND = [
  'function latestAssistantMessageId(legacy) {',
  '\tfor (let index = legacy.nodes.length - 1; index >= 0; index -= 1) {',
  '\t\tconst node = legacy.nodes[index];',
  '\t\tif (node?.kind === "assistant" && node.messageId !== void 0) return node.messageId;',
  '\t}',
  '\treturn null;',
  '}',
].join('\n')

const REFLECT_SKIP_REPLACE = [
  'const INPUT_NODE_KINDS = new Set(["user", "steering", "context", "turn-trigger"]);',
  'function isReflectInjection(node) {',
  '\tif (node?.source?.kind !== "plugin:meow-memory") return false;',
  '\tconst content = node.content;',
  '\tif (!Array.isArray(content)) return false;',
  '\tfor (const item of content) {',
  '\t\tif (typeof item?.text === "string" && item.text.includes("meow-memory-reflect")) return true;',
  '\t}',
  '\treturn false;',
  '}',
  'function isMemoryReflectTurn(legacy, index) {',
  '\tconst nodes = legacy.nodes;',
  '\tconst node = nodes[index];',
  '\tif (node === void 0 || node.turn === void 0) return false;',
  '\tfor (let cursor = index - 1; cursor >= 0; cursor -= 1) {',
  '\t\tconst previous = nodes[cursor];',
  '\t\tif (previous?.kind === "assistant") {',
  '\t\t\tif (previous.turn === node.turn) continue;',
  '\t\t\treturn true;',
  '\t\t}',
  '\t\tif (isReflectInjection(previous)) return true;',
  '\t\tif (INPUT_NODE_KINDS.has(previous?.kind)) return false;',
  '\t}',
  '\treturn false;',
  '}',
  'function latestAssistantMessageId(legacy) {',
  '\tfor (let index = legacy.nodes.length - 1; index >= 0; index -= 1) {',
  '\t\tconst node = legacy.nodes[index];',
  '\t\tif (node?.kind !== "assistant" || node.messageId === void 0) continue;',
  '\t\tif (isMemoryReflectTurn(legacy, index)) continue;',
  '\t\treturn node.messageId;',
  '\t}',
  '\treturn null;',
  '}',
].join('\n')

/**
 * 切会话不打断播放（2026-10-15 · 老大原话「切换会话啥的都不会打断」）。
 *
 * 上游把两件事挤在一个字段里：`activeSessionId` 既表示"UI 正在看哪个会话"，
 * 又被当成"这段播放属于谁"。后果是切会话时 `activateSession` 直接把音频掐掉
 * （`stopCurrent`），而且播放循环里十几处 `this.activeSessionId !== sessionId`
 * 会在切走的瞬间集体为真，就算不掐也在下一帧自己退出。
 *
 * 拆法：新增 `playbackOwnerId`（这段播放属于谁），让**播放路径**看它，
 * UI 记账路径（observeSession / claimAutomaticPlayback / updateLivePlayback）
 * 继续看 `activeSessionId`。切会话只改后者，播放自然活下来。
 *
 * 三条配套：
 *   - `activateSession` / `deactivateSession`：有音频在响就只换 UI 会话，
 *     不 stopCurrent、不 generation++、不 publish(emptyView)。
 *   - `segmented` / `toggle` 入口拿到所有权（`playbackOwnerId = sessionId`）——
 *     新的一次朗读仍然会打断上一次，单声道只能这样。
 *   - `cancelPlayback` 不再越权：别的会话正在播时，本会话起新一轮不该把它掐了。
 */
const SESSION_FIELD_FIND = '\tactiveSessionId = null;\n\tbeforePlayback = null;'

const SESSION_FIELD_REPLACE = '\tactiveSessionId = null;\n\tplaybackOwnerId = null;\n\tbeforePlayback = null;'

const ACTIVATE_SESSION_FIND = [
  '\tactivateSession(sessionId) {',
  '\t\tif (this.activeSessionId === sessionId) return;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.liveSessions.clear();',
  '\t\tthis.completedSessions.clear();',
  '\t\tthis.completedMessages.clear();',
  '\t\tthis.activeSessionId = sessionId;',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
].join('\n')

const ACTIVATE_SESSION_REPLACE = [
  '\tactivateSession(sessionId) {',
  '\t\tif (this.activeSessionId === sessionId) return;',
  '\t\tthis.activeSessionId = sessionId;',
  '\t\tthis.liveSessions.clear();',
  '\t\tthis.completedSessions.clear();',
  '\t\tthis.completedMessages.clear();',
  '\t\tif (this.isPlayingNow()) return;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.playbackOwnerId = null;',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
  '\t/** 现在有没有音频在响（含排队中与合成中）——切会话时靠它决定要不要打断。 */',
  '\tisPlayingNow() {',
  '\t\treturn this.current !== null || this.segmentQueue.length > 0 || this.segmentedState !== null || this.request !== null;',
  '\t}',
].join('\n')

const DEACTIVATE_SESSION_FIND = [
  '\tdeactivateSession(sessionId) {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.liveSessions.clear();',
  '\t\tthis.completedSessions.clear();',
  '\t\tthis.completedMessages.clear();',
  '\t\tthis.activeSessionId = null;',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
].join('\n')

const DEACTIVATE_SESSION_REPLACE = [
  '\tdeactivateSession(sessionId) {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tthis.activeSessionId = null;',
  '\t\tif (this.isPlayingNow()) return;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.playbackOwnerId = null;',
  '\t\tthis.liveSessions.clear();',
  '\t\tthis.completedSessions.clear();',
  '\t\tthis.completedMessages.clear();',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
].join('\n')

const CANCEL_PLAYBACK_FIND = [
  '\tcancelPlayback(sessionId) {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
].join('\n')

const CANCEL_PLAYBACK_REPLACE = [
  '\tcancelPlayback(sessionId) {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tif (this.playbackOwnerId !== null && this.playbackOwnerId !== sessionId) return;',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.playbackOwnerId = null;',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
].join('\n')

const PAUSE_SEGMENTED_FIND = [
  '\tpauseSegmented(sessionId, messageId) {',
  '\t\tif (this.activeSessionId !== sessionId || this.view.source !== "segmented" || this.view.messageId !== messageId) return;',
].join('\n')

const PAUSE_SEGMENTED_REPLACE = [
  '\tpauseSegmented(sessionId, messageId) {',
  '\t\tif (this.playbackOwnerId !== sessionId || this.view.source !== "segmented" || this.view.messageId !== messageId) return;',
].join('\n')

const SEGMENTED_ENTRY_FIND = [
  '\tasync segmented(sessionId, messageId, text, automatic, fallback) {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
].join('\n')

const SEGMENTED_ENTRY_REPLACE = [
  '\tasync segmented(sessionId, messageId, text, automatic, fallback) {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tthis.playbackOwnerId = sessionId;',
].join('\n')

const TOGGLE_ENTRY_FIND = [
  '\tasync toggle(sessionId, messageId, text, automatic, fallback, format = "mp3") {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
].join('\n')

const TOGGLE_ENTRY_REPLACE = [
  '\tasync toggle(sessionId, messageId, text, automatic, fallback, format = "mp3") {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tthis.playbackOwnerId = sessionId;',
].join('\n')

/**
 * 播放循环里的身份判据：`activeSessionId` → `playbackOwnerId`。
 *
 * 这些行逐字写死，`expect` 是它们在源码里的出现次数（有两对是完全相同的行，
 * 所以 expect 是 2——planEdits 遇到 expect > 1 时会整批替换，见那里的注释）。
 */
const OWNER_CHECKS = [
  {
    find: '\t\t\t\tif (generation !== this.generation || this.activeSessionId !== sessionId) return;',
    replace: '\t\t\t\tif (generation !== this.generation || this.playbackOwnerId !== sessionId) return;',
    expect: 1,
  },
  {
    find: '\t\t\tif (generation !== this.generation || this.activeSessionId !== sessionId) return;',
    replace: '\t\t\tif (generation !== this.generation || this.playbackOwnerId !== sessionId) return;',
    expect: 1,
  },
  {
    find: '\t\t\t\t\t\tif (generation === this.generation && this.activeSessionId === sessionId) {',
    replace: '\t\t\t\t\t\tif (generation === this.generation && this.playbackOwnerId === sessionId) {',
    expect: 1,
  },
  {
    find: '\t\t\tif (generation === this.generation && this.activeSessionId === sessionId) {',
    replace: '\t\t\tif (generation === this.generation && this.playbackOwnerId === sessionId) {',
    expect: 1,
  },
  {
    find: '\t\t\tif (!controller.signal.aborted && generation === this.generation && this.activeSessionId === sessionId) {',
    replace: '\t\t\tif (!controller.signal.aborted && generation === this.generation && this.playbackOwnerId === sessionId) {',
    expect: 1,
  },
  {
    find: '\t\t\t\tif (generation$1 !== this.generation || this.activeSessionId !== sessionId || this.current?.audio !== audio) return;',
    replace: '\t\t\t\tif (generation$1 !== this.generation || this.playbackOwnerId !== sessionId || this.current?.audio !== audio) return;',
    expect: 2,
  },
  {
    find: '\t\t\t\t\tif (this.activeSessionId !== sessionId || this.current?.audio !== audio) return;',
    replace: '\t\t\t\t\tif (this.playbackOwnerId !== sessionId || this.current?.audio !== audio) return;',
    expect: 2,
  },
  {
    find: '\t\t\t\tif (generation !== this.generation || this.activeSessionId !== sessionId || this.current?.audio !== audio) return;',
    replace: '\t\t\t\tif (generation !== this.generation || this.playbackOwnerId !== sessionId || this.current?.audio !== audio) return;',
    expect: 2,
  },
  {
    find: '\t\t\tif (controller.signal.aborted || generation !== this.generation || this.activeSessionId !== sessionId) return;',
    replace: '\t\t\tif (controller.signal.aborted || generation !== this.generation || this.playbackOwnerId !== sessionId) return;',
    expect: 1,
  },
]

/**
 * 跨会话自动播报 —— 隔壁会话跑完，也念给你听（2026-10-15 · 老大拍板
 * 「改，会进tts-fix里面吗？xiaom-tts升级的话，从补丁里重新打回来。」）。
 *
 * 为什么需要新入口，而不是复用现成的自动播报：上游 `PlaybackController` 里
 * `activeSessionId` 是**双重身份**——既表示"UI 在看哪个会话"，又被当成"这段播放
 * 属于谁"。它由 `SessionPlaybackObserver` 的 `activateSession(sessionId)` 设定，
 * 只可能等于当前渲染的那个会话。于是 `segmented` / `toggle` 首行那句
 * `if (this.activeSessionId !== sessionId) return;` 会把隔壁会话的播报直接挡回去
 * ——2026-10-15 的只读探针里，"设了 playbackOwnerId 就能播隔壁"的判断就是这么
 * 错的（切会话不打断的 0.4.0 补丁只把**播放循环**的判据换成了 playbackOwnerId，
 * 入口那道门还在）。
 *
 * 拆法：再加一个 `remoteSessionId`——"被跨会话播报临时接管的会话"。入口判据由
 * `activeSessionId === sessionId` 放宽成 `ownsSession(sessionId)`，其余播放路径
 * 一个字不动（它们看 playbackOwnerId，与本次改动无关）。播完 `remoteSessionId`
 * 复原，不改变任何既有语义。
 */
const REMOTE_FIELD_FIND = '\tactiveSessionId = null;\n\tplaybackOwnerId = null;\n\tbeforePlayback = null;'

const REMOTE_FIELD_REPLACE = '\tactiveSessionId = null;\n\tplaybackOwnerId = null;\n\tremoteSessionId = null;\n\tbeforePlayback = null;'

const REMOTE_HELPERS_FIND = [
  '\t/** 现在有没有音频在响（含排队中与合成中）——切会话时靠它决定要不要打断。 */',
  '\tisPlayingNow() {',
  '\t\treturn this.current !== null || this.segmentQueue.length > 0 || this.segmentedState !== null || this.request !== null;',
  '\t}',
].join('\n')

const REMOTE_HELPERS_REPLACE = [
  REMOTE_HELPERS_FIND,
  '\t/** 这段播放属不属于这个会话：当前在看的，或者被跨会话播报临时接管的。 */',
  '\townsSession(sessionId) {',
  '\t\treturn this.activeSessionId === sessionId || this.remoteSessionId === sessionId;',
  '\t}',
  '\t/** 给"不是当前正在看的那个会话"播一段——绕过 activeSessionId 门禁，走 remoteSessionId。 */',
  '\tasync playRemote(sessionId, messageId, text, automatic, fallback) {',
  '\t\tconst previous = this.remoteSessionId;',
  '\t\tthis.remoteSessionId = sessionId;',
  '\t\ttry {',
  '\t\t\tif (splitTtsSegments(text).length > 1) await this.segmented(sessionId, messageId, text, automatic, fallback);',
  '\t\t\telse await this.toggle(sessionId, messageId, text, automatic, fallback, "mp3");',
  '\t\t} finally {',
  '\t\t\tthis.remoteSessionId = previous;',
  '\t\t}',
  '\t}',
].join('\n')

const REMOTE_SEGMENTED_FIND = [
  '\tasync segmented(sessionId, messageId, text, automatic, fallback) {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tthis.playbackOwnerId = sessionId;',
].join('\n')

const REMOTE_SEGMENTED_REPLACE = [
  '\tasync segmented(sessionId, messageId, text, automatic, fallback) {',
  '\t\tif (!this.ownsSession(sessionId)) return;',
  '\t\tthis.playbackOwnerId = sessionId;',
].join('\n')

const REMOTE_TOGGLE_FIND = [
  '\tasync toggle(sessionId, messageId, text, automatic, fallback, format = "mp3") {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tthis.playbackOwnerId = sessionId;',
].join('\n')

const REMOTE_TOGGLE_REPLACE = [
  '\tasync toggle(sessionId, messageId, text, automatic, fallback, format = "mp3") {',
  '\t\tif (!this.ownsSession(sessionId)) return;',
  '\t\tthis.playbackOwnerId = sessionId;',
].join('\n')

/**
 * 观察者本体：发现"隔壁在跑的会话" → retain 拿 binding → 订阅 running 边沿 →
 * 跑完取最后一条 assistant 正文 → 排队播。
 *
 * 三条实测约束（2026-10-15 探针，写错任何一条都拿不到正文）：
 *   1. chat target 首次 `getSnapshot()` 恒为 `undefined`（等 1.5s 也没用），
 *      **必须先 `subscribe` 一次**把快照催出来；
 *   2. 运行中的会话正文还没落进 nodes 的 text 块（实测 running 会话 58 条
 *      assistant 只有 1 条带 text），**必须等 running 落下去之后再取，且留一拍**；
 *   3. retain 必须 release，否则那个会话永远不会 retire。
 *
 * 与上游 `installTaskSoundWatcher` 的区别：那个只盯 `retainedBy.mainView`（当前
 * 在看的会话），因为它服务的是音效；这个要跨会话，所以按会话列表里的 `running`
 * 发现目标。主视图会话**跳过**——它归 `ReadAloudAction` 的自动播报管，两边都来
 * 会念两遍。
 */
const CROSS_SESSION_WATCHER = [
  '/** 隔壁会话跑完自动念一遍——与"当前在看哪个会话"无关。 */',
  'function installCrossSessionAutoPlay(ctx, playback, scope) {',
  '\tconst sessions = ctx.sessions;',
  '\tconst conversation = ctx.uiConversation;',
  '\tconst watched = /* @__PURE__ */ new Map();',
  '\tconst played = /* @__PURE__ */ new Set();',
  '\tconst queue = [];',
  '\tlet pumping = false;',
  '\tconst settingsOf = () => resolveTtsSettings(scope.getSnapshot().value);',
  '\tconst pump = () => {',
  '\t\tif (pumping || queue.length === 0) return;',
  '\t\tconst settings = settingsOf();',
  '\t\tif (!settings.enabled || !settings.autoPlay) {',
  '\t\t\tqueue.length = 0;',
  '\t\t\treturn;',
  '\t\t}',
  '\t\tif (playback.isPlayingNow()) return;',
  '\t\tconst next = queue.shift();',
  '\t\tconst scoped = applyTtsPlaybackScope(next.text, settings.readScope, true);',
  '\t\tif (scoped.length === 0) {',
  '\t\t\tpump();',
  '\t\t\treturn;',
  '\t\t}',
  '\t\t// 与主视图共享消息级认领；必须在出队后、开始播放前原子认领。',
  '\t\tconst automaticKey = `${next.sessionId}:${next.messageId}`;',
  '\t\tif (playback.automaticallyPlayed.has(automaticKey)) { pump(); return; }',
  '\t\tplayback.automaticallyPlayed.add(automaticKey);',
  '\t\tpumping = true;',
  '\t\tplayback.playRemote(next.sessionId, next.messageId, scoped).catch(() => {}).then(() => {',
  '\t\t\tpumping = false;',
  '\t\t\tpump();',
  '\t\t});',
  '\t};',
  '\t/** @returns {boolean} 是否已处理完（false 表示快照还没就绪，值得再等一拍）。 */',
  '\tconst collect = (sessionId) => {',
  '\t\tconst record = watched.get(sessionId);',
  '\t\tif (record === void 0 || record.chat === void 0) return false;',
  '\t\tconst settings = settingsOf();',
  '\t\tif (!settings.enabled || !settings.autoPlay) return true;',
  '\t\tconst snapshot = record.chat.getSnapshot();',
  '\t\tconst nodes = snapshot?.legacy?.nodes;',
  '\t\tif (!Array.isArray(nodes)) return false;',
  '\t\tfor (let index = nodes.length - 1; index >= 0; index -= 1) {',
  '\t\t\tconst node = nodes[index];',
  '\t\t\tif (node?.kind !== "assistant" || node.messageId === void 0) continue;',
  '\t\t\tif (isMemoryReflectTurn(snapshot.legacy, index)) continue;',
  '\t\t\tconst text = messageText(snapshot.legacy, node.messageId);',
  '\t\t\tif (text.length === 0) continue;',
  '\t\t\tconst key = `${sessionId}:${node.messageId}`;',
  '\t\t\tif (played.has(key)) return true;',
  '\t\t\tplayed.add(key);',
  '\t\t\tqueue.push({',
  '\t\t\t\tsessionId,',
  '\t\t\t\tmessageId: node.messageId,',
  '\t\t\t\ttext',
  '\t\t\t});',
  '\t\t\tpump();',
  '\t\t\treturn true;',
  '\t\t}',
  '\t\treturn true;',
  '\t};',
  '\tconst unwatch = (sessionId) => {',
  '\t\tconst record = watched.get(sessionId);',
  '\t\tif (record === void 0) return;',
  '\t\twatched.delete(sessionId);',
  '\t\trecord.sessionOff?.();',
  '\t\trecord.chatOff?.();',
  '\t\ttry {',
  '\t\t\trecord.reference?.release();',
  '\t\t} catch {}',
  '\t};',
  '\tconst tick = (sessionId, binding) => {',
  '\t\tconst record = watched.get(sessionId);',
  '\t\tif (record === void 0) return;',
  '\t\tconst running = binding.session.getSnapshot().running === true;',
  '\t\tconst previous = record.lastRunning;',
  '\t\trecord.lastRunning = running;',
  '\t\tif (previous !== true || running) return;',
  '\t\tconst attempt = (tries) => {',
  '\t\t\tif (collect(sessionId) || tries <= 0) {',
  '\t\t\t\tunwatch(sessionId);',
  '\t\t\t\treturn;',
  '\t\t\t}',
  '\t\t\twindow.setTimeout(() => attempt(tries - 1), 400);',
  '\t\t};',
  '\t\twindow.setTimeout(() => attempt(5), 500);',
  '\t};',
  '\tconst watch = (sessionId) => {',
  '\t\tif (watched.has(sessionId)) return;',
  '\t\tconst record = {',
  '\t\t\tlastRunning: null,',
  '\t\t\tsessionOff: null,',
  '\t\t\tchatOff: null,',
  '\t\t\tchat: void 0,',
  '\t\t\treference: null',
  '\t\t};',
  '\t\twatched.set(sessionId, record);',
  '\t\tlet reference;',
  '\t\ttry {',
  '\t\t\treference = sessions.retain(sessionId, { source: "xiaomi-mimo-tts-cross-session" });',
  '\t\t} catch {',
  '\t\t\twatched.delete(sessionId);',
  '\t\t\treturn;',
  '\t\t}',
  '\t\trecord.reference = reference;',
  '\t\treference.ready.then(() => {',
  '\t\t\tif (!watched.has(sessionId)) return;',
  '\t\t\tconst binding = sessions.binding(sessionId);',
  '\t\t\tif (binding === void 0) {',
  '\t\t\t\tunwatch(sessionId);',
  '\t\t\t\treturn;',
  '\t\t\t}',
  '\t\t\trecord.chat = conversation.binding(binding).target("chat");',
  '\t\t\trecord.chatOff = record.chat.subscribe(() => {});',
  '\t\t\trecord.sessionOff = binding.session.subscribe(() => tick(sessionId, binding));',
  '\t\t\ttick(sessionId, binding);',
  '\t\t}).catch(() => {',
  '\t\t\tunwatch(sessionId);',
  '\t\t});',
  '\t};',
  '\tconst scan = () => {',
  '\t\tconst list = sessions.list.getSnapshot();',
  '\t\tfor (const entry of Object.values(list.byId)) {',
  '\t\t\tif ((entry.retainedBy?.mainView ?? 0) > 0) continue;',
  '\t\t\tif (entry.running === true) watch(entry.id);',
  '\t\t}',
  '\t};',
  '\tconst listOff = sessions.list.subscribe(scan);',
  '\tconst playbackOff = playback.subscribe(pump);',
  '\tscan();',
  '\treturn () => {',
  '\t\tlistOff?.();',
  '\t\tplaybackOff?.();',
  '\t\tfor (const sessionId of [...watched.keys()]) unwatch(sessionId);',
  '\t};',
  '}',
].join('\n')

/** 观察者的落点：紧跟在音效任务观察者那一区之后。 */
const WATCHER_ANCHOR_FIND = '//#endregion\n//#region src/client/style/action.css?raw'

const WATCHER_ANCHOR_REPLACE = `${CROSS_SESSION_WATCHER}\n${WATCHER_ANCHOR_FIND}`

/** `uiConversation` 是 cordis 服务，得先声明进 inject —— 不声明会抛 without inject。 */
const INJECT_FIND = [
  'const inject = [',
  '\t"slots",',
  '\t"locale",',
  '\t"remote",',
  '\t"configForms",',
  '\t"sessions"',
  '];',
].join('\n')

const INJECT_REPLACE = [
  'const inject = [',
  '\t"slots",',
  '\t"locale",',
  '\t"remote",',
  '\t"configForms",',
  '\t"sessions",',
  '\t"uiConversation"',
  '];',
].join('\n')

/** 挂载点：playback 建好、两个 setStateChangeListener 之后。 */
const WATCHER_MOUNT_FIND = [
  '\tlive.setStateChangeListener((sessionId, messageId, status) => playback.updateLivePlayback(sessionId, messageId, status, "live"));',
  '\tlocal.setStateChangeListener((sessionId, messageId, status, error) => playback.updateLivePlayback(sessionId, messageId, status, "system", error));',
].join('\n')

const WATCHER_MOUNT_REPLACE = [
  WATCHER_MOUNT_FIND,
  '\tctx.effect(() => installCrossSessionAutoPlay(ctx, playback, scope), "xiaomi-mimo-tts: cross-session auto play");',
].join('\n')

/**
 * 对单个文件做的编辑。`find` / `replace` 都是逐字字面量。
 *
 * @typedef {{ id: string, file: string, find: string, replace: string, expect: number, why: string }} Edit
 */

/** @type {Edit[]} */
export const EDITS = Object.freeze([
  ...TARGET_FILES.flatMap(file => [
    {
      id: 'style-helpers',
      file,
      // 锚点行顶格无缩进——写成带 \t 的会命中 0 次（2026-10-14 实测踩过）。
      find: 'const MARKDOWN_TABLE_SEP_RE = /[|]/g;\n',
      replace: `const MARKDOWN_TABLE_SEP_RE = /[|]/g;\n${STYLE_HELPERS}\n`,
      expect: 1,
      why: '把三个常量与 stripTtsStyleBlocks() 插在表格分隔正则之后',
    },
    {
      id: 'style-wire',
      file,
      // 这一行在源码里是**有缩进的**（函数体第一行），所以 find 与 replace
      // 都带一个 \t。只给 replace 加、find 不加的话，会匹配到 \t 之后的半行，
      // 替换后变成两层缩进（2026-10-15 实测踩到，重放结果与 patch-commit
      // 出来的版本差一个 \t）。
      find: '\tlet text = value.replace(MARKDOWN_CODE_BLOCK_RE, " ")',
      replace: '\tlet text = stripTtsCards(stripTtsStyleBlocks(value)).replace(MARKDOWN_CODE_BLOCK_RE, " ")',
      expect: 1,
      why: '把 removeTtsMarkup 的入口接在新函数上——写在旁边不等于会被调用；卡片剥离也挂这一处（所有朗读路径都过 removeTtsMarkup）',
    },
    {
      id: 'spoken-override',
      file,
      find: PLAYBACK_SCOPE_FIND,
      replace: PLAYBACK_SCOPE_REPLACE,
      expect: 1,
      why: '朗读范围解析前先看有没有 <!--tts:…--> 标记，有就念标记内容（挑重点），没有就走原逻辑',
    },
  ]),
  {
    id: 'spoken-override-entry',
    file: 'lib/client.js',
    // 真正的入口。只改客户端那份——messageText 只存在于 client.js，
    // shared-DQIrhcy-.js 里没有它（放进去会 expect 对不上、整批中止）。
    find: MESSAGE_TEXT_FIND,
    replace: MESSAGE_TEXT_REPLACE,
    expect: 1,
    why: '在 prepareTtsText 清洗之前先看标记——清洗会把 <!--tts:…--> 当 HTML 标签吃掉，标记活不到 applyTtsPlaybackScope',
  },
  {
    id: 'spoken-override-live',
    file: 'lib/client.js',
    // 流式实时播报旁路（2026-10-16 老大实测报障后补）。同样只存在于 client.js。
    find: LIVE_TEXT_FIND,
    replace: LIVE_TEXT_REPLACE,
    expect: 1,
    why: 'scopedLiveText 是边生成边播那条路，清洗前不吃标记——不补它，自动播报照旧念全文和卡片内容',
  },
  {
    id: 'reflect-skip',
    file: 'lib/client.js',
    find: REFLECT_SKIP_FIND,
    replace: REFLECT_SKIP_REPLACE,
    expect: 1,
    why: '记忆反思轮不念：latestAssistantMessageId 往前找第一条"不是反思产物"的 assistant，主视图与跨会话两条路一起生效',
  },
  // 以下整组只改 client.js：PlaybackController 只存在于客户端那份。
  {
    id: 'session-owner-field',
    file: 'lib/client.js',
    find: SESSION_FIELD_FIND,
    replace: SESSION_FIELD_REPLACE,
    expect: 1,
    why: '新增 playbackOwnerId：这段播放属于谁，与 UI 正在看哪个会话（activeSessionId）分开',
  },
  {
    id: 'session-owner-activate',
    file: 'lib/client.js',
    find: ACTIVATE_SESSION_FIND,
    replace: ACTIVATE_SESSION_REPLACE,
    expect: 1,
    why: '切会话时若还有音频在响，只换 UI 会话，不 stopCurrent / 不 generation++ / 不清 view —— 否则一切走就断',
  },
  {
    id: 'session-owner-deactivate',
    file: 'lib/client.js',
    find: DEACTIVATE_SESSION_FIND,
    replace: DEACTIVATE_SESSION_REPLACE,
    expect: 1,
    why: '同上：会话组件卸载（切走）不等于该停播放',
  },
  {
    id: 'session-owner-cancel',
    file: 'lib/client.js',
    find: CANCEL_PLAYBACK_FIND,
    replace: CANCEL_PLAYBACK_REPLACE,
    expect: 1,
    why: '本会话起新一轮（cancelPlayback）不该把别的会话正在播的那条掐掉',
  },
  {
    id: 'session-owner-pause',
    file: 'lib/client.js',
    find: PAUSE_SEGMENTED_FIND,
    replace: PAUSE_SEGMENTED_REPLACE,
    expect: 1,
    why: '暂停按钮按播放归属判定 —— 手动暂停是唯一能停它的动作',
  },
  {
    id: 'session-owner-segmented-entry',
    file: 'lib/client.js',
    find: SEGMENTED_ENTRY_FIND,
    replace: SEGMENTED_ENTRY_REPLACE,
    expect: 1,
    why: 'segmented 入口接管所有权（同一时刻只播一条，新的朗读仍会打断上一条）',
  },
  {
    id: 'session-owner-toggle-entry',
    file: 'lib/client.js',
    find: TOGGLE_ENTRY_FIND,
    replace: TOGGLE_ENTRY_REPLACE,
    expect: 1,
    why: 'toggle 入口同上',
  },
  ...OWNER_CHECKS.map((check, index) => ({
    id: `session-owner-check-${index + 1}`,
    file: 'lib/client.js',
    find: check.find,
    replace: check.replace,
    expect: check.expect,
    why: '播放循环里的身份判据改用 playbackOwnerId —— 否则切走的那一帧就自己退出了',
  })),
  // 跨会话自动播报（2026-10-15）。整组只改 client.js：PlaybackController 与
  // apply() 都只存在于客户端那份；shared 里没有它们，放进去会 expect 对不上。
  {
    id: 'cross-session-remote-field',
    file: 'lib/client.js',
    find: REMOTE_FIELD_FIND,
    replace: REMOTE_FIELD_REPLACE,
    expect: 1,
    why: '新增 remoteSessionId：被跨会话播报临时接管的会话，与 UI 正在看的那个分开',
  },
  {
    id: 'cross-session-remote-helpers',
    file: 'lib/client.js',
    find: REMOTE_HELPERS_FIND,
    replace: REMOTE_HELPERS_REPLACE,
    expect: 1,
    why: '加 ownsSession() 判据与 playRemote() 入口——给不是当前在看的会话播一段',
  },
  {
    id: 'cross-session-segmented-entry',
    file: 'lib/client.js',
    find: REMOTE_SEGMENTED_FIND,
    replace: REMOTE_SEGMENTED_REPLACE,
    expect: 1,
    why: 'segmented 入口由 activeSessionId 放宽成 ownsSession —— 否则隔壁会话第一行就被挡回去',
  },
  {
    id: 'cross-session-toggle-entry',
    file: 'lib/client.js',
    find: REMOTE_TOGGLE_FIND,
    replace: REMOTE_TOGGLE_REPLACE,
    expect: 1,
    why: 'toggle 入口同上',
  },
  {
    id: 'cross-session-watcher',
    file: 'lib/client.js',
    find: WATCHER_ANCHOR_FIND,
    replace: WATCHER_ANCHOR_REPLACE,
    expect: 1,
    why: '插入 installCrossSessionAutoPlay：发现隔壁在跑的会话 → retain → 订阅 running 边沿 → 跑完取正文 → 排队播',
  },
  {
    id: 'cross-session-inject',
    file: 'lib/client.js',
    find: INJECT_FIND,
    replace: INJECT_REPLACE,
    expect: 1,
    why: 'uiConversation 加进 cordis inject —— 不声明会抛 cannot get property without inject',
  },
  {
    id: 'cross-session-mount',
    file: 'lib/client.js',
    find: WATCHER_MOUNT_FIND,
    replace: WATCHER_MOUNT_REPLACE,
    expect: 1,
    why: '在 apply() 里把观察者挂上，随插件卸载一起收',
  },
])

/**
 * 按目标文件的行尾风格折算锚点串。
 *
 * 上游 `dsh-xiaomi-tts` 的两个 lib 文件是 CRLF 行尾，本仓的锚点一律用 `\n` 写。
 * 不折算就会像 2026-10-15 那次一样，`includes()` 全 false、命中 0 次，
 * 而人眼看源码"明明一模一样"——最难查的一类失配。
 *
 * @param {string} text 目标文件内容（用来判定行尾风格）。
 * @param {string} needle 用 `\n` 书写的锚点或替换串。
 * @returns {string} 折算成目标行尾的字符串。
 */
export function normalizeEol(text, needle) {
  return text.includes('\r\n') ? needle.replace(/\n/g, '\r\n') : needle
}

/**
 * 把 EDITS 应用到一棵源码树上。
 *
 * 全有或全无：任何一条命中数不等于 `expect` 就整体中止、一个字节不写。
 * 半打的补丁会让 `removeTtsMarkup` 引用一个不存在的函数（运行时报错），
 * 或者定义了却没人调用（静默无效）——两种都比彻底失败更难查。
 *
 * 幂等：判据与 cmdVerify 的落盘体检（lib/selfcheck.js 的 `inspectApplied`）同源
 * ——`APPLIED_MARKERS` 全集按文件聚合，**每个文件的全部标记都命中**，才认定
 * 这棵树已经打过补丁，直接返回 `already: true` 原样交回——不重复插入。
 * **这一步不能省**：`style-helpers` 的锚点行在打过补丁后依然存在（补丁是插在
 * 它后面），少了这道检查就会插第二份，函数被重复定义。
 *
 * **也不能只看一个特征串**（旧判据只查 client.js 有没有 `stripTtsStyleBlocks`，
 * 体检定性为 medium）：补丁落两份文件（`TARGET_FILES`），宿主 bundle 更新可能
 * 只动了其中一份——含补丁特征的那份与不含的那份组合出「半打」形态，单文件
 * 判据要么把需要重放的树假报成 already，要么把半打的树放进来叠第二遍。
 * 全集判据下，「体检会说 applied」的树才配 already，与 `cmdVerify` 永远说
 * 同一句话。
 *
 * @param {string} packageRoot 解开的包目录（pnpm patch 的临时目录）。
 * @param {(file: string) => string} readFile 读文件（便于测试注入）。
 * @returns {{ ok: boolean, already: boolean, applied: string[], failed: Array<object>, contents?: Map<string,string> }}
 */
export function planEdits(packageRoot, readFile) {
  const applied = []
  const failed = []
  const contents = new Map()

  // 幂等判定：把 marker 涉及的文件都读进来（预读结果留给下面的编辑循环复用），
  // 全部标记命中才算已打过补丁。markers 都是单行片段，`includes` 不涉行尾折算，
  // 与 inspectApplied 逐字同判据。
  //
  // 2026-10-18：markers 的 `file` 改成了逻辑名（`@client` / `@text`），因为 3.0.9
  // 起文本那支的文件名带构建哈希。这里按逻辑名解析成真实路径；3.0.8 的老名字
  // （`lib/shared-DQIrhcy-.js`）仍由 `resolveMarkerFiles()` 认出来。
  const resolved = resolveMarkerFiles(packageRoot)
  const realOf = (file) => (file === '@client' ? resolved.client : file === '@text' ? resolved.text : file)

  for (const { file } of APPLIED_MARKERS) {
    const real = realOf(file)
    if (real === '') continue
    const target = `${packageRoot}/${real}`
    if (!contents.has(target)) contents.set(target, readFile(target))
  }
  const fullyApplied = APPLIED_MARKERS.every(({ file, marker }) => {
    const real = realOf(file)
    if (real === '') return false
    const text = contents.get(`${packageRoot}/${real}`)
    return typeof text === 'string' && text.includes(marker)
  })
  if (fullyApplied) {
    return { ok: true, already: true, applied: [], failed: [], contents: undefined, targetFiles: TARGET_FILES }
  }

  for (const edit of EDITS) {
    const file = `${packageRoot}/${edit.file}`
    if (!contents.has(file)) contents.set(file, readFile(file))
    const source = contents.get(file)
    const find = normalizeEol(source, edit.find)
    const found = source.split(find).length - 1
    if (found !== edit.expect) {
      failed.push({ edit, found, eol: source.includes('\r\n') ? 'crlf' : 'lf' })
      continue
    }
    // expect > 1 时用 split/join 全换。`String.replace(串, ...)` 只换第一处——
    // 有几组锚点在源码里逐字重复（两处 `generation$1` 判据、两处 Audio 回调判据），
    // 只换一处的话另一半仍看 activeSessionId，切会话依旧会自己退出。
    contents.set(file, source.split(find).join(normalizeEol(source, edit.replace)))
    applied.push(edit.id)
  }

  if (failed.length > 0) return { ok: false, already: false, applied: [], failed, contents: undefined, targetFiles: TARGET_FILES }
  return { ok: true, already: false, applied, failed: [], contents, targetFiles: TARGET_FILES }
}
