import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import DataBaseManager from '../src/data/dataBaseManagerMain.js'
import AutonomousCore from '../src/core/autonomousCore.js'
import CycleScheduler from '../src/core/cycleScheduler.js'
import {defaultOperationsPolicy,mergeOperationsPolicy} from '../src/core/operationsPolicy.js'
import EventBus from '../src/eventBus/eventBusMain.js'
import {fixtureObservation} from './helpers/fixtureObservation.js'

const logger={child(){return this},info(){},warn(){},error(){}}
const limits={...defaultOperationsPolicy.controller,maxActionsPerCycle:2,maxCandidatesPerCycle:4,maxPassesPerDrain:1,continuationDelayMs:50}
const action=(botId,operation='assign_analyst',result='planned')=>({action:operation,target:{botId,itemId:null},after:{type:operation==='assign'?'reseller':'analyst'},result})
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const until=async predicate=>{const end=Date.now()+5000;while(!predicate()&&Date.now()<end)await sleep(10);assert.ok(predicate(),'condition reached before deadline')}

async function fixture(t,{count=6,hung=false,controller={},start=true}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'afina-scheduling-'))
 const db=new DataBaseManager({config:{databasePath:path.join(dir,'afina.db')},logger});await db.init()
 for(let left=count;left>0;left-=100)db.createGeneratedAccounts(Math.min(left,100))
 db.store.db.exec("INSERT INTO serverData VALUES(1,'localhost','1','test')")
 db.store.transaction(()=>{for(let id=1;id<=count;id++){
  db.query('INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(?,?,?,1,101)').run(id,'bot-'+id,id)
  db.query("INSERT INTO tasksData(botId,type,enabled) VALUES(?,'analyst',1)").run(id)
 }})
 const runtime=new Map(),bots=new Map()
 for(let id=1;id<=count;id++){
  runtime.set(id,{running:false,runtimeStatus:'offline',desiredState:'stopped',supervisorStatus:'offline',workerPid:id+100})
  bots.set(id,{taskData:db.query('SELECT * FROM tasksData WHERE botId=?').get(id),isRunning:()=>runtime.get(id).running,get desiredState(){return runtime.get(id).desiredState},analysisState:'idle'})
 }
 const manager=fixtureObservation({getBot:id=>bots.get(id),getBotRuntimeState:id=>runtime.get(id),hasBot:id=>bots.has(id)},db.store)
 const eventBus=new EventBus({logger}),calls=[],cycles=[]
 eventBus.onAny(e=>{if(e.type==='core.cycle.completed')cycles.push(structuredClone(e.payload))})
 const core=new AutonomousCore({dataBaseManager:db,botManager:manager,eventBus,logger,configurationService:{async sync(){}},executeCommand:request=>{
  request.executionGuard?.();calls.push(request)
  if(hung)return new Promise(()=>{})
  Object.assign(runtime.get(request.payload.botId),{running:true,desiredState:'running',runtimeStatus:'connecting',supervisorStatus:'starting'})
  return Promise.resolve({ok:true})
 }})
 t.after(async()=>{await core.stop();db.close();await rm(dir,{recursive:true,force:true})})
 core.store.updateOperationsPolicy({automationEnabled:true,capacity:{maximum:count},roles:{analyst:{target:count,maximum:count}},controller:{...limits,...controller}},core.store.operationsPolicy().revision)
 if(start)await core.start()
 return {core,db,manager,calls,cycles,runtime,bots,eventBus}
}

test('controller settings are canonical, bounded and default old JSON without a schema bump',async t=>{
 const old=structuredClone(defaultOperationsPolicy);delete old.controller
 assert.deepEqual(mergeOperationsPolicy(old,{}).controller,defaultOperationsPolicy.controller)
 for(const patch of [null,4,[],{maxActionsPerCycle:0},{maxCandidatesPerCycle:2001},{cycleBudgetMs:49},{yieldBudgetMs:0},{continuationDelayMs:0},{maxPassesPerDrain:11},{unknown:1}])assert.throws(()=>mergeOperationsPolicy(old,{controller:patch}))
 const f=await fixture(t,{start:false});assert.equal(f.db.query('PRAGMA user_version').get().user_version,16)
 assert.equal(f.core.store.operationsPolicy().controller.maxActionsPerCycle,2)
})

