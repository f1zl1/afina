import {fixtureObservation} from './helpers/fixtureObservation.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {EventEmitter} from 'node:events'
import DatabaseStore from '../src/data/databaseStore.js'
import {schema,addChangeTracking,upgradeToVersion2,upgradeToVersion3,upgradeToVersion4} from '../src/data/databaseSchema.js'
import AutonomousCore from '../src/core/autonomousCore.js'
import EventBus from '../src/eventBus/eventBusMain.js'
import MarketStore from '../src/core/market/marketStore.js'
import AnalysisPlanner from '../src/core/market/analysisPlanner.js'
import {marketDefaults,auctionConstraints,validateMarketPolicy} from '../src/core/market/marketConfig.js'
import {classifyLots,summarizeObservation,modelFromHistory,withAge} from '../src/core/market/marketStatistics.js'
import AnalystExecution from '../src/minecraftBot/taskRunner/modes/analyst/analystExecution.js'
import AuctionObservationParser from '../src/minecraftBot/taskRunner/modes/analyst/auctionObservationParser.js'
import BotTaskRunner from '../src/minecraftBot/taskRunner/botTaskRunner.js'
import {WorkerPublicEventMap} from '../src/events/events.js'
import {normalizeWorkerEvent} from '../src/events/workerEventNormalizer.js'
import {setImmediate} from 'node:timers/promises'

const policy={...marketDefaults,failureRetryMs:60000}
const lot=(price,amount=1,seller='OtherUser')=>({amount,totalPrice:price*amount,seller,expires:'5m'})
const clean=lots=>classifyLots(lots,new Set(['ourbot']),policy)
const logger={child(){return this},info(){},warn(){},error(){}}

test('high fence is relative, deterministic and unaffected by own extreme listings',()=>{
    for(const scale of [1,.1,1000]){
        const sample=clean([900,950,1000,1050,1100,100000000].map(p=>lot(p*scale)))
        assert.equal(sample.lots.at(-1).classification,'HIGH_PRICE_OUTLIER')
        assert.equal(summarizeObservation(sample).medianPricePerItem,1000*scale)
    }
    const sample=clean([lot(1000),lot(1100),lot(1200),lot(1300),lot(1400),lot(99999999,1,'OurBot')])
    assert.equal(sample.lots.at(-1).classification,'OWN_LISTING')
    assert.equal(summarizeObservation(sample).medianPricePerItem,1200)
})

test('cheap bulk remains an opportunity; amount-aware retail and bulk retain separate distributions',()=>{
    const sample=clean([lot(1200,1),lot(1180,2),lot(1150,4),lot(750,64),lot(800,64),lot(400,64)])
    const model=summarizeObservation(sample)
    assert.equal(model.retail.medianPricePerItem,1180)
    assert.equal(model.bulk.medianPricePerItem,750)
    assert.equal(sample.lots.at(-1).classification,'POTENTIAL_WHOLESALE_OPPORTUNITY')
    assert.equal(sample.lots.at(-1).includedInIndependentMarket,true)
    assert.equal(sample.lots.at(-1).potentialSpread,780)
    assert.ok(model.potentialWholesaleOpportunities.length>=1)
})

test('half-owned visible supply is kept raw and fully excluded from independent statistics',()=>{
    const sample=clean([lot(10,64,'OURBOT'),lot(20,32,'ourbot'),lot(1000,4,'OtherOne'),lot(1200,4,'OtherTwo')])
    const model=summarizeObservation(sample)
    assert.equal(sample.lots.length,4)
    assert.equal(model.ownSupply,96)
    assert.equal(model.independentSupply,8)
    assert.equal(model.ownLotCount,2)
    assert.equal(model.sellerCount,2)
    assert.equal(model.medianPricePerItem,1100)
})

test('malformed, unsafe and nonfinite observations never enter metrics; low valid price is retained',()=>{
    const sample=clean([{amount:0,totalPrice:100,seller:'OtherUser'},lot(NaN),lot(Infinity),lot(Number.MAX_SAFE_INTEGER+1),{amount:1,totalPrice:'1000',seller:'OtherUser'},lot(1),lot(1000,1,null)])
    assert.equal(sample.lots.filter(l=>l.classification==='INVALID').length,6)
    assert.equal(summarizeObservation(sample).medianPricePerItem,1)
    assert.ok(!JSON.stringify(sample).includes('Infinity'))
})

