import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import WorkerWorkload from '../src/workloads/workerWorkload.js'
import {failureKind,workloadEvidence} from '../src/workloads/workloadContract.js'
import AutonomousCore from '../src/core/autonomousCore.js'
import DatabaseStore from '../src/data/databaseStore.js'
import EventBus from '../src/eventBus/eventBusMain.js'
import AnalystTask from '../src/minecraftBot/taskRunner/modes/analystTask.js'
import ResellerTask from './helpers/legacyConfiguredReseller.js'
import BotTaskRunner from '../src/minecraftBot/taskRunner/botTaskRunner.js'
import GracefulStop from '../src/minecraftBot/worker/gracefulStop.js'
import {fixtureObservation} from './helpers/fixtureObservation.js'

const logger={child(){return this},withContext(){return this},info(){},warn(){},error(){},log(){}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
async function fixture(t,{count=2,limit=2}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'afina-workloads-')),store=new DatabaseStore({databasePath:path.join(dir,'afina.db')});await store.init()
 store.db.exec("INSERT INTO serverData VALUES(1,'localhost','1','test')")
 const processes=new Map(),runtimes=new Map(),sent=[],recovery=[]
 for(let id=1;id<=count;id++){
  store.prepare('INSERT INTO accountsData(accountId,username,password) VALUES(?,?,?)').run(id,'Bot'+id,'fixture-secret')
  store.prepare('INSERT INTO accountPoolState(accountId) VALUES(?)').run(id)
  store.prepare('INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(?,?,?,1,101)').run(id,'Bot'+id,id)
  store.prepare("INSERT INTO tasksData(botId,type,enabled) VALUES(?,'analyst',1)").run(id)
  const workload=new WorkerWorkload({role:'analyst',incarnation:()=> 'fixture-'+(100+id)});workload.generation=1
  processes.set(id,{workload,analysisState:'idle',sendEvent(event,task){sent.push({botId:id,event,task});return true}})
  runtimes.set(id,{running:true,desiredState:'running',runtimeStatus:'running',workerPid:100+id})
 }
 for(let id=1;id<=count*3;id++)store.prepare('INSERT INTO itemsData VALUES(?,?,?,?)').run(id,'Item'+id,'item'+id,'{}')
 const manager=fixtureObservation({hasBot:id=>processes.has(id),getBot:id=>processes.get(id),getBotRuntimeState:id=>runtimes.get(id)},store),eventBus=new EventBus({logger})
 const core=new AutonomousCore({dataBaseManager:{store},botManager:manager,eventBus,logger,configurationService:{async sync(){}},executeCommand:async()=>{throw new Error('WORKLOAD_MUST_NOT_CALL_LIFECYCLE')}})
 core.schedule=()=>{};await core.start()
 core.store.updateOperationsPolicy({automationEnabled:true,capacity:{maximum:count},roles:{analyst:{target:count,maximum:count}},controller:{maxActionsPerCycle:limit,maxCandidatesPerCycle:limit,maxPassesPerDrain:1,continuationDelayMs:60000}},core.store.operationsPolicy().revision)
 core.updatePolicy({expectedRevision:core.store.revision(),values:{autoAnalysis:true,analysisMinObservations:1,analysisMaxObservations:1,analysisRealmReadyDelayMs:0,analysisRealmReadyDelayJitterMs:0}})
 core.workloads.requestRecovery=(...args)=>{recovery.push(args);return true}
 const claim=(type='STOP',id=1)=>core.actions.ledger.reserve({type,logicalKey:'bot:'+id,botId:id,accountId:id,role:'analyst',metadata:{incarnationId:'next-incarnation'},policyRevision:core.store.operationsPolicy().revision,desiredRevision:1,inputRevision:core.store.revision(),deadlineAt:Date.now()+10000}).action
 const emit=(kind,session,payload={})=>eventBus.publish('bot.analysis.'+kind,{analysisId:session.analysisId,workloadGeneration:(typeof session.task==='string'?JSON.parse(session.task):session.task)?.workloadGeneration,...payload},{kind:'bot',botId:session.botId,workerPid:session.workerPid})
 t.after(async()=>{await core.stop();store.close();await rm(dir,{recursive:true,force:true})})
 return {core,store,manager,processes,runtimes,sent,recovery,claim,emit}
}

