/**
 * 补丁意图（dsh-xiaomi-tts **3.0.9** 版）—— 与 `lib/edits-v308.js`（3.0.8 版）并列，
 * 由 `lib/edits.js` 按包自身版本分发。
 *
 * 为什么需要单独一份：3.0.9 换了打包器（rolldown），产物形态与 3.0.8 不是同一棵树：
 *   ① 文本工具被拆到**带哈希的独立 chunk**（`lib/text-<hash>.js`），原
 *      `lib/shared-DQIrhcy-.js` 不复存在——哈希会随上游每次构建变化，所以目标文件
 *      必须**按内容发现**，不能硬编码文件名；
 *   ② 流式旁路从 `scopedLiveText` 换成了 `applyTtsLivePlaybackScope`（`scopeText()` 调用）；
 *   ③ `PlaybackController` 的 activate/deactivate 多了 `attachedMidRun.clear()` 一行；
 *   ④ `messageText` 改为调用 `prepareSpeechText(assistantText(node.blocks))`。
 *
 * 与 3.0.8 版的关系：**意图完全相同**（念 CSS/卡片修复、标记提取、切会话不打断、
 * 跨会话播报、反思轮跳过），只是锚点按新形态重写。锚点纪律不变：逐字相同、
 * 带 `expect` 次数、全有或全无、幂等。
 *
 * @module lib/edits-v309
 */
import fs from 'node:fs'
import { APPLIED_MARKERS } from './selfcheck.js'

/** 补丁目标逻辑名 → 由 `discoverTargets()` 解析成真实相对路径。 */
export const TARGET_KEYS = Object.freeze(['client', 'text'])

/**
 * 发现 3.0.9 的两个目标文件。
 *
 * 文本工具那支的文件名带构建哈希（`text-B7NACAYZ.js`），把它写死等于给下一次
 * 上游构建埋雷——按「哪个文件含 `function removeTtsMarkup(value) {`」来认，
 * 哈希怎么变都能找到。`client.js` 是插件主 bundle，名字稳定。
 *
 * @param {(file: string) => string} readFile 读文件（相对包根）。
 * @param {string[]} jsFiles 包内 `lib/` 下的 .js 文件清单（相对包根）。
 * @returns {{ client: string, text: string }} 两个目标文件；找不到返回空串。
 */
export function discoverTargets(readFile, jsFiles) {
  const has = (file) => {
    try { return readFile(file).includes('function removeTtsMarkup(value) {') } catch { return false }
  }
  const client = jsFiles.includes('lib/client.js') && has('lib/client.js') ? 'lib/client.js' : ''
  const text = jsFiles.find((f) => f !== 'lib/client.js' && has(f)) ?? ''
  return { client, text }
}

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

/** `<!--tts:…-->` 提取器（含收尾容错）。 */
const SPOKEN_OVERRIDE = [
  '/** 回复里写了 <!--tts:…--> 就念它，没写返回 undefined 走原逻辑。 */',
  'function extractTtsSpokenOverride(value) {',
  '\tconst match = /<!--\\s*tts:([\\s\\S]*?)-->/.exec(value) ?? /<!--\\s*tts:([\\s\\S]*?)(?:--|>)(?=\\s*(?:\\n|$))/.exec(value);',
  '\tif (match === null) return void 0;',
  '\tconst spoken = match[1].replace(/\\s+/g, " ").trim();',
  '\treturn spoken.length === 0 ? void 0 : spoken;',
  '}',
].join('\n')

/**
 * 3.0.9 的 `removeTtsMarkup` 入口：多了一层 `removeFencedCode(value)`。
 * 两个文件同形态，各命中 1 次。
 */
const STYLE_WIRE_FIND = '\tlet text = removeFencedCode(value).replace(MARKDOWN_CODE_BLOCK_RE, " ")'
const STYLE_WIRE_REPLACE =
  '\tlet text = stripTtsCards(stripTtsStyleBlocks(removeFencedCode(value))).replace(MARKDOWN_CODE_BLOCK_RE, " ")'

/**
 * `applyTtsPlaybackScope`（3.0.9 的三元式范围解析）。两个文件各命中 1 次。
 * 标记提取挂函数首行——它拿到的还是未清洗原文。
 */
const PLAYBACK_SCOPE_FIND = [
  'function applyTtsPlaybackScope(value, scope, automatic, random = Math.random) {',
  '\tconst scoped = scope === "smart" && automatic ? firstTtsSegments(value, 2) : applyTtsReadScope(value, resolveTtsReadScope(scope, automatic));',
].join('\n')

