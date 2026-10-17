# dsh-maid-tts-fix · 问题与解决记录

> **用途**：换新设备（或新 profile）装这套朗读维护层时，照着这份记录走，免得把已经踩过的坑再踩一遍。
> 每条按 **症状 → 原因 → 解法 → 验证** 写，症状照抄当时的实际现象。只写有据可查的（本仓源码与注释、`README.md`、实际 profile 核对结果、记忆库条目），不确定的标「（待核）」。
> 版本基准：`dsh-maid-tts-fix` **0.6.5** / 上游 `dsh-xiaomi-tts` **3.0.9** / 渲染侧 `dsh-maid-vcp` **0.6.14**（v6.42 注入 + 补丁器 v10.3）。
>
> 最后更新 **2026-10-18**

---

## 一、安装与部署（与 dsh-xiaomi-tts 的依赖关系、加载顺序）

**依赖**：本插件是 `dsh-xiaomi-tts` 的**维护层**，不是替代品。它自己只做两件事——携带补丁正本（`patches/`）、启动时体检补丁是否还活着（`index.js` → `lib/selfcheck.js`）；朗读能力全来自上游。

**顺序**：上游先装、补丁后打。① 装 `dsh-xiaomi-tts@3.0.9` → ② 装 `dsh-maid-tts-fix@0.6.5` → ③ 在本包目录跑 `node scripts/patch.mjs install`（复制补丁进 profile → 登记 → `pnpm install` → 核对）→ ④ 装渲染侧 `dsh-maid-vcp`（≥0.6.14）并打注入补丁 `node patch/install-all.cjs` → ⑤ **重启 DSH**

本插件在 profile 的 `cordis.patch.yml` 里只插一行（`id: tts-fix`），`inject = []`——没有客户端半边、不注册路由、不依赖 settings（`cordis.patch.yml:1-6`、`index.js:25-27`）。它**不影响启动顺序**；价值全在"没人想起来的时候它也在体检"。

### 1.1 手改 node_modules 的补丁会静默消失

- **症状**：朗读突然又开始念 CSS，没有报错、没有提示。
- **原因**：2026-10-14 第一版是手改进 `node_modules/dsh-xiaomi-tts/lib/` 的。当晚装另一个插件触发 pnpm 整棵重铺，补丁连同 `*.bak-*` 备份一起被**静默抹掉**，直到点朗读才听见。
- **解法**：一律走 pnpm patch。补丁正本 `patches/dsh-xiaomi-tts@3.0.9.patch`，登记进 profile 的 `pnpm-workspace.yaml` → `patchedDependencies`，hash 落进 `pnpm-lock.yaml` → `patch_hash`（**就是 `.patch` 的 sha256**），此后任何 install / 重铺都自动重打。
- **验证**：`node scripts/patch.mjs verify` 四项全 ✓。**记住：改 node_modules 等于没改。**

### 1.2 `pnpm install` 会假装成功（整包目录被外部删掉）

- **症状**：`pnpm install` 回一句 `Already up to date`，补丁文件、登记、lockfile 全对，包里却一个字没有，又开始念 CSS。
- **原因**：外面 `rm -rf node_modules/dsh-xiaomi-tts` 后，pnpm 账本仍认为"已装好"。实测（2026-10-15）：**连 `--force`、删 `node_modules/.modules.yaml` 都不管用**。
- **解法**：让 pnpm 重新解析这个包——`pnpm add dsh-xiaomi-tts@3.0.9`（同版本重装不改 `dependencies`，只补回目录）。`install` 子命令已内置这个回退（`scripts/patch.mjs:237-242`）。
- **验证**：verify 报 `missing-file` 时按提示重跑 install；重跑后 `lib/client.js` 里出现 `stripTtsStyleBlocks`。

### 1.3 上游升版后 `pnpm install` 直接中止

- **症状**：`ERR_PNPM_UNUSED_PATCH`，整个 install 失败。
- **原因**：`patchedDependencies` 的键是**精确版本**（`dsh-xiaomi-tts@3.0.9`）。上游一发新版旧键就悬空，pnpm 报错中止（实测 2026-10-15）。这其实是好事（不假装成功），但不重做补丁就升不动。
- **解法**：`node scripts/patch.mjs upgrade`——`pnpm patch` 解出干净上游树 → 按 `lib/edits.js` 重放 → `node --check` → `patch-commit` → 清掉旧版本补丁与登记 → verify。
- **验证**：verify 四项过，目标版本变新版本号。

### 1.4 补丁意图改了但版本没变：跑 `redo`，不是 `upgrade`

- **症状**：往 `lib/edits.js` 加了新编辑（例如加 `spoken-override`），跑 `upgrade` 被"补丁已是 3.0.9，无需重做"挡回来。
- **原因**：`upgrade` 只在版本变化时干活。
- **解法**：`node scripts/patch.mjs redo`——流程相同，只差**不检查版本变化**。
- **验证**：`node scripts/patch.mjs list` 看 sha256 变了、字节数变大。本仓 sha256 变化史：4120B → 6144B（`spoken-override`）→ 6921B（`spoken-override-entry`）→ 14883B（切会话不打断）→ 21868B（跨会话自动播报）→ 23356B（反思轮初版）→ 23082B（判据修正）→ 23463B（首轮反思补判据）→ 23587B（标记收尾容错）→ **26307B / `7bacff7947105f7e21a25a8e972a7837c687256442b1e2259091657e40594e5a`**（3.0.9 换 rolldown 打包器，意图按版本分家）。

### 1.5 `redo` 的双重陷阱：改了 edits.js 也可能等于白改

- **症状**：`redo` 打印成功，但补丁一个字节没变、新编辑没进去。
- **原因（两个，2026-10-15 卡了整整一轮）**：① `pnpm patch` 对**已登记在 `patchedDependencies` 里**的包，解出来的是**打过补丁的版本**（从虚拟 store 取现成产物，不是下 registry 原始 tarball），重放时看到树里已有 `stripTtsStyleBlocks` 就走幂等分支跳过；② 上次残留的暂存目录被沿用，里面本来就是打过补丁的树。
- **解法**：`redo` 的流程是 **①临时摘掉登记 → ②清掉上次暂存目录 → ③`pnpm patch` → ④重放 → `node --check` → `patch-commit`**（`scripts/patch.mjs:429-442`）。摘登记是临时的：失败时脚本自己还原，成功时 `patch-commit` 写回。
- **验证**：摘登记后若解出的树**仍含**补丁特征，脚本会中止并提示 `pnpm store prune`——那说明 store 被污染（补丁产物被当成原包缓存），重放会叠第二遍，别硬来。**附带坑**：版本不变时新旧补丁**同名**，先 `unlink` 旧名会把新补丁一起删掉（`scripts/patch.mjs:512-515`），别手写这类清理脚本。

