import {fixtureObservation} from './helpers/fixtureObservation.js'
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp,rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import DataBaseManager from "../src/data/dataBaseManagerMain.js"
import AutonomousCore from "../src/core/autonomousCore.js"
import Core from "../src/core/coreMain.js"
import EventBus from "../src/eventBus/eventBusMain.js"
import InterfaceGateway from "../src/interfaces/interfaceGateway.js"
import CommandService from "../src/core/commandService.js"
import {foundationEngines} from '../src/core/economicContracts.js'

async function fixture(t,{count=4,running=0}={}){
    const dir=await mkdtemp(path.join(os.tmpdir(),"afina-core-"))
    const logs=[],events=[],calls=[]
    const logger={child(){return this},info(...v){logs.push(v)},warn(){},error(...v){logs.push(v)}}
    const eventBus=new EventBus({logger})
    eventBus.onAny(e=>events.push(e))
    const db=new DataBaseManager({config:{databasePath:path.join(dir,"afina.db")},logger})
    await db.init()
    db.store.db.exec("INSERT INTO serverData VALUES(1,'localhost','1','test'); INSERT INTO itemsData VALUES(1,'Apple','Apple','{}'),(2,'Pearl','Pearl','{}')")
    const processes=new Map()
    const runtime=new Map()
    for(let id=1;id<=count;id++){
        db.query("INSERT INTO accountsData(accountId,username,password) VALUES(?,?,?)").run(id,"Player"+id,"private-minecraft-password")
        db.query("INSERT INTO accountPoolState(accountId) VALUES(?)").run(id)
        db.query("INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(?,?,?,1,101)").run(id,"Bot "+id,id)
        db.query("INSERT INTO tasksData(botId,type,itemId,buyPricePerOne,sellPricePerOne) VALUES(?,?,?,?,?)").run(id,id===1 || id<=running ? "reseller" : "afk",id===1 || id<=running ? 1 : null,id===1 || id<=running ? 10 : null,id===1 || id<=running ? 20 : null)
        runtime.set(id,{desiredState:id<=running ? "running" : "stopped",running:id<=running,runtimeStatus:id<=running ? "running" : "offline",supervisorStatus:id<=running ? "running" : "offline",workerPid:id<=running ? id+100 : null})
        processes.set(id,{isRunning:()=>runtime.get(id).running,get desiredState(){return runtime.get(id).desiredState},taskData:db.query("SELECT * FROM tasksData WHERE botId=?").get(id)})
    }
    const botManager={getBot:id=>processes.get(id),getBotRuntimeState:id=>runtime.get(id),hasBot:id=>processes.has(id)}
    fixtureObservation(botManager,db.store)
    const configurationService={async sync(){}}
    const executeCommand=async request=>{
        const id=request.payload.botId;calls.push(id)
        processes.get(id).taskData=db.query("SELECT * FROM tasksData WHERE botId=?").get(id)
        runtime.set(id,{desiredState:"running",running:true,runtimeStatus:"running",supervisorStatus:"running",workerPid:100+id})
        return {ok:true}
    }
    const core=new AutonomousCore({dataBaseManager:db,botManager,eventBus,logger,configurationService,executeCommand,engines:foundationEngines()})
    t.after(async()=>{await core.stop();db.close();await rm(dir,{recursive:true,force:true})})
    // Explicit canonical ceiling; legacy target edits cannot raise this safety limit.
    core.store.updateOperationsPolicy({capacity:{maximum:1000}},core.store.operationsPolicy().revision)
    await core.start()
    const policy=values=>core.updatePolicy({values,expectedRevision:core.store.revision()})
    const override=(itemId,values)=>core.setOverride({itemId,values,expectedRevision:core.store.revision()})
    const evaluate=()=>core.evaluateNow({type:"TEST_EVENT",source:"test",details:{}})
    return {db,core,botManager,eventBus,logger,events,logs,calls,processes,runtime,configurationService,policy,override,evaluate}
}