test('Analyst dispatch uses workload gate and sessions, never bot/account claims or lifecycle commands',async t=>{
 const f=await fixture(t);let dispatches=0;const dispatch=f.core.workloads.dispatch.bind(f.core.workloads);f.core.workloads.dispatch=(...args)=>{dispatches++;return dispatch(...args)}
 await f.core.evaluateNow();assert.equal(dispatches,2);assert.equal(f.core.marketStore.sessions().length,2);assert.equal(f.core.actions.ledger.resources().length,0)
 assert.ok(f.sent.every(s=>s.event==='core:analysis.assign'));assert.ok(f.sent.every(s=>s.task.lifecycleEpoch===0&&s.task.workloadGeneration===1))
 for(const method of ['start','stop','restart','kill','spawn','replaceAccount'])assert.equal(typeof f.core.workloads[method],'undefined')
})
for(const type of ['START','STOP','REPLACE'])test('active '+type+' claim fences workload dispatch',async t=>{
 const f=await fixture(t,{count:1});f.claim(type);const b=f.core.readActual().bots[0]
 assert.equal(f.core.workloads.eligible(b),'LIFECYCLE_OWNED');await f.core.evaluateNow();assert.equal(f.sent.filter(s=>s.event==='core:analysis.assign').length,0)
})
test('manual STOP ownership cancels work and rejects late results',async t=>{
 const f=await fixture(t,{count:1});await f.core.evaluateNow();const s=f.core.marketStore.sessions()[0];f.core.userControlsBot(1)
 f.emit('observation',s,{ordinal:1,observedAt:Date.now(),lots:[]});assert.equal(f.core.marketStore.session(s.analysisId).status,'cancelled');assert.equal(f.store.prepare('SELECT count(*) n FROM marketObservations').get().n,0)
 assert.ok(f.sent.some(v=>v.event==='core:analysis.cancel'&&v.task.incarnationId===s.task.incarnationId));assert.equal(f.core.workloads.eligible(f.core.readActual().bots[0]),'MANUAL_OWNERSHIP')
})
test('REPLACE acquired after dispatch rejects results and cancels the session',async t=>{
 const f=await fixture(t,{count:1});await f.core.evaluateNow();const s=f.core.marketStore.sessions()[0];f.claim('REPLACE')
 f.emit('observation',s,{ordinal:1,observedAt:Date.now(),lots:[]});assert.equal(f.core.marketStore.session(s.analysisId).status,'cancelled');assert.equal(f.store.prepare('SELECT count(*) n FROM marketObservations').get().n,0)
})
test('Analyst acceptance and completion are evidence, not IPC send success',async t=>{
 const f=await fixture(t,{count:1});await f.core.evaluateNow();const s=f.core.marketStore.sessions()[0]
 assert.equal(s.status,'planned');f.emit('status',s,{state:'busy'});assert.equal(f.core.marketStore.session(s.analysisId).status,'running')
 f.emit('observation',s,{ordinal:1,observedAt:Date.now(),lots:[]});f.emit('completed',s)
 assert.equal(f.core.marketStore.session(s.analysisId).status,'completed');assert.equal(f.store.prepare('SELECT count(*) n FROM marketObservations').get().n,1)
})
for(const code of ['WINDOW_TIMEOUT','INVALID_ANALYSIS_TASK','AFK_INTERRUPTED'])test(code+' is a workload/role failure, not a restart',async t=>{
 const f=await fixture(t,{count:1});await f.core.evaluateNow();const s=f.core.marketStore.sessions()[0];f.emit('failed',s,{code})
 assert.equal(f.core.marketStore.sessions().length,0);assert.equal(f.recovery.length,0);assert.equal(f.core.actions.ledger.active().length,0);assert.equal(f.runtimes.get(1).running,true)
})
test('runtime recovery requires current incarnation and observed failure evidence',async t=>{
 const f=await fixture(t,{count:1}),inc='fixture-101';assert.equal(f.core.workloads.runtimeFailure(1,inc),false)
 f.runtimes.get(1).running=false
 assert.equal(f.core.workloads.runtimeFailure(1,'old'),false);assert.equal(f.core.workloads.runtimeFailure(1,inc),true);assert.deepEqual(f.recovery,[[1,'worker_crash',inc]])
})
test('unhealthy fresh worker may request recovery but stale health cannot',async t=>{
 const f=await fixture(t,{count:1}),observe=f.manager.getWorkerObservation
 f.manager.getWorkerObservation=id=>{const w=observe(id);w.facts.health.alive=false;return w}
 assert.equal(f.core.workloads.runtimeFailure(1,'fixture-101'),true);assert.deepEqual(f.recovery,[[1,'fatal_error','fixture-101']])
 f.manager.getWorkerObservation=id=>{const w=observe(id);w.quality='STALE';w.facts.health.alive=false;return w}
 assert.equal(f.core.workloads.runtimeFailure(1,'fixture-101'),false);assert.equal(f.recovery.length,1)
})