test('temporal volatility and confidence use clean snapshot summaries, never inferred sales',()=>{
    const summaries=[1000,1100,900].map(base=>summarizeObservation(clean([lot(base),lot(base+10),lot(base-10),lot(base+20),lot(base-20),lot(100000000),lot(999999999,1,'ourbot')])))
    const model=modelFromHistory({...summaries[0],lastObservedAt:1000},summaries)
    assert.ok(Math.abs(model.volatility-.14826)<1e-9)
    assert.equal(model.salesVelocity,null)
    assert.equal(model.profitPerHour,null)
    const expected=(.45*5/20+.25*1/5+.3*3/5)/(1+.14826)
    assert.ok(Math.abs(model.confidenceBase-expected)<1e-9)
    assert.equal(modelFromHistory(summaries[0],[summaries[0]]).volatility,null)
    assert.equal(withAge(model,policy,1000).freshness,'fresh')
    assert.equal(withAge(model,policy,1000+policy.marketStaleMs*3).confidence,0)
    const repeated=modelFromHistory(summaries[0],Array(10).fill(summaries[0]))
    assert.equal(repeated.independentSupply,summaries[0].independentSupply)
    assert.equal(repeated.volatility,0)
})

const plannerContext=()=>({items:[1,2,3].map(itemId=>({itemId,name:'Item'+itemId,searchQuery:'item'+itemId,matcher:'{}'})),policy,market:{items:[]},actual:{bots:[]},overrides:[],sessions:[],serverId:1,realm:101,now:100000})
test('planner cold start, reservations, cooldown, disabled items and deterministic tie breaking',()=>{
    const planner=new AnalysisPlanner(),context=plannerContext()
    const first=planner.getNextAnalysisTask(context)
    assert.equal(first.itemId,1)
    assert.equal(first.priority,110)
    assert.equal(first.observationCount,policy.analysisMaxObservations)
    context.sessions=[{itemId:1,serverId:1,realm:101,status:'running',startedAt:99900}]
    assert.equal(planner.getNextAnalysisTask(context).itemId,2)
    context.overrides=[{itemId:2,disabled:true}]
    assert.equal(planner.getNextAnalysisTask(context).itemId,3)
    context.sessions.push({itemId:3,serverId:1,realm:101,status:'failed',startedAt:99000,completedAt:99999})
    assert.equal(planner.getNextAnalysisTask(context),null)
})
test('age provides unbounded fairness while confidence, volatility and real exposure explain priorities',()=>{
    const planner=new AnalysisPlanner(),context=plannerContext()
    context.market.items=[1,2,3].map(itemId=>({itemId,serverId:1,realm:101,dataAgeMs:1000,freshness:'fresh',confidence:100,observationCount:5,volatility:0}))
    const base=planner.rank(context)[0].priority
    context.market.items[1].confidence=10;context.market.items[1].volatility=.25
    context.actual.bots=[{role:'reseller',serverId:1,realm:101,activeTask:{itemId:2}}]
    assert.equal(planner.getNextAnalysisTask(context).itemId,2)
    assert.ok(planner.rank(context)[0].priority>base)
    context.market.items[2].dataAgeMs=policy.marketStaleMs*10
    context.market.items[2].freshness='stale'
    assert.equal(planner.getNextAnalysisTask(context).itemId,3)
    assert.ok(planner.rank(context)[0].reasons.some(r=>r.code==='DATA_STALE'))
})

