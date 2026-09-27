import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,readdir} from 'node:fs/promises'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import AutonomousCore from '../src/core/autonomousCore.js'
import {fixture,logger,until,actor,request} from './helpers/economicFixture.js'
import {classifyLots,summarizeObservation,modelFromHistory} from '../src/core/market/marketStatistics.js'
import {coreCapabilities} from '../src/core/coreCapabilities.js'

function policy(f,patch={}){return f.core.store.updateOperationsPolicy(patch,f.core.store.operationsPolicy().revision)}
function observe(f,{itemId=1,realm=101,at=Date.now(),confidenceBase=1,spread=true}={}){
    const p=f.core.store.runtimeSettings(),lots=Array.from({length:20},(_,i)=>({amount:1,totalPrice:20,seller:'Seller'+i}))
    if(spread)lots.push({amount:2,totalPrice:20,seller:'Wholesale'})
    const summary=summarizeObservation(classifyLots(lots,new Set(),p));f.core.marketStore.ownNames()
    const m={...modelFromHistory(summary,Array(5).fill(summary)),confidenceBase,itemId,serverId:1,realm,lastObservedAt:at,
        ownershipFingerprint:f.core.marketStore.namesFingerprint,segmentation:{retailMax:p.marketRetailMaxAmount,mediumMax:p.marketMediumMaxAmount}}
    f.store.prepare('INSERT INTO marketModels VALUES(?,?,?,?,?) ON CONFLICT(serverId,realm,itemId) DO UPDATE SET observedAt=excluded.observedAt,document=excluded.document').run(1,realm,itemId,at,JSON.stringify(m))
    f.store.db.exec('UPDATE marketMetadata SET revision=revision+1')
    return f.core.tradingSnapshot().plans.find(p=>p.itemId===itemId&&p.realm===realm)
}
async function setup(t,options={}){
    const f=await fixture(t,options)
    policy(f,{automationEnabled:true,allocationEnabled:false,autonomousTradingEnabled:true,capacity:{maximum:options.count??1},roles:{reseller:{target:options.count??1,maximum:options.count??1}}})
    f.plan=observe(f);return f
}
const rows=f=>f.core.economic.store.rows()
const submit=f=>f.core.economic.submitAutonomous(f.plan.planId,f.core.tradingExecution)
const candidate=(f,row,botId=1)=>({workloadId:row.workloadId,target:{botId}})
const terminal=(f,row,status='COMPLETED',patch={})=>f.core.economic.store.save({...row,status,progress:{...row.progress,boughtQuantity:2,listedQuantity:2,purchaseValue:20},...patch})
async function newer(f,options={}){await new Promise(r=>setTimeout(r,3));f.plan=observe(f,options);return f.plan}