test("Core observes actual roles and deficit without fake market metrics or disabled execution",async t=>{
    const f=await fixture(t,{count:10,running:8})
    f.policy({targetResellers:10,targetAnalysts:1,maxResellersPerItem:3,autoSelectItems:true})
    await f.evaluate()
    const s=f.core.snapshot()
    assert.equal(s.status.status,"disabled")
    assert.equal(s.actualState.roles.reseller,8)
    assert.equal(s.assessment.find(r=>r.code === "RESELLER_DEFICIT").data.deficit,2)
    assert.ok(s.desiredState.allocations.every(a=>a.desiredBots<=3))
    assert.deepEqual(f.calls,[])
    assert.equal(s.desiredState.market.available,false)
    const serialized=JSON.stringify(s)
    for(const forbidden of ["HIGH_DEMAND","HIGH_EXPECTED_PROFIT","private-minecraft-password","session","apiHash"]) assert.equal(serialized.includes(forbidden),false)
})

test("item max/forced/disabled and global policy are resolved deterministically",async t=>{
    const f=await fixture(t)
    f.policy({targetResellers:4,maxResellersPerItem:3,autoSelectItems:true})
    f.override(1,{maxBots:1})
    f.override(2,{forcedBots:2})
    await f.evaluate()
    let desired=f.core.snapshot().desiredState
    assert.equal(desired.allocations.find(a=>a.itemId===1).desiredBots,1)
    assert.equal(desired.allocations.find(a=>a.itemId===2).desiredBots,2)
    f.override(1,{disabled:true})
    await f.evaluate()
    assert.equal(f.core.snapshot().desiredState.allocations.find(a=>a.itemId===1).desiredBots,0)
    f.policy({targetResellers:1})
    await f.evaluate()
    desired=f.core.snapshot().desiredState
    assert.ok(desired.allocations.reduce((n,a)=>n+a.desiredBots,0)<=1)
    assert.ok(desired.assessments.some(r=>r.code === "OVERRIDE_CAPACITY_CONFLICT"))
})

test("policy/override validation, optimistic revisions and persistent journal",async t=>{
    const f=await fixture(t)
    for(const values of [{targetResellers:-1},{targetAnalysts:1.2},{maxResellersPerItem:0},{enabled:"true"},{switchCooldownMs:-1},{unknown:2}]) assert.throws(()=>f.policy(values))
    assert.throws(()=>f.override(1,{minBots:3,maxBots:2}))
    assert.throws(()=>f.override(1,{forcedBots:3,maxBots:2}))
    assert.throws(()=>f.override(1,{maxBuyPrice:0}))
    const revision=f.core.store.revision()
    f.policy({targetResellers:2})
    assert.throws(()=>f.core.updatePolicy({values:{targetResellers:3},expectedRevision:revision}),/CORE_CONFLICT/)
    await f.evaluate()
    const record=f.core.store.decisions().find(r=>r.action === "policy.update")
    assert.equal(record.trigger.type,"USER_POLICY_UPDATED")
    assert.equal(record.result,"applied")
    assert.ok(record.decisionId && record.reasons.length)
    assert.equal(f.db.query("SELECT targetResellers FROM corePolicy").get().targetResellers,2)
    assert.equal(f.core.store.desired().revision,f.core.snapshot().desiredState.revision)
})

test("enabled Core assigns stopped eligible bots, starts via command layer and journals observed success",async t=>{
    const f=await fixture(t)
    f.policy({enabled:true,targetResellers:2,maxResellersPerItem:3,autoSelectItems:true})
    await f.evaluate()
    assert.deepEqual(f.calls,[1,2])
    const actions=f.core.store.decisions().filter(d=>d.action === "assign")
    assert.equal(actions.filter(d=>d.result === "applied").length,2)
    for(const record of actions){assert.ok(record.actionId && record.decisionId && record.trigger && record.reasons.length)}
    assert.equal(f.core.snapshot().actualState.roles.reseller,2)
    const before=f.core.store.decisions().length
    await Promise.all(Array.from({length:50},()=>f.evaluate()))
    assert.deepEqual(f.calls,[1,2])
    assert.equal(f.core.store.decisions().length,before)
})