### 1.6 供应链门禁挡住补丁安装

- **症状**：`pnpm install` exit 1 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，而此时补丁文件与登记**其实已经写好了**，只差 install。
- **原因**：profile 的 lockfile 里随时可能有别的条目触犯 pnpm 的 `minimumReleaseAge`（公司机尤其常见）。
- **解法**：脚本对 install 这一步带**一次性**门禁覆盖重试（`--config.` 前缀传参；`npm_config_minimum_release_age` 这类环境变量**实测无效**），默认仍受保护、只在被挡住时让路一次、不改配置（`scripts/patch.mjs:107-129`）。
- **验证**：看 install 输出里的重试提示；补丁侧判定不受影响。

### 1.7 新克隆的仓库里 `.patch` 被 git 改了行尾

- **症状**：verify 报「lockfile 的 hash 与补丁正本不符」，但**没人改过补丁**。
- **原因**：`.patch` 的 sha256 就是 lockfile 里的 `patch_hash`，任何换行转换都会让它对不上——不是补丁坏了，是 git 动了字节。
- **解法**：本仓 `.gitattributes` 已写死 `*.patch -text`，其余文本统一 LF（`* text=auto eol=lf`）。**克隆后别用会改行尾的编辑器保存 `.patch`。**
- **验证**：`sha256sum patches/dsh-xiaomi-tts@3.0.9.patch` = `7bacff79…4e5a`（26307 字节）。

### 1.8 启动自检说补丁有问题，怎么办

- **症状**：DSH 启动日志出现 `[tts-fix] …` 的 warn。
- **原因**：三项独立失效点之一掉了——① 登记（`pnpm-workspace.yaml` 的 `patchedDependencies`）；② hash（lockfile 的 `patch_hash` 是否 = `.patch` 的 sha256）；③ 落盘（上游那两处文件是否含补丁特征）。
- **解法**：按 warn 附的命令修（多数是 `node scripts/patch.mjs install`，改完重启 DSH）。自检**不修、不拦、不抛**——体检器没资格让应用起不来。
- **验证**：修完重启，日志应出现 `补丁齐备：dsh-xiaomi-tts@3.0.9`。判据是 `lib/selfcheck.js` 的 **16 条 `APPLIED_MARKERS`**（按逻辑名 `@client` 12 条 / `@text` 4 条，实际落到 `lib/client.js` 与那支带哈希的文本 chunk 上），**按文件聚合**报告；**改补丁时必须同步改这里**，否则体检开始说谎。特例：只有 `lib/client.js` 有 `messageText`，所以 `spoken-override-entry` 那条标记只挂在客户端那份文件上。宿主完全没装 `dsh-xiaomi-tts` 时自检仍然会跑，若 profile 里也没登记，它会报「未登记到 patchedDependencies」，不是沉默通过。

### 1.9 升级不是一步：`pnpm patch` 只认**已安装**的版本

- **症状**：`node scripts/patch.mjs upgrade --to 3.0.9` 报 `[ERR_PNPM_PATCH_VERSION_NOT_FOUND] Can not find dsh-xiaomi-tts@3.0.9 in project … you can specify currently installed version: 3.0.8`。
- **原因**：`pnpm patch <包>@<新版本>` 要求那个版本**已经装好**在 profile 里。直接对未安装的新版本做 patch，pnpm 找不到落地目录。**先升上游，再打补丁**——顺序反了就走不动。
- **解法（2026-10-18 实测的正确三步）**：
  1. **先摘掉旧版本的 `patchedDependencies` 登记**。否则升版本时那条 `dsh-xiaomi-tts@3.0.8` 键悬空，pnpm 报 `ERR_PNPM_UNUSED_PATCH` 中止整个 install。
  2. 改 profile 的 `package.json` 依赖（`dsh-xiaomi-tts: 3.0.8 → 3.0.9`），跑 `pnpm install --config.minimumReleaseAge=0`，装到**干净的上游 3.0.9**。
  3. 回头跑 `node scripts/patch.mjs upgrade --to 3.0.9` 生成新补丁。
- **验证**：`upgrade` 打印「重放 N 条编辑 → node --check 通过」；随后 `verify` 四项全 ✓。

### 1.10 `patch-commit` 也会被供应链门禁挡下

- **症状**：`upgrade` 走到最后一步报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`：`dsh-xiaomi-tts@3.0.9 was published at … within the minimumReleaseAge cutoff`。新发版几小时内必然踩到。
- **原因**：`pnpm patch-commit` 内部会**重新校验 lockfile 的供应链门禁**——不只是 `install` 那一步会。
- **解法**：`patch-commit` 这一步也要带 `retryPolicy`（脚本已改，`scripts/patch.mjs:548`）。只对 `install` 加了重试是不够的——**凡是会让 pnpm 解析 lockfile 的子命令都得包上**。
- **验证**：重试输出里出现 `带 --config.minimumReleaseAge=0 重试一次`，随后 `Lockfile passes supply-chain policies` 并写出 `.patch`。

### 1.11 「落盘：文件缺失」但文件明明在——裸文件名漏了 `lib/` 前缀

- **症状**：`verify` 报 `✗ 落盘：text-B7NACAYZ.js 文件缺失`，可 `ls lib/text-B7NACAYZ.js` 明明存在，`client.js` 那项却是 ✓。
- **原因**：`resolveMarkerFiles()` 按内容认文本那支文件时，返回的是 `fs.readdirSync(libDir)` 给出的**裸文件名**（`text-B7NACAYZ.js`），没补 `lib/` 前缀；调用方拿它 `path.join(packageRoot, file)` 就指到了包根。3.0.8 时代走的是「旧名优先」分支（那个常量自带 `lib/`），所以一直没暴露。
- **解法**：按内容找到时补前缀 `` `lib/${found}` ``（`lib/selfcheck.js:97`）。**教训**：凡是「先 readdir 拿名字、再拼进路径」的地方，都要问一句「这名字是相对谁的」。
- **验证**：`verify` 变成 `✓ 落盘：lib/text-B7NACAYZ.js 已应用`。

### 1.12 意图必须按上游版本分家

- **症状**：升级到 3.0.9 后锚点整批失配（3.0.8 的锚点一条也命中不了）。
- **原因**：3.0.9 换了打包器（rolldown），产物形态不是同一棵树——文本工具被拆进**带构建哈希**的独立 chunk（`shared-DQIrhcy-.js` 消失 → `text-B7NACAYZ.js`），流式旁路从 `scopedLiveText` 换成 `applyTtsLivePlaybackScope`，`PlaybackController` 两个方法多了一行。锚点是逐字的，跨版本必然全灭。
- **解法**：`lib/edits.js` 改成**分发器**，按包自身 `package.json` 的版本挑 `lib/edits-v308.js` / `lib/edits-v309.js`；未登记版本**回落最新模块**（宁可 loudly 失败，也不拿语义已不匹配的锚点去猜）。同理 `APPLIED_MARKERS` 用逻辑名 `@client` / `@text`，由 `resolveMarkerFiles()` 按内容认文件，**不写死带哈希的文件名**。
- **验证**：`node -e` 查 `knownEditModules()` 应列出两个版本；`planEdits` 对 3.0.9 目录报 33 条重放、对 3.0.8 报 32 条。

### 1.13 `pnpm` 的路径会跟着宿主版本搬家

- **症状**：`upgrade` 报找不到 pnpm，或静默回退到 PATH 上的 `pnpm`——而这台机 PATH 上**没有** pnpm。
- **原因**：`patch.mjs` 曾把 `D:/DeepSeek Harness/resources/runtime/pnpm/bin/pnpm.cjs` 写死。宿主升级后运行时搬到了 `resources/runtime/primary-runtime/dependencies/pnpm/`，用户目录还有个 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/`。写死就会在换宿主版本后失联。
- **解法**：改成**候选清单探测**（`resolveBundledPnpm()`，`scripts/patch.mjs:36-57`），取第一个存在的；都不存在才退回 PATH 的 `pnpm`。**凡是引用宿主自带工具链的地方都别写死单一路径。**
- **验证**：`node scripts/patch.mjs list` 与 `verify` 均正常，且 install 走的是内置 pnpm（v11.28.5）。

