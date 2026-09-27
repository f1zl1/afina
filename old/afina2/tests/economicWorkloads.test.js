import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {DatabaseSync} from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import DatabaseStore from '../src/data/databaseStore.js'
import AutonomousCore from '../src/core/autonomousCore.js'
import CommandService from '../src/core/commandService.js'
import EventBus from '../src/eventBus/eventBusMain.js'
import BotTaskRunner from '../src/minecraftBot/taskRunner/botTaskRunner.js'
import WorkerWorkload from '../src/workloads/workerWorkload.js'
import {economicTerminal,economicRequest} from '../src/workloads/economicContract.js'
import {fixtureObservation} from './helpers/fixtureObservation.js'
import {normalizeWorkerEvent} from '../src/events/workerEventNormalizer.js'
import {coreCapabilities} from '../src/core/coreCapabilities.js'

import {fixture,logger,actor,request,tick,until} from './helpers/economicFixture.js'

test('operator command → scheduler → workload boundary → real buy/list mechanics → durable Core result',async t=>{
 const f=await fixture(t,{transport:true}),row=await f.run()
 assert.equal(row.status,'COMPLETED');assert.deepEqual(f.transactions,['buy','list','list']);assert.equal(row.progress.boughtQuantity,2);assert.equal(row.progress.listedQuantity,2);assert.equal(row.progress.purchaseValue,20);assert.equal(row.progress.soldQuantity,null);assert.equal(row.progress.receivedAmount,null);assert.equal(row.progress.remainingInventory,0)
 assert.equal(f.core.actions.ledger.active().length,0);assert.equal(f.core.lastCycle.economicDispatched,1);assert.ok(f.results.every(r=>r.lifecycleEpoch===0&&r.workloadGeneration===1&&r.incarnationId==='fixture-101'))
})
for(const patch of [{itemId:9},{itemId:-1},{maxBuyPricePerItem:0},{targetSellPricePerItem:NaN},{targetQuantity:0},{targetQuantity:65},{targetQuantity:1.5},{maxBuyPricePerItem:1000000000,targetQuantity:2},{unknown:true}])test('reject invalid manual contract '+JSON.stringify(patch),async t=>{
 const f=await fixture(t),result=await f.commands.execute({command:'core.economic.submit',payload:request(patch),actor});assert.equal(result.ok,false);assert.equal(f.core.economic.store.rows().length,0)
})
test('explicit ineligible bot and manual hold are rejected; automatic selection uses another ready reseller',async t=>{
 const f=await fixture(t,{count:2});f.core.userControlsBot(1)
 assert.equal((await f.commands.execute({command:'core.economic.submit',payload:request({botId:1}),actor})).ok,false)
 const row=await f.run();assert.equal(row.botId,2)
})
test('manual permission does not enable autonomous trading or internal submissions',async t=>{
 const f=await fixture(t)
 for(const who of [null,{type:'internal',id:'market'},{type:'system',id:'core'}])assert.equal((await f.commands.execute({command:'core.economic.submit',payload:request(),actor:who})).ok,false)
 const c=coreCapabilities();assert.equal(c.manualTradingExecution.supported,true);assert.equal(c.autonomousTradingExecution.supported,true);assert.equal(c.autonomousTradingExecution.blocker,'TRADING_EXECUTION_DISABLED');assert.equal(c.resellerTrading.supported,false)
 await f.core.evaluateNow();assert.equal(f.core.economic.store.rows().length,0);assert.equal(f.sent.length,0)
})
test('an older configured-cycle worker cannot accept manual economic admission',async t=>{
 const f=await fixture(t);f.bots.get(1).workload.manualEconomicSupported=false
 const r=await f.commands.execute({command:'core.economic.submit',payload:request({botId:1}),actor});assert.equal(r.ok,false);assert.equal(r.error.message,'WORKLOAD_BOUNDARY_UNAVAILABLE');assert.equal(f.sent.length,0)
})
test('one durable request identity survives retries and rejects different terms',async t=>{
 const f=await fixture(t),a=await f.submit(),b=await f.submit();assert.equal(a.workloadId,b.workloadId)
 assert.equal((await f.commands.execute({command:'core.economic.submit',payload:request({targetQuantity:3}),actor})).ok,false)
 await f.core.evaluateNow();await f.submit();await f.core.evaluateNow();assert.equal(f.sent.filter(s=>s.event==='core:economic.assign').length,1)
})
test('bounded scheduler fairly admits independent economic workloads',async t=>{
 const f=await fixture(t,{count:4,limit:1})
 for(let id=1;id<=4;id++)await f.submit({requestId:'request-'+id,botId:id})
 for(let n=0;n<8;n++){await f.core.evaluateNow();assert.ok(f.core.lastCycle.candidatesConsidered<=1);assert.ok(f.core.lastCycle.workloadDispatched<=1)}
 assert.equal(new Set(f.sent.filter(s=>s.event==='core:economic.assign').map(s=>s.botId)).size,4)
})
test('partial purchase preserves four of ten when another bounded lot is unavailable',async t=>{
 const f=await fixture(t,{transport:true,lots:[4]}),r=await f.run({targetQuantity:10});assert.equal(r.status,'FAILED');assert.equal(r.progress.boughtQuantity,4);assert.equal(r.progress.listedQuantity,4);assert.equal(r.result,'PARTIAL');assert.equal(r.reason,'PRICE_UNAVAILABLE')
})
test('oversized lot cannot exceed the requested quantity',async t=>{
 const f=await fixture(t,{transport:true,lots:[4]}),r=await f.run({targetQuantity:2});assert.equal(r.status,'FAILED');assert.deepEqual(f.transactions,[])
})
test('listing rejection preserves the proven purchase and remaining inventory',async t=>{
 const f=await fixture(t,{transport:true,listing:'storage_full'}),r=await f.run();assert.equal(r.status,'FAILED');assert.equal(r.progress.boughtQuantity,2);assert.equal(r.progress.listedQuantity,0);assert.equal(r.progress.remainingInventory,2)
})
test('cancellation before admission cannot transact',async t=>{
 const f=await fixture(t,{transport:true}),row=await f.submit();f.core.economic.cancel(row.workloadId);await f.core.evaluateNow();assert.equal(f.core.economic.store.get(row.workloadId).status,'CANCELLED');assert.equal(f.transactions.length,0)
})
test('partial listing keeps only acknowledged listings and verified inventory',async t=>{
 const f=await fixture(t,{transport:true,lots:[4],listing:['success','success','storage_full']}),r=await f.run({targetQuantity:4});assert.equal(r.status,'FAILED');assert.equal(r.progress.boughtQuantity,4);assert.equal(r.progress.listedQuantity,2);assert.equal(r.progress.remainingInventory,2)
})
test('pre-existing inventory cannot be sold or mixed into manual accounting',async t=>{
 const f=await fixture(t,{transport:true});f.workers[0].client.inventory.slots[9]={name:'apple',count:3,slot:9};const r=await f.run();assert.equal(r.status,'FAILED');assert.equal(r.reason,'EXISTING_TARGET_INVENTORY');assert.equal(f.transactions.length,0)
})
test('relist uncertainty blocks admission and ordinary safe stop',async t=>{
 const f=await fixture(t,{transport:true});f.workers[0].bot.lifecycleUncertain='RELIST_RESULT_UNCERTAIN'
 assert.equal((await f.commands.execute({command:'core.economic.submit',payload:request({botId:1}),actor})).ok,false)
 const evidence=await f.workers[0].runner.quiesce({actionId:'stop'});assert.equal(evidence.safe,false);assert.equal(evidence.reason,'RELIST_RESULT_UNCERTAIN')
})
test('Analyst and manual economic demand share bounded fair admission',async t=>{
 const f=await fixture(t,{count:2,limit:1});f.store.prepare("UPDATE tasksData SET type='analyst' WHERE botId=1").run()
 f.core.store.updateOperationsPolicy({automationEnabled:true,capacity:{maximum:2},roles:{analyst:{target:1,maximum:1},reseller:{target:1,maximum:1}}},f.core.store.operationsPolicy().revision)
 f.core.updatePolicy({expectedRevision:f.core.store.revision(),values:{autoAnalysis:true}});await f.submit({botId:2})
 for(let n=0;n<6;n++){await f.core.evaluateNow();assert.ok(f.core.lastCycle.dispatched+f.core.lastCycle.workloadDispatched<=1)}
 assert.ok(f.sent.some(s=>s.event==='core:analysis.assign'));assert.ok(f.sent.some(s=>s.event==='core:economic.assign'))
})
test('cancellation in purchase drains verification and preserves bought inventory without listing',async t=>{
 let f;f=await fixture(t,{transport:true,onConfirm:()=>{const r=f.core.economic.store.rows()[0];f.core.economic.cancel(r.workloadId)}})
 const r=await f.run();assert.equal(r.status,'CANCELLED');assert.equal(r.progress.boughtQuantity,2);assert.equal(r.progress.listedQuantity,0);assert.deepEqual(f.transactions,['buy'])
})
test('cancellation in listing waits for its acknowledgement and preserves partial listing',async t=>{
 let f;f=await fixture(t,{transport:true,onListing:()=>f.core.economic.cancel(f.core.economic.store.rows()[0].workloadId)})
 const r=await f.run();assert.equal(r.status,'CANCELLED');assert.equal(r.progress.boughtQuantity,2);assert.equal(r.progress.listedQuantity,1);assert.equal(r.progress.remainingInventory,1);assert.deepEqual(f.transactions,['buy','list'])
})
test('Core restart drains a surviving executor while retaining uncertainty and no replay',async t=>{
 const f=await fixture(t),r=await f.run();f.core.economic.restore();assert.equal(f.core.economic.store.get(r.workloadId).status,'UNCERTAIN');assert.ok(f.sent.some(s=>s.event==='core:economic.cancel'&&s.payload.workloadId===r.workloadId));await f.core.evaluateNow();assert.equal(f.sent.filter(s=>s.event==='core:economic.assign').length,1)
})
test('a new observed role generation fences the old job and prevents automatic recovery replay',async t=>{
 const f=await fixture(t),r=await f.run();f.bots.get(1).workload.generation=2;f.core.economic.reconcile();assert.equal(f.core.economic.store.get(r.workloadId).status,'UNCERTAIN');assert.equal(f.core.economic.store.get(r.workloadId).reason,'EXECUTOR_LOST');await f.core.evaluateNow();assert.equal(f.sent.filter(s=>s.event==='core:economic.assign').length,1)
})
for(const options of [{purchase:'timeout'},{purchase:'throw'},{listing:'timeout'}])test('uncertain economic result is never blindly replayed '+JSON.stringify(options),async t=>{
 const f=await fixture(t,{transport:true,...options}),r=await f.run();assert.equal(r.status,'UNCERTAIN');assert.equal(r.progress.certainty,'UNCERTAIN');const before=f.transactions.length
 f.core.economic.restore();await f.core.evaluateNow();await f.submit();assert.equal(f.transactions.length,before);assert.equal(f.workers[0].runner.workload.read().safe,false)
})
test('admitted crash/restart becomes uncertain; pending request remains safe to admit',async t=>{
 const f=await fixture(t,{count:2}),r=await f.run({botId:1});await f.submit({requestId:'pending-two',botId:2});f.core.economic.restore()
 assert.equal(f.core.economic.store.get(r.workloadId).status,'UNCERTAIN');assert.equal(f.core.economic.store.request('pending-two').status,'PENDING');await f.core.evaluateNow();assert.equal(f.sent.filter(s=>s.botId===1&&s.event==='core:economic.assign').length,1)
})
for(const mismatch of ['incarnationId','workloadGeneration','lifecycleEpoch','workloadId'])test('stale result rejected: '+mismatch,async t=>{
 const f=await fixture(t),r=await f.run(),payload={workloadId:r.workloadId,incarnationId:r.incarnationId,workloadGeneration:r.workloadGeneration,lifecycleEpoch:r.lifecycleEpoch,sequence:1,status:'COMPLETED',progress:{boughtQuantity:2,listedQuantity:2,purchaseValue:20,remainingInventory:0}}
 payload[mismatch]=typeof payload[mismatch]==='number'?999:'stale';f.eventBus.publish('bot.economic.result',payload,{kind:'bot',botId:1,workerPid:101});assert.equal(f.core.economic.store.get(r.workloadId).status,'ADMITTED')
})
for(const cause of ['STOP','REPLACE','manual restart','configuration restart','binding continuation','recovery'])test(cause+' fences economic execution and requests drain',async t=>{
 const f=await fixture(t),r=await f.run()
 if(cause==='STOP'||cause==='REPLACE')f.core.actions.ledger.reserve({type:cause,logicalKey:'bot:1',botId:1,accountId:1,role:'reseller',policyRevision:f.core.store.operationsPolicy().revision,desiredRevision:1,inputRevision:f.core.store.revision(),deadlineAt:Date.now()+10000})
 else if(cause==='manual restart')f.core.userControlsBot(1)
 else f.runtimes.get(1).configuration={restartRequired:true}
 f.core.economic.reconcile();assert.equal(f.core.economic.store.get(r.workloadId).status,'DRAINING');assert.ok(f.sent.some(s=>s.event==='core:economic.cancel'));assert.equal(f.core.economic.eligible(f.core.readActual().bots[0])!==null,true)
})
test('same-boundary graceful stop waits for an economic operation and requires safe evidence',async t=>{
 let release;const gate=new Promise(r=>release=r);const f=await fixture(t,{transport:true,onConfirm:()=>gate}),r=await f.submit();await f.core.evaluateNow();await until(()=>f.transactions.includes('buy'))
 const drain=f.workers[0].runner.quiesce({actionId:'stop'});await tick();assert.equal(f.workers[0].runner.workload.read().safe,false);release();const evidence=await drain
 assert.equal(evidence.safe,true);assert.equal(f.core.economic.store.get(r.workloadId).status,'CANCELLED');assert.equal(f.core.economic.store.get(r.workloadId).progress.boughtQuantity,2)
})
test('application shutdown drains admitted work and never replays it',async t=>{
 const f=await fixture(t),r=await f.run();await f.core.stop();assert.equal(f.core.economic.store.get(r.workloadId).status,'DRAINING');assert.ok(f.sent.some(s=>s.event==='core:economic.cancel'));f.core.economic.restore();assert.equal(f.core.economic.store.get(r.workloadId).status,'UNCERTAIN')
})
test('operator resolution preserves uncertainty and cannot release a live old executor',async t=>{
 const f=await fixture(t),r=await f.run();f.core.economic.restore();assert.throws(()=>f.core.economic.resolve({workloadId:r.workloadId,note:'Inventory checked externally'},actor),/OLD_EXECUTOR/)
 f.runtimes.get(1).running=false;const resolved=f.core.economic.resolve({workloadId:r.workloadId,note:'Inventory checked externally'},actor);assert.equal(resolved.status,'CANCELLED');assert.equal(resolved.progress.certainty,'UNCERTAIN');assert.equal(resolved.result,'OPERATOR_ACKNOWLEDGED_UNKNOWN')
})
test('v11 → v12 backup, transactional schema, integrity, durable results and idempotent reopen',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'afina-v12-')),config={databasePath:path.join(dir,'afina.db')};let store=new DatabaseStore(config)
 try{await store.init();store.db.exec('DROP TABLE IF EXISTS liveValidationFuse; DELETE FROM schemaMigrations WHERE version=16; DROP INDEX IF EXISTS economic_source_plan; DROP INDEX IF EXISTS economic_autonomous_item; DELETE FROM schemaMigrations WHERE version=15; DROP TABLE tradingPlans; DELETE FROM schemaMigrations WHERE version=14; DROP TABLE proxyDiagnostics; DROP TABLE proxyReservations; DROP TABLE proxies; ALTER TABLE telegramAccounts DROP COLUMN active; DELETE FROM schemaMigrations WHERE version=13; DROP TABLE economicWorkloads; DELETE FROM schemaMigrations WHERE version=12; PRAGMA user_version=11');store.close();store=new DatabaseStore(config);await store.init()
  assert.equal(store.prepare('PRAGMA user_version').get().user_version,16);assert.deepEqual(store.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(store.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
  const backups=await readdir(path.join(dir,'backups'));const backup=new DatabaseSync(path.join(dir,'backups',backups[0],'afina-before-v16.db'),{readOnly:true});assert.equal(backup.prepare('PRAGMA user_version').get().user_version,11);assert.equal(backup.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='economicWorkloads'").get().n,0);backup.close()
  store.db.exec(`INSERT INTO itemsData VALUES(1,'Apple','apple','{}');INSERT INTO economicWorkloads VALUES('w','request-key',1,NULL,'UNCERTAIN',1,1,'{"workloadId":"w","progress":{"boughtQuantity":4}}')`);store.close();store=new DatabaseStore(config);await store.init();assert.equal(store.prepare("SELECT status FROM economicWorkloads WHERE workloadId='w'").get().status,'UNCERTAIN');assert.equal((await readdir(path.join(dir,'backups'))).length,1)
 }finally{store.close();await rm(dir,{recursive:true,force:true})}
})
test('failed v12 migration rolls back the version and migration receipt',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'afina-v12-failure-')),config={databasePath:path.join(dir,'afina.db')};let store=new DatabaseStore(config)
 try{await store.init();store.db.exec('DROP TABLE IF EXISTS liveValidationFuse; DELETE FROM schemaMigrations WHERE version=16; DROP INDEX IF EXISTS economic_source_plan; DROP INDEX IF EXISTS economic_autonomous_item; DELETE FROM schemaMigrations WHERE version=15; DROP TABLE tradingPlans; DELETE FROM schemaMigrations WHERE version=14; DROP TABLE proxyDiagnostics; DROP TABLE proxyReservations; DROP TABLE proxies; ALTER TABLE telegramAccounts DROP COLUMN active; DELETE FROM schemaMigrations WHERE version=13; DROP TABLE economicWorkloads; CREATE TABLE economicWorkloads(bad INTEGER); DELETE FROM schemaMigrations WHERE version=12; PRAGMA user_version=11');store.close();store=new DatabaseStore(config);await assert.rejects(store.init())
  const db=new DatabaseSync(config.databasePath);assert.equal(db.prepare('PRAGMA user_version').get().user_version,11);assert.equal(db.prepare('SELECT count(*) n FROM schemaMigrations WHERE version=12').get().n,0);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close()
 }finally{store.close();await rm(dir,{recursive:true,force:true})}
})