test('pending lifecycle intent fences new work before a claim is reserved',async t=>{
 const f=await fixture(t,{count:1}),b=f.core.readActual().bots[0]
 for(const lifecycle of [{intent:'stopped'},{owner:'manual'},{intent:'running',requestReason:'configuration'}])assert.ok(f.core.workloads.eligible({...b,lifecycle}))
 f.core.workloads.requireEvidence=true
 assert.equal(f.core.workloads.eligible({...b,workload:null}),'WORKLOAD_BOUNDARY_UNAVAILABLE')
})

test('workload admission yields through the existing cycle checkpoint and rechecks ownership',async t=>{
 const f=await fixture(t,{count:1}),begin=f.core.scheduler.begin.bind(f.core.scheduler);let checkpoints=0
 f.core.scheduler.begin=(...args)=>{const c=begin(...args),checkpoint=c.checkpoint;c.checkpoint=async stage=>{if(stage==='SETTLE_WAIT'&&++checkpoints===2){await tick();f.core.userControlsBot(1)}return checkpoint(stage)};return c}
 await f.core.evaluateNow();assert.ok(checkpoints>=2);assert.equal(f.sent.filter(s=>s.event==='core:analysis.assign').length,0)
})
test('stale incarnation and stale workload id cannot alter a new session',async t=>{
 const f=await fixture(t,{count:1});await f.core.evaluateNow();const s=f.core.marketStore.sessions()[0]
 f.runtimes.get(1).workerPid=999;f.emit('completed',s);assert.equal(f.core.marketStore.session(s.analysisId).status,'planned')
 f.runtimes.get(1).workerPid=101;f.emit('failed',{...s,analysisId:'old'},{code:'WINDOW_TIMEOUT'});assert.equal(f.core.marketStore.session(s.analysisId).status,'planned')
})
test('startup cancels interrupted sessions without replay and retains schema v11',async t=>{
 const f=await fixture(t,{count:1});await f.core.evaluateNow();const s=f.core.marketStore.sessions()[0],sends=f.sent.filter(v=>v.event==='core:analysis.assign').length
 f.core.analysis.restore();assert.equal(f.core.marketStore.session(s.analysisId).status,'cancelled');assert.equal(f.sent.filter(v=>v.event==='core:analysis.assign').length,sends)
 assert.equal(f.store.prepare('PRAGMA user_version').get().user_version,16)
})
test('stale generation callbacks do not accept, fail or complete current work',async t=>{
 const f=await fixture(t,{count:1});await f.core.evaluateNow();const s=f.core.marketStore.sessions()[0]
 for(const kind of ['status','observation','failed','completed'])f.emit(kind,s,{state:'busy',workloadGeneration:0,ordinal:1,observedAt:Date.now(),lots:[],code:'WINDOW_TIMEOUT'})
 assert.equal(f.core.marketStore.session(s.analysisId).status,'planned');assert.equal(f.store.prepare('SELECT count(*) n FROM marketObservations').get().n,0)
 f.processes.get(1).workload.generation=2;f.emit('failed',s,{code:'WINDOW_TIMEOUT'})
 assert.equal(f.core.marketStore.session(s.analysisId).failureCode,'ANALYSIS_CANCELLED');assert.equal(f.recovery.length,0)
})