const PLAYBACK_SCOPE_REPLACE = [
  SPOKEN_OVERRIDE,
  'function applyTtsPlaybackScope(value, scope, automatic, random = Math.random) {',
  '\tconst override = extractTtsSpokenOverride(value);',
  '\tif (override !== void 0) return override;',
  '\tconst scoped = scope === "smart" && automatic ? firstTtsSegments(value, 2) : applyTtsReadScope(value, resolveTtsReadScope(scope, automatic));',
].join('\n')

/**
 * 流式旁路（3.0.9 的 `applyTtsLivePlaybackScope`，由 `RealtimeSpeechSession.scopeText()`
 * 每帧调用）。标记检查放在 `full` 短路**之前**：标记内容本身就是最终朗读文本。
 */
const LIVE_SCOPE_FIND = [
  'function applyTtsLivePlaybackScope(value, scope, limiter, final = false, random = Math.random) {',
  '\tif (resolveTtsReadScope(scope, true) === "full") return value;',
].join('\n')

const LIVE_SCOPE_REPLACE = [
  'function applyTtsLivePlaybackScope(value, scope, limiter, final = false, random = Math.random) {',
  '\tconst spokenOverride = extractTtsSpokenOverride(value);',
  '\tif (spokenOverride !== void 0) return spokenOverride;',
  '\tif (resolveTtsReadScope(scope, true) === "full") return value;',
].join('\n')

/** `messageText`（3.0.9 走 `prepareSpeechText(assistantText(blocks))`）。只 client.js。 */
const MESSAGE_TEXT_FIND = [
  'function messageText(legacy, messageId) {',
  '\tfor (const node of legacy.nodes) {',
  '\t\tif (node.kind !== "assistant" || node.messageId !== messageId) continue;',
  '\t\treturn prepareSpeechText(assistantText(node.blocks));',
  '\t}',
  '\treturn "";',
  '}',
].join('\n')

const MESSAGE_TEXT_REPLACE = [
  'function messageText(legacy, messageId) {',
  '\tfor (const node of legacy.nodes) {',
  '\t\tif (node.kind !== "assistant" || node.messageId !== messageId) continue;',
  '\t\tconst rawText = assistantText(node.blocks);',
  '\t\tconst spokenOverride = extractTtsSpokenOverride(rawText);',
  '\t\tif (spokenOverride !== void 0) return spokenOverride;',
  '\t\treturn prepareSpeechText(rawText);',
  '\t}',
  '\treturn "";',
  '}',
].join('\n')

/** 反思轮跳过（`latestAssistantMessageId`，3.0.9 与 3.0.8 逐字相同）。只 client.js。 */
const REFLECT_FIND = [
  'function latestAssistantMessageId(legacy) {',
  '\tfor (let index = legacy.nodes.length - 1; index >= 0; index -= 1) {',
  '\t\tconst node = legacy.nodes[index];',
  '\t\tif (node?.kind === "assistant" && node.messageId !== void 0) return node.messageId;',
  '\t}',
  '\treturn null;',
  '}',
].join('\n')