---

## 二、朗读内容问题（念了不该念的、没念标记、念全文、跨行标记）

### 2.1 念出 CSS：属性表一字不落地念出来

- **症状**：点一次朗读，耳朵里是 `#vcp-rootbox-sizing:border-box;max-width:760px;padding:26px 28px;…`。卡片做得越精致，念出来的垃圾越多。
- **原因**：上游 `removeTtsMarkup` 剥 HTML 用的是**单行**正则 `MARKDOWN_HTML_TAG_RE = /<[^>\r\n]*>/g`——`[^>\r\n]` 跨不过换行。VCP 卡片的样式写在**多行** `<style>` 块里，`<style>` 与 `</style>` 之间的整段原样留下、被当正文送进合成。
- **解法**：加三个常量 + `stripTtsStyleBlocks()`：先按**块**删 `<style>`/`<script>` 整段（跨行），再走原来的行内清洗；把新函数**接在 `removeTtsMarkup` 链首**。**两处副本都要改**——3.0.8 时代是 `lib/client.js`（浏览器实际跑的那份）与 `lib/shared-DQIrhcy-.js`（宿主/Node 侧）；3.0.9 换成 `lib/client.js` 与一支带构建哈希的文本 chunk。漏一处等于没修（本仓一律用逻辑名 `@client` / `@text` 指代，由内容认文件）。流式中间帧也照顾了：`<style>` 已开、`</style>` 未到时从开标签处截断——宁可少念半句也不念 CSS。
- **验证**：`_probe/tts-text-probe.mjs` 三场景（完整卡 / 流式未闭合 / 卡+正文），CSS 残留应全为 false。

### 2.2 写了 `<!--tts:…-->` 标记，点朗读照旧念全文

- **症状**：标记写得没问题，手动点朗读按钮还是从头念到尾。
- **原因**：**钩子挂在了调用链下游**。第一版把 `extractTtsSpokenOverride()` 挂在 `applyTtsPlaybackScope`（看着最合理——手动朗读确实走它），但上游 `messageText` 会先调 `prepareTtsText` → `removeTtsMarkup`，那支 `MARKDOWN_HTML_TAG_RE` 正好把 `<!--tts:…-->` 这**一行内的尖括号对整条当标签吃掉**，标记根本活不到下游。
- **解法**：真正的入口是 `messageText` **清洗之前**——先拿原始文本看有没有标记，有就直接返回标记内容（它本身就是最终朗读文本，不必再走 markdown 清洗）；同时保留 `applyTtsPlaybackScope` 那处作**双保险**（自动播报链路不经过 `messageText`）。判据：**不是"哪个函数最像入口"，而是"标记在哪一步还活着"。**
- **验证**：`_probe/tts-spoken-probe.mjs`（标记多场景）；落盘标记 `const spokenOverride = extractTtsSpokenOverride(rawText);` 必须在 `lib/client.js` 里（已列入自检判据）。

### 2.3 没写标记就念全文（"抓重点"机制形同虚设）

- **症状**：老大报「有时候还是会讲全部」。
- **原因**：机制没漏——是**过程性消息没写标记**。DSH 里工具调用之间的短叙述（含英文思考片段）都是独立消息、都带朗读按钮；审计最近 40 条回复：**35 条无标记**（`_probe/tts-mark-audit.mjs` 解压会话日志统计）。**纪律型机制（"每条回复都写标记"）必漏**，必须配机制兜底。
- **解法**：profile 的 `cordis.patch.yml` 把 `readScope` 由 `smart` 改成 **`first-segment`**（上游原生档位：没标记也只念首段约 160 字，写了标记仍优先念标记）。最终行为：**有标记念标记、没标记念首段、永不念全文**。备份 `cordis.patch.yml.bak-firstseg-20261015-0450`。代价：手动点历史消息同样只念首段，要全文得靠标记装。
- **验证**：`_probe/tts-firstseg-e2e.mjs`（真实补丁代码 **12 条**）：无标记长文首段 184 字、CSS 剥净、英文长段只念开头 211 字、空标记走兜底、手动/自动一致。上游切段常量 `DEFAULT_TTS_SEGMENT_CHARACTERS=160 / MAX 240 / MIN 50`。

### 2.4 标记写残（少一个 `>`、结尾只剩 `--`）→ 退回念全文

- **症状**：标记结尾写成 `了。>` 或只剩 `--`，朗读把全文念完；更糟的是同时正文被吞（见 4.2）。
- **原因**：`extractTtsSpokenOverride` 原来只认 `-->`，标签写残就匹配失败 → 退回原逻辑。
- **解法**（0.6.3）：放宽成「`-->` 优先，匹配不到就认**行尾/文末**的 `--` 或 `>`」，即 `(?:--|>)(?=\s*(?:\n|$))`。**锚定位置是必须的**——不锚的话正文里正常的 `>`（如「老大 > 小困」、引用符号）会被当成收尾把摘要拦腰截断。
- **验证**：`_probe/tts-spoken-probe.mjs`；落盘判据 `(?:--|>)(?=\s*(?:\n|$))` 在 `lib/client.js` 里。**这是善后不是许可——标记仍必须写全 `-->`。**

### 2.5 多行标记、空标记、收尾语

