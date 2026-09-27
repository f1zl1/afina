import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {DatabaseSync} from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import DataBaseManager from '../src/data/dataBaseManagerMain.js'
import ActionLedger from '../src/core/actionLedger.js'
import {transitionAccounting} from '../src/core/transitionAccounting.js'
import AutonomousCore from '../src/core/autonomousCore.js'
import EventBus from '../src/eventBus/eventBusMain.js'
import {fixtureObservation} from './helpers/fixtureObservation.js'

const logger={child(){return this},info(){},warn(){},error(){}}
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'afina-actions-')),db=new DataBaseManager({config:{databasePath:path.join(dir,'afina.db')},logger});await db.init()
 const ledger=new ActionLedger({store:db.store}),cores=[]
 t.after(async()=>{for(const c of cores)await c.stop();db.close();await rm(dir,{recursive:true,force:true})})
 const reserve=(values={})=>ledger.reserve({type:'START',logicalKey:'bot:1',botId:1,accountId:1,role:'analyst',quantity:1,policyRevision:1,desiredRevision:1,inputRevision:1,deadlineAt:Date.now()+60000,...values}).action
 return {dir,db,ledger,reserve,cores}
}
const observed=(bots=[],actions=[])=>({bots,roles:{analyst:bots.filter(b=>b.workReady&&b.role==='analyst').length,reseller:0},accounts:{available:0,total:1},observation:{actions,generationResults:[],pending:{replacements:{rows:[]}}}})
const ready={botId:1,accountId:1,role:'analyst',workReady:true,incarnationId:'new',observationQuality:'FRESH',task:{type:'analyst'},activeTask:{type:'analyst'},running:true}

test('atomic active resource uniqueness rejects START/STOP and shared account conflicts; retry is a new attempt',async t=>{
 const f=await fixture(t),a=f.reserve()
 assert.equal(f.reserve().actionId,a.actionId)
 assert.throws(()=>f.reserve({logicalKey:'stop:1',type:'STOP'}),/ACTIVE_CONFLICTING_ACTION/)
 assert.throws(()=>f.reserve({logicalKey:'bot:2',botId:2}),/ACTIVE_CONFLICTING_ACTION/)
 f.ledger.transition(a.actionId,'CANCELLED','TEST')
 assert.equal(f.ledger.resources().length,0)
 const b=f.reserve();assert.equal(b.attempt,2);assert.notEqual(a.idempotencyKey,b.idempotencyKey)
 assert.throws(()=>f.db.query('UPDATE coreActions SET state=? WHERE actionId=?').run('INVALID',b.actionId),/CHECK/)
})

test('observation repairs lost START completion and terminal state cannot be overwritten by late callbacks',async t=>{
 const f=await fixture(t),a=f.reserve();f.ledger.transition(a.actionId,'DISPATCHED')
 f.ledger.reconcile(observed([ready]),{policyRevision:1})
 assert.equal(f.ledger.get(a.actionId).state,'COMPLETED');assert.equal(f.ledger.active().length,0)
 f.ledger.transition(a.actionId,'FAILED','LATE');assert.equal(f.ledger.get(a.actionId).state,'COMPLETED')
})

test('recorded incarnation mismatch never proves START success',async t=>{
 const f=await fixture(t),a=f.reserve({metadata:{incarnationId:'expected'}})
 f.ledger.transition(a.actionId,'DISPATCHED');f.ledger.reconcile(observed([ready]),{policyRevision:1})
 assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED')
})

test('expiry releases stale START reservation without treating live unready worker as stopped',async t=>{
 const f=await fixture(t),a=f.reserve();f.ledger.transition(a.actionId,'DISPATCHED')
 const actual=observed([{...ready,workReady:false,role:null}])
 f.ledger.reconcile(actual,{policyRevision:1,now:a.deadlineAt+1})
 assert.equal(f.ledger.get(a.actionId).state,'EXPIRED');assert.equal(f.ledger.resources().length,0);assert.equal(actual.bots[0].running,true)
})