test('dispatch rechecks role generation and lifecycle epoch before sending',async t=>{
 const f=await fixture(t,{count:1});await f.core.evaluateNow();const s=f.core.marketStore.sessions()[0],task=s.task,before=f.sent.length
 f.processes.get(1).workload.generation=2;assert.equal(f.core.workloads.dispatch(1,task).reason,'STALE_WORKLOAD_OWNER')
 f.processes.get(1).workload.generation=1;f.core.workloads.epoch=()=>1;assert.equal(f.core.workloads.dispatch(1,task).reason,'STALE_WORKLOAD_OWNER')
 f.emit('failed',s,{code:'WINDOW_TIMEOUT'});assert.equal(f.core.marketStore.session(s.analysisId).failureCode,'ANALYSIS_CANCELLED');assert.equal(f.sent.length,before+1)
})

test('permanent blocked diagnostics and operational demand cannot starve an independent workload',async t=>{
 const f=await fixture(t,{count:2,limit:1});let operations=0
 // Exercise the real scheduler with a repeatable, failing operational candidate.
 f.core.reconciler.plan=({admission})=>admission.botIds.has(1)?[{action:'recover_bot',target:{botId:1},after:{type:'analyst'},result:'planned',reasons:[]}]:[{action:'assign',target:{botId:99},after:{type:'reseller'},result:'blocked',reasons:[]}]
 f.core.actions.reserve=()=>{operations++;throw new Error('TEST_TRANSIENT_FAILURE')}
 for(let n=0;n<6;n++)await f.core.evaluateNow()
 assert.ok(operations>0);assert.ok(f.sent.some(s=>s.botId===2&&s.event==='core:analysis.assign'))
 assert.ok(f.core.lastCycle.candidatesConsidered<=1);assert.ok(f.core.lastCycle.dispatched+f.core.lastCycle.workloadDispatched<=1)
})
test('action/candidate allowance and fair workload bot age cover four independent bots',async t=>{
 const f=await fixture(t,{count:4,limit:1}),turns=[]
 for(let n=0;n<4;n++){await f.core.evaluateNow();turns.push(f.core.lastCycle);for(const s of f.core.marketStore.sessions())f.core.analysis.finish(s,'completed','ANALYSIS_COMPLETED')}
 assert.deepEqual(new Set(f.sent.filter(v=>v.event==='core:analysis.assign').map(v=>v.botId)),new Set([1,2,3,4]))
 assert.ok(turns.every(c=>c.dispatched+c.workloadDispatched<=1&&c.candidatesConsidered<=1))
})
test('one evaluator coalesces a workload trigger burst without duplicate sessions',async t=>{
 const f=await fixture(t,{count:4,limit:2});let inFlight=0,max=0;const original=f.core.runCycle.bind(f.core)
 f.core.runCycle=async(...args)=>{inFlight++;max=Math.max(max,inFlight);try{return await original(...args)}finally{inFlight--}}
 await Promise.all(Array.from({length:50},()=>f.core.evaluateNow({type:'WORKLOAD_BURST'})))
 assert.equal(max,1);assert.equal(new Set(f.core.marketStore.sessions().map(s=>s.botId)).size,f.core.marketStore.sessions().length);assert.ok(f.sent.filter(v=>v.event==='core:analysis.assign').length<=2)
})
test('Core and worker reject autonomous Reseller work',async t=>{
 const f=await fixture(t,{count:1});assert.equal(f.core.workloads.dispatch(1,{analysisId:'trade'},'reseller').reason,'UNSUPPORTED_WORKLOAD_TYPE')
 const worker=new WorkerWorkload({role:'reseller'});assert.equal(worker.begin({workloadId:'trade',type:'buy'}),'ECONOMIC_ADMISSION_REQUIRED');assert.equal(f.sent.length,0)
})
test('new session diagnostics never inherit an old workload completion',async t=>{
 const f=await fixture(t,{count:1}),w=f.processes.get(1).workload;w.begin({workloadId:'old',type:'analysis',incarnationId:'fixture-101',generation:1});w.finish('old')
 await f.core.evaluateNow();const row=f.core.snapshot().workloads[0];assert.equal(row.state,'STARTING');assert.notEqual(row.workloadId,'old');assert.equal(row.safe,false)
})