- **症状**：探针断言④（多行标记）报不通过，实际产物是 `老大， 多行 标记也要能认。`
- **原因**：**探针期望值写错**，不是补丁缺陷。实现是 `match[1].replace(/\s+/g, " ").trim()`——`\s+ → 单空格` 必然保留一个空格，别指望它把空格也吃掉。
- **解法**：校正期望值。规矩：**断言失败先拿实现源码对一遍产物，别急着改补丁**——陈旧探针比真缺陷常见。附带三个正面结论：① 标记内容会压掉换行与连续空白再念，所以**可以为了好读写成多行**；② 空白标记（`<!--tts:   -->`）**视为没写**，退回原逻辑；③ 命中标记时**不加** smart 收尾语（"后面还有内容…"）——摘要本就是完整的一段。
- **验证**：`tts-spoken-probe.mjs` 三断言全绿；`tts-firstseg-e2e.mjs` 覆盖空标记兜底；`_probe/tts-spoken-pipeline.mjs` 做真实代码三段对照。

### 2.6 切会话就掐断朗读

- **症状**：正在念，去别的会话干活，音频立刻断。
- **原因**：上游 `PlaybackController` 把两件事挤在 `activeSessionId` 一个字段里——**UI 正在看哪个会话** 与 **这段播放属于谁**。`activateSession` / `deactivateSession` 一进来就 `stopCurrent()`；播放循环里十几处 `this.activeSessionId !== sessionId` 也会在切走后自己 `return`。
- **解法**：拆出 **`playbackOwnerId`**（播放归属）：播放路径看它，UI 记账路径（`observeSession` / `claimAutomaticPlayback` / `updateLivePlayback`）继续看 `activeSessionId`。三条配套：切换时若 `isPlayingNow()`（current / 队列 / 分段状态 / 合成请求任一活着）就只换 UI 会话不停播；播放入口同时设 `playbackOwnerId`（新朗读仍打断旧的——单声道只能这样）；`cancelPlayback` 只准归属会话停，不越权。老大原话：「切换会话啥的都不会打断」。
- **验证**：`_probe/tts-switch-probe.mjs`——用 `cutFunction` 从落盘 client.js 抠出**真实的** `PlaybackController`，在 `node:vm` 里喂桩，**11 条断言全过**。**探针第一版把 `releaseCurrentAudio` 桩掉了，`stopCurrent` 清空链断裂 → 误报一堆：桩要贴着真实生命周期给，别图省事。**

### 2.7 隔壁会话跑完了不念

- **症状**：在 A 会话干活、切到 B 会话看，A 跑完了没声音。
- **原因**：上游自动播报触发器挂在**当前渲染着的那条消息组件**里（`conversation.chat.assistant-actions` 槽位的 `ReadAloudAction`），切走 = 组件卸载 = 触发器没了；另外 `activeSessionId` 的双重身份让 `segmented` / `toggle` 首行门禁会把隔壁会话的播报直接挡回去。
- **解法**：加一个与"当前在看哪个会话"无关的**全局观察者**，并给播放入口加 `remoteSessionId`（被跨会话播报临时接管的会话），门禁由 `activeSessionId === sessionId` 放宽成 `ownsSession(sessionId)`。主视图会话**跳过**——它归上游 `ReadAloudAction` 管，两边都来会念两遍。老大拍板原话：「改，会进tts-fix里面吗？xiaom-tts升级的话，从补丁里重新打回来。」
- **三条实测约束（写错任何一条都拿不到正文）**：① chat target 首次 `getSnapshot()` **恒为 `undefined`**（等 1.5s 也没用），必须先 `subscribe` 一次把快照催出来；② 运行中的会话正文还没落进 nodes 的 text 块（实测 running 会话 58 条 assistant 只有 1 条带 text），必须等 running 落下去再取，且留一拍；③ `retain` 必须 `release`，否则那个会话永远不会 retire。
- **验证**：`_probe/tts-cross-session-probe.mjs`。运行时实测：播隔壁时 `activeSessionId` 仍是主视图会话、`playbackOwnerId` 切到隔壁，`POST /plugins/xiaomi-mimo-tts/synthesize` 与 blob 播放都真的发生。上游也有个跨会话观察者（`installTaskSoundWatcher`），但只盯 `retainedBy.mainView > 0`（服务音效），用途不同。

### 2.8 记忆反思轮被念出来

- **症状**：自动播报把「记忆反思·本轮封存」卡念了一遍，耳朵里一串记账。老大原话（2026-10-15）：「如果最新一条是记忆反思任务就改为念上一条。」
- **原因（两层）**：① 0.6.0 用"文本里找 `meow-memory-reflect`"当判据，**线上完全不生效**——反思任务以 `agent/inbox/spliced`（target `next-turn`）注入，被 claim 时 kind 是 `turn-trigger`，而上游 `ui-chat-client.js` 的 `legacyContribution` 只认 `user` / `steering` / `context` / `command`，`turn-trigger` 直接返回 EMPTY，**`legacy.nodes` 里根本没有那条注入**；② 换成"看这一轮前面有没有可见输入"后仍漏首轮——**没被 claim 的反思注入本身就以 `context` 形态留在 legacy 里**，往前扫先撞见它自己，被判成"有可见输入"。
- **解法**：判据改成扫本轮**起点 assistant** 之前：先撞见别的 assistant ⇒ 反思轮；先撞见 `user`/`steering`/`context`/`turn-trigger` ⇒ 正常轮；`model-retry` / `turn-max-tokens` 这类系统节点跳过继续往前找。再加一道 `isReflectInjection(previous)`（输入型节点若本身 `source.kind === "plugin:meow-memory"` 且文本含 `meow-memory-reflect`，也算反思轮）——0.6.2 补的。一轮多 step 时同 turn 有多条 assistant，**先回退到本轮最早那条再往前扫**。落点选 `latestAssistantMessageId`：主视图 `ReadAloudAction` 与 `SessionPlaybackObserver` 都走它，改一处两条路一起生效；跨会话观察者的 `collect` 是自扫的，另补一行同样判据。
- **验证**：在 **42 个会话 / 21 个含反思的会话 / 27 个反思轮**（README 记 28，两处口径不一，待核）上比对新判据，v2 **零假阳零假阴**；v1 漏 2 处（`dee6e427` 的 turn 84、`df8018f8` 的 turn 18，都是首轮 `context` 形态）。真值口径必须取自 `snap.nodes.byKey` 且带 `source.kind` 过滤——一开始拿 `legacy.nodes` 文本匹配当真值，把老大自己打的字和 tool-result 回显全算进去，报出 130 处假阳。
- **边界**：**去重仍生效**——上一条若已被播过，不会因为"改念上一条"而重念，净效果是**这一轮不响**；连着反思时一路往前取，直到撞到非反思轮。想强制重念得再加开关。

### 2.9 写了标记、开着自动播报，念的还是全文+卡片（流式旁路漏挂）

