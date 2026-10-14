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
].join('\n')

/**
 * 对单个文件做的编辑。`find` / `replace` 都是逐字字面量。
 *
 * @typedef {{ id: string, file: string, find: string, replace: string, expect: number, why: string }} Edit
 */

/** @type {Edit[]} */
export const EDITS = Object.freeze(
  TARGET_FILES.flatMap(file => [
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
      replace: '\tlet text = stripTtsStyleBlocks(value).replace(MARKDOWN_CODE_BLOCK_RE, " ")',
      expect: 1,
      why: '把 removeTtsMarkup 的入口接在新函数上——写在旁边不等于会被调用',
    },
  ]),
)

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
 * 幂等：若目标文件里已经有 `stripTtsStyleBlocks`，说明这棵树已经打过补丁，
 * 直接返回 `already: true` 原样交回——不重复插入。**这一步不能省**：
 * `style-helpers` 的锚点行在打过补丁后依然存在（补丁是插在它后面），
 * 少了这道检查就会插第二份，函数被重复定义。
 *
 * @param {string} packageRoot 解开的包目录（pnpm patch 的临时目录）。
 * @param {(file: string) => string} readFile 读文件（便于测试注入）。
 * @returns {{ ok: boolean, already: boolean, applied: string[], failed: Array<object>, contents?: Map<string,string> }}
 */
export function planEdits(packageRoot, readFile) {
  const applied = []
  const failed = []
  const contents = new Map()

  const first = `${packageRoot}/${EDITS[0].file}`
  contents.set(first, readFile(first))
  if (contents.get(first).includes('function stripTtsStyleBlocks(')) {
    return { ok: true, already: true, applied: [], failed: [], contents: undefined }
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
    contents.set(file, source.replace(find, normalizeEol(source, edit.replace)))
    applied.push(edit.id)
  }

  if (failed.length > 0) return { ok: false, already: false, applied: [], failed, contents: undefined }
  return { ok: true, already: false, applied, failed: [], contents }
}
