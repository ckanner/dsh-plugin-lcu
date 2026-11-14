/** Real public attachment + generated bridge + subprocess JSON-RPC tests; no GUI/model account. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { attachManagedLcu, installManagedLcu, ManagedLcuError, type ManagedLcuEvent, type ManagedLcuHandle, type ManagedLcuOptions } from '../src/managed.ts'
import { connectCua } from '../src/bridge.ts'
import { CUA_TOOL_NAME } from '../src/ptc.ts'
import { apply } from '../src/index.ts'

function fixture(t, opts: {images?:number;cleanupFailure?:boolean;trace?:string;lateApproval?:boolean}={}) {
  const dir=mkdtempSync(join(tmpdir(),'lcu-managed-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const app=join(dir,'Fixture.app'), runtime=join(app,'Contents/Resources/cua_node')
  const launcher=join(runtime,'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')
  mkdirSync(dirname(launcher),{recursive:true});copyFileSync(new URL('./fixtures/managed-runtime.mjs',import.meta.url),launcher)
  mkdirSync(join(runtime,'bin'),{recursive:true});writeFileSync(join(runtime,'bin/node'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\"'\"'")}' \"$@\"\n`, {mode:0o700})
  mkdirSync(join(runtime,'lib/node_modules/@oai/sky/Codex Computer Use.app'),{recursive:true})
  mkdirSync(join(app,'Contents/Resources/codex-cli/bin'),{recursive:true});writeFileSync(join(app,'Contents/Resources/codex-cli/bin/codex'),'fixture',{mode:0o700})
  writeFileSync(join(runtime,'manifest.json'),'{}')
  writeFileSync(join(app,'Contents/Info.plist'),'<key>CFBundleShortVersionString</key><string>fixture</string>')
  const trace=opts.trace??join(dir,'trace.jsonl');writeFileSync(trace,'')
  writeFileSync(join(app,'Contents/Resources','fixture.json'),JSON.stringify({...opts,trace}))
  return {app,trace,runtime,rows:()=>readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))}
}

function harness(id='agent-1', existing: string[] = [], questions=true) {
  const tools=new Map<string,ToolDefinition>(),listeners=new Map<string,Set<Function>>(),effects:Function[]=[]
  for(const name of existing)tools.set(name,{name} as ToolDefinition)
  let agent:Agent
  let live=true
  const ctx={
    tools:{register(tool){if(tools.has(tool.name))throw new Error('duplicate tool');tools.set(tool.name,tool);return()=>tools.delete(tool.name)},schemas:()=>[...tools.values()]},
    systemPrompt:{section:()=>()=>{}},
    logger:{debug(){},info(){},warn(){},error(){}},
    get(name){
      if(name==='agents')return {get:key=>live&&key===id?agent:undefined}
      if(name==='llm')return {resolveModelInfo:async()=>({inputModalities:['text','image']})}
      if(name==='attachments')return {saveImages:async images=>images.map((image,i)=>({attachmentId:`image-${i}`,mediaType:image.mediaType,bytes:image.data.length,width:1,height:1})),imageHostPath:ref=>`/trusted/attachments/${ref.attachmentId}`}
      if(name==='userQuestions'&&questions)return {ask:async()=>({answers:[{id:'choice',selected:['Decline']}]})}
      return undefined
    },
    on(name,fn){const set=listeners.get(name)??new Set();set.add(fn);listeners.set(name,set);return()=>set.delete(fn)},
    effect(fn){const cleanup=fn();effects.push(cleanup);return()=>{}},
  } as unknown as Context
  agent={id,ctx,options:{provider:'fixture',model:'vision'},session:{header:{},requestHeader:()=>undefined}} as unknown as Agent
  let call=0
  async function execute(args, signal=new AbortController().signal) {
    const tool=tools.get(CUA_TOOL_NAME);assert.ok(tool)
    const exec={agent,callId:`call-${++call}`,name:CUA_TOOL_NAME,arguments:args,signal} as ToolRunContext
    const value=await tool.execute(args,exec)
    const content=tool.projectContent?.(exec,{value,content:tool.output.render(args,value as never)})??tool.output.render(args,value as never)
    return {value,content}
  }
  return {ctx,agent,tools,execute,unregister:()=>{live=false},
    dispose:async()=>{await Promise.allSettled(effects.map(cleanup=>cleanup()))},
    emit:async(name,...args)=>{for(const fn of listeners.get(name)??[])await fn(...args,async()=>({continued:true}))}}
}

function options(h, app, resource: string, overrides: Partial<ManagedLcuOptions>={}) {
  const events:ManagedLcuEvent[]=[], admissions:unknown[]=[]
  const opts:ManagedLcuOptions={agent:h.agent,config:{app},identity:{runId:'run',invocationId:'invocation',rootSessionId:'root',candidateId:'sha-1'},lease:{leaseId:'lease',resourceId:resource,leaseEpoch:'lease-1',ownerInvocationId:'invocation'},verifyLease:async request=>{admissions.push(request)},onEvent:async event=>{events.push(event)},...overrides}
  return {opts,events,admissions}
}

async function attached(t,h,opts) {
  const handle=await attachManagedLcu(h.ctx,opts)
  t.after(async()=>{await handle.close()})
  await handle.beginTurn('turn-1')
  return handle
}

test('public SDK attachment runs generated RPC and preserves handles with multiple projected images',async t=>{
  const f=fixture(t,{images:2}),h=harness(),o=options(h,f.app,f.app)
  const handle=await attached(t,h,o.opts)
  assert.equal(h.agent.session.header.agentPreset,undefined)
  assert.deepEqual([...h.tools.keys()],['lcu_cua'])
  let content
  const cua=connectCua(async args=>{const result=await h.execute(args);content=result.content;return result.value})
  const app=await cua.getApp!('Finder') as any
  assert.equal(app.name,'Finder');assert.equal(typeof app.activate,'function')
  assert.equal(content.filter(block=>block.type==='image').length,2)
  assert.deepEqual(await app.activate(),{active:true})
  assert.ok(o.events.some(event=>event.type==='media'&&event.facts.preparedImages===2))
  const media=o.events.find(event=>event.type==='media')!
  assert.equal(media.facts.imageDeliveredToModel,'unverified')
  assert.equal(media.facts.evidenceAttachedToRun,false)
  const before=handle.snapshot().runtimeEpoch
  await cua.reset!()
  assert.notEqual(handle.snapshot().runtimeEpoch,before)
  await assert.rejects(()=>app.activate(),/STALE_HANDLE/)
  const receipt=await handle.close()
  assert.equal(receipt.cleanup,'confirmed');assert.equal(receipt.runtimeExitConfirmed,true)
  assert.ok(f.rows().some(row=>row.event==='activate'&&row.metadata['x-codex-turn-metadata'].session_id==='agent-1'))
})

for (const images of [0, 1]) test(`canonical handles stay callable with ${images} projected image`,async t=>{
  const f=fixture(t,{images}),h=harness(),o=options(h,f.app,f.app)
  const handle=await attached(t,h,o.opts)
  const result=await h.execute({method:'getApp',args:['Finder']})
  assert.equal(result.content.filter(block=>block.type==='image').length,images)
  const cua=connectCua(async args=>(await h.execute(args)).value)
  const app=await cua.getApp!('Finder') as any
  assert.deepEqual(await app.activate(),{active:true})
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('same-resource Agents serialize complete calls even with the same admitted lease',async t=>{
  const f=fixture(t,{images:0}),h1=harness('root'),h2=harness('child'),o1=options(h1,f.app,f.app),o2=options(h2,f.app,f.app)
  const a=await attached(t,h1,o1.opts),b=await attached(t,h2,o2.opts)
  await Promise.all([h1.execute({method:'action',args:['root']}),h2.execute({method:'action',args:['child']})])
  const rows=f.rows().filter(row=>row.event==='start'||row.event==='end')
  assert.deepEqual(rows.map(row=>row.event),['start','end','start','end'])
  assert.equal((await a.close()).cleanup,'confirmed');assert.equal((await b.close()).cleanup,'confirmed')
})

test('turn interruption cancels the wire request and waits for a cleanup acknowledgement',async t=>{
  const f=fixture(t,{images:0}),h=harness(),o=options(h,f.app,f.app)
  let started!:()=>void;const waiting=new Promise<void>(resolve=>{started=resolve})
  const original=o.opts.onEvent
  const handle=await attached(t,h,{...o.opts,onEvent:async e=>{await original(e);if(e.type==='call.started')started()}})
  const call=h.execute({method:'wait'})
  const outcome=assert.rejects(call,/aborted|canceled|interrupted/)
  await waiting
  // The generated native program is now admitted; synchronize on its real trace.
  const deadline=Date.now()+5000
  while(!f.rows().some(row=>row.event==='waiting')){assert.ok(Date.now()<deadline,'fixture must admit the real call');await new Promise(resolve=>setTimeout(resolve,5))}
  const receipt=await handle.stopTurn('Interrupt');await outcome
  assert.equal(receipt.turnCleanupConfirmed,true)
  assert.ok(f.rows().some(row=>row.event==='cancel'))
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('a canceled tool cannot authorize a late runtime elicitation for a preapproved target',async t=>{
  const f=fixture(t,{images:0,lateApproval:true}),h=harness(),o=options(h,f.app,f.app)
  const handle=await attached(t,h,{...o.opts,config:{app:f.app,allowedOrigins:['https://allowed.example']}})
  const abort=new AbortController()
  const call=h.execute({method:'wait'},abort.signal)
  const rejection=assert.rejects(call,/aborted|canceled|interrupted/)
  const deadline=Date.now()+5000
  while(!f.rows().some(row=>row.event==='waiting')){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5))}
  abort.abort();await rejection
  while(!f.rows().some(row=>row.event==='late-approval')){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5))}
  assert.equal(f.rows().find(row=>row.event==='late-approval').action,'cancel')
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('unknown cleanup blocks siblings and remains unknown after the kernel exits',async t=>{
  const f=fixture(t,{cleanupFailure:true,images:0}),h=harness(),sibling=harness('sibling')
  const a=await attached(t,h,options(h,f.app,f.app).opts),b=await attached(t,sibling,options(sibling,f.app,f.app).opts)
  await h.execute({method:'getState'})
  assert.equal((await a.stopTurn()).cleanup,'unknown')
  await assert.rejects(()=>sibling.execute({method:'getState'}),/unconfirmed cleanup/)
  const receipt=await a.close()
  assert.equal(receipt.runtimeExitConfirmed,true);assert.equal(receipt.cleanup,'unknown');assert.equal(receipt.state,'blocked')
  assert.equal((await b.close()).cleanup,'confirmed')
})

test('stale lease, existing ungoverned tools and different live actor cannot gain GUI access',async t=>{
  const f=fixture(t),h=harness(),o=options(h,f.app,f.app,{verifyLease:async()=>{throw new Error('lease revoked')}})
  await assert.rejects(()=>attachManagedLcu(h.ctx,o.opts),error=>error instanceof ManagedLcuError&&error.receipt?.runtimeExitConfirmed===true)
  const unsafe=harness('unsafe',['cua'])
  await assert.rejects(()=>attachManagedLcu(unsafe.ctx,options(unsafe,f.app,f.app).opts),/unmanaged CUA/)
  const handle=await attached(t,h,options(h,f.app,f.app).opts)
  const tool=h.tools.get(CUA_TOOL_NAME)!
  await assert.rejects(()=>tool.execute({method:'getState'} as never,{agent:unsafe.agent,signal:new AbortController().signal,callId:'x'} as ToolRunContext),/actor/)
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('pinned runtime generation changes require new admission without transparent replacement',async t=>{
  const f=fixture(t,{images:0}),h=harness(),handle=await attached(t,h,options(h,f.app,f.app).opts)
  await h.execute({method:'getState'})
  writeFileSync(join(f.runtime,'manifest.json'),'{"runtime_archive_version":"changed"}')
  await assert.rejects(()=>h.execute({method:'getState'}),/GENERATION_CHANGED/)
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('installManagedLcu attaches through the actual created/step/stop lifecycle',async t=>{
  const f=fixture(t,{images:0}),h=harness(),o=options(h,f.app,f.app)
  const installed=installManagedLcu(h.ctx,async agent=>{assert.equal(agent,h.agent);const {agent:_,...opts}=o.opts;return opts})
  t.after(()=>installed.closeAll())
  await h.emit('agent/created',{agent:h.agent})
  assert.ok(installed.get(h.agent))
  await h.emit('agent/pre-step',{agent:h.agent,turn:1,step:1,signal:new AbortController().signal})
  await h.execute({method:'getState'})
  await h.emit('agent/turn-stopping',{agent:h.agent,turn:1,signal:new AbortController().signal})
  const receipts=await installed.closeAll();assert.equal(receipts[0]?.cleanup,'confirmed')
})

test('managed GUI approvals preserve exact allowlists and reject the agent host even with the legacy override',async t=>{
  const f=fixture(t,{images:0}),h=harness(),o=options(h,f.app,f.app)
  const handle=await attached(t,h,{...o.opts,config:{app:f.app,allowedOrigins:['https://allowed.example'],allowedApps:['com.deepseek.dsh']}})
  const origin=value=>({_meta:{tool_name:'access_browser_origin',origin:value}})
  assert.equal((await h.execute({method:'requestApproval',args:[origin('https://allowed.example')]})).value.action,'accept')
  assert.equal((await h.execute({method:'requestApproval',args:[origin('https://other.example')]})).value.action,'decline')
  const before=process.env.LCU_ALLOW_AGENT_HOST_APPROVAL
  process.env.LCU_ALLOW_AGENT_HOST_APPROVAL='1'
  try {
    const request={mode:'form',message:'Allow host?',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',tool_params:{app:'com.deepseek.dsh'}}}
    assert.equal((await h.execute({method:'requestApproval',args:[request]})).value.action,'decline')
  } finally {if(before===undefined)delete process.env.LCU_ALLOW_AGENT_HOST_APPROVAL;else process.env.LCU_ALLOW_AGENT_HOST_APPROVAL=before}
  assert.ok(o.events.filter(event=>event.type==='approval').every(event=>typeof event.facts.requestId==='number'))
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('a missing question service cancels even a preapproved target',async t=>{
  const f=fixture(t,{images:0}),h=harness('no-questions',[],false)
  const handle=await attached(t,h,{...options(h,f.app,f.app).opts,config:{app:f.app,allowedOrigins:['https://allowed.example']}})
  const result=await h.execute({method:'requestApproval',args:[{_meta:{tool_name:'access_browser_origin',origin:'https://allowed.example'}}]})
  assert.equal(result.value.action,'cancel')
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('failure to commit a call receipt prevents native dispatch and preserves a recoverable cleanup receipt',async t=>{
  const f=fixture(t,{images:0}),h=harness(),o=options(h,f.app,f.app)
  const handle=await attached(t,h,{...o.opts,onEvent:async event=>{if(event.type==='call.started')throw new Error('disk unavailable');await o.opts.onEvent(event)}})
  await assert.rejects(()=>h.execute({method:'action',args:['must-not-run']}),/receipt was not committed/)
  assert.equal(f.rows().some(row=>row.event==='start'),false)
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('an approval cannot outlive the lease while its event receipt is committed',async t=>{
  const f=fixture(t,{images:0}),h=harness(),o=options(h,f.app,f.app)
  let valid=true
  const handle=await attached(t,h,{...o.opts,config:{app:f.app,allowedOrigins:['https://allowed.example']},
    verifyLease:async()=>{if(!valid)throw new Error('lease revoked')},
    onEvent:async event=>{await o.opts.onEvent(event);if(event.type==='approval')valid=false},
  })
  const result=await h.execute({method:'requestApproval',args:[{_meta:{tool_name:'access_browser_origin',origin:'https://allowed.example'}}]})
  assert.equal(result.value.action,'cancel')
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('removing an admitted Agent during lease verification prevents its next native action',async t=>{
  const f=fixture(t,{images:0}),h=harness(),o=options(h,f.app,f.app)
  const handle=await attached(t,h,{...o.opts,verifyLease:async admission=>{if(admission.phase==='call')h.unregister()}})
  await assert.rejects(()=>h.execute({method:'action',args:['must-not-run']}),/actor changed/)
  assert.equal(f.rows().some(row=>row.event==='start'),false)
  assert.equal((await handle.close()).cleanup,'confirmed')
})

test('changing desktop presets revokes tools, interrupts active calls and waits for original turn cleanup',async t=>{
  const f=fixture(t,{images:0}),h=harness('desktop')
  t.after(()=>h.dispose())
  ;(h.agent.session.header as any).agentPreset='heavy'
  apply(h.ctx,{app:f.app,presets:['heavy']})
  await h.emit('agent/created',{agent:h.agent})
  await h.emit('agent/pre-step',{agent:h.agent,turn:1,step:1,signal:new AbortController().signal})
  assert.ok(h.tools.has(CUA_TOOL_NAME))
  const call=assert.rejects(()=>h.execute({method:'wait'}),/aborted|canceled|revoked|interrupted/)
  const deadline=Date.now()+5000
  while(!f.rows().some(row=>row.event==='waiting')){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,5))}
  await h.emit('agent-preset/selected','desktop','without-cua')
  await call
  assert.equal(h.tools.size,0)
  assert.ok(f.rows().some(row=>row.event==='cleanup'&&row.session==='desktop'))
  await h.emit('agent-preset/selected','desktop','heavy')
  assert.ok(h.tools.has(CUA_TOOL_NAME),'confirmed cleanup permits a fresh desktop attachment')
})

test('unknown desktop cleanup keeps the revoked Agent from silently reopening another runtime',async t=>{
  const f=fixture(t,{images:0,cleanupFailure:true}),h=harness('desktop-unknown')
  t.after(()=>h.dispose())
  ;(h.agent.session.header as any).agentPreset='heavy'
  apply(h.ctx,{app:f.app,presets:['heavy']})
  await h.emit('agent/created',{agent:h.agent})
  await h.emit('agent/pre-step',{agent:h.agent,turn:1,step:1,signal:new AbortController().signal})
  await h.execute({method:'getState'})
  await assert.rejects(()=>h.emit('agent-preset/selected','desktop-unknown','without-cua'),/cleanup/)
  assert.equal(h.tools.size,0)
  await h.emit('agent-preset/selected','desktop-unknown','heavy')
  assert.equal(h.tools.size,0,'unconfirmed owner cannot be replaced by a fresh connection')
})
