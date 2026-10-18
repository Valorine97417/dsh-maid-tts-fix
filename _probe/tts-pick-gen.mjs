#!/usr/bin/env node
/**
 * tts-pick-gen.mjs —— 反复抽样的「听感取样器」
 *
 * 用途（对应 TROUBLESHOOTING §3.2）：
 *   `mimo-v2.5-tts-voicedesign` **没有音色身份**，每次请求现场重新生成嗓子。
 *   所以「这一条好听」没有复现路径——只能同文本连发 N 次、听平均印象。
 *   本脚本就是把「连发 N 次」自动化：抽 key、抽提示词、抽完落盘、并打印 F0 粗估。
 *
 * 默认 **dry-run**：只打印将要发什么，不花钱、不发请求。
 * 真跑要显式加 `--go`（每次都真扣额度，别顺手敲）。
 *
 * 跑法：
 *   node _probe/tts-pick-gen.mjs                    # 预演
 *   node _probe/tts-pick-gen.mjs --go --n 5         # 真抽 5 条
 *   node _probe/tts-pick-gen.mjs --go --text "..."  # 换文本
 *
 * 产出：`voice-refs/_picks/<时间戳>/pick-01.wav …`（已在 .gitignore 排除范围内）。
 * 注意：抽出来的 wav **不是**运行时依赖，只是靶子；真正要留的是 `voice-refs/prompt.md` 的提示词。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, '..')
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}

const GO = flag('go')
const COUNT = Number(value('n', '3'))
const TEXT =
  value('text') ??
  '小困这就去办。老大你先坐着，剩下的活交给小困。这份报告小困已经核过了，三处补丁都在位，日志也干净。'

/**
 * 从 profile 的 cordis.patch.yml 里抽 `xiaomi-mimo-tts` 段的某个字段。手写解析，不引依赖。
 *
 * **别用行正则偷懒**：`voiceDesignPrompt` 是 YAML 块标量（`|-`），值在下面几行、
 * 靠缩进定界。只取 `key: 值` 那一行会拿到字面 `|-` 三个字符（踩过一次）。
 * 这里正经处理三种形态：行内标量 / 块标量 `|`、`|-`、`>`、`>-` / 带引号的行内值。
 */