test("active reassignment stays blocked and hard overrides cannot bypass lifecycle safety",async t=>{
    const f=await fixture(t,{running:1})
    f.policy({enabled:true,targetResellers:1})
    f.override(1,{disabled:true})
    f.override(2,{forcedBots:1})
    await f.evaluate()
    assert.deepEqual(f.calls,[])
    assert.ok(f.core.store.decisions().some(d=>d.result === "blocked" && d.reasons.some(r=>r.code === "SAFE_TRANSITION_UNAVAILABLE")))
    assert.equal(f.db.query("SELECT itemId FROM tasksData WHERE botId=1").get().itemId,1)
})

test("price overrides block unsafe configured prices; analyst remains explicitly unavailable",async t=>{
    const f=await fixture(t)
    f.policy({enabled:true,targetResellers:1,targetAnalysts:1})
    f.override(1,{forcedBots:1,maxBuyPrice:5,minSellPrice:30})
    await f.evaluate()
    assert.deepEqual(f.calls,[])
    assert.ok(f.core.store.decisions().some(d=>d.reasons.some(r=>r.code === "PRICES_UNAVAILABLE")))
    assert.ok(f.core.snapshot().assessment.some(r=>r.code === "ANALYST_UNAVAILABLE"))
})

test("manual bot hold survives evaluation and explicit release returns control",async t=>{
    const f=await fixture(t,{count:1})
    f.core.userControlsBot(1)
    f.policy({enabled:true,targetResellers:1})
    await f.evaluate()
    assert.deepEqual(f.calls,[])
    assert.equal(f.core.snapshot().actualState.bots[0].manualHold,true)
    f.core.releaseBot({botId:1})
    await f.evaluate()
    assert.deepEqual(f.calls,[1])
})

test("policy update during reconciliation cancels old execution and serialized cycle uses new inputs",async t=>{
    const f=await fixture(t,{count:2})
    let entered,finish
    const barrier=new Promise(resolve=>{entered=resolve})
    f.configurationService.sync=()=>{entered();return new Promise(resolve=>{finish=resolve})}
    f.policy({enabled:true,targetResellers:2,autoSelectItems:true})
    const evaluation=f.evaluate()
    await barrier
    f.policy({enabled:false,targetResellers:0})
    finish()
    await evaluation
    assert.deepEqual(f.calls,[])
    assert.equal(f.core.snapshot().status.status,"disabled")
    assert.equal(f.core.snapshot().desiredState.roles.reseller,0)
    assert.ok(f.core.store.decisions().some(d=>d.reasons.some(r=>r.code === "STALE_REVISION")))
})

test("failure backoff, decision retention and readonly Core table editor",async t=>{
    const f=await fixture(t,{count:1})
    f.core.reconciler.executeCommand=async()=>{f.calls.push(1);throw new Error("secret failure details")}
    f.policy({enabled:true,targetResellers:1,journalLimit:50})
    await f.evaluate()
    await f.evaluate()
    assert.equal(f.calls.length,1)
    assert.ok(f.core.store.decisions().some(d=>d.result === "failed"))
    assert.equal(JSON.stringify(f.core.snapshot()).includes("secret failure details"),false)
    for(let i=0;i<60;i++) f.core.record({action:"test",result:"blocked",trigger:{type:"TEST"},target:{},reasons:[],before:null,after:null,constraintsApplied:[],alternatives:[]})
    assert.equal(f.db.query("SELECT count(*) AS n FROM coreDecisionJournal").get().n,50)
    const {default:DatabaseEditor}=await import("../src/data/databaseEditor.js")
    const editor=new DatabaseEditor({store:f.db.store})
    assert.throws(()=>editor.mutate({database:"core",table:"corePolicy",operation:"update",values:{enabled:1}}),/read-only/)
})

test("Core gateway snapshot and updates use existing commands and semantic events",async t=>{
    const f=await fixture(t)
    const core=new Core({logger:f.logger,eventBus:f.eventBus})
    core.queryService.handlers.set("core.getSnapshot",()=>({ok:true,data:f.core.snapshot()}))
    core.commandService.handlers.set("core.policy.update",({payload})=>({ok:true,data:f.core.updatePolicy(payload)}))
    const gateway=new InterfaceGateway({logger:f.logger,eventBus:f.eventBus,core})
    const received=[];const unsubscribe=gateway.subscribe(message=>received.push(message))
    t.after(unsubscribe)
    const snapshot=await gateway.handleRequest(gateway.createQuery("core.getSnapshot"))
    for(const field of ["policy","overrides","status","desiredState","actualState","recentDecisions"]) assert.ok(Object.hasOwn(snapshot.data,field))
    const response=await gateway.handleRequest(gateway.createCommand("core.policy.update",{values:{targetResellers:3},expectedRevision:snapshot.data.inputRevision}),{type:"web",id:"one"})
    assert.equal(response.ok,true)
    await f.evaluate()
    assert.ok(received.some(message=>message.event?.type === "core.decision.created"))
    assert.ok(received.some(message=>message.event?.type === "core.desiredState.updated"))
})