test('selection is deterministic across input order and prioritizes operation, role and stable IDs',()=>{
 const values=[action(4),action(2),action(1,'stop_analyst'),action(3,'replace_account'),action(5,'assign')]
 const select=values=>new CycleScheduler().select(values,{...limits,maxActionsPerCycle:5,maxCandidatesPerCycle:5},defaultOperationsPolicy).selected.map(a=>[a.action,a.target.botId])
 assert.deepEqual(select(values),select([...values].reverse()))
 assert.deepEqual(select(values),[['stop_analyst',1],['replace_account',3],['assign_analyst',2],['assign',5],['assign_analyst',4]])
})

test('one-action cycles rotate role groups and failed candidates across rotating inventory windows',()=>{
 const scheduler=new CycleScheduler(),seen=new Set(),actual={bots:Array.from({length:32},(_,i)=>({botId:i+1})),items:[]}
 for(let i=0;i<128;i++){
  const window=scheduler.window(actual,8,[{type:i?'CORE_CONTINUATION':'TEST'}],1)
  const candidates=[...window.botIds].flatMap(id=>[action(id),action(id,'assign')])
  const selected=scheduler.select(candidates,{...limits,maxActionsPerCycle:1},defaultOperationsPolicy).selected
  for(const a of selected)seen.add(a.action+':'+a.target.botId)
 }
 assert.equal(seen.size,64,'every permanently eligible candidate gets an opportunity, even when all attempts fail')
})

test('blocked inventory receives a finite paced sweep and waits for a fresh trigger',()=>{
 const scheduler=new CycleScheduler(),actual={bots:Array.from({length:40},(_,i)=>({botId:i+1})),items:[]},visited=new Set()
 let count=0,more=true
 while(more&&count<100){const w=scheduler.window(actual,4,[{type:count?'CORE_CONTINUATION':'TEST'}],2);for(const id of w.botIds)visited.add(id);more=scheduler.continuation({reserved:0,deferred:0},w.unvisited);count++}
 assert.equal(visited.size,40);assert.ok(count<100);assert.equal(more,false)
 scheduler.window(actual,4,[{type:'SAFETY_RECONCILIATION'}],2);assert.ok(scheduler.continuation({reserved:0,deferred:1},0))
})

test('whole-cycle action and candidate limits defer demand and paced cycles finish without new input',async t=>{
 const f=await fixture(t)
 assert.equal(f.calls.length,2);assert.equal(f.cycles.length,1)
 assert.equal(f.cycles[0].continuationRequested,true)
 await until(()=>f.calls.length===6)
 assert.equal(new Set(f.calls.map(c=>c.payload.botId)).size,6)
 assert.ok(f.cycles.every(c=>c.dispatched<=2&&c.reserved<=2&&c.candidatesConsidered<=4))
 assert.equal(f.core.actions.ledger.active().length,6)
 assert.equal(f.core.snapshot().transitionAccounting.roles.analyst.uncovered,0)
 t.diagnostic('normal '+JSON.stringify(f.cycles.map(({durationMs,candidatesConsidered,selected,dispatched,deferred})=>({durationMs,candidatesConsidered,selected,dispatched,deferred}))))
})

test('trigger burst is coalesced, overflow forces observation and active evaluations never overlap',async t=>{
 const f=await fixture(t,{count:1}),core=f.core
 await until(()=>!core.running)
 let release,entered=0,active=0,maximum=0,forced=false
 const original=core.observer.refresh.bind(core.observer)
 core.observer.refresh=async options=>{entered++;maximum=Math.max(maximum,++active);forced ||= options.force;if(entered===1)await new Promise(resolve=>{release=resolve});await original(options);active--}
 const before=f.cycles.length,run=core.evaluateNow({type:'TEST'})
 for(let i=0;i<200;i++)core.schedule({type:'burst-'+i})
 assert.ok(core.triggerQueue.size<=22);assert.equal(entered,1);release();await run
 assert.equal(f.cycles.length,before+1,'one pass per drain')
 await until(()=>entered===2&&!core.running)
 assert.equal(maximum,1);assert.equal(forced,true)
 assert.equal(f.cycles.at(-1).triggerCount,200)
 t.diagnostic('burst '+JSON.stringify(f.cycles.at(-1)))
})

test('a failed pass retains triggers arriving during observation and schedules their retry',async t=>{
 const f=await fixture(t,{count:1}),core=f.core
 let release,first=true
 core.observer.refresh=async()=>{if(first){first=false;await new Promise(resolve=>{release=resolve});throw new Error('fixture observation failure')}}
 const run=core.evaluateNow({type:'FAIL'})
 core.schedule({type:'AFTER_FAILURE'});release();await run
 assert.equal(core.lastCycle.outcome,'failed');assert.ok(core.triggerQueue.has('AFTER_FAILURE'))
 await until(()=>core.lastCycle.outcome!=='failed'&&!core.running)
})

