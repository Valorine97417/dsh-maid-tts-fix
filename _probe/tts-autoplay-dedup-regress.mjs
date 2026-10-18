// 静默行为回归：执行真实观察者与主视图 claim；只 mock stores/timers/音频出口。
// --installed 检验当前落盘（修复前应复现失败），默认检验维护意图层。
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { buildEdits } from '../lib/edits-v309.js'
import { EDITS as edits308 } from '../lib/edits-v308.js'
const installed = fs.readFileSync('C:/Users/Kayle/.dsh/profiles/desktop/node_modules/dsh-xiaomi-tts/lib/client.js', 'utf8')
const marker = 'function installCrossSessionAutoPlay(ctx, playback, scope) {'
const from = installed.indexOf(marker)
const original = installed.slice(from, installed.indexOf('\n}\n', from) + 2)
const claimStart = installed.indexOf('\tclaimAutomaticPlayback(sessionId, messageId) {')
const claimEnd = installed.indexOf('\n\tupdateLivePlayback(', claimStart)
const claim = vm.runInNewContext('({' + installed.slice(claimStart, claimEnd) + '})').claimAutomaticPlayback
const remoteStart = installed.indexOf('\tasync playRemote(sessionId, messageId, text, automatic, fallback) {')
const remoteEnd = installed.indexOf('\n\tcancelPlayback(', remoteStart)
const remote = vm.runInNewContext('({' + installed.slice(remoteStart, remoteEnd) + '})', {splitTtsSegments:text=>[text]}).playRemote
const spokenStart = installed.indexOf('function extractTtsSpokenOverride(value) {')
const spokenEnd = installed.indexOf('\nfunction applyTtsPlaybackScope(', spokenStart)
const spoken = vm.runInNewContext('(' + installed.slice(spokenStart, spokenEnd) + ')')
const address = String.fromCodePoint(0x8001, 0x5927)
assert.equal(spoken(`<!--tts:${address}, hello-->visible card`), `${address}, hello`)
console.log('PASS installed spoken marker preserves address prefix')
const useInstalled = process.argv.includes('--installed')
const versions = useInstalled ? [['installed', original]] : [
  ['3.0.9 intent', buildEdits({client:'lib/client.js',text:'lib/text.js'}).find(e => e.id === 'cross-session-watcher').replace],
  ['3.0.8 intent', edits308.find(e => e.id === 'cross-session-watcher').replace],
]
function harness(source, initialMain = false) {
  source += '\n'
  let running = true, messageId = 'm1', text = 'hello', listCb, sessionCb, playbackCb
  const timers = [], calls = []
  const entry = {id:'s', running:true, retainedBy:{mainView:initialMain ? 1 : 0}}
  const chat = {getSnapshot:()=>({legacy:{nodes:[{kind:'assistant',messageId,text}]}}),subscribe:()=>()=>{}}
  const binding = {session:{getSnapshot:()=>({running}),subscribe:cb=>(sessionCb=cb,()=>{})}}
  const ctx = {sessions:{
    list:{getSnapshot:()=>({byId:{s:entry}}),subscribe:cb=>(listCb=cb,()=>{})},
    retain:()=>({ready:Promise.resolve(),release(){}}),binding:()=>binding,
  },uiConversation:{binding:()=>({target:()=>chat})}}
  let busy = false
  const playback = {
    activeSessionId:'s', automaticallyPlayed:new Set(), completedMessages:new Map(), completedSessions:new Set(), attachedMidRun:new Set(),
    subscribe:cb=>(playbackCb=cb,()=>{}),isPlayingNow:()=>busy,
    playRemote:remote,
    toggle:async(s,m,t)=>{calls.push([s,m,t]);busy=true},
    claimAutomaticPlayback:claim,
  }
  const scope = {getSnapshot:()=>({value:{enabled:true,autoPlay:true,readScope:'first-segment'}})}
  const context = {resolveTtsSettings:x=>x, applyTtsPlaybackScope:x=>x,isMemoryReflectTurn:()=>false,
    messageText:(legacy,id)=>legacy.nodes.find(n=>n.messageId===id).text,
    window:{setTimeout:cb=>timers.push(cb)},Map,Set}
  vm.createContext(context)
  vm.runInContext(source.slice(source.indexOf(marker), source.indexOf('\n}\n', source.indexOf(marker))+2),context)
  const dispose = context.installCrossSessionAutoPlay(ctx,playback,scope)
  return {
    calls,playback,dispose,
    foreground(){entry.retainedBy.mainView=1;listCb()},
    background(){entry.retainedBy.mainView=0;listCb()},
    finish(){running=false;entry.running=false;sessionCb()},
    main(){playback.completedMessages.set('s',messageId);if(playback.claimAutomaticPlayback('s',messageId)){calls.push(['s',messageId,text]);busy=true}},
    flush(){while(timers.length)timers.shift()()},
    idle(){busy=false;playbackCb()},
    next(){running=true;entry.running=true;messageId='m2';text='next';listCb()},
    manual(){return playback.playRemote('s',messageId,text,false)},
  }
}
const settle = async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve()}
let failed = 0
for(const [version,source] of versions) {
  for(const order of ['background-to-main/main-first','background-to-main/remote-first','main-to-background']) {
    const h=harness(source, order==='main-to-background');await settle()
    h.foreground()
    if(order.endsWith('main-first') || order==='main-to-background')h.main()
    if(order==='main-to-background'){h.background();await settle()}
    h.finish();h.flush();await settle()
    if(order.endsWith('remote-first'))h.main()
    h.idle();await settle();h.idle();await settle()
    try {assert.equal(h.calls.length,1);console.log('PASS',version,order)}
    catch {failed++;console.log('FAIL',version,order,'calls=',h.calls.length)}
    h.dispose()
  }
  const late=harness(source);await settle();late.finish();late.flush();await settle();late.idle();await settle();late.foreground();late.main()
  try{assert.equal(late.calls.length,1);console.log('PASS',version,'completed background then late main')}
  catch{failed++;console.log('FAIL',version,'completed background then late main','calls=',late.calls.length)}
  late.dispose()
  const h=harness(source);await settle();h.finish();h.flush();await settle();h.idle();await settle()
  h.next();await settle();h.finish();h.flush();await settle();h.idle();await settle()
  try{assert.equal(h.calls.length,2);assert.deepEqual(h.calls.map(c=>c[1]),['m1','m2']);console.log('PASS',version,'consecutive turns')}
  catch{failed++;console.log('FAIL',version,'consecutive turns',h.calls)}
  h.manual();h.manual()
  try{assert.equal(h.calls.length,4);console.log('PASS',version,'manual repeat remains allowed')}
  catch{failed++;console.log('FAIL',version,'manual repeat')}
  h.dispose()
}
console.log(failed ? `${failed} regressions reproduced` : 'All silent behavior checks passed; no real audio/network/DOM used.')
process.exitCode=failed?1:0