test('policy change cancels RESERVED but preserves accepted START transition',async t=>{
 const f=await fixture(t),a=f.reserve()
 f.ledger.reconcile(observed([{...ready,workReady:false}]),{policyRevision:2});assert.equal(f.ledger.get(a.actionId).state,'CANCELLED')
 const b=f.reserve();f.ledger.transition(b.actionId,'DISPATCHED');f.ledger.transition(b.actionId,'RUNNING')
 f.ledger.reconcile(observed([{...ready,workReady:false}]),{policyRevision:2});assert.equal(f.ledger.get(b.actionId).state,'RUNNING')
})

test('STOP completes only on process absence, never on temporary unavailable facts',async t=>{
 const f=await fixture(t),a=f.reserve({type:'STOP'});f.ledger.transition(a.actionId,'DISPATCHED')
 f.ledger.reconcile(observed([{...ready,observationQuality:'UNAVAILABLE'}]),{policyRevision:1});assert.equal(f.ledger.active().length,1)
 f.ledger.reconcile(observed([{...ready,workReady:false,observationQuality:'PROCESS_MISSING'}]),{policyRevision:1});assert.equal(f.ledger.get(a.actionId).state,'COMPLETED')
})

test('generation transaction correlates accounts and recovers a crash before action completion',async t=>{
 const f=await fixture(t),a=f.reserve({type:'GENERATE',logicalKey:'generation',botId:null,accountId:null,quantity:2})
 f.ledger.transition(a.actionId,'DISPATCHED')
 const accounts=f.db.createGeneratedAccounts(2,undefined,null,a.actionId)
 f.db.close();await f.db.init()
 const recovered=new ActionLedger({store:f.db.store})
 recovered.reconcile(observed(),{policyRevision:1,startup:true})
 assert.equal(recovered.get(a.actionId).state,'COMPLETED');assert.equal(recovered.get(a.actionId).created,2)
 assert.deepEqual(f.db.createGeneratedAccounts(2,()=>assert.fail('must not generate'),null,a.actionId).map(a=>a.accountId),accounts.map(a=>a.accountId))
 assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,2)
 assert.throws(()=>f.db.createGeneratedAccounts(1,undefined,null,a.actionId),/GENERATION_REQUEST_CONFLICT/)
 assert.equal(JSON.stringify(recovered.get(a.actionId)).includes('password'),false)
})

test('generation is all-or-nothing including correlation and callback failure',async t=>{
 const f=await fixture(t),a=f.reserve({type:'GENERATE',logicalKey:'generation',botId:null,accountId:null,quantity:2});f.ledger.transition(a.actionId,'DISPATCHED')
 assert.throws(()=>f.db.createGeneratedAccounts(2,undefined,()=>{throw new Error('crash')},a.actionId),/crash/)
 assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,0)
 assert.equal(f.db.query('SELECT count(*) n FROM coreGenerationResults').get().n,0)
 f.ledger.transition(a.actionId,'EXPIRED','ACTION_TIMEOUT')
 assert.throws(()=>f.db.createGeneratedAccounts(2,undefined,null,a.actionId),/ACTION_NOT_ACTIVE/)
})

for(const state of ['RESERVED','DISPATCHED','COMPLETED'])test('restart boundary '+state+' never blindly redispatches generation',async t=>{
 const f=await fixture(t),a=f.reserve({type:'GENERATE',logicalKey:'generation',botId:null,accountId:null})
 if(state!=='RESERVED')f.ledger.transition(a.actionId,'DISPATCHED')
 if(state==='COMPLETED'){f.db.createGeneratedAccounts(1,undefined,null,a.actionId);f.ledger.transition(a.actionId,'COMPLETED',null,{created:1})}
 f.db.close();await f.db.init();f.ledger.reconcile(observed(),{policyRevision:1,startup:true})
 assert.equal(f.ledger.get(a.actionId).state,state==='RESERVED'?'CANCELLED':state)
 assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,state==='COMPLETED'?1:0)
})