test('reservation failure does not suppress independent selected work and is diagnosed',async t=>{
 const f=await fixture(t,{start:false}),reserve=f.core.actions.reserve.bind(f.core.actions)
 f.core.actions.reserve=(plan,context)=>{if(plan.target.botId===1)throw new Error('fixture failure');return reserve(plan,context)}
 await f.core.start()
 assert.deepEqual(f.calls.map(c=>c.payload.botId),[2]);assert.equal(f.cycles[0].failures[0].code,'ACTION_RESERVATION_FAILED')
 await until(()=>f.calls.length===5)
 assert.equal(new Set(f.calls.map(c=>c.payload.botId)).size,5)
})

test('a single-slot deficit does not repeatedly hide alternatives behind a failed first candidate',async t=>{
 const f=await fixture(t,{count:3,start:false,controller:{maxActionsPerCycle:1}}),core=f.core,reserve=core.actions.reserve.bind(core.actions)
 core.store.updateOperationsPolicy({roles:{analyst:{target:1}}},core.store.operationsPolicy().revision)
 core.actions.reserve=(plan,context)=>{if(plan.target.botId===1)throw new Error('fixture failure');return reserve(plan,context)}
 await core.start();assert.equal(f.calls.length,0)
 await until(()=>f.calls.length===1)
 assert.deepEqual(f.calls.map(c=>c.payload.botId),[2])
})

test('planning component failure leaves unrelated Analyst candidates executable',async t=>{
 const f=await fixture(t,{start:false})
 f.core.replacements.plan=()=>{throw new Error('fixture planner failure')}
 await f.core.start();assert.equal(f.calls.length,2)
 assert.ok(f.cycles[0].failures.some(r=>r.code==='PLAN_COMPONENT_FAILED'&&r.component==='replacement'))
})

test('hung executor yields, keeps durable claims and permits later independent work without duplicate dispatch',async t=>{
 const f=await fixture(t,{hung:true})
 assert.ok(f.cycles[0].durationMs<2000)
 await until(()=>f.calls.length===6)
 for(let i=0;i<3;i++)await f.core.evaluateNow({type:'TEST'})
 assert.equal(f.calls.length,6);assert.equal(f.core.actions.ledger.active().length,6)
 assert.equal(new Set(f.core.actions.ledger.resources().map(r=>r.resourceKey)).size,f.core.actions.ledger.resources().length)
 t.diagnostic('hung '+JSON.stringify(f.cycles.slice(0,3).map(c=>({durationMs:c.durationMs,selected:c.selected,dispatched:c.dispatched,deferred:c.deferred}))))
})

test('time budget defers dispatch and yields to the event loop',async t=>{
 const f=await fixture(t,{count:12,start:false,hung:true,controller:{maxActionsPerCycle:12,maxCandidatesPerCycle:12,cycleBudgetMs:50,yieldBudgetMs:1}})
 let heartbeats=0;const timer=setInterval(()=>heartbeats++,1);t.after(()=>clearInterval(timer))
 await f.core.start()
 assert.equal(f.cycles[0].budgetReason,'CYCLE_TIME_BUDGET');assert.ok(f.cycles[0].dispatched<12);assert.ok(heartbeats>0)
 assert.equal(f.cycles[0].continuationRequested,true)
 await until(()=>f.calls.length===12)
})

test('replacement planning is repeatable, read-only and settlement has an explicit boundary',async t=>{
 const f=await fixture(t,{count:1,start:false}),core=f.core,now=Date.now()
 f.db.query("INSERT INTO accountReplacements(requestId,botId,bannedAccountId,replacementAccountId,state,createdAt,updatedAt) VALUES('pure',1,1,1,'initializing',?,?)").run(now,now)
 Object.assign(f.runtime.get(1),{running:true,runtimeStatus:'running',desiredState:'running',supervisorStatus:'running'})
 const actual=core.readActual(),policy=core.runtimePolicy(),desired={roles:{analyst:1,reseller:0},allocations:[]}
 let events=0;f.eventBus.onAny(()=>events++)
 const before=f.db.query('SELECT total_changes() n').get().n,input=JSON.stringify(actual)
 assert.deepEqual(core.replacements.plan({policy,desired,actual,now}),core.replacements.plan({policy,desired,actual,now}))
 assert.equal(f.db.query('SELECT total_changes() n').get().n,before);assert.equal(events,0);assert.equal(JSON.stringify(actual),input)
 core.replacements.settle({policy,actual,now})
 assert.equal(core.replacements.rows()[0].state,'completed');assert.ok(events>0)
})