function analyst(){
 const events=new EventEmitter(),client=new EventEmitter(),window=new EventEmitter(),messages=[]
 Object.assign(window,{id:1,type:'minecraft:generic_9x6',title:'Аукцион: Поиск',slots:Array(90).fill(null)})
 client.chat=text=>{messages.push(text);client.currentWindow=window;client.emit('windowOpen',window)};client.closeWindow=()=>{client.currentWindow=null}
 const bot={botId:1,incarnationId:'inc',positionStatus:'realm',client},task=new AnalystTask({bot,eventBus:events,logger})
 const request={analysisId:'job',incarnationId:'inc',itemId:1,query:'apple',matcher:{},observationCount:1,timing:{minimumRefreshIntervalMs:5000,refreshJitterMs:0,windowTimeoutMs:1000}}
 return {bot,task,request,events,messages}
}
test('actual Analyst adapter runs read-only execution and exposes completed work',async()=>{
 const f=analyst(),role=f.task.start();await f.task.assign(f.request)
 assert.equal(f.task.workload.read().state,'COMPLETED');assert.deepEqual(f.messages,['/ah search apple']);f.task.stop();await role
})
test('actual Analyst adapter reports invalid work without terminating the role',async()=>{
 const f=analyst(),role=f.task.start();await f.task.assign({...f.request,query:''})
 assert.equal(f.task.workload.read().state,'FAILED');assert.equal(f.task.workload.read().failureKind,'WORKLOAD_FAILURE');assert.equal(f.task.stopped,false);assert.equal(f.messages.length,0);f.task.stop();await role
})
test('Analyst drain waits for cleanup and yields a safe checkpoint',async()=>{
 const f=analyst(),gate=deferred();f.bot.realmReadyGate={ready:()=>gate.promise};const role=f.task.start(),job=f.task.assign(f.request)
 const drain=f.task.workload.drain({actionId:'stop'});await tick();assert.equal(f.task.workload.read().state,'DRAINING');assert.equal(f.task.workload.read().safe,false)
 gate.resolve();await job;const result=await drain;await role;assert.equal(result.safe,true);assert.equal(result.state,'CANCELLED');assert.equal(f.messages.length,0)
})
test('worker rejects a stale incarnation and stale role generation before execution',async()=>{
 const f=analyst(),role=f.task.start();f.task.workload.generation=2
 await f.task.assign({...f.request,incarnationId:'old',workloadGeneration:2});await f.task.assign({...f.request,workloadGeneration:1});assert.equal(f.messages.length,0)
 f.task.stop();await role
})
test('role replacement retains deduplication and exposes a new generation',async()=>{
 const f=analyst(),runner=new BotTaskRunner({bot:f.bot,eventBus:f.events,logger}),role=runner.start({type:'analyst',enabled:1})
 const generation=runner.workload.generation;await runner.activeTask.assign({...f.request,workloadGeneration:generation});runner.stop();await role
 const next=runner.start({type:'analyst',enabled:1});assert.notEqual(runner.workload.generation,generation)
 await runner.activeTask.assign({...f.request,workloadGeneration:runner.workload.generation});assert.equal(f.messages.length,1);runner.stop();await next
})
test('Reseller idle adapter drains without trading',async()=>{
 const bot={botId:1,incarnationId:'r',positionStatus:'lobby'},task=new ResellerTask({bot,taskData:{},logger,eventBus:new EventEmitter(),settings:{get:()=>1}})
 const role=task.start(),evidence=await task.workload.drain({actionId:'stop'});await role;assert.equal(evidence.safe,true);assert.equal(task.cycleRunning,false)
})
test('Reseller active inventory boundary drains after operation finishes',async()=>{
 const gate=deferred(),bot={botId:1,incarnationId:'r',positionStatus:'realm',client:{}},task=new ResellerTask({bot,taskData:{},logger,eventBus:new EventEmitter(),settings:{get:()=>0}})
 task.inventory.cleanup=()=>gate.promise
 const role=task.start();await tick();assert.equal(task.cycleRunning,true)
 const drain=task.workload.drain({actionId:'stop'});await tick();assert.equal(task.workload.read().state,'DRAINING');assert.equal(task.workload.read().safe,false)
 gate.resolve();const evidence=await drain;await role;assert.equal(evidence.safe,true);assert.equal(task.running,false)
})
for(const reason of ['PURCHASE_RESULT_UNCERTAIN','SELL_RESULT_UNCERTAIN','RELIST_RESULT_UNCERTAIN'])test('uncertain Reseller stop is refused: '+reason,async()=>{
 const bot={botId:1,incarnationId:'r',lifecycleUncertain:reason},runner=new BotTaskRunner({bot,logger,eventBus:new EventEmitter()}),messages=[];bot.taskRunner=runner
 const protocol=new GracefulStop({bot,incarnationId:'r',send:m=>messages.push(m)});await protocol.request({actionId:'stop',incarnationId:'r'})
 assert.equal(messages.at(-1).state,'unsafe');assert.equal(messages.at(-1).safe,false);assert.equal(runner.workload.read().state,'UNCERTAIN')
})
test('common drain acknowledgement is not process absence or a process command',async()=>{
 let drains=0;const worker=new WorkerWorkload({role:'analyst',requestDrain:()=>{drains++}}),messages=[]
 const stop=new GracefulStop({bot:{taskRunner:{quiesce:context=>worker.drain(context)}},incarnationId:'i',send:m=>messages.push(m)})
 await stop.request({actionId:'a',incarnationId:'i'});await stop.request({actionId:'a',incarnationId:'i'});assert.equal(drains,1);assert.equal(messages.at(-1).safe,true)
 assert.ok(messages.every(m=>m.type==='lifecycle:quiescence'));for(const method of ['kill','restart','spawn','reconnect'])assert.equal(worker[method],undefined)
})
test('workload facts are allowlisted, bounded and classify failures without restarting',()=>{
 const value=workloadEvidence({state:'UNCERTAIN',reason:'x'.repeat(1000),password:'secret',safe:false});assert.equal(value.reason.length,128);assert.equal('password' in value,false)
 assert.equal(failureKind('WINDOW_TIMEOUT'),'WORKLOAD_FAILURE');assert.equal(failureKind('AFK_INTERRUPTED'),'ROLE_FAILURE');assert.equal(failureKind('WORKER_RUNTIME_FAILED'),'RUNTIME_FAILURE');assert.equal(failureKind('DISCONNECTED'),'TRANSPORT_FAILURE');assert.equal(failureKind('SELL_RESULT_UNCERTAIN'),'UNCERTAIN_RESULT')
})
test('targeted workload source audit contains no lifecycle executor calls',async()=>{
 for(const file of ['src/core/workloadCoordinator.js','src/workloads/workerWorkload.js','src/core/market/analysisCoordinator.js']){
  const source=await readFile(file,'utf8');assert.doesNotMatch(source,/\.(?:startBot|stopBot|restartBot|kill|fork|assignAvailableAccount)\s*\(/)
 }
})