async function fixture(t,count=2){
    const dir=await mkdtemp(path.join(os.tmpdir(),'afina-market-')),config={databasePath:path.join(dir,'afina.db')}
    const store=new DatabaseStore(config);await store.init()
    store.db.exec(`INSERT INTO serverData VALUES(1,'localhost','1','Test'); INSERT INTO itemsData VALUES(1,'Apple','apple','{"minecraftName":"apple"}'),(2,'Pearl','pearl','{"minecraftName":"ender_pearl"}');`)
    const runtimes=new Map(),processes=new Map(),requests=[],cores=[]
    for(let id=1;id<=count;id++){
        store.prepare('INSERT INTO accountsData(accountId,username,password) VALUES(?,?,?)').run(id,'OurBot'+id,'private-password')
        store.prepare('INSERT INTO accountPoolState(accountId) VALUES(?)').run(id)
        store.prepare('INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(?,?,?,1,101)').run(id,'Bot'+id,id)
        store.prepare("INSERT INTO tasksData(botId,type) VALUES(?,'afk')").run(id)
        runtimes.set(id,{running:false,desiredState:'stopped',runtimeStatus:'offline',supervisorStatus:'offline',workerPid:null})
        processes.set(id,{isRunning:()=>runtimes.get(id).running,get desiredState(){return runtimes.get(id).desiredState},analysisState:'unavailable',sendEvent(event,task){requests.push({botId:id,event,task});return true}})
    }
    const botManager={hasBot:id=>processes.has(id),getBot:id=>processes.get(id),getBotRuntimeState:id=>runtimes.get(id)}
    const eventBus=new EventBus({logger}),events=[];eventBus.onAny(e=>events.push(e))
    const executeCommand=async ({command,payload,executionGuard})=>{
        const id=payload.botId;executionGuard?.();requests.push({command,botId:id})
        if(command==='bot.start'){
            processes.get(id).taskData=store.prepare('SELECT * FROM tasksData WHERE botId=?').get(id)
            processes.get(id).analysisState='idle'
            runtimes.set(id,{running:true,desiredState:'running',runtimeStatus:'running',supervisorStatus:'running',workerPid:100+id})
        }else if(command==='bot.stop') runtimes.set(id,{running:false,desiredState:'stopped',runtimeStatus:'offline',supervisorStatus:'stopped',workerPid:null})
        return {ok:true}
    }
    fixtureObservation(botManager,store)
    const newCore=()=>{const core=new AutonomousCore({dataBaseManager:{store},botManager,eventBus,logger,configurationService:{async sync(){}},executeCommand});cores.push(core);return core}
    const core=newCore()
    // Explicit canonical ceiling; legacy target edits cannot raise this safety limit.
    core.store.updateOperationsPolicy({capacity:{maximum:1000}},core.store.operationsPolicy().revision)
    await core.start()
    t.after(async()=>{for(const c of cores) await c.stop();store.close();await rm(dir,{recursive:true,force:true})})
    const update=values=>core.updatePolicy({values,expectedRevision:core.store.revision()})
    const emit=(type,session,payload={})=>eventBus.publish('bot.analysis.'+type,{analysisId:session.analysisId,...payload},{kind:'bot',botId:session.botId,workerPid:session.workerPid})
    return {store,core,newCore,runtimes,processes,botManager,eventBus,events,requests,update,emit,dir}
}

test('Core maintains N analysts, reserves distinct items once and disables autonomous trading',async t=>{
    const f=await fixture(t)
    f.update({enabled:true,autoAnalysis:true,targetAnalysts:2,targetResellers:1})
    await f.core.evaluateNow()
    const sessions=f.core.marketStore.sessions()
    assert.equal(sessions.length,2)
    assert.equal(new Set(sessions.map(s=>s.itemId)).size,2)
    assert.equal(f.core.snapshot().actualState.roles.analyst,2)
    assert.ok(f.store.prepare('SELECT type FROM tasksData').all().every(r=>r.type==='analyst'))
    const dispatched=f.requests.filter(r=>r.event==='core:analysis.assign').length
    for(let i=0;i<20;i++) f.eventBus.publish('system.database.changed',{table:'itemsData'})
    await f.core.evaluateNow()
    assert.equal(f.requests.filter(r=>r.event==='core:analysis.assign').length,dispatched)
    assert.equal(f.core.snapshot().capabilities.automaticTrading,false)
    assert.equal(JSON.stringify(f.core.snapshot()).includes('private-password'),false)
})