test('shutdown cancels queued continuations and startup observation without installing a late safety timer',async t=>{
 const f=await fixture(t,{start:false}),core=f.core
 let release;core.observer.refresh=()=>new Promise(resolve=>{release=resolve})
 const run=core.start();core.schedule({type:'QUEUED'});const stopped=core.stop();release();await Promise.all([run,stopped])
 assert.equal(f.calls.length,0);assert.equal(core.triggerQueue.size,0);assert.equal(core.safetyTimer,undefined);assert.equal(core.lastCycle.outcome,'cancelled')
 const count=f.cycles.length;await sleep(80);assert.equal(f.cycles.length,count);await core.evaluateNow();assert.equal(f.cycles.length,count)
})

test('large synthetic backlog bounds execution admission and records actual duration',async t=>{
 const f=await fixture(t,{count:1000,start:false,controller:{maxActionsPerCycle:4,maxCandidatesPerCycle:32,continuationDelayMs:60000}})
 const start=performance.now();await f.core.start();const elapsed=performance.now()-start,c=f.cycles[0]
 assert.equal(f.calls.length,4);assert.equal(c.selected,4);assert.ok(c.candidatesConsidered<=32);assert.ok(c.deferred>0);assert.equal(c.continuationRequested,true)
 assert.ok(elapsed<10000)
 t.diagnostic('backlog '+JSON.stringify({bots:1000,startupMs:elapsed,durationMs:c.durationMs,candidatesProduced:c.candidatesProduced,candidatesConsidered:c.candidatesConsidered,selected:c.selected,dispatched:c.dispatched,deferred:c.deferred,unvisited:c.unvisited}))
})

test('manual ownership during observation invalidates the cycle and keeps the held bot unclaimed',async t=>{
 const f=await fixture(t,{count:2,start:false}),core=f.core
 let release;core.observer.refresh=()=>new Promise(resolve=>{release=resolve})
 const run=core.start();core.userControlsBot(1);release();await run
 assert.equal(core.lastCycle.outcome,'superseded');assert.equal(f.calls.length,0)
 core.observer.refresh=async()=>{};await core.evaluateNow({type:'TEST'})
 assert.deepEqual(f.calls.map(c=>c.payload.botId),[2]);assert.equal(core.actions.ledger.active().some(a=>a.botId===1),false)
})

test('a policy revision during observation replans the new target before any dispatch',async t=>{
 const f=await fixture(t,{count:2,start:false}),core=f.core
 let release;core.observer.refresh=()=>new Promise(resolve=>{release=resolve})
 const run=core.start();core.updateOperationsPolicy({expectedRevision:core.store.operationsPolicy().revision,values:{roles:{analyst:{target:0}}}});release();await run
 assert.equal(core.lastCycle.outcome,'superseded');assert.equal(f.calls.length,0)
 core.observer.refresh=async()=>{};await core.evaluateNow({type:'TEST'})
 assert.equal(core.snapshot().desiredState.roles.analyst,0);assert.equal(f.calls.length,0)
})

test('supervisor recovery stays externally owned and covers demand without another start',async t=>{
 const f=await fixture(t,{count:1,start:false})
 Object.assign(f.runtime.get(1),{desiredState:'running',supervisorStatus:'restarting',restartRequested:true})
 await f.core.start()
 assert.equal(f.calls.length,0);assert.equal(f.core.actions.ledger.active().length,0)
 assert.equal(f.core.snapshot().transitionAccounting.roles.analyst.externalTransition,1)
 assert.equal(f.runtime.get(1).restartRequested,true)
})

test('production trading and general Reseller stop remain unavailable under the scheduler',async t=>{
 const f=await fixture(t,{count:1,start:false}),core=f.core
 f.db.store.db.exec("INSERT INTO itemsData VALUES(1,'Apple','apple','{}')")
 f.db.query("UPDATE tasksData SET type='reseller',itemId=1,buyPricePerOne=10,sellPricePerOne=20 WHERE botId=1").run();f.bots.get(1).taskData=f.db.query('SELECT * FROM tasksData WHERE botId=1').get()
 Object.assign(f.runtime.get(1),{running:true,runtimeStatus:'running',desiredState:'running',supervisorStatus:'running'})
 core.store.updateOperationsPolicy({roles:{analyst:{target:0},reseller:{target:1,maximum:1}}},core.store.operationsPolicy().revision)
 await core.start()
 assert.equal(f.calls.length,0);assert.ok(core.snapshot().capabilityBlockers.some(b=>b.code==='TRADING_EXECUTION_DISABLED'))
 core.updateOperationsPolicy({expectedRevision:core.store.operationsPolicy().revision,values:{roles:{reseller:{target:0}}}})
 await core.evaluateNow({type:'TEST'})
 assert.equal(f.calls.length,0);assert.equal(f.runtime.get(1).running,true)
 assert.ok(core.snapshot().recentDecisions.some(a=>a.result==='blocked'&&a.action==='release'))
})

