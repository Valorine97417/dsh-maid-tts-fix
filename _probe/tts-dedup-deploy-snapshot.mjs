// 部署前后快照；不负责安装，不改配置。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const repo = 'D:/DeepSeek Harness/Works/dsh-maid-tts-fix'
const profile = 'C:/Users/Kayle/.dsh/profiles/desktop'
const files = [
  `${profile}/package.json`, `${profile}/pnpm-workspace.yaml`, `${profile}/pnpm-lock.yaml`,
  `${profile}/patches/dsh-xiaomi-tts@3.0.9.patch`,
  `${repo}/patches/dsh-xiaomi-tts@3.0.9.patch`,
  `${repo}/lib/edits-v309.js`, `${repo}/lib/edits-v308.js`,
  `${repo}/_probe/tts-autoplay-dedup-regress.mjs`,
  `${profile}/node_modules/dsh-xiaomi-tts/lib/client.js`,
  `${profile}/node_modules/dsh-xiaomi-tts/lib/text-B7NACAYZ.js`,
  `${profile}/cordis.patch.yml`,
]
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex')
const rows = files.map((file,index)=>{
  const bytes=fs.readFileSync(file), stat=fs.statSync(file)
  return {file,index,bytes:bytes.length,md5:md5(bytes),mtime:stat.mtime.toISOString(),data:bytes}
})
const stamp = new Date().toISOString().replace(/[:.]/g,'-')
const dir = path.join(repo,'.patch-backups',`dedup-${stamp}`)
if(!path.resolve(dir).startsWith(path.resolve(repo,'.patch-backups')+path.sep))throw Error('Unexpected backup target')
fs.mkdirSync(dir,{recursive:true})
for(const row of rows){
  row.backup=path.join(dir,`${row.index}-${path.basename(row.file)}`)
  fs.writeFileSync(row.backup,row.data)
  if(md5(fs.readFileSync(row.file))!==row.md5)throw Error(`Concurrent modification: ${row.file}`)
  delete row.data
}
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({time:new Date().toISOString(),rows},null,2))
console.log(JSON.stringify({dir,rows},null,2))