test('production Core does not launch a configured reseller from Market Intelligence',async t=>{
    const f=await fixture(t,1)
    f.store.prepare("UPDATE tasksData SET type='reseller',itemId=1,buyPricePerOne=100,sellPricePerOne=200 WHERE botId=1").run()
    f.update({enabled:true,targetResellers:1,autoSelectItems:true})
    await f.core.evaluateNow()
    assert.equal(f.requests.filter(r=>r.command==='bot.start').length,0)
    assert.ok(f.core.store.decisions().some(d=>d.reasons.some(r=>r.code==='TRADING_EXECUTION_DISABLED')))
    const snapshot=f.core.snapshot()
    assert.equal(snapshot.effectiveOperationsPolicy.roles.reseller.executable,false)
    assert.ok(snapshot.assessment.some(r=>r.code==='TRADING_EXECUTION_DISABLED'))
    assert.equal(snapshot.status.status,'degraded')
})

test('canonical switch controls production Analyst dispatch and event handling despite poisoned legacy mirrors',async t=>{
    const f=await fixture(t,1)
    f.update({autoAnalysis:true})
    f.core.updateOperationsPolicy({expectedRevision:f.core.store.operationsPolicy().revision,values:{automationEnabled:true,roles:{analyst:{target:1,maximum:1}}}})
    f.store.prepare('UPDATE corePolicy SET enabled=0,targetAnalysts=0').run()
    await f.core.evaluateNow()
    assert.equal(f.core.runtimePolicy().operations.automationActive,true)
    assert.equal(f.core.snapshot().actualState.roles.analyst,1)
    const [session]=f.core.marketStore.sessions();assert.ok(session)
    f.emit('observation',session,{ordinal:1,lots:[lot(1000)],observedAt:Date.now()})
    assert.equal(f.core.marketStore.session(session.analysisId).completedObservations,1)
    f.core.updateOperationsPolicy({expectedRevision:f.core.store.operationsPolicy().revision,values:{automationEnabled:false}})
    f.store.prepare('UPDATE corePolicy SET enabled=1,targetAnalysts=999').run()
    f.emit('observation',session,{ordinal:2,lots:[lot(1000)],observedAt:Date.now()})
    assert.equal(f.core.marketStore.session(session.analysisId).status,'cancelled')
    assert.equal(f.core.snapshot().automation.active,false)
    assert.equal(f.core.snapshot().status.status,'disabled')
})

test('one canonical or legacy save queues one evaluation and increments one canonical revision',async t=>{
    const f=await fixture(t,1);await f.core.evaluateNow()
    const scheduled=[];f.core.schedule=trigger=>scheduled.push(trigger)
    for(const save of [()=>f.update({targetAnalysts:1}),()=>f.core.updateOperationsPolicy({expectedRevision:f.core.store.operationsPolicy().revision,values:{automationEnabled:true}})]){
        const revision=f.core.store.operationsPolicy().revision,input=f.core.store.revision(),count=scheduled.length
        const response=save();assert.equal(response.canonicalRevision,revision+1);assert.equal(f.core.store.revision(),input+1)
        assert.equal(scheduled.length,count+1)
    }
})

test('production reports unsupported Reseller intent even without an item plan',async t=>{
    const f=await fixture(t,1)
    f.core.updateOperationsPolicy({expectedRevision:f.core.store.operationsPolicy().revision,values:{automationEnabled:true,roles:{reseller:{target:5,maximum:5}}}})
    await f.core.evaluateNow()
    const s=f.core.snapshot();assert.equal(s.effectiveOperationsPolicy.roles.reseller.configuredTarget,5)
    assert.ok(s.assessment.some(r=>r.code==='TRADING_EXECUTION_DISABLED'))
    assert.equal(s.status.status,'degraded');assert.equal(f.requests.filter(r=>r.command==='bot.start').length,0)
})