- **症状**：老大实测报障（2026-10-16）：「现在只念重点，并没有实现。反而在念输出的内容和卡片上的内容。」——回复开头明明写了 `<!--tts:…-->`，且切会话不打断、跨会话播报、反思轮跳过三项都正常，唯独听到的还是整段正文和卡片文字。
- **原因**：标记提取需要挂**三处**，此前只挂了两处——`messageText`（手动点朗读）与 `applyTtsPlaybackScope`（跨会话自动播报）都吃标记，唯独**主视图流式播报**这条旁路 `scopedLiveText` 漏了：回复边生成边念，每帧拿 `partial` 的累积文本直接走 `extractMarkdownPlainText(prepareTtsText(value))` 清洗，`<!--tts:…-->` 在清洗里被当 HTML 标签吃掉，于是照旧念全文。老大开着 autoPlay，听到的恰恰就是这条旁路。**元教训**：0.6.1 落地时曾写下「两条路已验证，没有第三处」的断言——旁路排查必须 grep 全量清洗链入口（`grep -n "prepareTtsText\|scopedLiveText" lib/client.js`），旧结论不算免检金牌。
- **解法**（0.6.4）：给 `scopedLiveText` 函数**第一行**（`full` 短路**之前**）补挂 `extractTtsSpokenOverride`——有标记时每帧返回同一稳定字符串，limiter 的单调性天然满足；放 full 之前是为了 readScope 切回 full 时标记依然优先。该函数只存在于 `lib/client.js`（shared 两份没有，实测 grep=0）。改 `lib/edits.js` 加 `spoken-override-live` 编辑 → `node scripts/patch.mjs redo` 重出补丁（32 条编辑）并自动落 profile。
- **发布注记**：本版号一度错标 0.6.6——v0.6.4/v0.6.5 是公司电脑**误传**的分叉标签（不在 main 线上，已删），空出的号段应直接复用；跳号反而制造「又升两版」的假象。改号提交 `7ff4545` 拉齐。
- **验证**：redo 全绿（node --check 过、patch-commit 落盘、verify 三项：登记 / hash / 落盘）；安装件 `lib/client.js` 里 `scopedLiveText` 头两行已是标记提取；最后一层是耳朵验收——重启 DSH、开自动播报，只应念标记那句。

### 2.10 没写标记时，念的是卡片上的字

- **症状**：老大实测报障（2026-10-16 深夜）：「现在朗读又开始读卡片了」。上一条回复是纯卡片（`<div id="vcp-root">` 装整段汇报），耳朵里念出来的是卡片里的可见文字——标题、"JASNA · 关机问答"、时间线那些行。
- **原因**：**不是插件退化，是写回复的人漏了标记**。`readScope=first-segment` 下没标记就走兜底"念首段（≤240 字）"，而纯卡片回复的**首段恰好是卡片可见文字**（卡片本体在前、正文在后）。CSS 早被 0.6.0 剥干净了，所以念出来的不是样式垃圾，是**卡片排版好的那些短句**——比念 CSS 更隐蔽，听着像"它在读屏幕"。排查三路全干净：补丁符号全在、CSS 剥离探针全过、首段端到端 9 过 0 挂；复现脚本 `_probe/tts-card-regress.mjs` 拿那条真实回复原文喂真链路——不加标记念出卡片文字，加上标记立刻只念那一句。
- **解法**（0.6.5）：加 `stripTtsCards(value)`，挂在 `removeTtsMarkup` 入口、`stripTtsStyleBlocks` 之前（`style-wire` 那一处），所有朗读路径都过这里，一处接线全覆盖。**不能用非贪婪正则**——卡片里有嵌套 `div`，正则会从第一个 `</div>` 截断。算法：找 `<div id="vcp-root" …>` 起点 → 用 `/ <div\b[^>]*>|<\/div\s*>/gi` 从该点起按 div 配平找块尾 → 剥掉**所有** vcp-root 块 → 拼回。
- **三条边界（都写进代码注释了）**：① **剥完 trim 为空则原样返回**——纯卡片消息退回老行为，绝不念成空；② **未闭合卡片（流式中间帧）不动**——宁可多念半句，也不能吞掉卡片之后的正文；③ 卡片在末尾时正文完整保留（首版原型把"正文在前+卡片在后"的正文切掉了，改成剥所有卡块而非只剥开头那块）。
- **验证**：原型探针 `_probe/tts-card-strip-probe.mjs` **11/11**；端到端 `_probe/tts-firstseg-e2e.mjs` 扩到 12 条（新增 ⑩ 纯卡片不许念成空、⑪ 卡片在末尾正文保留、⑫ 嵌套 div 只剥卡片本身）**12 过 0 挂**；redo 重放 32 条编辑、node --check 过、落盘核对两文件均"已应用"。
- **元教训**：这道保险是**给"人忘写标记"兜底的**，不是替代标记。标记仍要每条都写——卡片剥离只是让"忘了写"不再念出一串界面文字。

---

## 三、音色与配置落点（voiceDesignPrompt、profile 配置、面板值优先）

### 3.1 改了 `cordis.patch.yml` 里的提示词，音色没变

- **症状**：文件改好了，念出来还是老声音。
- **原因（两条，缺一不可）**：① **改完必须重启 DSH**；② **插件设置面板里的本地值会盖过文件**——面板里贴过值，改文件就不生效。
- **解法**：提示词写进 **profile 的** `cordis.patch.yml` 的 `xiaomi-mimo-tts` 段，`voiceDesignPrompt` 与 `voiceDesignCustomPrompt` **两处必须一致**（当前实测行号 `:115` 与 `:123`；2026-10-14 当时为 116/124——行号随配置增删变动，按字段名找，别按行号找）。改完重启，并确认面板里的值一致。备份 `cordis.patch.yml.bak-tts-c-20261014`（6817B）。
- **验证**：重启后点一次朗读听音色；`grep -n "voiceDesignPrompt" cordis.patch.yml` 确认两处同内容。

### 3.2 音色每次都不一样（"这一条好听，下一条就变了"）