test('canonical fresh default disables autonomous execution with bounded risk',async t=>{const f=await fixture(t),p=f.core.store.operationsPolicy();assert.equal(p.autonomousTradingEnabled,false);assert.equal(p.autonomousTradingMaxPurchaseValue,100000);assert.equal(p.autonomousTradingMaxConcurrentWorkloads,1);observe(f);await f.core.evaluateNow();assert.equal(rows(f).length,0)})
test('disabled switch blocks even with Core automation enabled',async t=>{const f=await setup(t);policy(f,{autonomousTradingEnabled:false});await f.core.evaluateNow();assert.equal(rows(f).length,0);assert.equal(f.core.snapshot().trading.executionBlocker,'TRADING_EXECUTION_DISABLED')})
test('valid plan becomes exactly one workload through scheduler preserving all terms',async t=>{
    const f=await setup(t);await f.core.evaluateNow();assert.equal(rows(f).length,1);const row=rows(f)[0]
    assert.equal(row.status,'ADMITTED');assert.equal(row.source,'AUTONOMOUS_TRADING');assert.equal(row.sourcePlanId,f.plan.planId)
    for(const k of ['maxBuyPricePerItem','targetSellPricePerItem','targetQuantity','itemId'])assert.equal(row[k],f.plan[k])
    assert.equal(row.serverId,1);assert.equal(row.realm,101);assert.equal(f.sent.filter(s=>s.event==='core:economic.assign').length,1)
    const view=f.core.snapshot().trading;assert.equal(view.executionEnabled,true);assert.equal(view.executionBlocker,null);assert.equal(view.plans[0].execution.workloadId,row.workloadId)
})
test('enabled path runs real existing economic mechanics without a second executor',async t=>{const f=await setup(t,{transport:true});await f.core.evaluateNow();await until(()=>rows(f)[0]?.status==='COMPLETED');assert.deepEqual(f.transactions,['buy','list','list']);assert.equal(f.workers[0].runner.workload.read().owner,'core');await f.core.evaluateNow();assert.equal(rows(f).length,1)})
test('HOLD never executes',async t=>{const f=await setup(t);f.plan=observe(f,{spread:false});assert.equal(f.plan.decision,'HOLD');await f.core.evaluateNow();assert.equal(rows(f).length,0)})
test('expired/stale evidence never executes',async t=>{const f=await setup(t);f.plan=observe(f,{at:Date.now()-400000});await f.core.evaluateNow();assert.equal(rows(f).length,0)})
test('superseded identity cannot submit',async t=>{const f=await setup(t),old=f.plan.planId;await newer(f);assert.throws(()=>f.core.economic.submitAutonomous(old,f.core.tradingExecution),/SUPERSEDED/);assert.equal(rows(f).length,0)})
test('disabled item cannot submit',async t=>{const f=await setup(t);f.core.store.setOverride(1,{disabled:true},f.core.store.revision());assert.throws(()=>submit(f),/SUPERSEDED|ITEM_DISABLED/);assert.equal(rows(f).length,0)})
test('purchase commitment risk bound blocks without changing plan quantity',async t=>{const f=await setup(t);policy(f,{autonomousTradingMaxPurchaseValue:19});assert.throws(()=>submit(f),/AUTONOMOUS_PURCHASE_VALUE_LIMIT/);assert.equal(f.core.tradingSnapshot().plans[0].targetQuantity,2)})
test('missing risk limit fails closed',async t=>{const f=await setup(t);f.store.db.exec("UPDATE operationsPolicy SET document=json_remove(document,'$.autonomousTradingMaxPurchaseValue')");assert.throws(()=>submit(f),/AUTONOMOUS_RISK_LIMIT_INVALID/);assert.equal(rows(f).length,0)})
test('invalid risk limits rejected by canonical policy',async t=>{const f=await setup(t);for(const patch of [{autonomousTradingMaxPurchaseValue:0},{autonomousTradingMaxPurchaseValue:null},{autonomousTradingMaxConcurrentWorkloads:0},{autonomousTradingMaxConcurrentWorkloads:101},{autonomousTradingEnabled:1}])assert.throws(()=>policy(f,patch))})
test('concurrent workload cap spans items and includes pending requests',async t=>{const f=await setup(t,{count:2});submit(f);f.store.db.exec(`INSERT INTO itemsData VALUES(2,'Pear','pear','{"minecraftName":"pear"}')`);const second=observe(f,{itemId:2});assert.throws(()=>f.core.economic.submitAutonomous(second.planId,f.core.tradingExecution),/CONCURRENCY_LIMIT/);assert.equal(rows(f).length,1)})
test('same plan repeated evaluates and event delivery do not duplicate dispatch',async t=>{const f=await setup(t);for(let i=0;i<5;i++){f.eventBus.publish('core.market.updated',{});await f.core.evaluateNow()}assert.equal(rows(f).length,1);assert.equal(f.sent.filter(s=>s.event==='core:economic.assign').length,1);assert.equal(submit(f).workloadId,rows(f)[0].workloadId)})
test('restart reconciles admitted work to uncertainty without duplicate',async t=>{
    const f=await setup(t);await f.core.evaluateNow();const id=rows(f)[0].workloadId;await f.core.stop()
    const next=new AutonomousCore({dataBaseManager:{store:f.store},botManager:f.manager,eventBus:f.eventBus,logger,configurationService:{async sync(){}}});next.schedule=()=>{}
    try{await next.start();await next.evaluateNow();assert.equal(next.economic.store.rows().length,1);assert.equal(next.economic.store.get(id).status,'UNCERTAIN');assert.equal(f.sent.filter(s=>s.event==='core:economic.assign').length,1)}finally{await next.stop()}
})
for(const status of ['COMPLETED','FAILED','CANCELLED'])test(`${status} consumes plan; newer evidence may execute`,async t=>{const f=await setup(t);terminal(f,submit(f),status);await f.core.evaluateNow();assert.equal(rows(f).length,1);await newer(f);await f.core.evaluateNow();assert.equal(rows(f).length,2)})
test('policy-only new plan identity cannot reuse purchased market evidence',async t=>{const f=await setup(t);terminal(f,submit(f));f.core.store.setOverride(1,{maxBuyPrice:11},f.core.store.revision());f.plan=f.core.tradingSnapshot().plans[0];assert.notEqual(f.plan.planId,rows(f)[0].sourcePlanId);assert.throws(()=>submit(f),/MARKET_EVIDENCE_ALREADY_USED/)})
test('active item workload blocks newer plans even with spare bot/concurrency',async t=>{const f=await setup(t,{count:2});policy(f,{autonomousTradingMaxConcurrentWorkloads:2});submit(f);await newer(f);assert.throws(()=>submit(f),/ITEM_ECONOMIC_WORKLOAD_BUSY/)})
test('manual pending item workload blocks autonomous execution',async t=>{const f=await setup(t,{count:2});await f.submit();assert.throws(()=>submit(f),/ITEM_ECONOMIC_WORKLOAD_BUSY/)})
test('manual cannot dispatch alongside admitted autonomous work for the item',async t=>{const f=await setup(t,{count:2});const a=submit(f);assert.equal(f.core.economic.dispatch(candidate(f,a)),true);const manual=await f.submit({botId:2});assert.equal(f.core.economic.dispatch(candidate(f,manual,2)),false)})
test('UNCERTAIN blocks new item plans across bots and realms',async t=>{const f=await setup(t,{count:2});terminal(f,submit(f),'UNCERTAIN');await newer(f,{realm:102});assert.throws(()=>submit(f),/ITEM_ECONOMIC_UNCERTAIN/);assert.equal(rows(f).length,1)})
test('unreviewed residual inventory blocks new evidence',async t=>{const f=await setup(t);const row=submit(f);terminal(f,row,'FAILED',{progress:{...row.progress,boughtQuantity:2,listedQuantity:0,purchaseValue:20}});await newer(f);assert.throws(()=>submit(f),/RESIDUAL_INVENTORY_REVIEW_REQUIRED/)})
test('operator review is required and never permits replay of the same identity',async t=>{const f=await setup(t);const row=submit(f);terminal(f,row,'FAILED',{progress:{...row.progress,boughtQuantity:2,listedQuantity:0,purchaseValue:20}});assert.throws(()=>f.core.economic.resolve({workloadId:row.workloadId,note:'Inventory checked externally'},{type:'core',id:'trading'}),/MANUAL_OPERATOR_REQUIRED/);f.core.economic.resolve({workloadId:row.workloadId,note:'Inventory checked externally'},actor);assert.equal(submit(f).workloadId,row.workloadId);await newer(f);assert.ok(submit(f).workloadId!==row.workloadId)})
test('manual executes with autonomous switch disabled and has MANUAL source',async t=>{const f=await fixture(t,{transport:true});const row=await f.run();assert.equal(row.status,'COMPLETED');assert.equal(row.source,'MANUAL')})
test('untrusted actors cannot impersonate autonomous or Web submission',async t=>{const f=await setup(t);for(const who of [null,{type:'core',id:'trading'},{type:'web',id:'operator'}])assert.throws(()=>f.core.economic.submitAutonomous(f.plan.planId,who),/CORE_TRADING_AUTHORITY_REQUIRED/);assert.throws(()=>f.core.economic.submit({...request(),source:'AUTONOMOUS_TRADING'},actor),/INVALID_ECONOMIC_REQUEST/);assert.throws(()=>f.core.economic.submit(request(),{type:'core',id:'trading'}),/MANUAL_OPERATOR_REQUIRED/)})
test('admitted identity index prevents duplicate even under alternate request id',async t=>{const f=await setup(t),row=submit(f);assert.throws(()=>f.core.economic.store.save({...row,workloadId:'duplicate',requestId:'alternate-request'}),/UNIQUE/);assert.equal(rows(f).length,1)})
for(const gate of ['manualHold','notReady','wrongRealm','maintenance','automationDisabled'])test(`readiness gate: ${gate}`,async t=>{const f=await setup(t);if(gate==='manualHold')f.core.store.setControl(1,{manualHold:true});if(gate==='notReady')f.bots.get(1).workReady=false;if(gate==='wrongRealm')f.store.db.exec('UPDATE botData SET realm=102');if(gate==='maintenance')policy(f,{maintenanceMode:true});if(gate==='automationDisabled')policy(f,{automationEnabled:false});assert.throws(()=>submit(f),/NO_ELIGIBLE_RESELLER|MAINTENANCE_MODE|CORE_DISABLED/);assert.equal(rows(f).length,0)})
for(const change of ['disabled','superseded','expired','price','itemDisabled','risk'])test(`dispatch revalidates ${change}`,async t=>{
    const f=await setup(t),row=submit(f)
    if(change==='disabled')policy(f,{autonomousTradingEnabled:false})
    if(change==='superseded')await newer(f)
    if(change==='expired')observe(f,{at:Date.now()-400000})
    if(change==='price')f.core.store.setOverride(1,{maxBuyPrice:9},f.core.store.revision())
    if(change==='itemDisabled')f.core.store.setOverride(1,{disabled:true},f.core.store.revision())
    if(change==='risk')policy(f,{autonomousTradingMaxPurchaseValue:19})
    assert.equal(f.core.economic.dispatch(candidate(f,row)),false);assert.equal(f.sent.filter(s=>s.event==='core:economic.assign').length,0);assert.equal(rows(f)[0].status,'CANCELLED')
})
test('dispatch preserves lifecycle ownership and market placement',async t=>{const f=await setup(t,{count:2}),row=submit(f);f.core.store.setControl(1,{manualHold:true});assert.equal(f.core.economic.dispatch(candidate(f,row)),false);f.store.db.exec('UPDATE botData SET realm=102 WHERE botId=2');assert.equal(f.core.economic.dispatch(candidate(f,row,2)),false);assert.equal(f.sent.length,0)})
test('switch off requests drain of admitted autonomous work',async t=>{const f=await setup(t);await f.core.evaluateNow();policy(f,{autonomousTradingEnabled:false});f.core.economic.reconcile();assert.equal(rows(f)[0].status,'DRAINING');assert.ok(f.sent.some(s=>s.event==='core:economic.cancel'))})
test('enabled capabilities do not advertise disabled execution',()=>{const c=coreCapabilities({autonomousTradingEnabled:true,lifecycleAvailable:true});assert.equal(c.autonomousTradingExecution.supported,true);assert.equal(JSON.stringify(c).includes('TRADING_EXECUTION_DISABLED'),false);assert.equal(c.resellerTrading.supported,true)})
test('admission has no direct mechanics, lifecycle or process executor imports',async()=>{const source=await readFile(new URL('../src/core/tradingExecutionCoordinator.js',import.meta.url),'utf8');assert.doesNotMatch(source,/BotManager|spawn\(|\.startBot\(|\.restartBot\(|resellerBuyer|resellerSeller|sendEvent/);assert.match(source,/economic\.submitAutonomous/)})
test('v14 migration forces switch off, keeps economic history and unique receipt',async t=>{
    const f=await setup(t);terminal(f,submit(f));f.store.db.exec('DROP TABLE IF EXISTS liveValidationFuse; DELETE FROM schemaMigrations WHERE version=16; DROP INDEX economic_source_plan; DROP INDEX economic_autonomous_item; DELETE FROM schemaMigrations WHERE version=15; PRAGMA user_version=14');f.store.close();await f.store.init()
    assert.equal(f.store.prepare('PRAGMA user_version').get().user_version,16);assert.equal(f.core.store.operationsPolicy().autonomousTradingEnabled,false);assert.equal(rows(f).length,1);assert.equal(f.store.prepare('SELECT count(*) n FROM schemaMigrations WHERE version=15').get().n,1)
    const dirs=await readdir(path.join(f.dir,'backups')),db=new DatabaseSync(path.join(f.dir,'backups',dirs[0],'afina-before-v16.db'),{readOnly:true});assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);db.close();f.store.close();await f.store.init();assert.equal((await readdir(path.join(f.dir,'backups'))).length,1);assert.deepEqual(f.store.prepare('PRAGMA foreign_key_check').all(),[])
})
test('v15 migration rollback preserves the old version and can be repaired',async t=>{
    const f=await fixture(t);f.store.db.exec('DROP TABLE IF EXISTS liveValidationFuse; DELETE FROM schemaMigrations WHERE version=16; DROP INDEX economic_source_plan; DROP INDEX economic_autonomous_item; CREATE INDEX economic_source_plan ON economicWorkloads(itemId); DELETE FROM schemaMigrations WHERE version=15; PRAGMA user_version=14');f.store.close();await assert.rejects(f.store.init())
    const db=new DatabaseSync(path.join(f.dir,'afina.db'));assert.equal(db.prepare('PRAGMA user_version').get().user_version,14);assert.equal(db.prepare('SELECT count(*) n FROM schemaMigrations WHERE version=15').get().n,0);db.exec('DROP INDEX economic_source_plan');db.close();await f.store.init();assert.equal(f.store.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(f.core.store.operationsPolicy().autonomousTradingEnabled,false)
})
test('two autonomous opportunities share existing scheduler action limit',async t=>{
    const f=await setup(t,{count:2,limit:1});policy(f,{autonomousTradingMaxConcurrentWorkloads:2});f.store.db.exec(`INSERT INTO itemsData VALUES(2,'Pear','pear','{"minecraftName":"pear"}')`);observe(f,{itemId:2})
    await f.core.evaluateNow();assert.equal(f.sent.filter(s=>s.event==='core:economic.assign').length,1);assert.ok(f.core.lastCycle.economicDispatched<=1)
    await f.core.evaluateNow();assert.equal(rows(f).length,2);assert.equal(f.sent.filter(s=>s.event==='core:economic.assign').length,2)
})
test('zero desired Reseller capacity does not create capacity from a profitable plan',async t=>{const f=await setup(t);policy(f,{roles:{reseller:{target:0}}});assert.throws(()=>submit(f),/RESELLER_CAPACITY_DISABLED/);assert.equal(rows(f).length,0)})
test('zero maxBots and increased sell floor invalidate autonomous admission',async t=>{const f=await setup(t);for(const patch of [{maxBots:0},{maxBots:null,minSellPrice:21}]){f.core.store.setOverride(1,patch,f.core.store.revision());await f.core.evaluateNow();assert.equal(rows(f).length,0)}})