test('reducing analyst target cancels work and stops only idle excess analysts',async t=>{
    const f=await fixture(t)
    f.update({enabled:true,autoAnalysis:true,targetAnalysts:2})
    await f.core.evaluateNow()
    for(const process of f.processes.values()) process.analysisState='busy'
    f.update({targetAnalysts:1})
    await f.core.evaluateNow()
    assert.equal(f.requests.filter(r=>r.command==='bot.stop').length,0)
    assert.equal(f.core.marketStore.sessions().length,0)
    for(const process of f.processes.values()) process.analysisState='idle'
    await f.core.evaluateNow()
    assert.deepEqual(f.requests.filter(r=>r.command==='bot.stop').map(r=>r.botId),[2])
    assert.equal(f.core.snapshot().actualState.roles.analyst,1)
})

test('manual hold cancels analysis immediately; session deadline rejects late observations',async t=>{
    const f=await fixture(t)
    f.update({enabled:true,autoAnalysis:true,targetAnalysts:2})
    await f.core.evaluateNow()
    const sessions=f.core.marketStore.sessions()
    f.core.userControlsBot(sessions[0].botId)
    assert.equal(f.core.marketStore.session(sessions[0].analysisId).status,'cancelled')
    f.store.prepare('UPDATE analysisSessions SET deadline=? WHERE analysisId=?').run(Date.now()-1,sessions[1].analysisId)
    f.emit('observation',sessions[1],{ordinal:1,observedAt:Date.now(),lots:[lot(1000)]})
    assert.equal(f.core.marketStore.session(sessions[1].analysisId).status,'timed_out')
    assert.equal(f.store.prepare('SELECT count(*) AS n FROM marketObservations').get().n,0)
})

test('raw observations, own lots and aggregate revisions persist; duplicate deliveries do not double-count',async t=>{
    const f=await fixture(t,1)
    f.update({enabled:true,autoAnalysis:true,targetAnalysts:1,analysisMinObservations:2,analysisMaxObservations:2})
    await f.core.evaluateNow()
    const session=f.core.marketStore.sessions()[0]
    const payload={ordinal:1,observedAt:Date.now(),lots:[lot(1,64,'OURBOT1'),lot(900),lot(950),lot(1000),lot(1050),lot(1100),lot(100000000)]}
    f.emit('observation',session,payload);f.emit('observation',session,payload)
    assert.equal(f.store.prepare('SELECT count(*) AS n FROM marketObservations').get().n,1)
    let model=f.core.marketStore.snapshot(f.core.store.policy()).items[0]
    assert.equal(model.ownSupply,64);assert.equal(model.independentSupply,5)
    assert.equal(model.excludedHighOutlierCount,1);assert.equal(model.medianPricePerItem,1000)
    f.emit('observation',session,{...payload,ordinal:2,observedAt:Date.now()})
    f.emit('completed',session)
    assert.equal(f.core.marketStore.session(session.analysisId).status,'completed')
    assert.equal(f.core.store.getDecision(session.decisionId).result,'applied')
    model=f.core.marketStore.snapshot(f.core.store.policy()).items[0]
    assert.equal(model.independentSupply,5)
    await f.core.stop();f.store.close();await f.store.init()
    const restored=new MarketStore(f.store)
    assert.equal(restored.snapshot(f.core.store.policy()).revision,3)
    assert.equal(restored.snapshot(f.core.store.policy()).items[0].ownSupply,64)
    assert.ok(restored.details({itemId:session.itemId,serverId:1,realm:101}).lots.some(l=>l.classification==='OWN_LISTING'))
    assert.ok(f.events.some(e=>e.type==='core.market.updated'))
    assert.ok(f.events.some(e=>e.type==='core.analysis.completed'))
})

test('policy cancellation and replaced workers reject stale results; restart cancels interrupted sessions',async t=>{
    const f=await fixture(t,1)
    f.update({enabled:true,autoAnalysis:true,targetAnalysts:1})
    await f.core.evaluateNow()
    const session=f.core.marketStore.sessions()[0]
    f.runtimes.get(1).workerPid=999
    f.emit('observation',session,{ordinal:1,observedAt:Date.now(),lots:[lot(1000)]})
    assert.equal(f.store.prepare('SELECT count(*) AS n FROM marketObservations').get().n,0)
    f.runtimes.get(1).workerPid=session.workerPid
    f.update({enabled:false})
    f.emit('observation',session,{ordinal:1,observedAt:Date.now(),lots:[lot(1000)]})
    assert.equal(f.core.marketStore.session(session.analysisId).status,'cancelled')
    await f.core.evaluateNow()
    assert.equal(f.core.marketStore.sessions().length,0)
    // Emulate an interrupted persisted session, without resuming old tasks on restart.
    f.store.prepare("UPDATE analysisSessions SET status='running',completedAt=NULL WHERE analysisId=?").run(session.analysisId)
    const restarted=f.newCore();restarted.analysis.restore()
    assert.equal(restarted.marketStore.session(session.analysisId).status,'cancelled')
})