test('shared accounting separates worker transitions from generation and does not double count ready workers',()=>{
 const start={actionId:'a',botId:2,type:'START',role:'analyst',quantity:1,created:0,metadata:{},deadlineAt:100}
 const generation={actionId:'g',type:'GENERATE',quantity:1,created:0,metadata:{},deadlineAt:100}
 const a=observed([ready,{...ready,botId:2,accountId:2,role:null,workReady:false}], [start,generation])
 const result=transitionAccounting(a,{roles:{analyst:3,reseller:0}},{reserve:{targetReadyAccounts:0}},1)
 assert.deepEqual([result.roles.analyst.workReady,result.roles.analyst.inProgress,result.roles.analyst.uncovered],[1,1,1])
 assert.equal(result.accounts.uncovered,0)
 a.bots[1].workReady=true;a.bots[1].role='analyst';a.roles.analyst=2
 assert.equal(transitionAccounting(a,{roles:{analyst:3}},{reserve:{targetReadyAccounts:0}},1).roles.analyst.inProgress,0)
})

test('supervisor transitions occupy resources without becoming Core actions or lasting forever',()=>{
 const a=observed([{...ready,workReady:false,role:null,desiredState:'running',readinessAgeMs:10}])
 let result=transitionAccounting(a,{roles:{analyst:1}},{reserve:{targetReadyAccounts:0}},1,100)
 assert.equal(result.roles.analyst.externalTransition,1);assert.equal(result.active,0)
 a.bots[0].readinessAgeMs=200
 result=transitionAccounting(a,{roles:{analyst:1}},{reserve:{targetReadyAccounts:0}},1,100)
 assert.equal(result.roles.analyst.uncovered,1)
})

test('replacement generation covers its own account demand, not an additional spare reserve',()=>{
 const action={actionId:'r',type:'REPLACE',role:'analyst',botId:1,accountId:null,quantity:1,created:0,metadata:{generation:true},deadlineAt:100}
 const actual=observed([{...ready,workReady:false,role:null,banned:true}], [action])
 const result=transitionAccounting(actual,{roles:{analyst:1}},{reserve:{targetReadyAccounts:1}},1)
 assert.equal(result.roles.analyst.uncovered,0);assert.equal(result.accounts.uncovered,1)
})

test('reserved account cannot be assigned to a competing operation, but manual command can use another',async t=>{
 const f=await fixture(t),accounts=f.db.createGeneratedAccounts(2)
 f.db.query("INSERT INTO botData(botId,name) VALUES(1,'one'),(2,'two')").run()
 const a=f.reserve({accountId:accounts[0].accountId})
 const other=f.db.assignAvailableAccount(2);assert.equal(other.accountId,accounts[1].accountId)
 const own=f.db.assignAvailableAccount(1,{actionId:a.actionId});assert.equal(own.accountId,accounts[0].accountId)
 assert.deepEqual(f.db.query('PRAGMA foreign_key_check').all(),[])
})