- **症状**：同一提示词，连续两次朗读音色不同；单次试听结果无法复现。
- **原因**：**不是插件问题**——`mimo-v2.5-tts-voicedesign`（自定义音色模型）**没有音色身份，每次请求现场重新生成嗓子**。直连 `api.xiaomimimo.com` 实测：同一段提示词连发三次，F0 中位 303.8 / 342.9 / 320.0 Hz（极差 39.1 Hz）；预置音色"冰糖"三次为 222.2 / 216.2 / 222.2 Hz（极差 6.0 Hz）。已探过的死路：`seed` 传两次结果照样不同（被忽略）、`temperature=0` 无效、`/audio/voices`、`/voices`、`/audio/voice/clone` 全 404、参考音 `reference_audio` 不报错也不生效、9 个预置音色里没有童声。
- **解法**：接受它。提示词的作用是"**平均更好听、音区更稳**"，不是"锁死一个嗓子"；要稳定只能改用预置音色（但没童声），要童声就只能反复刷。**判模板必须多次试听取平均印象，别拿一次听感定论、别反复自证。**
- **验证**：`_probe/tts-pick-gen.mjs`（从 `cordis.patch.yml` 抽 apiKey 与 voiceDesignPrompt，同文本连发 N 次，`model=mimo-v2.5-tts-voicedesign`、`audio.format=wav`，随抽随算 F0 中位与极差）。默认 dry-run 只打印将要发什么，真抽要显式加 `--go`——每次都真扣额度。产出落 `voice-refs/_picks/<时间戳>/`。
  **另两个脚本不在本仓**：`tts-acoustic.py`（F0/声学统计）与 `tts-timbre-matrix.py`（多模板矩阵对比）依赖真实音频样本与 python 音频栈，**只在本机临时用过、没有入库**（2026-10-18 核对：`_probe/` 下只有 `.mjs`，无 `.py`）。要用时的替代路径是：`tts-pick-gen.mjs --go` 抽出的 wav + 自选声学工具统计——**别照文档里的旧数字复现，那批样本已不在**。

### 3.3 音色偏尖、偏高、像播报腔

- **症状**：念出来又高又细、没感情、像念稿机器。
- **原因**：提示词三坑 + 两个配置元凶。① 写成「音色基底：／语速节奏：」条目化规格表、或写场景动作（"吐槽时""汇报时""叫老大时"）——插件明写**只描述声音本身，不写场景或动作**，场景它执行不了，只会把每条平均掉，出来就是没表情的播报腔；② 一路堆「中高音／清甜／少女／音调略抬／奶凶」会**推高音高**，要反向压；③ 「中等偏慢」+「自然的小起伏」会念成没感情的念稿；④ 「忠实朗读、不增删」写多了会变成逐字念稿。配置元凶：**`voiceRate` 非 1.0×**（PCM 流式路径变速即变调，1.2× 实测整体升调约 3 个半音）、**`localSpeechMode=auto` 时 API 超时会悄悄回退到系统合成音**（本机 `localVoiceURI` 是微软康康男声）。
- **解法**：明写「中音区、不尖细、共鸣位置适中偏低、声音落得下来、句尾不上扬」；写「语速偏快、句子连着往下说、语调起伏明显、抓重点说、读出兴致来」；把"忠实朗读"换成「像跟人讲话一样把意思讲出来…意思照原文，不自行添加」。`voiceRate` 默认保持 `1`——**PCM 流式路径变速即变调**，调快会连带升调；老大 2026-10-18 明确要求 `1.2×` 换速度，那就接受约 3 个半音的升调，**别再加"中音区、别尖"之类的反向话去抵**，两股力会互相打架、出来更飘。定稿全文见 `voice-refs/prompt.md`（C 组，2026-10-14）。选型依据：同一段 265 字文本、同模型，四组提示词各抽 5～10 样本测 F0 中位（自相关法）——A 六到九岁童声 293.7±17.4Hz(n=10)｜B 加厚+中音区+明写不要尖 263.4±26.9Hz(n=5)｜**C 八到十一岁+清亮结实有厚度+中音区 256.5±16.9Hz(n=5)**｜D 极简口语 280.0±21.0Hz(n=5)；老大听完 25 个样本后 C 组五个全过。要的是「厚一点、落得下来，不是又高又细的童声」。
- **验证**：改完重启 → 连听多条取平均印象。主观听感类调参小困无法自验，只能靠老大听。

### 3.4 `readScope` 三档怎么选

- **症状**：朗读要么念全文（太长），要么只念开头（截断，不知道重点在哪）。
- **原因**：上游档位——`smart`（自动：短文本全文 / 长文本首段+随机收尾语，手动点则全文）、`full`（都全文）、`first-segment`（都首段约 160 字）。**上游没有任何摘要能力，只有截断**，首段是按 160 字目标硬切的第一段，它不会挑重点。
- **解法**：配 **`first-segment`** 作兜底（当前 `cordis.patch.yml:133`），重点靠 `<!--tts:…-->` 标记表达——只有写回复的人知道重点在哪。**别改回 `smart`**：没标记时它会念全文。
- **验证**：`grep -n "readScope" cordis.patch.yml` 应为 `first-segment`；改前备份 `cordis.patch.yml.bak-firstseg-20261015-0450`（5889B）。

### 3.5 参照样本、密钥与"找回刚才那个音色"

- **症状**：想找回刚才那次朗读的音色文件 / 想把整段配置（含 `apiKey`）提交上去。
- **原因**：DSH 播报走**流式 PCM，播完即丢**，服务端也不保存——"找回刚才那个音色"**没有文件层面的路**；而配置段带着 API 密钥。
- **解法**：三个挑中的参照样本 `voice-refs/小困童声参照-09 / -04 / -02.wav`（约 8.7MB，md5 与声学数据见 `voice-refs/README.json`）只是**靶子**，不是运行时依赖，**不入库**（`.gitignore` 已排除 `voice-refs/*.wav`）；复刻用同文本 + `voice-refs/prompt.md` 的提示词直连 API 重抽。本仓只存「**怎么调**」，不存「调到哪台机器上」。
  装机时**手抄/粘贴**即可：要抄的就是 `cordis.patch.yml` 里 `xiaomi-mimo-tts` 段的 `apiKey` + `voiceDesignPrompt`/`voiceDesignCustomPrompt` 两段提示词（两处必须一致）。早年那份 `_probe/tts-install-sheet.md`（2026-10-15 导出、含 key 的装配单）**已不在本仓**（2026-10-18 核对：`_probe/` 下没有该文件，含密钥本就不该留在仓库里）——照那份旧快照抄会写进 `dsh-maid-tts-fix@0.4.0` + 渲染侧 v6.41，现在最低配套是 **0.6.5 + v6.42（补丁器 v10.3）**。云端**无音色资产要迁移**——voicedesign 每次朗读重新采样。
- **验证**：`voice-refs/README.json` 里三个样本的 md5 / `f0_med`（266.7 / 292.7 / 300.0 Hz）；`git status` 里不应出现任何含 `sk-` 的文件。

## 四、渲染与注释显形问题

> 这一章的问题在 **`dsh-maid-vcp`** 侧修，但**必须与本仓配套**：只打 TTS 侧 → 注释不念但显形；只打渲染侧 → 注释不显形但照旧念全文。两个补丁都打才算数。

### 4.1 正文里那行 `<!--tts:…-->` 明晃晃显示出来