test('failure backoff, own account cache refresh, query bounds and retention are enforced',async t=>{
    const f=await fixture(t,1),market=f.core.marketStore
    f.update({enabled:true,autoAnalysis:true,targetAnalysts:1})
    await f.core.evaluateNow()
    const session=market.sessions()[0]
    f.emit('observation',session,{ordinal:1,observedAt:Date.now(),lots:[lot(1000)]})
    f.emit('failed',session,{code:'WINDOW_TIMEOUT'})
    assert.equal(market.session(session.analysisId).status,'failed')
    const count=f.requests.filter(r=>r.event==='core:analysis.assign' && r.task.itemId===session.itemId).length
    await f.core.evaluateNow()
    assert.equal(f.requests.filter(r=>r.event==='core:analysis.assign' && r.task.itemId===session.itemId).length,count)
    assert.ok(market.ownNames().has('ourbot1'))
    f.store.prepare("UPDATE accountsData SET username='NewName' WHERE accountId=1").run()
    assert.ok(market.ownNames().has('newname'));assert.ok(!market.ownNames().has('ourbot1'))
    assert.equal(market.snapshot(f.core.store.policy()).items[0].freshness,'requires_reanalysis')
    assert.throws(()=>market.details({itemId:1,serverId:1,realm:101,limit:10000}))
    market.cleanup({...policy,marketRawRetentionHours:1,marketHistoryRetentionHours:1},Date.now()+7200000)
    assert.equal(f.store.prepare('SELECT count(*) AS n FROM marketObservations').get().n,0)
    assert.equal(f.store.prepare('SELECT count(*) AS n FROM marketHistory').get().n,0)
    assert.equal(f.store.prepare('SELECT count(*) AS n FROM marketModels').get().n,1)
})

test('v4 to v5 migration preserves data, adds analyst constraint and query indexes with backup',async t=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'afina-market-migration-')),config={databasePath:path.join(dir,'afina.db')}
    const old=new DatabaseSync(config.databasePath)
    old.exec(schema);addChangeTracking(old);upgradeToVersion2(old);upgradeToVersion3(old);upgradeToVersion4(old)
    old.exec("INSERT INTO schemaMigrations VALUES(4,'before'); PRAGMA user_version=4; INSERT INTO botData(botId,name) VALUES(1,'Preserved'); INSERT INTO tasksData(botId,type) VALUES(1,'afk'); UPDATE corePolicy SET targetAnalysts=2")
    old.close()
    const store=new DatabaseStore(config);await store.init()
    t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})})
    assert.equal(store.prepare('PRAGMA user_version').get().user_version,16)
    assert.equal(store.prepare('SELECT targetAnalysts FROM corePolicy').get().targetAnalysts,2)
    assert.equal(store.prepare('SELECT type FROM tasksData').get().type,'afk')
    store.prepare("UPDATE tasksData SET type='analyst' WHERE botId=1").run()
    assert.ok(store.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all().some(r=>r.name==='analysis_reserved_item'))
    assert.equal((await readdir(path.join(dir,'backups'))).length,1)
    assert.deepEqual(store.prepare('PRAGMA foreign_key_check').all(),[])
})

