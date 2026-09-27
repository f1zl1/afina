import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import BotProcess from '../src/botManager/botProcess.js'
import BotManager from '../src/botManager/botManagerMain.js'
import WorkerFacts,{sanitizeWorkerFacts} from '../src/minecraftBot/worker/workerFacts.js'
import RealmReadyGate from '../src/minecraftBot/runtime/realmReadyGate.js'
import CoreObserver from '../src/core/coreObserver.js'
import CoreActualState from '../src/core/coreActualState.js'
import AutonomousCore from '../src/core/autonomousCore.js'
import DatabaseStore from '../src/data/databaseStore.js'
import EventBus from '../src/eventBus/eventBusMain.js'
import BotSnapshotStore from '../src/snapshots/botSnapshotStore.js'
import {createEvent} from '../src/events/eventFactory.js'

const logger={child(){return this},withContext(){return this},info(){},warn(){},error(){},log(){}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function runtime(id=1){
    const b={botId:id,accountId:id,accountData:{realm:101,password:'secret-password',telegramSession:'secret-session'},serverData:{serverId:1},status:'running',positionStatus:'realm',realmReadyTarget:101,
        client:{entity:{},health:20,_client:{state:'play',socket:{destroyed:false}}},taskData:{taskId:id,type:'analyst',itemId:null,enabled:1},taskRunner:{activeTask:{stopped:false,job:null},stopping:false},afkRecovery:{failed:false}}
    b.realmReadyGate=new RealmReadyGate({bot:b});b.realmReadyGate.enteredAt=Date.now()-20000;b.realmReadyGate.target=101;b.realmReadyGate.jitter=0
    return b
}
function worker(id=1,eventBus=new EventBus({logger})){
    const b=runtime(id),children=[];let current,collector
    const p=new BotProcess({botId:id,accountData:{accountId:id,realm:101,password:'secret-password'},taskData:b.taskData,serverData:b.serverData,logger,eventBus,
        probeProcess:()=>current.alive,
        forkWorker:()=>{
            const child=new EventEmitter();Object.assign(child,{pid:900+id,connected:true,alive:true,exitCode:null,signalCode:null,messages:[],respond:true})
            child.send=(message,callback)=>{
                child.messages.push(message);callback?.(null)
                if(message.type==='init')collector=new WorkerFacts({bot:b,incarnationId:message.payload.incarnationId})
                if(message.type==='runtime:getFacts'&&child.respond)queueMicrotask(()=>child.emit('message',{type:'runtime:facts',requestId:message.requestId,incarnationId:message.incarnationId,facts:collector.read()}))
            }
            current=child;children.push(child);return child
        }})
    const start=()=>{p.start();current.emit('spawn');return current}
    const publish=(type,payload={},child=current,instance=p.incarnationId,facts=collector.read())=>child.emit('message',{type:'publicEvent',incarnationId:instance,facts,event:createEvent({type,payload,source:{kind:'bot',botId:id,workerPid:child.pid,accountId:id,incarnationId:instance}})})
    const child=start();p.desiredState='running'
    return {p,b,child,children,start,publish,get collector(){return collector}}
}
async function system(t,count=1){
    const directory=await mkdtemp(path.join(os.tmpdir(),'afina-observation-')),store=new DatabaseStore({databasePath:path.join(directory,'afina.db')});await store.init()
    store.db.exec("INSERT INTO serverData VALUES(1,'localhost','1','test'); INSERT INTO itemsData VALUES(1,'Apple','apple','{}')")
    for(let id=1;id<=count;id++){
        store.prepare('INSERT INTO accountsData(accountId,username,password) VALUES(?,?,?)').run(id,'Test'+id,'secret-password')
        store.prepare('INSERT INTO accountPoolState(accountId) VALUES(?)').run(id)
        store.prepare('INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(?,?,?,1,101)').run(id,'Bot'+id,id)
        store.prepare("INSERT INTO tasksData(taskId,botId,type,enabled) VALUES(?,?,'analyst',1)").run(id,id)
    }
    const eventBus=new EventBus({logger}),snapshots=new BotSnapshotStore({eventBus,logger}),manager=new BotManager({logger,eventBus,snapshotStore:snapshots,dataBaseManager:{store}})
    const workers=Array.from({length:count},(_,i)=>worker(i+1,eventBus))
    for(const [index,w] of workers.entries()){manager.definitions.set(index+1,{botId:index+1,connectedAccountId:index+1});manager.bots.set(index+1,w.p)}
    const options={timeoutMs:30,scanTimeoutMs:100,concurrency:8,freshMs:1000},observer=new CoreObserver({store,botManager:manager,logger,options}),projection=new CoreActualState()
    const read=()=>projection.read(observer.snapshot({policyRevision:1}))
    const cores=[]
    t.after(async()=>{for(const core of cores)await core.stop();observer.stop();clearInterval(manager.heartbeatTimer);for(const w of workers)w.p.cancelFactRequest();snapshots.destroy();store.close();await rm(directory,{recursive:true,force:true})})
    return {store,eventBus,snapshots,manager,workers,observer,read,options,cores}
}

test('worker facts are a live allowlisted projection, with stable progress timestamps and no credentials',()=>{
    const b=runtime();let now=Date.now();const f=new WorkerFacts({bot:b,incarnationId:'A',now:()=>now})
    const first=f.read();assert.equal(first.role.ready,true);assert.equal(first.position.realmReady,true)
    now+=1000;assert.equal(f.read().lastProgressAt,first.lastProgressAt)
    b.positionStatus='lobby';assert.equal(f.read().position.realmReady,false);assert.equal(f.read().lastProgressAt,now)
    const json=JSON.stringify(sanitizeWorkerFacts({...first,password:'secret-password',environment:process.env,session:'secret-session'}))
    for(const token of ['secret-password','secret-session','password','environment','session'])assert.equal(json.includes(token),false)
})

for(const [label,change,blocker] of [
    ['connecting',b=>{b.status='connecting';b.client._client.state='login'},'MINECRAFT_DISCONNECTED'],
    ['hub',b=>b.positionStatus='lobby','TARGET_REALM_UNCONFIRMED'],
    ['AFK',b=>b.positionStatus='afk','TARGET_REALM_UNCONFIRMED'],
    ['realm delay',b=>b.realmReadyGate.enteredAt=Date.now(),'REALM_NOT_READY'],
    ['uninitialized role',b=>b.taskRunner.activeTask=null,'ROLE_NOT_READY'],
    ['disconnected socket',b=>b.client._client.socket.destroyed=true,'MINECRAFT_DISCONNECTED'],
    ['dead',b=>b.client.health=0,'WORKER_NOT_READY']
])test('process alive is not healthy capacity: '+label,async t=>{
    const f=await system(t);change(f.workers[0].b);await f.observer.refresh({force:true})
    const actual=f.read();assert.equal(actual.counts.processes,1);assert.equal(actual.roles.analyst,0);assert.equal(actual.bots[0].blocker,blocker)
})

test('lost ready and silently disappeared process repair without semantic events',async t=>{
    const f=await system(t),w=f.workers[0]
    w.b.positionStatus='lobby';await f.observer.refresh({force:true});assert.equal(f.read().roles.analyst,0)
    w.b.positionStatus='realm';await f.observer.refresh({force:true})
    assert.equal(w.p.workReady,false);assert.equal(w.p.runtimeStatus,'offline') // parent aliases never received ready/spawn
    assert.equal(f.read().roles.analyst,1)
    w.child.alive=false // no exit or BOT_STOPPED event
    await f.observer.refresh({force:true});assert.equal(f.read().roles.analyst,0);assert.equal(f.read().bots[0].observationQuality,'PROCESS_MISSING')
})

test('old incarnation events, heartbeat and responses cannot corrupt replacement worker, even with PID reuse',async t=>{
    const f=await system(t),w=f.workers[0];await w.p.requestFacts()
    const old=w.collector.read(),oldId=w.p.incarnationId
    w.child.emit('exit',0,null);w.b.positionStatus='lobby';const next=w.start();assert.notEqual(w.p.incarnationId,oldId)
    const before=w.p.lastHeartbeatAt
    w.child.emit('message',{type:'heartbeat',incarnationId:oldId});assert.equal(w.p.lastHeartbeatAt,before)
    w.publish('bot.runtime.ready',{botId:1},w.child,oldId,old)
    w.publish('bot.runtime.ready',{botId:1},next,oldId,old)
    await w.p.requestFacts();assert.equal(f.read().roles.analyst,0);assert.equal(f.read().bots[0].incarnationId,w.p.incarnationId)
    next.respond=false;const pending=w.p.requestFacts({timeoutMs:15}),request=next.messages.at(-1)
    next.emit('message',{type:'runtime:facts',requestId:request.requestId,incarnationId:oldId,facts:old})
    assert.equal((await pending).reason,'WORKER_FACTS_TIMEOUT')
    assert.equal(w.p.factCache.facts.position.status,'lobby')
    const queued=createEvent({type:'bot.status.changed',payload:{status:'running'},source:{kind:'bot',botId:1,workerPid:next.pid,incarnationId:oldId}})
    assert.equal(f.manager.isCurrentWorkerEvent(queued),false)
    f.eventBus.publishEnvelope(queued);assert.notEqual(f.snapshots.get(1)?.runtime.status,'running')
})

test('one hung worker times out concurrently while others remain observable; requests coalesce and clean up',async t=>{
    const f=await system(t,4);f.workers[1].b.positionStatus='lobby';f.workers[2].b.client=null;f.workers[3].child.respond=false
    const start=performance.now(),a=f.workers[3].p.requestFacts({timeoutMs:30}),b=f.workers[3].p.requestFacts({timeoutMs:30})
    assert.equal(a,b)
    await f.observer.refresh({force:true});await a
    assert.ok(performance.now()-start<500)
    const actual=f.read();assert.equal(actual.roles.analyst,1);assert.equal(actual.counts.processes,4);assert.equal(actual.counts.uncertain,1)
    assert.equal(f.workers[3].child.messages.filter(m=>m.type==='runtime:getFacts').length,1)
    assert.equal(f.workers[3].p.factRequest,null);assert.equal(f.observer.metrics.timeouts,1)
})

test('fresh event facts avoid queries, stale cache expires, and current events wake Core immediately',async t=>{
    const f=await system(t),w=f.workers[0]
    w.publish('bot.runtime.ready',{botId:1});await tick()
    await f.observer.refresh();assert.equal(f.observer.metrics.queried,0)
    assert.equal(f.read().roles.analyst,1);assert.equal(f.read().bots[0].factSource,'worker_event');assert.equal(f.read().bots[0].lastObservedAt,null)
    w.p.factCache.receivedAt-=2000;assert.equal(f.read().roles.analyst,0);assert.equal(f.read().bots[0].observationQuality,'STALE')
    await f.observer.refresh();assert.equal(f.observer.metrics.queried,1);assert.equal(f.read().bots[0].factSource,'worker_query')
})

test('worker exit, IPC disconnect and observer stop settle requests without dangling promises',async t=>{
    const f=await system(t,3);for(const w of f.workers)w.child.respond=false
    const requests=f.workers.map(w=>w.p.requestFacts({timeoutMs:5000}))
    f.workers[0].child.emit('exit',0,null);f.workers[1].child.emit('disconnect');f.observer.stop()
    const results=await Promise.all(requests)
    assert.deepEqual(results.map(r=>r.reason),['PROCESS_MISSING','WORKER_IPC_DISCONNECTED','OBSERVATION_CANCELLED'])
    assert.ok(f.workers.every(w=>w.p.factRequest===null))
})

test('immutable snapshot combines durable bans, assignment, pending stages and fresh runtime facts',async t=>{
    const f=await system(t);await f.observer.refresh({force:true})
    const before=f.read();assert.equal(before.roles.analyst,1)
    assert.throws(()=>{before.observation.workers[0].facts.role.ready=false},TypeError)
    f.store.prepare('UPDATE accountsData SET banned=1 WHERE accountId=1').run()
    assert.equal(f.read().roles.analyst,0);assert.equal(before.roles.analyst,1)
    assert.equal(f.read().observation.accounts[0].assigned,true)
    assert.equal(f.read().observation.accounts[0].source,'database')
    assert.equal(JSON.stringify(f.read().observation).includes('secret-password'),false)
})

async function coreSystem(t){
    const f=await system(t),commands=[]
    const core=new AutonomousCore({dataBaseManager:{store:f.store},botManager:f.manager,eventBus:f.eventBus,logger,configurationService:{async sync(){}},executeCommand:async request=>{commands.push(request.command);return {ok:true}},observationOptions:f.options})
    // Keep execution constrained: these scenarios prove observation and drift, not recovery ownership.
    core.store.updateOperationsPolicy({automationEnabled:true,allocationEnabled:false,capacity:{maximum:5},roles:{analyst:{target:1,maximum:1}}},core.store.operationsPolicy().revision)
    f.cores.push(core)
    return {...f,core,commands}
}

test('production safety reconciliation repairs lost process disappearance and reports a deficit',async t=>{
    const f=await coreSystem(t);await f.core.start();assert.equal(f.core.snapshot().actualState.roles.analyst,1)
    f.workers[0].child.alive=false
    await f.core.evaluateNow({type:'SAFETY_RECONCILIATION',source:'clock'})
    const s=f.core.snapshot();assert.equal(s.actualState.roles.analyst,0);assert.equal(s.observationCounts.processes,0)
    assert.ok(s.assessment.some(r=>r.code==='ANALYST_DEFICIT'));assert.notEqual(s.status.status,'stable');assert.deepEqual(f.commands,[])
})

test('startup needs no bot event; it observes absence and preserves production trading block',async t=>{
    const f=await coreSystem(t);f.workers[0].child.alive=false
    f.core.store.updateOperationsPolicy({roles:{reseller:{target:2,maximum:2}}},f.core.store.operationsPolicy().revision)
    await f.core.start();const s=f.core.snapshot()
    assert.equal(s.actualState.roles.analyst,0);assert.ok(s.assessment.some(r=>r.code==='ANALYST_DEFICIT'))
    assert.ok(s.assessment.some(r=>r.code==='TRADING_EXECUTION_DISABLED'));assert.deepEqual(f.commands,[])
})

test('production periodic scan repairs lost readiness; normal current events still schedule evaluation',async t=>{
    const f=await coreSystem(t),w=f.workers[0];w.b.positionStatus='lobby';await f.core.start()
    assert.equal(f.core.snapshot().actualState.roles.analyst,0)
    w.b.positionStatus='realm';await f.core.evaluateNow({type:'SAFETY_RECONCILIATION'})
    assert.equal(f.core.snapshot().actualState.roles.analyst,1)
    const triggers=[];f.core.schedule=trigger=>triggers.push(trigger)
    w.b.positionStatus='afk';w.publish('bot.position.changed',{position:'afk'})
    assert.ok(triggers.some(t=>t.type==='bot.position.changed'))
    assert.equal(f.core.readActual().roles.analyst,0)
})

test('Core coalesces refreshes, preserves a later policy trigger and cancels observation on stop',async t=>{
    const f=await coreSystem(t);await f.core.start();const w=f.workers[0];w.child.respond=false
    const before=w.child.messages.length
    const first=f.core.evaluateNow({type:'SAFETY_RECONCILIATION'})
    f.core.updateOperationsPolicy({expectedRevision:f.core.store.operationsPolicy().revision,values:{roles:{analyst:{target:0}}}})
    await first
    assert.equal(f.core.snapshot().desiredState.roles.analyst,0)
    assert.equal(w.child.messages.slice(before).filter(m=>m.type==='runtime:getFacts').length,1)
    const pending=f.core.evaluateNow({type:'SAFETY_RECONCILIATION'});await f.core.stop();await pending
    assert.equal(w.p.factRequest,null)
})

test('20 workers collect concurrently; one hung worker does not hide the other 19',async t=>{
    const f=await system(t,20);f.workers[0].child.respond=false
    const metrics=await f.manager.observeBots(f.workers.map(w=>w.p.botId),{force:true,timeoutMs:40,concurrency:8,scanTimeoutMs:500})
    assert.equal(metrics.queried,20);assert.equal(metrics.refreshed,19);assert.equal(metrics.timeouts,1)
    assert.equal(f.read().roles.analyst,19);assert.equal(f.read().counts.uncertain,1)
    assert.ok(f.workers.every(w=>!w.p.factRequest));t.diagnostic(JSON.stringify(metrics))
})

test('scan deadline bounds a hung inventory and rotates subsequent scans without starving later workers',async t=>{
    const f=await system(t,20);for(const w of f.workers)w.child.respond=false
    const ids=f.workers.map(w=>w.p.botId),options={force:true,timeoutMs:1000,concurrency:4,scanTimeoutMs:25}
    const first=await f.manager.observeBots(ids,options)
    assert.equal(first.queried,4);assert.equal(first.deadlineReached,true);assert.equal(first.unqueried,16)
    assert.ok(f.workers.every(w=>!w.p.factRequest))
    const second=await f.manager.observeBots(ids,options)
    assert.equal(second.queried,4)
    assert.ok(f.workers.slice(0,8).every(w=>w.child.messages.filter(m=>m.type==='runtime:getFacts').length===1))
    assert.ok(f.workers.every(w=>!w.p.factRequest));t.diagnostic(JSON.stringify({first,second}))
})

test('Reseller readiness respects initialization and pause; physical capacity never enables production trading',async t=>{
    const f=await coreSystem(t),w=f.workers[0]
    f.store.prepare("UPDATE tasksData SET type='reseller',itemId=1,buyPricePerOne=10,sellPricePerOne=20 WHERE botId=1").run()
    Object.assign(w.b.taskData,{type:'reseller',itemId:1});w.b.taskRunner.activeTask={running:true,paused:false,state:'waiting_for_realm'}
    await f.observer.refresh({force:true});assert.equal(f.read().roles.reseller,0)
    w.b.taskRunner.activeTask.state='idle';w.b.taskRunner.activeTask.paused=true
    await f.observer.refresh({force:true});assert.equal(f.read().roles.reseller,0)
    w.b.taskRunner.activeTask.paused=false
    f.core.store.updateOperationsPolicy({roles:{reseller:{target:1,maximum:1}}},f.core.store.operationsPolicy().revision)
    await f.core.start();const s=f.core.snapshot()
    assert.equal(s.actualState.roles.reseller,1)
    assert.equal(s.effectiveOperationsPolicy.roles.reseller.executable,false)
    assert.ok(s.capabilityBlockers.some(b=>b.code==='TRADING_EXECUTION_DISABLED'));assert.deepEqual(f.commands,[])
})

test('snapshot counts and stable status cannot retain readiness after observation expires',async t=>{
    const f=await coreSystem(t);await f.core.start()
    f.core.state.status='stable';const w=f.workers[0]
    w.child.alive=false
    const s=f.core.snapshot()
    assert.equal(s.status.actualAnalysts,0);assert.equal(s.status.status,'degraded')
})

test('IPC failure invalidates cached readiness and send callback failure cleans up immediately',async t=>{
    const f=await system(t),w=f.workers[0];await f.observer.refresh({force:true})
    w.child.connected=false
    assert.equal((await w.p.requestFacts()).reason,'WORKER_IPC_DISCONNECTED')
    assert.equal(f.read().roles.analyst,0);assert.equal(f.read().bots[0].uncertain,true)
    w.child.connected=true;w.child.send=(message,callback)=>callback(new Error('closed'))
    assert.equal((await w.p.requestFacts({timeoutMs:1000})).reason,'WORKER_IPC_DISCONNECTED')
    assert.equal(w.p.factRequest,null)
})