- **症状**：卡片底下挂着一行尖括号注释，老大两次截图来问「注释没隐藏」。
- **原因**：注释经 `DOMParser` 变成 comment 节点，再交给 vdom 转换时被转成**带尖括号的文本**渲染出来。
- **解法**：修在 `patch/v6-inject.js`，**两版才修对**——v6.40 挂在 `parseFrag`（进 DOM 之前剥）**无效**；v6.41 改成在 `render` 入口最上游剥注释、且剥完为空时返回**空 Fragment**，才生效。
- **v6.40 为什么没用（典型假修）**：`<!--tts:…-->` 前后有空行时会被切成**独立的 HTML 注释块**单独交给 `render`；处理链走完 `v` 已是空串，而 `if (!v) return null` 在 `parseFrag` **之前**就短路了，剥注释那行根本轮不到——而 `render` 返回 `null` 的语义是「我不渲染」，宿主随即 `return e.value`，**把注释原文当内容渲染**。所以 v6.41 两处一起改（剥注释提到 `render` 入口 + 空 Fragment 而非 null，判据是"原文有东西、剥完没东西"；真空消息仍返 `null`，不吞内容）。`<pre><code>` 里的注释示例已在 `protectCodeEntities` 转义成 `&lt;!--`，不受影响。
- **验证**：改完**硬刷新页面**（Ctrl+R）；用 `_probe/tts-markup-lenient-probe.mjs` 验剥离行为。

### 4.2 整条正文连同卡片一起消失（只剩"已完成，用时 N 秒"）

- **症状**：回复正文和卡片全没了，界面只剩一行「已完成，用时 21 秒」。老大连着看见两次，报「我以为是我的问题，你两次回复我都是这样」。
- **原因**：v6.41 对未闭合注释的处理是「按 HTML 规范**无条件**截断到末尾」——护住了流式中间帧，却埋了雷。小困有三次回复把标记写残（一次写成 `了。>`，两次结尾只剩 `--`），那一刀就从标记处切到消息末尾（`<!--tts:…--` 后面的正文全被切掉）。
- **解法**（v6.42）：剥法改**宽容模式**——遇到未闭合的 `<!--`，吃掉**它所在的整行**（标记协议上独占一行，删整行才不会把两侧正文粘成一行），然后继续处理剩下的；只有 `lenient !== true` 的老调用点（流式中间帧）保留截断行为。行尾没有换行时仍吃到末尾——那种情况标记后面本来也没东西。
- **元教训**：**「防流式」的宽容逻辑不能无条件套在最终帧上**——同一段代码要在两个语境下表现不同，就得把语境（`lenient`）显式传参，不能靠调用顺序碰运气。**双保险**：同一处事故 TTS 侧也补了一道（0.6.3 的标记收尾容错，见 2.4）——渲染侧保证正文不消失，TTS 侧保证写残也照样念对。
- **验证**：把残缺标记喂给 `stripHtmlComments(..., lenient=true)`，正文应完整保留；最终帧与流式帧分别断言。

### 4.3 标记被写成 Markdown 行内代码（加反引号）→ 尖括号原样显形

- **症状**：写成 `` `<!--tts:…-->` `` 时那行注释原样显示；裸写的注释从不显形。
- **原因**：反引号内容被 CommonMark 当**行内代码**，走宿主 `case "inlineCode"` 分支渲染成 `<code>`，而 VCP 的注释剥离只挂在 `case "html"` 与 `case "code"` 两条分支上——`inlineCode` 根本没接补丁。统计：全工作区 50 条标记里只有 3 条这样写，全出在同一会话、全是小困自己干的。
- **解法**：**标记必须裸写、独占一行，绝不能加反引号。** 渲染侧已补（补丁器 v10.3）：`patch/patch-frontend-asar.cjs` 加「**G. inlineCode 兜底**」（判据窄到内容以 `<!--` 开头才拦），同时去掉 `case "code"` 兜底判据的 `^` 锚定——原来要求围栏内容以 `<div id="vcp-root"` 开头，卡片前带一行说明或一行标记就**整卡退回源码**。
- **验证**：自测 24 用例全绿、asar 已写入（747912 字节、G 守卫在），**重启后运行时 bundle 复核通过**（2026-10-16 04:41）；剩下的只能靠肉眼确认。

### 4.4 改完补丁页面没变化

- **症状**：补丁确实落地了，页面行为照旧。
- **原因**：客户端 bundle 走 **combo URL + rev**，浏览器拿着旧 rev；带 asar 的注入补丁还有 asar 头缓存。
- **解法**：**硬刷新页面**（Ctrl+R）；asar 注入补丁要**重启 DSH**。
- **验证（重要陷阱）**：直接 `curl /plugins/??dsh-xiaomi-tts/client.js`（**不带 rev**）返回 404，**不能据此断言补丁没送达**——那只是缺 rev 参数。要判落盘就读 `node_modules/dsh-xiaomi-tts/lib/client.js` 里的特征串。

---

## 五、关键路径与配置落点

| 项 | 路径 | 说明 |
| --- | --- | --- |
| 本仓 | `D:\DeepSeek Harness\Works\dsh-maid-tts-fix` | 远端 `Valorine97417/dsh-maid-tts-fix` |
| 补丁正本 | `dsh-maid-tts-fix/patches/dsh-xiaomi-tts@3.0.9.patch` | 26307 字节 / sha256 `7bacff7947105f7e21a25a8e972a7837c687256442b1e2259091657e40594e5a` |
| 意图层 | `dsh-maid-tts-fix/lib/edits.js` | **按版本分发的分发器** → `edits-v308.js`（展开 32 条）/ `edits-v309.js`（展开 33 条）；锚点 + `expect`；全有或全无、幂等 |
| 体检判据 | `dsh-maid-tts-fix/lib/selfcheck.js` | **16 条 `APPLIED_MARKERS`**，逻辑名 `@client`(12) / `@text`(4)，按内容认文件 |
| 命令行 | `dsh-maid-tts-fix/scripts/patch.mjs` | `list / install / verify / remove / upgrade / redo`；pnpm 走候选路径探测 |
| 补丁备份 | `dsh-maid-tts-fix/.patch-backups/` | 本机 profile 的补丁与 lock/workspace 快照，**不进版本控制**；升级前留 `pre-309/` |
| profile 目录 | `C:\Users\<用户>\.dsh\profiles\desktop` | 本机为 `C:\Users\Kayle\…`；启动自检优先读 `DSH_PROFILE_DIR` 环境变量 |
| 登记 | `…\profiles\desktop\pnpm-workspace.yaml` → `patchedDependencies` | 当前含 `dsh-video-understand@0.5.2`、`dsh-xiaomi-tts@3.0.9` |
| hash | `…\profiles\desktop\pnpm-lock.yaml` → `patch_hash`（第 9 行） | 应与补丁正本 sha256 一致 |
| 上游落盘 | `…\node_modules\dsh-xiaomi-tts\lib\client.js`、`lib\text-<hash>.js` | 两份都必须含 `stripTtsStyleBlocks`；文本那支名字带构建哈希，**按内容找** |
| 音色配置 | `…\profiles\desktop\cordis.patch.yml` 的 `xiaomi-mimo-tts` 段 | `voiceDesignPrompt`(:115) / `voiceDesignCustomPrompt`(:123) / `model`(:112) / `readScope`(:133) / `voiceRate`(:145) |
| 配置备份 | `…\profiles\desktop\cordis.patch.yml.bak-*` | `bak-tts-c-20261014`（音色定稿前）、`bak-firstseg-20261015-0450`（readScope 改动前）、`bak-rate1-20261014-220042` |
| 探针 | `D:\DeepSeek Harness\Works\_probe\tts-*` | 见第六章；**在仓库之外** |
| 装机单 | `D:\DeepSeek Harness\Works\_probe\tts-install-sheet.md` | 含 apiKey，**别上传**；版本号为 10-15 快照，照抄要更新 |