for(const state of ['RESERVED','DISPATCHED','COMPLETED'])test('scheduler startup preserves generation evidence: '+state,async t=>{
 const f=await fixture(t,{count:1,start:false}),core=f.core
 core.store.updateOperationsPolicy({roles:{analyst:{target:0}},reserve:{targetReadyAccounts:1,automaticAccountGeneration:true,maximumTotalAccounts:4}},core.store.operationsPolicy().revision)
 const a=core.actions.ledger.reserve({type:'GENERATE',logicalKey:'generation:reserve',quantity:1,policyRevision:core.store.operationsPolicy().revision,desiredRevision:1,inputRevision:core.store.revision(),deadlineAt:Date.now()+60000,metadata:{generation:true}}).action
 if(state!=='RESERVED')core.actions.ledger.transition(a.actionId,'DISPATCHED')
 if(state==='COMPLETED'){f.db.createGeneratedAccounts(1,undefined,null,a.actionId);core.actions.ledger.transition(a.actionId,'COMPLETED',null,{created:1})}
 if(state==='RESERVED')core.store.updateOperationsPolicy({reserve:{automaticAccountGeneration:false}},core.store.operationsPolicy().revision)
 await core.start();await core.evaluateNow({type:'TEST'})
 assert.equal(core.actions.ledger.get(a.actionId).state,state==='RESERVED'?'CANCELLED':state)
 assert.equal(f.calls.length,0)
 if(state==='COMPLETED')assert.equal(f.db.createGeneratedAccounts(1,()=>assert.fail('receipt must prevent generation'),null,a.actionId).length,1)
})

test('startup imports legacy pending work once before planning another action',async t=>{
 const f=await fixture(t,{count:1,start:false}),core=f.core
 Object.assign(f.runtime.get(1),{running:true,runtimeStatus:'connecting',desiredState:'running',supervisorStatus:'starting'})
 core.store.setControl(1,{pendingActionId:'legacy',pendingDecisionId:'legacy-decision',pendingSince:Date.now(),pendingAfter:JSON.stringify({type:'analyst'})})
 await core.start();await core.evaluateNow({type:'TEST'})
 const actions=core.actions.ledger.active();assert.equal(actions.length,1);assert.equal(actions[0].metadata.imported,true);assert.equal(f.calls.length,0)
})

test('a fresh controller recovers interrupted dispatch with no scheduler state or replay',async t=>{
 const f=await fixture(t,{count:1,hung:true}),id=f.core.actions.ledger.active()[0].actionId
 await f.core.stop()
 Object.assign(f.runtime.get(1),{running:true,runtimeStatus:'connecting',desiredState:'running',supervisorStatus:'starting'})
 const next=new AutonomousCore({dataBaseManager:f.db,botManager:f.manager,eventBus:f.eventBus,logger,configurationService:{async sync(){}},executeCommand:()=>assert.fail('active durable action must not replay')})
 try{await next.start();assert.equal(next.scheduler.sequence,1);assert.equal(next.actions.ledger.active()[0].actionId,id);assert.equal(next.actions.ledger.active().length,1)}finally{await next.stop()}
})

test('startup imports a ready legacy replacement before explicit settlement removes it from pending observation',async t=>{
 const f=await fixture(t,{count:1,start:false}),now=Date.now()
 f.db.query("INSERT INTO accountReplacements(requestId,botId,bannedAccountId,replacementAccountId,state,createdAt,updatedAt) VALUES('ready-legacy',1,1,1,'initializing',?,?)").run(now,now)
 Object.assign(f.runtime.get(1),{running:true,runtimeStatus:'running',desiredState:'running',supervisorStatus:'running'})
 await f.core.start()
 const imported=f.core.actions.ledger.recent().find(a=>a.metadata.replacementRequestId==='ready-legacy')
 assert.equal(imported.type,'REPLACE');assert.equal(imported.state,'COMPLETED');assert.equal(f.calls.length,0)
 assert.equal(f.core.replacements.rows()[0].state,'completed')
})