test('v9 migration backs up and preserves policy/accounts, adds empty actions, and reopens idempotently',async t=>{
 const f=await fixture(t);f.db.createGeneratedAccounts(1)
 const policy=f.db.query('SELECT * FROM operationsPolicy').get(),account=f.db.query('SELECT * FROM accountsData').get()
 f.db.store.db.exec('DROP TABLE IF EXISTS liveValidationFuse; DELETE FROM schemaMigrations WHERE version=16; DROP INDEX IF EXISTS economic_source_plan; DROP INDEX IF EXISTS economic_autonomous_item; DELETE FROM schemaMigrations WHERE version=15; DROP TABLE tradingPlans; DELETE FROM schemaMigrations WHERE version=14; DROP TABLE proxyDiagnostics; DROP TABLE proxyReservations; DROP TABLE proxies; ALTER TABLE telegramAccounts DROP COLUMN active; DELETE FROM schemaMigrations WHERE version=13; DROP TABLE coreLifecycle; DROP TABLE coreActionResources; DROP TABLE coreActions; DROP TABLE coreGenerationResults; DELETE FROM schemaMigrations WHERE version>=10; PRAGMA user_version=9')
 f.db.close();await f.db.init()
 assert.equal(f.db.query('PRAGMA user_version').get().user_version,16)
 assert.deepEqual(f.db.query('SELECT * FROM operationsPolicy').get(),policy);assert.deepEqual(f.db.query('SELECT * FROM accountsData').get(),account)
 assert.equal(f.ledger.active().length,0);assert.equal(f.db.query('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(f.db.query('PRAGMA foreign_key_check').all(),[])
 const backups=await readdir(path.join(f.dir,'backups'));assert.equal(backups.length,1)
 const backup=new DatabaseSync(path.join(f.dir,'backups',backups[0],'afina-before-v16.db'),{readOnly:true});assert.equal(backup.prepare('PRAGMA user_version').get().user_version,9);backup.close()
 f.db.close();await f.db.init();assert.deepEqual(await readdir(path.join(f.dir,'backups')),backups)
})

async function coreFixture(t,{hung=false}={}){
 const f=await fixture(t);f.db.createGeneratedAccounts(2)
 f.db.store.db.exec("INSERT INTO serverData VALUES(1,'localhost','1','test'); INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(1,'one',1,1,101),(2,'two',2,1,101); INSERT INTO tasksData(botId,type,enabled) VALUES(1,'analyst',1),(2,'analyst',1)")
 const runtime=new Map([1,2].map(id=>[id,{running:id===1,runtimeStatus:id===1?'running':'offline',desiredState:id===1?'running':'stopped',supervisorStatus:id===1?'running':'offline',workerPid:100+id}]))
 const bots=new Map([1,2].map(id=>[id,{taskData:f.db.query('SELECT * FROM tasksData WHERE botId=?').get(id),isRunning:()=>runtime.get(id).running,get desiredState(){return runtime.get(id).desiredState},analysisState:'idle'}]))
 const manager=fixtureObservation({getBot:id=>bots.get(id),getBotRuntimeState:id=>runtime.get(id),hasBot:id=>bots.has(id)},f.db.store)
 const calls=[],eventBus=new EventBus({logger})
 const core=new AutonomousCore({dataBaseManager:f.db,botManager:manager,eventBus,logger,configurationService:{async sync(){}},executeCommand:request=>{
  calls.push(request);request.executionGuard?.()
  if(hung)return new Promise(()=>{})
  const r=runtime.get(request.payload.botId);r.running=true;r.desiredState='running';r.runtimeStatus='connecting';r.supervisorStatus='starting';return Promise.resolve({ok:true})
 }})
 f.cores.push(core)
 core.store.updateOperationsPolicy({automationEnabled:true,capacity:{maximum:3},roles:{analyst:{target:2,maximum:3}}},core.store.operationsPolicy().revision)
 await core.start();return {...f,core,calls,runtime,bots}
}

test('production Core repeated reconciliation dispatches one START until ready observation completes it',async t=>{
 const f=await coreFixture(t)
 for(let i=0;i<5;i++)await f.core.evaluateNow({type:'TEST'})
 assert.equal(f.calls.length,1);assert.equal(f.core.actions.ledger.active().filter(a=>a.type==='START').length,1)
 assert.equal(f.core.snapshot().transitionAccounting.roles.analyst.inProgress,1)
 f.runtime.get(2).runtimeStatus='running'
 await f.core.evaluateNow({type:'SAFETY_RECONCILIATION'})
 assert.equal(f.core.actions.ledger.active().length,0);assert.equal(f.calls.length,1)
 assert.equal(f.core.snapshot().actualState.roles.analyst,2)
})

test('hung executor does not hang Core or duplicate dispatch; manual intent cancels its reservation',async t=>{
 const before=Date.now(),f=await coreFixture(t,{hung:true})
 assert.ok(Date.now()-before<3000)
 await f.core.evaluateNow({type:'TEST'});assert.equal(f.calls.length,1)
 const a=f.core.actions.ledger.active()[0];assert.equal(a.state,'DISPATCHED')
 f.core.userControlsBot(2);assert.equal(f.core.actions.ledger.get(a.actionId).state,'CANCELLED')
 assert.throws(()=>f.calls[0].executionGuard(),/STALE_REVISION/)
 assert.equal(f.core.actions.ledger.resources().length,0)
})

test('production trading capability remains blocked with action infrastructure installed',async t=>{
 const f=await coreFixture(t)
 f.core.updateOperationsPolicy({expectedRevision:f.core.store.operationsPolicy().revision,values:{roles:{reseller:{target:1,maximum:1}}}})
 await f.core.evaluateNow({type:'TEST'})
 assert.ok(f.core.snapshot().capabilityBlockers.some(b=>b.code==='TRADING_EXECUTION_DISABLED'))
    assert.equal(f.core.actions.ledger.active().some(a=>a.type==='START'&&a.role==='reseller'),false)
})

test('reserved obsolete action is never dispatched after a policy edit',async t=>{
 const f=await coreFixture(t),core=f.core
 const a=core.actions.ledger.reserve({type:'GENERATE',logicalKey:'old-policy',quantity:1,policyRevision:core.store.operationsPolicy().revision,desiredRevision:1,inputRevision:core.store.revision(),deadlineAt:Date.now()+60000}).action
 const before=f.calls.length
 core.updateOperationsPolicy({expectedRevision:core.store.operationsPolicy().revision,values:{roles:{analyst:{target:1}}}})
 await core.actions.dispatch(a,{action:'generate_accounts',target:{},after:{requested:1}},{valid:()=>true,onAssigned(){}})
 assert.equal(core.actions.ledger.get(a.actionId).state,'CANCELLED');assert.equal(f.calls.length,before)
})

test('legacy pending START is imported once and reconciled from current reality without replay',async t=>{
 const f=await coreFixture(t),core=f.core
 core.store.setControl(1,{pendingActionId:'legacy',pendingDecisionId:'legacy-decision',pendingSince:Date.now(),pendingAfter:JSON.stringify({type:'analyst'})})
 const before=f.calls.length
 core.actions.reconcile(core.readActual(),true)
 core.actions.reconcile(core.readActual(),true)
 const imported=core.actions.ledger.recent().filter(a=>a.botId===1&&a.metadata.imported)
 assert.equal(imported.length,1);assert.equal(imported[0].state,'COMPLETED');assert.equal(f.calls.length,before)
})

test('production pending generation covers quantity across repeated passes and durable failure restores backoff',async t=>{
 const f=await coreFixture(t),core=f.core
 // Satisfy worker capacity; only the canonical spare reserve needs accounts.
 f.runtime.get(2).runtimeStatus='running';await core.evaluateNow({type:'TEST'})
 let count=0
 core.reconciler.executeCommand=request=>{request.executionGuard?.();count++;return new Promise(()=>{})}
 core.updateOperationsPolicy({expectedRevision:core.store.operationsPolicy().revision,values:{reserve:{targetReadyAccounts:2,automaticAccountGeneration:true,maximumPendingAccountGeneration:2,maximumTotalAccounts:10}}})
 await core.evaluateNow({type:'TEST'})
 for(let i=0;i<5;i++)await core.evaluateNow({type:'TEST'})
 assert.equal(count,1)
 const a=core.actions.ledger.active().find(a=>a.type==='GENERATE');assert.equal(a.quantity,2)
 assert.equal(core.snapshot().transitionAccounting.accounts.uncovered,0)
 core.actions.ledger.transition(a.actionId,'FAILED','ACCOUNT_GENERATION_FAILED')
 await core.evaluateNow({type:'TEST'});assert.equal(count,1);assert.ok(core.accountGeneration.retryAt>Date.now())
 core.accountGeneration.retryAt=null;core.actions.reconcile(core.readActual());assert.ok(core.accountGeneration.retryAt>Date.now())
 assert.equal(core.snapshot().transitionAccounting.accounts.pendingGeneration,0)
})

test('legacy replacement stages recover as linked transitions rather than another replacement',async t=>{
 const f=await coreFixture(t),core=f.core
 core.actions.ledger.cancelBot(2)
 f.db.query("INSERT INTO accountReplacements(requestId,botId,bannedAccountId,replacementAccountId,state,createdAt,updatedAt) VALUES('old-replacement',2,1,2,'initializing',?,?)").run(Date.now(),Date.now())
 const before=f.calls.length
 core.actions.reconcile(core.readActual(),true)
 const a=core.actions.ledger.active().find(a=>a.type==='REPLACE')
 assert.equal(a.metadata.replacementRequestId,'old-replacement');assert.equal(f.calls.length,before)
 f.runtime.get(2).runtimeStatus='running';core.actions.reconcile(core.readActual())
 assert.equal(core.actions.ledger.get(a.actionId).state,'COMPLETED')
})