const REFLECT_REPLACE = [
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

/** 新增 `playbackOwnerId`：3.0.9 的字段区多了 `attachedMidRun` 之外基本同形。 */
const SESSION_FIELD_FIND = '\tactiveSessionId = null;\n\tbeforePlayback = null;'
const SESSION_FIELD_REPLACE = '\tactiveSessionId = null;\n\tplaybackOwnerId = null;\n\tbeforePlayback = null;'

const REMOTE_FIELD_FIND = '\tactiveSessionId = null;\n\tplaybackOwnerId = null;\n\tbeforePlayback = null;'
const REMOTE_FIELD_REPLACE = '\tactiveSessionId = null;\n\tplaybackOwnerId = null;\n\tremoteSessionId = null;\n\tbeforePlayback = null;'

/** activateSession：3.0.9 多了 `this.attachedMidRun.clear();`。 */
const ACTIVATE_FIND = [
  '\tactivateSession(sessionId) {',
  '\t\tif (this.activeSessionId === sessionId) return;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.liveSessions.clear();',
  '\t\tthis.completedSessions.clear();',
  '\t\tthis.completedMessages.clear();',
  '\t\tthis.attachedMidRun.clear();',
  '\t\tthis.activeSessionId = sessionId;',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
].join('\n')

const ACTIVATE_REPLACE = [
  '\tactivateSession(sessionId) {',
  '\t\tif (this.activeSessionId === sessionId) return;',
  '\t\tthis.activeSessionId = sessionId;',
  '\t\tthis.liveSessions.clear();',
  '\t\tthis.completedSessions.clear();',
  '\t\tthis.completedMessages.clear();',
  '\t\tthis.attachedMidRun.clear();',
  '\t\tif (this.isPlayingNow()) return;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.playbackOwnerId = null;',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
  '\t/** 现在有没有音频在响（含排队中与合成中）——切会话时靠它决定要不要打断。 */',
  '\tisPlayingNow() {',
  '\t\treturn this.current !== null || this.segmentQueue.size > 0 || this.segmentedState !== null || this.request !== null;',
  '\t}',
].join('\n')

const DEACTIVATE_FIND = [
  '\tdeactivateSession(sessionId) {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.liveSessions.clear();',
  '\t\tthis.completedSessions.clear();',
  '\t\tthis.completedMessages.clear();',
  '\t\tthis.attachedMidRun.clear();',
  '\t\tthis.activeSessionId = null;',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
].join('\n')

const DEACTIVATE_REPLACE = [
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
  '\t\tthis.attachedMidRun.clear();',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
].join('\n')

const CANCEL_FIND = [
  '\tcancelPlayback(sessionId) {',
  '\t\tif (this.activeSessionId !== sessionId) return;',
  '\t\tthis.segmentedState = null;',
  '\t\tthis.generation += 1;',
  '\t\tthis.stopCurrent();',
  '\t\tthis.publish(this.emptyView());',
  '\t}',
].join('\n')

const CANCEL_REPLACE = [
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

const PAUSE_FIND = [
  '\tpauseSegmented(sessionId, messageId) {',
  '\t\tif (this.activeSessionId !== sessionId || this.view.source !== "segmented" || this.view.messageId !== messageId) return;',
].join('\n')

const PAUSE_REPLACE = [
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
 * 播放循环里的身份判据。
 *
 * **行首锚定是必须的（2026-10-18 实测踩到）**：不带前导 `\n` 时，4 个 tab 的锚点
 * 会命中 6 个 tab 那行的**中段**——因为 `\t\t\t\tif (…` 正是 `\t\t\t\t\t\tif (…`
 * 的子串。实测 `session-owner-check-1` 因此报 `expect 2 / found 3`，而 6-tab 那条
 * 也被同一批命中搅乱。所有 find / replace 一律带 `\n` 前缀，把锚点钉在行首。
 *
 * `expect` 按 3.0.9 产物实测重算：与 3.0.8 相比少了「4 tab 的 `=== … && … {`」
 * 那一条形态，多了「3 tab 的 `generation !== …`」（`check-3`）。多一处少一处都会
 * 在 planEdits 里如实报出来，不猜。
 */
const OWNER_CHECKS = [
  {
    find: '\n\t\t\t\tif (generation !== this.generation || this.activeSessionId !== sessionId) return;',
    replace: '\n\t\t\t\tif (generation !== this.generation || this.playbackOwnerId !== sessionId) return;',
    expect: 2,
  },
  {
    find: '\n\t\t\t\t\t\tif (generation !== this.generation || this.activeSessionId !== sessionId) return;',
    replace: '\n\t\t\t\t\t\tif (generation !== this.generation || this.playbackOwnerId !== sessionId) return;',
    expect: 1,
  },
  {
    find: '\n\t\t\tif (generation !== this.generation || this.activeSessionId !== sessionId) return;',
    replace: '\n\t\t\tif (generation !== this.generation || this.playbackOwnerId !== sessionId) return;',
    expect: 1,
  },
  {
    find: '\n\t\t\tif (generation === this.generation && this.activeSessionId === sessionId) {',
    replace: '\n\t\t\tif (generation === this.generation && this.playbackOwnerId === sessionId) {',
    expect: 1,
  },
  {
    find: '\n\t\t\tif (!controller.signal.aborted && generation === this.generation && this.activeSessionId === sessionId) {',
    replace: '\n\t\t\tif (!controller.signal.aborted && generation === this.generation && this.playbackOwnerId === sessionId) {',
    expect: 1,
  },
  {
    find: '\n\t\t\t\tif (generation$1 !== this.generation || this.activeSessionId !== sessionId || this.current?.audio !== audio) return;',
    replace: '\n\t\t\t\tif (generation$1 !== this.generation || this.playbackOwnerId !== sessionId || this.current?.audio !== audio) return;',
    expect: 2,
  },
  {
    find: '\n\t\t\t\t\tif (this.activeSessionId !== sessionId || this.current?.audio !== audio) return;',
    replace: '\n\t\t\t\t\tif (this.playbackOwnerId !== sessionId || this.current?.audio !== audio) return;',
    expect: 2,
  },
  {
    find: '\n\t\t\t\tif (generation !== this.generation || this.activeSessionId !== sessionId || this.current?.audio !== audio) return;',
    replace: '\n\t\t\t\tif (generation !== this.generation || this.playbackOwnerId !== sessionId || this.current?.audio !== audio) return;',
    expect: 2,
  },
  {
    find: '\n\t\t\tif (controller.signal.aborted || generation !== this.generation || this.activeSessionId !== sessionId) return;',
    replace: '\n\t\t\tif (controller.signal.aborted || generation !== this.generation || this.playbackOwnerId !== sessionId) return;',
    expect: 1,
  },
]

/** 3.0.9 的 `inject` 与 3.0.8 同形。 */
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

const MOUNT_FIND = [
  '\tlive.setStateChangeListener((sessionId, messageId, status) => playback.updateLivePlayback(sessionId, messageId, status, "live"));',
  '\tlocal.setStateChangeListener((sessionId, messageId, status, error) => playback.updateLivePlayback(sessionId, messageId, status, "system", error));',
].join('\n')

/** 跨会话观察者（与 3.0.8 版同逻辑，`segmentQueue.size` 按 3.0.9 的 Set 形态取值）。 */
const CROSS_SESSION = [
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

const WATCHER_ANCHOR_FIND = '//#endregion\n//#region src/client/style/action.css?raw'
const WATCHER_ANCHOR_REPLACE = `${CROSS_SESSION}\n${WATCHER_ANCHOR_FIND}`

const REMOTE_HELPERS_FIND = [
  '\t/** 现在有没有音频在响（含排队中与合成中）——切会话时靠它决定要不要打断。 */',
  '\tisPlayingNow() {',
  '\t\treturn this.current !== null || this.segmentQueue.size > 0 || this.segmentedState !== null || this.request !== null;',
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
 * 编辑清单。`file` 用逻辑名 `@client` / `@text`，由 `planEdits309()` 换成真实相对路径。
 *
 * @typedef {{ id: string, file: string, find: string, replace: string, expect: number, why: string }} Edit
 */

/** 文本工具那两个文件共用的编辑（`@both` 展开成 client + text 两份）。 */
const BOTH_FILES_EDITS = [
  {
    id: 'style-helpers',
    find: 'const MARKDOWN_TABLE_SEP_RE = /[|]/g;\n',
    replace: `const MARKDOWN_TABLE_SEP_RE = /[|]/g;\n${STYLE_HELPERS}\n`,
    expect: 1,
    why: '把三个常量与 stripTtsStyleBlocks()/stripTtsCards() 插在表格分隔正则之后',
  },
  {
    id: 'style-wire',
    find: STYLE_WIRE_FIND,
    replace: STYLE_WIRE_REPLACE,
    expect: 1,
    why: 'removeTtsMarkup 入口接上 CSS 与卡片剥离（3.0.9 入口多一层 removeFencedCode）',
  },
  {
    id: 'spoken-override',
    find: PLAYBACK_SCOPE_FIND,
    replace: PLAYBACK_SCOPE_REPLACE,
    expect: 1,
    why: '范围解析前先看标记（3.0.9 的范围解析改成三元式）',
  },
  {
    id: 'spoken-override-live',
    find: LIVE_SCOPE_FIND,
    replace: LIVE_SCOPE_REPLACE,
    expect: 1,
    why: '流式旁路 applyTtsLivePlaybackScope 挂标记提取（3.0.9 取代 scopedLiveText）',
  },
]

/** 只属于 `client.js` 的编辑。 */
const CLIENT_ONLY_EDITS = [
  {
    id: 'spoken-override-entry',
    find: MESSAGE_TEXT_FIND,
    replace: MESSAGE_TEXT_REPLACE,
    expect: 1,
    why: '在 prepareSpeechText 清洗之前先看标记——清洗会把 <!--tts:…--> 当 HTML 标签吃掉',
  },
  {
    id: 'reflect-skip',
    find: REFLECT_FIND,
    replace: REFLECT_REPLACE,
    expect: 1,
    why: '记忆反思轮不念：往前找第一条"不是反思产物"的 assistant',
  },
  {
    id: 'session-owner-field',
    find: SESSION_FIELD_FIND,
    replace: SESSION_FIELD_REPLACE,
    expect: 1,
    why: '新增 playbackOwnerId：播放归属与 UI 正在看哪个会话分开',
  },
  {
    id: 'session-owner-activate',
    find: ACTIVATE_FIND,
    replace: ACTIVATE_REPLACE,
    expect: 1,
    why: '切会话时若还有音频在响，只换 UI 会话，不 stopCurrent（3.0.9 含 attachedMidRun.clear）',
  },
  {
    id: 'session-owner-deactivate',
    find: DEACTIVATE_FIND,
    replace: DEACTIVATE_REPLACE,
    expect: 1,
    why: '会话组件卸载（切走）不等于该停播放',
  },
  {
    id: 'session-owner-cancel',
    find: CANCEL_FIND,
    replace: CANCEL_REPLACE,
    expect: 1,
    why: '本会话起新一轮不该把别的会话正在播的那条掐掉',
  },
  {
    id: 'session-owner-pause',
    find: PAUSE_FIND,
    replace: PAUSE_REPLACE,
    expect: 1,
    why: '暂停按钮按播放归属判定',
  },
  {
    id: 'session-owner-segmented-entry',
    find: SEGMENTED_ENTRY_FIND,
    replace: SEGMENTED_ENTRY_REPLACE,
    expect: 1,
    why: 'segmented 入口接管所有权',
  },
  {
    id: 'session-owner-toggle-entry',
    find: TOGGLE_ENTRY_FIND,
    replace: TOGGLE_ENTRY_REPLACE,
    expect: 1,
    why: 'toggle 入口同上',
  },
  ...OWNER_CHECKS.map((check, index) => ({
    id: `session-owner-check-${index + 1}`,
    find: check.find,
    replace: check.replace,
    expect: check.expect,
    why: '播放循环里的身份判据改用 playbackOwnerId',
  })),
  {
    id: 'cross-session-remote-field',
    find: REMOTE_FIELD_FIND,
    replace: REMOTE_FIELD_REPLACE,
    expect: 1,
    why: '新增 remoteSessionId：被跨会话播报临时接管的会话',
  },
  {
    id: 'cross-session-remote-helpers',
    find: REMOTE_HELPERS_FIND,
    replace: REMOTE_HELPERS_REPLACE,
    expect: 1,
    why: '加 ownsSession() 与 playRemote()',
  },
  {
    id: 'cross-session-segmented-entry',
    find: REMOTE_SEGMENTED_FIND,
    replace: REMOTE_SEGMENTED_REPLACE,
    expect: 1,
    why: 'segmented 入口放宽成 ownsSession',
  },
  {
    id: 'cross-session-toggle-entry',
    find: REMOTE_TOGGLE_FIND,
    replace: REMOTE_TOGGLE_REPLACE,
    expect: 1,
    why: 'toggle 入口同上',
  },
  {
    id: 'cross-session-watcher',
    find: WATCHER_ANCHOR_FIND,
    replace: WATCHER_ANCHOR_REPLACE,
    expect: 1,
    why: '插入 installCrossSessionAutoPlay 观察者',
  },
  {
    id: 'cross-session-inject',
    find: INJECT_FIND,
    replace: INJECT_REPLACE,
    expect: 1,
    why: 'uiConversation 加进 cordis inject',
  },
  {
    id: 'cross-session-mount',
    find: MOUNT_FIND,
    replace: `${MOUNT_FIND}\n\tctx.effect(() => installCrossSessionAutoPlay(ctx, playback, scope), "xiaomi-mimo-tts: cross-session auto play");`,
    expect: 1,
    why: '在 apply() 里把观察者挂上',
  },
]

/**
 * 展开成带真实文件路径的编辑清单。
 *
 * @param {{ client: string, text: string }} targets 由 `discoverTargets()` 得到。
 * @returns {Edit[]}
 */
export function buildEdits(targets) {
  const out = []
  for (const target of [targets.client, targets.text]) {
    if (!target) continue
    for (const edit of BOTH_FILES_EDITS) out.push({ ...edit, file: target })
  }
  for (const edit of CLIENT_ONLY_EDITS) out.push({ ...edit, file: targets.client })
  return out
}

/** 按目标文件的行尾风格折算锚点串（3.0.9 产物是 LF，保留折算逻辑防上游改）。 */
export function normalizeEol(text, needle) {
  return text.includes('\r\n') ? needle.replace(/\n/g, '\r\n') : needle
}

/**
 * 把 EDITS 应用到一棵 3.0.9 源码树上。
 *
 * 语义与 3.0.8 版 `planEdits` 完全一致：全有或全无（任何一条命中数不等于
 * `expect` 就整体中止、一个字节不写）、幂等（`APPLIED_MARKERS` 全集命中即
 * 认定已打过，原样交回）。
 *
 * 与 3.0.8 版的差别只有一处：目标文件**先按内容发现**（哈希名会变），
 * 再拿逻辑名去查标记。返回值多带 `targetFiles`，供命令行做语法检查。
 *
 * @param {string} packageRoot 解开的包目录。
 * @param {(file: string) => string} readFile 读文件。
 * @returns {{ ok: boolean, already: boolean, applied: string[], failed: Array<object>, contents?: Map<string,string>, targetFiles: string[] }}
 */
export function planEdits(packageRoot, readFile) {
  const rel = (file) => `${packageRoot}/${file}`
  // `readFile` 的调用约定与 3.0.8 版一致：**收绝对路径**（patch.mjs 传的就是
  // `file => fs.readFileSync(file, 'utf8')`）。内部一律用相对名做键、拼绝对路径去读。
  const read = (relative) => readFile(rel(relative))

  const jsFiles = []
  for (const name of readDirNames(`${packageRoot}/lib`)) {
    if (name.endsWith('.js')) jsFiles.push(`lib/${name}`)
  }

  const targets = discoverTargets(read, jsFiles)
  const targetFiles = [targets.client, targets.text].filter(Boolean)

  // 幂等判定：markers 用逻辑名，先换成真实路径再逐条 includes。
  const contents = new Map()
  const load = (relative) => {
    if (!contents.has(relative)) contents.set(relative, read(relative))
    return contents.get(relative)
  }
  const markerFiles = new Map()
  for (const { file, marker } of APPLIED_MARKERS) {
    const real = file === '@client' ? targets.client : file === '@text' ? targets.text : file
    if (!markerFiles.has(real)) markerFiles.set(real, [])
    markerFiles.get(real).push(marker)
  }
  const fullyApplied = [...markerFiles].every(([file, markers]) => {
    if (!file) return false
    try { const text = load(file); return markers.every((marker) => text.includes(marker)) } catch { return false }
  })
  if (fullyApplied) {
    return { ok: true, already: true, applied: [], failed: [], contents: undefined, targetFiles }
  }

  const edits = buildEdits(targets)
  const applied = []
  const failed = []
  for (const edit of edits) {
    if (!edit.file) { failed.push({ edit, found: 0, eol: 'n/a' }); continue }
    const source = load(edit.file)
    const find = normalizeEol(source, edit.find)
    const found = source.split(find).length - 1
    if (found !== edit.expect) {
      failed.push({ edit, found, eol: source.includes('\r\n') ? 'crlf' : 'lf' })
      continue
    }
    contents.set(edit.file, source.split(find).join(normalizeEol(source, edit.replace)))
    applied.push(edit.id)
  }

  if (failed.length > 0) return { ok: false, already: false, applied: [], failed, contents: undefined, targetFiles }

  // 交给调用方时把键换成**绝对路径**——patch.mjs 直接 writeFileSync(file)，
  // 而 3.0.8 版 planEdits 的 contents 键就是绝对路径，保持一致。
  const absolute = new Map()
  for (const [relative, text] of contents) absolute.set(rel(relative), text)
  return { ok: true, already: false, applied, failed: [], contents: absolute, targetFiles }
}

/** 列目录名（独立出来便于测试注入；读不到返回空数组）。 */
function readDirNames(dir) {
  try {
    // 延迟 import 避免顶层依赖 fs 影响纯函数测试
    return fs.readdirSync(dir)
  } catch { return [] }
}

/** 当前补丁集的编辑条数（`patch.mjs` 打印用）。 */
export function editCount(targets) {
  return buildEdits(targets).length
}

/**
 * 不看源码树的名义条数：`--dry-run` 时暂存树还没解出来，`discoverTargets()`
 * 只能给空串、算出「只有客户端那几条」的假数字。这里按「两份文件都在」折算，
 * 打印出来才是真会重放的条数。
 */
export function nominalEditCount() {
  return buildEdits({ client: '@client', text: '@text' }).length
}