## 六、排查手法

1. **先问"判据的输入到底存不存在"，再怀疑判据写法。** 0.6.0 实例：锚点、函数名、落盘标记全对，真因是 `legacyContribution` 把 `turn-trigger` 投影丢了。同类坑：`node.data.content` 实际扁平挂顶层、`chat target.getSnapshot()` 首次恒 `undefined`（要先 `subscribe` 预热）。
2. **修好一处可能引入更糟的一处。** 排查"某功能突然坏了"时，除了问"输入在不在"，还要问"**最近改的那条分支，在别的语境下也会跑到吗**"（v6.41 截断 → v6.42 `lenient`）。
3. **验落盘，别猜。** `node scripts/patch.mjs verify`（登记 / hash / 落盘）+ 启动日志 `[tts-fix]` 行；判据是 `APPLIED_MARKERS`，不是页面表现。
4. **探针清单**（`D:\DeepSeek Harness\Works\_probe\`，均在仓库之外）：`tts-309-landed-check.mjs`（**对落盘后的真实产物跑端到端 8 场景**——见下条）｜`tts-text-probe.mjs`（CSS 剥离三场景）｜`tts-spoken-probe.mjs`（标记提取，含多行与写残）｜`tts-spoken-pipeline.mjs`（真实代码三段对照）｜`tts-firstseg-e2e.mjs`（首段兜底 9 场景）｜`tts-mark-audit.mjs`（会话日志标记覆盖率审计）｜`tts-switch-probe.mjs`（切会话 7 组 20 用例）｜`tts-cross-session-probe.mjs`（跨会话播报）｜`tts-fix-replay-test.mjs`（补丁重放逐字节可复现：`git apply -R` 撤成上游原样 → 重放 → 比对）｜`tts-markup-lenient-probe.mjs`（注释剥离宽容分支）｜`tts-pick-gen.mjs` / `tts-acoustic.py`（音色重抽与 F0 统计）。
5. **`verify` 绿了不等于功能对——再跑一遍落盘产物。** `tts-309-landed-check.mjs` 从 `node_modules/dsh-xiaomi-tts/lib/` 里**抠出真正会上线的那份字节**跑 8 个场景（CSS 剥离、纯卡片、嵌套 div、流式中间帧、标记提取、写残标记、普通文本、围栏代码）。手法：把 `lib/` 拷到临时目录，在文本 chunk 末尾**追加一行 `export {...}`** 再 `import()`——让 Node 自己解析它原本的 `import` 链。**踩过的两条弯路**：① 按内容认文件时必须**排除 `client.js`**（两份都含 `removeTtsMarkup`，字母序在前会认错）；② 别用 `vm` 抠函数体逐层补依赖（`removeTtsMarkup` → `removeFencedCode` → `findFencedCodeRegions` → `MARKDOWN_CODE_BLOCK_RE` …补不完，**别重造模块系统**）。
6. **断言失败先定性，别急着改补丁。** 见 2.5：`tts-spoken-probe.mjs` 断言④报错实为探针期望值写错——陈旧探针比真缺陷常见。**桩要贴着真实生命周期给**（`releaseCurrentAudio` 那次的教训）。
7. **别拿老大的屏幕当测试环境。** 验证样本要自己先确认渲染正常，再放进给老大看的回复里；要老大配合实测时，明确说清"这条注释会暂时显形，属于验证样本"。
8. **机制型功能上线后必须主动讲清触发条件**（"不写标记就念首段"）。否则用户把"没触发"当故障，还要多花几轮去猜、去证。
9. **写完回复扫一眼开头的 `<!--tts:` 是否以 `-->` 收尾、是否裸写独占一行。** 这是最便宜的自检，代价却是老大看不见回复。
10. **别手改 `node_modules`；别手工编辑 `.patch`**（`.patch` 是产物、`edits.js` 是意图——手改产物下次 `upgrade` 一重放就没了）。
11. **锚点三坑**（`lib/edits.js` 顶部注释）：① 锚点写成带 `\t` 前缀而源码顶格 → 命中 0 次；② 替换串自带 `\t` 而源码行已有缩进 → 叠成两层；③ **上游那两个文件是 CRLF 行尾**，锚点写 `\n` → 逐字全不匹配而"肉眼明明一样"。现在的写法：锚点一律用 `\n`，由 `normalizeEol()` 按目标文件行尾折算。
12. **补丁随包分发**（`patches/` 在 `package.json` 的 `files` 白名单里）。上游哪天自己修好了，`verify` 会报「落盘：未应用」而不是假装成功——那正是该退休的信号；长期无提交则转整包接管（形态参照 `dsh-maid-preset` 内联 `meow-memory` 的做法）。
13. **凡是会让 pnpm 解析 lockfile 的子命令，都要包上供应链门禁重试。** 只给 `install` 加是不够的——`patch-commit` 内部**同样会重新校验**，升级到刚发布不久的新版本时必然被 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 拦下（2026-10-18 实测）。
14. **引用宿主自带工具链（pnpm/node）别写死单一路径。** 宿主升级会把运行时搬家（`resources/runtime/pnpm/` → `resources/runtime/primary-runtime/dependencies/pnpm/`），写死就会静默回退到 PATH，而这台机 PATH 上根本没有 pnpm。改成候选清单探测第一个存在的。
15. **升级三步不能颠倒**：先摘旧版本 `patchedDependencies` 登记 → 改 `dependencies` 并 install 到干净新版本 → 再跑 `upgrade`。`pnpm patch` 只认**已安装**的版本，顺序反了直接 `ERR_PNPM_PATCH_VERSION_NOT_FOUND`。

## 附：暂未遇到

- 多路会话同时跑完时的播报**排队时序**问题（队列已有"正在播就等它完"，未遇到真实冲突出）。
- 预置音色（冰糖等）与 voicedesign **混用**的配置冲突（本机只用 `mimo-v2.5-tts-voicedesign`）。
- **Linux / macOS 部署**：本记录的行尾、profile 路径、脚本实测全部基于 Windows（待核）。
