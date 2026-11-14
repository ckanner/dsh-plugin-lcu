/** Offline MCP peer. Runs the real generated CUA bridge program, not GUI APIs. */
import { createInterface } from 'node:readline'
import { readFileSync, appendFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..')
const config = JSON.parse(readFileSync(resolve(root, 'fixture.json'), 'utf8'))
const send = value => process.stdout.write(`${JSON.stringify({jsonrpc:'2.0',...value})}\n`)
const note = value => appendFileSync(config.trace, JSON.stringify(value)+'\n')
const active = new Map()
const questions = new Map()
let questionId = 10000
let currentSignal, metadata
const image = {type:'image',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',mimeType:'image/png'}
let images = []
let failure = config.cleanupFailure
const pause = (ms,signal) => new Promise((resolve,reject)=>{
  const timer=setTimeout(resolve,ms)
  if (signal?.aborted) {clearTimeout(timer);reject(new Error('interrupted'));return}
  signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('interrupted'))},{once:true})
})
globalThis.cua = {
  async getState(){ return {ready:true} },
  async requestApproval(params){const id=++questionId;const answer=new Promise(resolve=>questions.set(id,resolve));send({id,method:'elicitation/create',params});return await answer},
  async getApp(name){
    images = Array.from({length:config.images??1},()=>image)
    return {name,id:'app-1',async activate(){note({event:'activate',metadata});return {active:true}}}
  },
  async action(label){ note({event:'start',label,metadata});await pause(30,currentSignal);note({event:'end',label});return {label} },
  async wait(){note({event:'waiting',metadata});await pause(60000,currentSignal);return {done:true}},
  async repairCleanup(){failure=false;return {ok:true}},
  async rewriteDocumentation(){return 'fixture manual'},
}
const lines=createInterface({input:process.stdin})
lines.on('line',async line=>{
  const request=JSON.parse(line)
  if(request.method===undefined && questions.has(request.id)){questions.get(request.id)(request.result);questions.delete(request.id);return}
  if(request.method==='notifications/cancelled'){
    note({event:'cancel',id:request.params.requestId})
    active.get(request.params.requestId)?.abort()
    if(config.lateApproval){
      const id=++questionId
      questions.set(id,answer=>note({event:'late-approval',action:answer?.action}))
      send({id,method:'elicitation/create',params:{_meta:{tool_name:'access_browser_origin',origin:'https://allowed.example'}}})
    }
    return
  }
  if(request.id===undefined) return
  try {
    if(request.method==='initialize'){send({id:request.id,result:{serverInfo:{name:'fixture-mcp',version:'1'},instructions:'offline protocol fixture'}});return}
    if(request.method==='tools/list'){send({id:request.id,result:{tools:['js','js_reset','turn_ended'].map(name=>({name,description:name,inputSchema:{type:'object'}}))}});return}
    const {name,arguments:args}=request.params
    if(name==='turn_ended'){
      note({event:'cleanup',session:args.session_id,turn:args.turn_id})
      send({id:request.id,result:{content:failure?[{type:'text',text:'fixture cleanup is unknown'}]:[],isError:!!failure}});return
    }
    if(name==='js_reset'){delete globalThis.__dshLcu;send({id:request.id,result:{content:[],isError:false}});return}
    const controller=new AbortController();active.set(request.id,controller);currentSignal=controller.signal
    metadata=request.params._meta;images=[]
    const captured=[]
    const previous=console.log;console.log=(...args)=>captured.push(args.join(' '))
    try{
      await new (Object.getPrototypeOf(async function(){}).constructor)(args.code)()
      send({id:request.id,result:{content:[...captured.map(text=>({type:'text',text})),...images],isError:false}})
    } finally {console.log=previous;active.delete(request.id)}
  }catch(error){send({id:request.id,result:{content:[{type:'text',text:String(error)}],isError:true}})}
})
lines.on('close',()=>process.exit(0))