test("eligible stopped bot is preferred over an unavailable account; events coalesce",async t=>{
    const f=await fixture(t,{count:2})
    f.db.query("UPDATE accountPoolState SET status='blocked' WHERE accountId=1").run()
    let cycles=0
    const cycle=f.core.cycle.bind(f.core)
    f.core.cycle=async batch=>{cycles++;return cycle(batch)}
    for(let i=0;i<50;i++) f.eventBus.publish("system.database.changed",{table:"tasksData"})
    await f.evaluate()
    assert.equal(cycles,1)
    f.policy({enabled:true,targetResellers:1})
    await f.evaluate()
    assert.deepEqual(f.calls,[2])
})

test("hysteresis requires duration, cooldown and measured improvement; hard override stays constrained",async t=>{
    const f=await fixture(t,{count:1})
    f.policy({enabled:true,targetResellers:1})
    const actual=f.core.readActual()
    const policy=f.core.runtimePolicy()
    actual.bots[0].lastSwitchAt=Date.now()
    const allocation={itemId:2,desiredBots:1,buyPrice:10,sellPrice:20,reasons:[],constraintsApplied:[],hardOverride:false,improvementPercent:null}
    const desired={allocations:[allocation],unallocatedResellers:0}
    let actions=f.core.reconciler.plan({policy,actual,desired})
    const codes=actions[0].reasons.map(r=>r.code)
    for(const code of ['MINIMUM_ASSIGNMENT_DURATION','SWITCH_COOLDOWN','SWITCH_IMPROVEMENT_UNAVAILABLE']) assert.ok(codes.includes(code))
    allocation.hardOverride=true
    actions=f.core.reconciler.plan({policy,actual,desired})
    assert.equal(actions[0].result,'planned')
    actual.bots[0].running=true
    actions=f.core.reconciler.plan({policy,actual,desired})
    assert.equal(actions[0].result,'blocked')
})

test("command layer rechecks autonomous permission after asynchronous account assignment",async t=>{
    const f=await fixture(t,{count:1})
    let allowed=true,started=false
    const commands=new CommandService({logger:f.logger,eventBus:f.eventBus,
        botManager:{...f.botManager,async startBot(){started=true}},
        accountAssignmentService:{async ensureAccount(){allowed=false;return {accountId:1}}}})
    const result=await commands.execute({command:'bot.start',payload:{botId:1},actor:{type:'internal',id:'autonomous-core'},executionGuard:()=>{if(!allowed) throw new Error('STALE_REVISION')}})
    assert.equal(result.ok,false)
    assert.equal(started,false)
})

test("restarted Core restores policy, overrides, desired revision and journal from SQLite",async t=>{
    const f=await fixture(t)
    f.policy({targetResellers:2})
    f.override(1,{maxBots:2})
    await f.evaluate()
    const before=f.core.snapshot()
    await f.core.stop()
    const restarted=new AutonomousCore({dataBaseManager:f.db,botManager:f.botManager,eventBus:f.eventBus,logger:f.logger,configurationService:f.configurationService,engines:foundationEngines(),executeCommand:async()=>{throw new Error('Must remain disabled')}})
    t.after(()=>restarted.stop())
    await restarted.start()
    const after=restarted.snapshot()
    assert.deepEqual(after.policy,before.policy)
    assert.deepEqual(after.overrides,before.overrides)
    assert.equal(after.desiredState.revision,before.desiredState.revision)
    assert.ok(after.recentDecisions.some(d=>d.decisionId===before.recentDecisions[0].decisionId))
    await restarted.stop()
})
