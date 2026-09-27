import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {readFile,readdir} from 'node:fs/promises'
import path from 'node:path'
import {DatabaseSync,backup} from 'node:sqlite'
import DatabaseStore from '../src/data/databaseStore.js'
import Core from '../src/core/coreMain.js'
import BotManager from '../src/botManager/botManagerMain.js'
import InterfaceGateway from '../src/interfaces/interfaceGateway.js'
import EventBus from '../src/eventBus/eventBusMain.js'
import {sendChat} from '../src/minecraftBot/worker/sendChat.js'
import ResellerTask from '../src/minecraftBot/taskRunner/modes/reseller/resellerTask.js'
import {coreCapabilities} from '../src/core/coreCapabilities.js'
import {fixture,actor,logger,tick,request,until} from './helpers/economicFixture.js'

test('production Reseller ignores configured trading flags on every construction',async()=>{
 for(let n=0;n<3;n++){
  const events=new EventEmitter(),task=new ResellerTask({bot:{botId:1,incarnationId:'run-'+n,client:{chat(){assert.fail('configured trading activated')}}},taskData:{type:'reseller',enabled:1,item:{itemId:1},buyPricePerOne:10,sellPricePerOne:20},manualOnly:false,eventBus:events,logger})
  const done=task.start();await tick();assert.equal(task.state,'idle');assert.equal(task.economicJob,undefined);task.stop();await done;assert.equal(events.listenerCount('core:economic.assign'),0)
 }
})
test('production graph cannot import isolated configured cycle or relisting executors',async()=>{
 async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(file.endsWith('.js'))assert.doesNotMatch(await readFile(file,'utf8'),/from\s+['"][^'"]*(?:tests\/helpers|legacyConfiguredReseller|resellerAuction|auctionRelist)\b/,file)}}
 await walk('src')
 const main=await readFile('src/main.js','utf8');assert.ok(main.indexOf('await core.start()')<main.indexOf('webTerminal.init()'))
})
test('capabilities distinguish manual execution, external reconciliation and retired trading',()=>{
 const c=coreCapabilities({lifecycleAvailable:true});assert.equal(c.manualTradingExecution.status,'SUPPORTED');assert.equal(c.economicReconciliation.status,'PARTIALLY_SUPPORTED')
 for(const key of ['legacyConfiguredTrading','automaticRelisting','healthQuarantine'])assert.equal(c[key].status,'UNSUPPORTED')
})
test('operator console cannot issue auction commands or interfere with unsafe work',()=>{
 const sent=[],bot={status:'running',client:{_client:{state:'play'},chat:text=>sent.push(text)},taskRunner:{workload:{read:()=>({safe:true,uncertain:false})}}}
 for(const command of ['/ah sell 20','/auction relist','/plugin:ah sell 20'])assert.throws(()=>sendChat(bot,command,false,null,true))
 bot.taskRunner.workload.read=()=>({safe:false,uncertain:false});assert.throws(()=>sendChat(bot,'/hub',false,null,true))
 bot.taskRunner.workload.read=()=>({safe:true,uncertain:true});assert.throws(()=>sendChat(bot,'/an101',false,null,true))
 sendChat(bot,'hello',false,null,true);assert.deepEqual(sent,['hello'])
})
for(const options of [{lots:[4],targetQuantity:10,listing:'full'},{lots:[4],targetQuantity:4,listing:['success','success','full']}])test('proven partial inventory requires review without rewriting economic evidence '+options.targetQuantity,async t=>{
 const f=await fixture(t,{transport:true,...options}),r=await f.run({targetQuantity:options.targetQuantity,botId:1}),before=structuredClone(r)
 assert.equal(r.progress.boughtQuantity,4);const o=f.core.economic.snapshot().workloads[0].operator
 assert.equal(o.reviewKind,'RESIDUAL');assert.equal(o.attributedRemainingQuantity,4-r.progress.listedQuantity);assert.equal(o.admissionReason,'RESIDUAL_INVENTORY_REVIEW_REQUIRED')
 const result=await f.commands.execute({command:'core.economic.resolve',payload:{workloadId:r.workloadId,note:'Checked inventory and auction externally'},actor});assert.equal(result.ok,true,JSON.stringify(result))
 const after=f.core.economic.store.get(r.workloadId);assert.deepEqual(after.progress,before.progress);assert.equal(after.status,before.status);assert.equal(after.result,before.result);assert.equal(after.evidenceAt,before.evidenceAt);assert.equal(after.residualReview.actorId,actor.id)
 assert.equal(f.core.economic.snapshot().workloads[0].operator.reviewRequired,false)
 const next=await f.run({requestId:'after-review-1',botId:1});assert.equal(next.reason,'EXISTING_TARGET_INVENTORY');assert.equal(f.transactions.filter(x=>x==='buy').length,1)
})
test('existing target inventory is unrelated evidence and is never sold or discarded',async t=>{
 const f=await fixture(t,{transport:true});f.workers[0].client.inventory.slots[9]={name:'apple',count:3,slot:9}
 const r=await f.run(),o=f.core.economic.snapshot().workloads[0].operator
 assert.equal(r.reason,'EXISTING_TARGET_INVENTORY');assert.equal(o.unrelatedInventoryAtStart,3);assert.equal(o.attributedRemainingQuantity,null);assert.equal(o.observedMatchingInventory,3);assert.deepEqual(f.transactions,[]);assert.equal(f.workers[0].client.inventory.slots[9].count,3)
})
for(const boundary of ['inventory unlock','hotbar selection'])test('unrelated item arriving at '+boundary+' cannot be discarded or listed',async t=>{
 const f=await fixture(t,{transport:true}),w=f.workers[0],unrelated={name:'diamond',count:1,slot:36}
 if(boundary==='inventory unlock')w.bot.waitForInventoryUnlock=async()=>{w.client.inventory.slots[36]=unrelated;return true}
 else w.client.setQuickBarSlot=()=>{w.client.inventory.slots[36]=unrelated}
 await f.run();assert.equal(w.client.inventory.slots[36],unrelated);assert.equal(f.transactions.filter(x=>x==='list').length,0)
})
test('unknown resolution requires observed old executor absence and never clears worker safety',async t=>{
 const f=await fixture(t,{transport:true,purchase:'throw'}),r=await f.run(),progress=structuredClone(r.progress)
 assert.equal(r.status,'UNCERTAIN');assert.equal(f.core.economic.snapshot().workloads[0].operator.canResolve,false)
 const actual=f.core.readActual.bind(f.core);f.core.readActual=()=>({...actual(),bots:[]});assert.throws(()=>f.core.economic.resolve({workloadId:r.workloadId,note:'Checked external inventory'},actor),/OLD_EXECUTOR/);f.core.readActual=actual
 f.runtimes.get(1).running=false;f.core.economic.resolve({workloadId:r.workloadId,note:'Checked external inventory'},actor)
 const after=f.core.economic.store.get(r.workloadId);assert.deepEqual(after.progress,progress);assert.equal(after.result,'OPERATOR_ACKNOWLEDGED_UNKNOWN');assert.equal(f.workers[0].runner.workload.read().safe,false)
 f.runtimes.get(1).running=true;assert.equal(f.core.economic.snapshot().botReadiness[0].eligible,false);await f.core.evaluateNow();assert.equal(f.transactions.length,1)
})
test('additional matching inventory arriving before listing is not attributed or sold',async t=>{
 const f=await fixture(t,{transport:true}),w=f.workers[0]
 w.client.setQuickBarSlot=()=>{w.client.inventory.slots[10]={name:'apple',count:3,slot:10}}
 const row=await f.run();assert.equal(row.progress.boughtQuantity,2);assert.equal(row.progress.listedQuantity,0);assert.equal(f.transactions.filter(x=>x==='list').length,0)
 assert.equal(f.core.economic.snapshot().workloads[0].operator.attributedRemainingQuantity,null);assert.equal(w.client.inventory.slots[10].count,3)
})
for(const status of ['ADMITTED','RUNNING','DRAINING','UNCERTAIN'])test('startup retains '+status+' history without dispatch replay',async t=>{
 const f=await fixture(t),r=await f.run();f.core.economic.store.save({...r,status});f.core.economic.restore();await f.core.evaluateNow();assert.equal(f.core.economic.store.get(r.workloadId).status,'UNCERTAIN');assert.equal(f.sent.filter(x=>x.event==='core:economic.assign').length,1)
})
test('pending operator request survives recovery and is dispatched exactly once',async t=>{
 const f=await fixture(t,{transport:true}),r=await f.submit();f.core.economic.restore();assert.equal(f.core.economic.store.get(r.workloadId).status,'PENDING');await f.core.evaluateNow();await tick();await f.core.evaluateNow();assert.equal(f.sent.filter(x=>x.event==='core:economic.assign').length,1)
})
test('temporary v11 backup retains complete data; failed upgrade can be repaired and reopened',async t=>{
 const f=await fixture(t),r=await f.run(),config={databasePath:path.join(f.dir,'upgrade.db')}
 f.core.actions.ledger.reserve({type:'START',logicalKey:'migration-retained-action',botId:1,accountId:1,role:'reseller',policyRevision:1,desiredRevision:1,inputRevision:1,deadlineAt:Date.now()+60000})
 await backup(f.store.db,config.databasePath)
 let db=new DatabaseSync(config.databasePath);db.exec('DROP TABLE IF EXISTS liveValidationFuse; DELETE FROM schemaMigrations WHERE version=16; DROP INDEX IF EXISTS economic_source_plan; DROP INDEX IF EXISTS economic_autonomous_item; DELETE FROM schemaMigrations WHERE version=15; DROP TABLE tradingPlans; DELETE FROM schemaMigrations WHERE version=14; DROP TABLE proxyDiagnostics; DROP TABLE proxyReservations; DROP TABLE proxies; ALTER TABLE telegramAccounts DROP COLUMN active; DELETE FROM schemaMigrations WHERE version=13; DROP TABLE economicWorkloads; DELETE FROM schemaMigrations WHERE version=12; PRAGMA user_version=11; CREATE TABLE economicWorkloads(bad INTEGER)');db.close()
 let upgraded=new DatabaseStore(config);await assert.rejects(upgraded.init());upgraded.close()
 db=new DatabaseSync(config.databasePath);assert.equal(db.prepare('PRAGMA user_version').get().user_version,11);assert.equal(db.prepare('SELECT count(*) n FROM schemaMigrations WHERE version=12').get().n,0);db.exec('DROP TABLE economicWorkloads');db.close()
 upgraded=new DatabaseStore(config);await upgraded.init()
 try{
  for(const table of ['accountsData','tasksData','coreActions'])assert.deepEqual(upgraded.prepare('SELECT * FROM '+table).all(),f.store.prepare('SELECT * FROM '+table).all())
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
  const backups=await readdir(path.join(f.dir,'backups'));assert.ok(backups.length>=1)
  for(const dir of backups){const backup=new DatabaseSync(path.join(f.dir,'backups',dir,'afina-before-v16.db'),{readOnly:true});assert.equal(backup.prepare('SELECT count(*) n FROM accountsData').get().n,1);assert.equal(backup.prepare('SELECT count(*) n FROM tasksData').get().n,1);backup.close()}
  const serialized=JSON.stringify(r);upgraded.prepare('INSERT INTO economicWorkloads VALUES(?,?,?,?,?,?,?,?)').run(r.workloadId,r.requestId,r.itemId,r.botId,'UNCERTAIN',r.createdAt,r.updatedAt,serialized)
 }finally{upgraded.close()}
 upgraded=new DatabaseStore(config);await upgraded.init();try{assert.equal(upgraded.prepare('SELECT status FROM economicWorkloads').get().status,'UNCERTAIN');assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version,16)}finally{upgraded.close()}
})
test('real Core and BotManager install lifecycle ownership before startup admission',async t=>{
 const f=await fixture(t);await f.core.stop()
 const eventBus=new EventBus({logger}),manager=new BotManager({logger,eventBus,dataBaseManager:{store:f.store}}),facade=new Core({logger,eventBus,botManager:manager,dataBaseManager:{store:f.store},configurationService:{async sync(){}}})
 facade.autonomy.schedule=()=>{}
 try{assert.equal(manager.lifecycle,facade.autonomy.lifecycle);await facade.start();await assert.rejects(manager.startBot(1),/LIFECYCLE|ACTION/);assert.equal(manager.bots.size,0);assert.equal(facade.autonomy.readActual().bots[0].observationQuality,'PROCESS_MISSING')}
 finally{await facade.stop()}
})
for(const scenario of ['success','partial','cancelled','uncertain'])test('operator gateway through real Core and mechanics produces durable '+scenario+' UI evidence',async t=>{
 let f;f=await fixture(t,{transport:true,listing:scenario==='partial'?'full':'success',purchase:scenario==='uncertain'?'throw':'success',onConfirm:scenario==='cancelled'?()=>{const row=f.core.economic.store.rows()[0];f.core.economic.cancel(row.workloadId)}:null})
 const gateway=new InterfaceGateway({core:f.facade,eventBus:f.eventBus,logger}),response=await gateway.handleRequest({type:'command',name:'core.economic.submit',payload:request()},actor)
 assert.equal(response.ok,true,JSON.stringify(response));await f.core.evaluateNow()
 const expected={success:'COMPLETED',partial:'FAILED',cancelled:'CANCELLED',uncertain:'UNCERTAIN'}[scenario]
 await until(()=>f.core.economic.store.get(response.data.workloadId).status===expected)
 const snapshot=await gateway.handleRequest({type:'query',name:'core.getSnapshot'},actor);assert.equal(snapshot.ok,true,JSON.stringify(snapshot));assert.equal(snapshot.data.economic.workloads[0].status,expected)
 assert.equal(f.sent.filter(x=>x.event==='core:economic.assign').length,1)
})
