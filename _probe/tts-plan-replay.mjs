// 对**任意上游包目录**跑真实累积重放，只打印结果、不写盘——升版预检用它。
//
// 用法：
//   node _probe/tts-plan-replay.mjs /path/to/unpacked/dsh-xiaomi-tts
//
// 为什么单独一支：`tts-fix-replay-test.mjs` 会先卡「上游版本 == 已安装版本」，
// 升版预检阶段（装着 3.0.9、上游已发 4.2.0）必然中途放弃，验不到东西。
//
// 取干净上游：
//   npm pack dsh-xiaomi-tts@4.2.0 && tar xzf dsh-xiaomi-tts-4.2.0.tgz
//
// 判读：`failed=0` 且 `applied + already = 33` 才算这份意图能在该版本上落地。
// 任一 `✗` 行都会打印 id / 期望次数 / 实际次数，锚点失配基本都在这行里看。
import fs from 'node:fs'

import { editCountOf, packageVersionOf, planEdits } from '../lib/edits.js'

const root = process.argv[2]
if (!root) {
  console.error('用法：node _probe/tts-plan-replay.mjs <上游包目录>')
  process.exit(2)
}
if (!fs.existsSync(root)) {
  console.error(`目录不存在：${root}`)
  process.exit(2)
}

const readFile = (file) => fs.readFileSync(file, 'utf8')
const version = packageVersionOf(root)
const nominal = editCountOf(root, readFile)
const result = planEdits(root, readFile)

const applied = (result.applied ?? []).length
const alreadyDone = result.already === true
const failed = result.failed ?? []

console.log(`上游版本 ${version ?? '(读不到)'}   名义条数 ${nominal}`)
console.log(`目录 ${root}`)
console.log(`ok=${result.ok}  already=${alreadyDone}  applied=${applied}  failed=${failed.length}`)

for (const item of failed) {
  const id = item.edit?.id ?? '(无 id)'
  const expect = item.edit?.expect ?? '?'
  console.log(`  ✗ ${id}  expect=${expect} found=${item.found ?? '?'} eol=${item.eol ?? '?'}  ${item.edit?.why ?? ''}`)
}

const landed = result.ok === true && failed.length === 0
const count = alreadyDone ? nominal : applied
console.log(landed ? `\n✓ 重放通过：${count}/${nominal} 条落地，该版本可直接 upgrade。` : '\n✗ 重放未通过——先修锚点，再 upgrade。')
process.exit(landed ? 0 : 1)