function auctionMock(){
    const client=new EventEmitter(),window=new EventEmitter(),calls=[],waits=[]
    Object.assign(window,{id:1,type:'minecraft:generic_9x6',title:'Аукцион: Поиск',slots:Array(90).fill(null)})
    client.chat=text=>{calls.push(['chat',text]);client.currentWindow=window;client.emit('windowOpen',window)}
    client.clickWindow=async slot=>{calls.push(['click',slot]);client.emit('setWindowItems:1')}
    client.closeWindow=()=>{client.currentWindow=null}
    let now=10000
    const execution=new AnalystExecution({client,logger,parser:{scan:()=>[lot(1000)]},random:()=>.5,now:()=>now,wait:async ms=>{waits.push(ms);now+=ms}})
    const task={analysisId:'test',itemId:1,query:'apple',matcher:{minecraftName:'apple'},observationCount:3,timing:{minimumRefreshIntervalMs:5000,refreshJitterMs:1000,windowTimeoutMs:1000}}
    return {client,window,calls,waits,execution,task}
}
test('mock auction executes search, scan, safe randomized refresh and result without purchase clicks',async()=>{
    const f=auctionMock(),observations=[]
    await f.execution.execute(f.task,{onObservation:o=>observations.push(o),onProgress(){}})
    assert.deepEqual(f.calls,[['chat','/ah search apple'],['click',45],['click',45]])
    assert.equal(observations.length,3)
    assert.ok(f.waits.every(ms=>ms>=5000 && ms<=6000))
    assert.equal(observations[1].observedAt-observations[0].observedAt,5500)
    assert.equal(f.client.listenerCount('windowOpen'),0)
    assert.equal(f.client.currentWindow,null)
    assert.equal(auctionConstraints.maxActiveListingsPerAccount,5)
})
test('auction cancellation, disconnect, unexpected GUI and missing refresh fail safely',async()=>{
    for(const mode of ['cancel','disconnect','wrong','timeout']){
        const f=auctionMock(),controller=new AbortController()
        if(mode==='cancel') f.execution.wait=async()=>controller.abort(new Error('CANCELLED'))
        if(mode==='disconnect') f.execution.wait=async()=>f.client.emit('end')
        if(mode==='wrong') f.client.chat=()=>{f.window.title='Shop';f.client.currentWindow=f.window;f.client.emit('windowOpen',f.window)}
        if(mode==='timeout') f.client.clickWindow=async()=>{}
        await assert.rejects(f.execution.execute(f.task,{signal:controller.signal,onObservation(){},onProgress(){}}),new RegExp({cancel:'CANCELLED',disconnect:'DISCONNECTED',wrong:'UNEXPECTED_WINDOW',timeout:'REFRESH_TIMEOUT'}[mode]))
        assert.equal(f.client.listenerCount('end'),0)
        assert.equal(f.client.listenerCount('windowOpen'),0)
    }
})

test('refresh may replace the auction window only with the same validated title',async()=>{
    const f=auctionMock(),observations=[]
    f.client.clickWindow=async()=>{
        const previous=f.client.currentWindow,next=new EventEmitter()
        Object.assign(next,{id:previous.id+1,type:previous.type,title:previous.title,slots:previous.slots})
        f.client.emit('windowClose',previous);f.client.currentWindow=next;f.client.emit('windowOpen',next)
    }
    await f.execution.execute(f.task,{onObservation:o=>observations.push(o),onProgress(){}})
    assert.equal(observations.length,3)
    assert.equal(f.client.listenerCount('windowOpen'),0)
})
test('one malformed lot becomes raw INVALID while other slots still parse via existing total price parser',()=>{
    const parser=new AuctionObservationParser(),slots=Array(90).fill(null)
    slots[0]={name:'apple',count:64,components:[{type:'lore',data:['Цена: $6,400','Продавец: OtherUser','Истекает: 5m']}]}
    slots[1]={name:'apple',count:1,get components(){throw new Error('malformed')}}
    const lots=parser.scan({slots},{matcher:{minecraftName:'apple'}},logger)
    assert.equal(lots.length,2)
    assert.equal(lots[0].totalPrice,6400)
    assert.equal(lots[0].seller,'OtherUser')
    assert.equal(lots[0].totalPrice/lots[0].amount,100)
    assert.equal(lots[1].invalidReason,'PARSER_ERROR')
})
test('timing and segmentation validation reject unsafe policy combinations',()=>{
    assert.doesNotThrow(()=>validateMarketPolicy(policy))
    assert.throws(()=>validateMarketPolicy({...policy,marketRetailMaxAmount:64,marketMediumMaxAmount:16}))
    assert.throws(()=>validateMarketPolicy({...policy,analysisSessionTimeoutMs:30000}))
})

