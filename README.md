# dsh-maid-tts-fix

DSH 小困插件 · **朗读文本清洗补丁器**：给 [dsh-xiaomi-tts](https://github.com/ppy-web/dsh-plugin-xiaomi-mimo-tts) 装上能跨行的 `style`/`script` 剥离，让 VCP 卡片的 CSS 不再被念出来；并**盯着这个补丁别掉**。

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

补丁做两件事，两处文件各改一遍（`lib/client.js` 与 `lib/shared-DQIrhcy-.js` 是同一个函数的两个副本，漏一个就等于没修）：

| 改动 | 做什么 |
| --- | --- |
| 加三个常量 + `stripTtsStyleBlocks()` | 先按**块**删 `<style>`/`<script>` 整段，再走原来的行内清洗 |
| 改 `removeTtsMarkup` 首行 | 把新函数接在链首——函数写在旁边不等于会被调用 |

流式中间帧也照顾到了：`<style>` 已开、`</style>` 还没到时，从开标签处截断，宁可少念半句也不念 CSS。

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
node scripts/patch.mjs install --dry-run      # 只说要做什么
node scripts/patch.mjs verify --profile <dir> # 换 profile（默认 desktop）
node scripts/patch.mjs upgrade --to 3.1.0     # 指定目标版本，默认按已装的
```

`verify` 输出长这样：

```
✓ 登记：pnpm-workspace.yaml 的 patchedDependencies → dsh-xiaomi-tts@3.0.8
✓ lockfile hash 与补丁正本一致：1933918e04f838e8…
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
流程）生成的补丁，sha256 与原正本逐字节相同：`1933918e…81ac2`。

## 五、启动自检：它不会悄悄死掉

`index.js` 在每次启动时把同样三项问一遍，掉哪一项就 `warn` 出来并附上修它的命令。三条路径互相独立，因为它们是三个独立的失效点：

| 问什么 | 掉了会怎样 |
| --- | --- |
| 登记还在吗 | profile 换过 / 被谁清过 → 补丁根本不参与 install |
| hash 对得上吗 | 补丁改过但没重打 → 生效的是旧版本 |
| 字节落盘了吗 | install 失败 / 包被换版本 → 补丁文件在，包里没有 |

它**不修、不拦、不抛**——一个体检器没有资格让应用起不来。宿主没装 `dsh-xiaomi-tts` 时，它也不过是白问一遍。

## 六、边界

- **只做朗读文本清洗这一件事。** 不碰音色、不碰配置、不碰插件其余部分。
- **不改上游一个字节以外的任何东西。** 补丁全部内容都在 `patches/*.patch` 里，`install`/`remove` 之外不写 profile。
- **补丁随包分发。** `patches/` 在 `package.json` 的 `files` 白名单里——这个包的意义就是携带补丁正本，丢了它就没意义。
- 上游哪天自己修好了，`verify` 会报「落盘：未应用」而不是假装成功——那正是该退休的信号。

### 上游停更了怎么办

本仓的定位是**两段式**：上游活着时只做补丁、跟随更新、不锁版本；上游一旦停更，
就整体收录接管（形态参照 `dsh-maid-preset` 内置 `meow-memory` 的做法）。

判断信号：`verify` 报「落盘：未应用」且上游仓库长期无提交 —— 说明上游自己修好了，
或者不再维护。前者退休，后者转收录。

## 七、和 dsh-maid-preset 的关系

**没有关系，也不需要有关系。** 人设插件管人设与记忆，这个插件管第三方插件的朗读文本——环境施工件不进人设仓库，两边各自独立。人设那边只留了一份音色提示词与说明（`voice-refs/prompt.md`），不引用本包。

## License

MIT