function readTtsConfig() {
  const candidates = [
    path.join(PROFILE, 'cordis.patch.yml'),
    path.join(PROFILE, 'cordis.yml'),
  ]
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const start = lines.findIndex((line) => /^\s*-?\s*id:\s*xiaomi-mimo-tts\s*$/.test(line))
    if (start === -1) continue

    const config = {}
    let keyIndent = null
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      // 段结束：又出现同级的 `- id:`
      if (/^\s*-\s*id:\s*\S/.test(line) && !/^\s{4,}/.test(line)) break

      const match = /^(\s+)([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/.exec(line)
      if (match) {
        keyIndent = match[1].length
        const key = match[2]
        const raw = match[3].trim()

        // 块标量：值在后面的缩进行里
        if (/^[|>][+-]?$/.test(raw)) {
          const fold = raw.startsWith('>')
          const body = []
          let j = i + 1
          for (; j < lines.length; j += 1) {
            const inner = lines[j]
            if (inner.trim() === '') {
              body.push('')
              continue
            }
            const indent = inner.length - inner.trimStart().length
            if (indent <= keyIndent) break
            body.push(inner.trim())
          }
          config[key] = (fold ? body.join(' ') : body.join('\n')).trim()
          i = j - 1
          continue
        }

        config[key] = raw.replace(/^['"]|['"]$/g, '')
        continue
      }

      // 续行（多行纯文本值，没写块标量的老格式）——保守起见不并入，只跳过
    }
    return { file, config }
  }
  throw new Error('两个配置文件里都没找到 xiaomi-mimo-tts 段')
}

/** 极端粗略的 F0 中位估算：自相关法，只为「听起来是不是偏高」给个数字参考。 */
function estimateF0(pcmFloat, sampleRate) {
  const frame = 2048
  if (pcmFloat.length < frame * 4) return null
  const minLag = Math.floor(sampleRate / 500)
  const maxLag = Math.floor(sampleRate / 80)
  const estimates = []
  for (let offset = 0; offset + frame + maxLag < pcmFloat.length; offset += frame) {
    let energy = 0
    for (let i = 0; i < frame; i += 1) energy += pcmFloat[offset + i] ** 2
    if (energy / frame < 1e-4) continue
    let bestLag = -1
    let bestScore = -Infinity
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let score = 0
      for (let i = 0; i < frame; i += 1) score += pcmFloat[offset + i] * pcmFloat[offset + i + lag]
      score /= frame
      if (score > bestScore) {
        bestScore = score
        bestLag = lag
      }
    }
    if (bestLag > 0) estimates.push(sampleRate / bestLag)
  }
  if (!estimates.length) return null
  estimates.sort((a, b) => a - b)
  return estimates[Math.floor(estimates.length / 2)]
}

const { file, config } = readTtsConfig()
const apiKey = config.apiKey
const baseURL = config.baseURL ?? 'https://api.xiaomimimo.com/v1'
const prompt = config.voiceDesignPrompt ?? config.voiceDesignCustomPrompt

console.log(`配置来源：${file}`)
console.log(`apiKey：${apiKey ? `${apiKey.slice(0, 8)}…（长度 ${apiKey.length}）` : '✗ 没抽到'}`)
console.log(`baseURL：${baseURL}`)
console.log(`音色提示词：${prompt ? `${prompt.slice(0, 60)}…（${prompt.length} 字符）` : '✗ 没抽到'}`)
console.log(`待念文本：${TEXT.length} 字符`)
console.log(`抽样次数：${COUNT}\n`)

if (!apiKey || !prompt) {
  console.error('✗ 抽不到 apiKey 或音色提示词，先检查 cordis.patch.yml 的 xiaomi-mimo-tts 段')
  process.exit(1)
}

const body = {
  model: 'mimo-v2.5-tts-voicedesign',
  messages: [
    { role: 'user', content: prompt },
    { role: 'assistant', content: TEXT },
  ],
  audio: { format: 'wav', voice: 'default' },
}

if (!GO) {
  console.log('—— 预演（未发请求），要真抽加 --go ——')
  console.log(JSON.stringify({ ...body, messages: body.messages.map((m) => ({ ...m, content: `${m.content.slice(0, 40)}…` })) }, null, 2))
  console.log('\n注意：voicedesign 每次重新采样，抽到的嗓子各不相同——别指望复现某一次。')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const outDir = path.join(REPO, 'voice-refs', '_picks', stamp)
fs.mkdirSync(outDir, { recursive: true })
console.log(`产出目录：${outDir}\n`)

const readings = []
for (let i = 1; i <= COUNT; i += 1) {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    console.error(`✗ 第 ${i} 次失败：HTTP ${response.status} ${await response.text()}`)
    continue
  }
  const json = await response.json()
  const audio = json?.choices?.[0]?.message?.audio?.data
  if (!audio) {
    console.error(`✗ 第 ${i} 次没返回音频：${JSON.stringify(json).slice(0, 300)}`)
    continue
  }
  const buffer = Buffer.from(audio, 'base64')
  const out = path.join(outDir, `pick-${String(i).padStart(2, '0')}.wav`)
  fs.writeFileSync(out, buffer)

  // WAV：跳过 44 字节头，16-bit 单/双声道按第一声道取
  const sampleRate = buffer.readUInt32LE(24)
  const channels = buffer.readUInt16LE(22)
  const pcm = []
  for (let p = 44; p + 1 < buffer.length; p += 2 * channels) pcm.push(buffer.readInt16LE(p) / 32768)
  const f0 = estimateF0(pcm, sampleRate)
  readings.push(f0)
  console.log(`✓ 第 ${i} 次 → ${path.basename(out)}（${(buffer.length / 1024).toFixed(0)} KB，F0 中位 ${f0 ? f0.toFixed(1) : '?'} Hz）`)
}

if (readings.filter(Boolean).length) {
  const valid = readings.filter(Boolean).sort((a, b) => a - b)
  console.log(`\nF0 中位：${valid.map((v) => v.toFixed(1)).join(' / ')} Hz`)
  console.log(`极差：${(valid[valid.length - 1] - valid[0]).toFixed(1)} Hz —— 极差大就是「每条嗓子都不一样」，属正常。`)
  console.log('把 wav 里的平均印象听完再下结论，别拿一次听感定模板。')
}