test('retention count caps handle identical timestamps and leave compact current model intact',async t=>{
    const f=await fixture(t,1)
    f.update({enabled:true,autoAnalysis:true,targetAnalysts:1})
    await f.core.evaluateNow()
    const session=f.core.marketStore.sessions()[0],now=Date.now()
    f.emit('observation',session,{ordinal:1,observedAt:now,lots:[lot(1000)]})
    for(let i=0;i<120;i++){
        f.store.prepare('INSERT INTO marketObservations VALUES(?,?,?,?,?,?,?,?)').run('extra'+i,session.analysisId,i+2,session.itemId,1,101,now,'[]')
        f.store.prepare('INSERT INTO marketHistory VALUES(?,?,?,?,?,?,?)').run('extra'+i,session.analysisId,session.itemId,1,101,now,'{}')
    }
    f.core.marketStore.cleanup({...policy,marketRawLimit:100,marketHistoryLimit:100})
    assert.equal(f.store.prepare('SELECT count(*) AS n FROM marketObservations').get().n,100)
    assert.equal(f.store.prepare('SELECT count(*) AS n FROM marketHistory').get().n,100)
    assert.equal(f.store.prepare('SELECT count(*) AS n FROM marketModels').get().n,1)
})

test('existing task runner and worker event contract deliver an actual mocked Analyst result to Core',async t=>{
    const f=await fixture(t,1),workerBus=new EventEmitter(),auction=auctionMock()
    auction.window.slots[0]={name:'apple',count:2,components:[{type:'lore',data:['Цена: $2,000','Продавец: OtherUser']}]}
    for(const [local,publicType] of Object.entries(WorkerPublicEventMap).filter(([local])=>local.startsWith('bot:analysis.'))){
        workerBus.on(local,payload=>f.eventBus.publish(publicType,normalizeWorkerEvent(local,publicType,payload),{kind:'bot',botId:1,workerPid:101}))
    }
    const runner=new BotTaskRunner({bot:{botId:1,incarnationId:'fixture-101',positionStatus:'realm',client:auction.client},eventBus:workerBus,logger})
    const lifecycle=runner.start({type:'analyst',enabled:1})
    f.processes.get(1).workload=runner.workload
    t.after(async()=>{runner.stop();await lifecycle})
    f.processes.get(1).sendEvent=(event,task)=>{workerBus.emit(event,task);return true}
    f.update({enabled:true,autoAnalysis:true,targetAnalysts:1,analysisMinObservations:1,analysisMaxObservations:1})
    await f.core.evaluateNow()
    await setImmediate()
    const model=f.core.marketStore.snapshot(f.core.store.policy()).items.find(m=>m.itemId===1)
    assert.equal(model.medianPricePerItem,1000)
    assert.ok(f.core.marketStore.sessions(false).some(s=>s.status==='completed'))
    assert.ok(auction.calls.some(c=>c[1]==='/ah search apple'))
    assert.ok(!auction.calls.some(c=>c[0]==='click'))
    runner.stop();await lifecycle
})

test('observations from different realms never share prices or item reservations',async t=>{
    const f=await fixture(t)
    f.store.prepare('UPDATE botData SET realm=202 WHERE botId=2').run()
    f.update({enabled:true,autoAnalysis:true,targetAnalysts:2})
    await f.core.evaluateNow()
    const sessions=f.core.marketStore.sessions()
    assert.equal(sessions[0].itemId,sessions[1].itemId)
    for(const s of sessions) f.emit('observation',s,{ordinal:1,observedAt:Date.now(),lots:[lot(s.realm===101?1000:2000)]})
    const market=f.core.marketStore.snapshot(f.core.store.policy())
    assert.equal(market.items.find(m=>m.realm===101).medianPricePerItem,1000)
    assert.equal(market.items.find(m=>m.realm===202).medianPricePerItem,2000)
})
