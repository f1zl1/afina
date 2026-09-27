import {fixture} from './helpers/lifecycleFixture.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {DatabaseSync} from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import DatabaseStore from '../src/data/databaseStore.js'
import AutonomousCore from '../src/core/autonomousCore.js'
import BotManager from '../src/botManager/botManagerMain.js'
import BotProcess from '../src/botManager/botProcess.js'
import EventBus from '../src/eventBus/eventBusMain.js'
import GracefulStop from '../src/minecraftBot/worker/gracefulStop.js'
import BotTaskRunner from '../src/minecraftBot/taskRunner/botTaskRunner.js'
import ResellerBuyer from '../src/minecraftBot/taskRunner/modes/reseller/resellerBuyer.js'
import WorkerFacts from '../src/minecraftBot/worker/workerFacts.js'
import {operationsSetting} from '../src/core/coreCapabilities.js'

const logger={child(){return this},withContext(){return this},info(){},warn(){},error(){},log(){}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
for(const type of ['START','REPLACE'])test(type+' cannot fork without active proxy capacity',async t=>{
 const f=await fixture(t),a=f.reserve(type),proxy=f.core.proxies.rows()[0]
 f.core.proxies.save({proxyId:proxy.proxyId,active:false})
 await assert.rejects(f.manager.startBot(1,()=>{},a.actionId),/NO_ELIGIBLE_PROXY/)
 assert.equal(f.workers[0].children.length,0);assert.equal(f.core.proxies.owned().length,0)
 f.core.proxies.save({proxyId:proxy.proxyId,active:true});f.workers[0].bot.desiredState='running'
 await f.manager.startBot(1,()=>{},a.actionId);assert.equal(f.core.proxies.owned().length,1);assert.equal(f.workers[0].children.length,1)
 f.workers[0].children[0].exit();assert.equal(f.core.proxies.owned().length,0)
})

for(const type of ['START','STOP','REPLACE'])test(type+' owns bot against supervisor/configuration restart',async t=>{
 const f=await fixture(t),w=f.workers[0];w.start();const a=f.reserve(type)
 await f.manager.restartBot(1,{reason:'configuration',incarnationId:w.bot.incarnationId})
 assert.equal(w.children.length,1);assert.equal(f.ledger.active().length,1);assert.equal(f.ledger.resources().find(r=>r.resourceKey==='bot:1').actionId,a.actionId)
 assert.equal(f.life.plan({actual:f.core.readActual(),policy:f.core.runtimePolicy(),now:Date.now()}).length,0)
})
for(const command of ['bot.stop','bot.start','bot.restart'])test('manual '+command+' supersedes autonomous ownership and fences late spawn',async t=>{
 const f=await fixture(t),a=f.reserve(command==='bot.start'?'STOP':'START');f.core.userControlsBot(1)
 assert.equal(f.ledger.get(a.actionId).state,'CANCELLED');assert.equal(f.life.state.get(1).owner,'manual')
 assert.throws(()=>f.life.beforeSpawn(1,a.actionId,'late'),/OWNERSHIP/)
 const result=await f.life.manual(command,{botId:1});assert.equal(result.accepted,true)
 assert.equal(f.ledger.get(result.actionId).metadata.manual,true)
})
test('manual start rejects a live process without creating an unfulfillable action',async t=>{
 const f=await fixture(t);f.workers[0].start();f.core.userControlsBot(1)
 await assert.rejects(f.life.manual('bot.start',{botId:1}),/ALREADY_RUNNING/);assert.equal(f.ledger.active().length,0)
})
test('releasing manual hold preserves an already accepted action until settlement',async t=>{
 const f=await fixture(t);f.core.userControlsBot(1);const a=f.reserve('STOP',1,true);f.core.releaseBot({botId:1})
 assert.equal(f.life.state.get(1).owner,'core');assert.equal(f.life.valid(a.actionId),true);assert.equal(f.ledger.resources().length,2)
})
test('binding continues its existing manual START claim through scheduler planning',async t=>{
 const f=await fixture(t),w=f.workers[0];f.core.userControlsBot(1);const a=f.reserve('START',1,true);w.start();f.life.beforeSpawn(1,a.actionId,w.bot.incarnationId)
 assert.equal(f.life.request(1,'binding',w.bot.incarnationId),true)
 const plan=f.life.plan({actual:f.core.readActual(),policy:f.core.runtimePolicy(),now:Date.now()})
 assert.equal(plan[0].action,'continue_binding');assert.equal(plan[0].actionId,a.actionId)
 const reserved=f.core.actions.reserve(plan[0],{});assert.equal(reserved.continuation,true);assert.equal(f.ledger.active().length,1)
})
for(const type of ['START','REPLACE'])test('crash while '+type+' awaits readiness fails the correlated action and persists backoff',async t=>{
 const f=await fixture(t),w=f.workers[0],a=f.reserve(type);w.start();f.life.beforeSpawn(1,a.actionId,w.bot.incarnationId);w.bot.process.exit()
 assert.equal(f.ledger.get(a.actionId).state,'FAILED');assert.equal(f.life.state.get(1).failures,1);assert.ok(f.life.state.get(1).retryAt>Date.now());assert.equal(f.ledger.resources().length,0)
})
test('stale exit cannot fail an action for another incarnation',async t=>{
 const f=await fixture(t),w=f.workers[0],a=f.reserve();w.start();f.life.beforeSpawn(1,a.actionId,'new-incarnation');f.life.exited(w.bot,{reason:'worker_crash'})
 assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED')
})
test('unrelated ready worker cannot complete an action without correlated spawn evidence',async t=>{
 const f=await fixture(t),a=f.reserve(),actual=f.core.readActual();Object.assign(actual.bots[0],{workReady:true,role:'analyst',incarnationId:'other'})
 f.ledger.reconcile(actual,{policyRevision:a.policyRevision});assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED')
})
for(const quality of ['UNAVAILABLE','STALE','PROCESS_MISSING'])test('STOP completion requires absence: '+quality,async t=>{
 const f=await fixture(t),a=f.reserve('STOP'),actual=f.core.readActual();actual.bots[0].observationQuality=quality
 f.ledger.reconcile(actual,{policyRevision:a.policyRevision});assert.equal(f.ledger.get(a.actionId).state,quality==='PROCESS_MISSING'?'COMPLETED':'DISPATCHED')
})
test('idle STOP safe ACK alone does not complete; subsequent process exit does',async t=>{
 const f=await fixture(t),w=f.workers[0];w.start();const a=f.reserve('STOP')
 const stop=f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+1000})
 w.ack(a.actionId);await tick();assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED');assert.equal(w.bot.process.kills,0)
 w.bot.process.exit();await stop;assert.equal(f.ledger.get(a.actionId).state,'COMPLETED')
})
test('busy worker stays alive until its safe checkpoint',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve('STOP')
 const stop=f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+1000})
 w.ack(a.actionId,'quiescing');await tick();assert.equal(child.messages.some(m=>m.type==='command'),false)
 w.ack(a.actionId);await tick();child.exit();await stop;assert.equal(child.kills,0)
})
test('unsafe Reseller evidence refuses normal stop without killing',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve('STOP')
 const stop=f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+1000})
 w.ack(a.actionId,'unsafe');await assert.rejects(stop,/TRANSACTION_RESULT_UNCERTAIN/);assert.equal(child.kills,0);assert.equal(w.bot.isRunning(),true)
})
test('graceful timeout is visible failure, never implicit force',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve('STOP')
 await assert.rejects(f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+15}),/GRACEFUL_STOP_TIMEOUT/)
 assert.equal(child.kills,0);assert.equal(w.bot.isRunning(),true)
})
test('explicit manual force stops without claiming safe evidence',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start();f.core.userControlsBot(1);const a=f.reserve('STOP',1,true)
 f.ledger.annotate(a.actionId,{force:true})
 await f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,force:true,deadlineAt:Date.now()+1000})
 assert.equal(child.kills,1);assert.equal(w.bot.stopEvidence,null);assert.equal(f.ledger.get(a.actionId).state,'COMPLETED')
})
test('crash during quiescence proves STOP absence even without ACK',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve('STOP')
 const stop=f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+1000});child.exit();await stop
 assert.equal(f.ledger.get(a.actionId).state,'COMPLETED')
})
for(const wrong of ['action','incarnation'])test('stale '+wrong+' ACK cannot stop current worker',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve('STOP')
 const stop=f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+20})
 w.ack(wrong==='action'?'old':a.actionId,'safe',wrong==='incarnation'?'old':w.bot.incarnationId)
 await assert.rejects(stop,/TIMEOUT/);assert.equal(child.kills,0)
})
test('malformed stop evidence isolates failure to its own action',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve('STOP')
 const stop=f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+1000})
 child.emit('message',{type:'lifecycle:quiescence',actionId:a.actionId,incarnationId:w.bot.incarnationId,state:'safe',safe:false})
 await assert.rejects(stop,/INVALID_STOP_EVIDENCE/);assert.equal(child.kills,0)
})
test('IPC disconnect settles quiescence without fabricating absence',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve('STOP')
 const stop=f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+1000});child.emit('disconnect')
 await assert.rejects(stop,/STOP_TRANSPORT_UNAVAILABLE/);assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED')
})
test('manual supersession cancels mechanical wait and late ACK cannot terminate',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve('STOP')
 const stop=f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+1000});f.core.userControlsBot(1)
 await assert.rejects(stop,/STOP_SUPERSEDED/);w.ack(a.actionId);await tick();assert.equal(child.kills,0);assert.equal(child.messages.some(m=>m.type==='command'),false)
})
test('worker fence waits for role cleanup and prevents realm re-entry from starting work',async()=>{
 const drain=deferred(),bot={},runner=new BotTaskRunner({bot,logger,eventBus:{}});bot.taskRunner=runner
 let requested=0;runner.activeTask={requestQuiesce(){requested++}};runner.completion=drain.promise
 const messages=[],protocol=new GracefulStop({bot,incarnationId:'i',send:m=>messages.push(m)}),request={actionId:'a',incarnationId:'i'}
 const wait=protocol.request(request);await tick();assert.equal(messages.at(-1).safe,false);assert.equal(requested,1)
 await runner.start({type:'unknown'});drain.resolve();await wait;assert.equal(messages.at(-1).safe,true)
 await protocol.request(request);assert.equal(requested,1)
})
for(const uncertainty of ['PURCHASE_RESULT_UNCERTAIN','SELL_RESULT_UNCERTAIN','RELIST_RESULT_UNCERTAIN','SERVER_ACTION_RESULT_UNCERTAIN'])test('worker refuses safe checkpoint after '+uncertainty,async()=>{
 const messages=[],bot={lifecycleUncertain:uncertainty,taskRunner:{async quiesce(){}}},protocol=new GracefulStop({bot,incarnationId:'i',send:m=>messages.push(m)})
 await protocol.request({actionId:'a',incarnationId:'i'});assert.equal(messages.at(-1).state,'unsafe');assert.equal(messages.at(-1).reason,uncertainty)
})
test('worker ignores malformed and stale quiescence requests',async()=>{
 let calls=0;const protocol=new GracefulStop({bot:{taskRunner:{quiesce(){calls++}}},incarnationId:'i',send(){calls++}})
 for(const request of [{},{actionId:'a',incarnationId:'old'},{actionId:'',incarnationId:'i'},{actionId:'x'.repeat(129),incarnationId:'i'}])await protocol.request(request)
 assert.equal(calls,0)
})
test('Reseller buyer leaves an idle search checkpoint without opening a new transaction',async()=>{
 const buyer=new ResellerBuyer({bot:{lifecycleQuiescing:true},taskData:{},logger,eventBus:{},inventory:{findTarget(){throw new Error('new work')}},canContinue:()=>true,setState(){},settings:{},server:{}})
 assert.equal(await buyer.buyUntilSuccess(),'quiesced')
})
test('startup accepts ready evidence only for the correlated lifecycle incarnation',async t=>{
 const f=await fixture(t),w=f.workers[0],a=f.reserve();w.start();f.life.beforeSpawn(1,a.actionId,w.bot.incarnationId)
 const actual=f.core.readActual();Object.assign(actual.bots[0],{workReady:true,role:'analyst',incarnationId:w.bot.incarnationId,observationQuality:'FRESH'})
 f.life.account(actual,true);f.ledger.reconcile(actual,{policyRevision:a.policyRevision,startup:true});assert.equal(f.ledger.get(a.actionId).state,'COMPLETED')
})
test('legacy imported receipt keeps Phase 3 observation-only recovery semantics',async t=>{
 const f=await fixture(t),a=f.ledger.reserve({type:'START',logicalKey:'bot:1',botId:1,accountId:1,role:'analyst',policyRevision:f.core.store.operationsPolicy().revision,desiredRevision:1,inputRevision:1,deadlineAt:Date.now()+10000,metadata:{imported:true}}).action
 assert.equal(a.metadata.lifecycle,undefined);const actual=f.core.readActual();Object.assign(actual.bots[0],{workReady:true,role:'analyst'})
 f.ledger.reconcile(actual,{policyRevision:a.policyRevision,startup:true});assert.equal(f.ledger.get(a.actionId).state,'COMPLETED')
})
test('durable start/stop spacing survives ledger pruning and manual overrides are explicit',async t=>{
 const f=await fixture(t),bot=f.core.readActual().bots[0];f.policy({transitions:{startIntervalMs:10000}});f.life.state.update(1,{lastStartAt:Date.now()})
 assert.equal(f.life.permission(bot,'assign_analyst'),'TRANSITION_SPACING');assert.equal(f.life.permission(bot,'assign_analyst',Date.now(),true),null)
})
for(const [operation,field] of [['stop_bot','lastStartAt'],['assign_analyst','lastStopAt']])test('minimum lifetime guards '+operation,async t=>{
 const f=await fixture(t);f.policy({stability:{minimumBotRuntimeMs:10000,minimumBotDowntimeMs:10000}});f.life.state.update(1,{[field]:Date.now()})
 assert.equal(f.life.permission(f.core.readActual().bots[0],operation),'MINIMUM_LIFETIME')
})
test('recovery backoff persists across reopen and bounds permanent failure',async t=>{
 const f=await fixture(t);f.policy({recovery:{maximumRestartAttempts:2,restartDelayMinMs:10,restartDelayMaxMs:20}});f.life.state.update(1,{intent:'running'})
 f.life.failure(1,'worker_crash');const first=f.life.state.get(1);f.store.close();await f.store.init();assert.equal(f.life.state.get(1).retryAt,first.retryAt)
 f.life.failure(1,'worker_crash');f.life.failure(1,'worker_crash');assert.equal(f.life.permission(f.core.readActual().bots[0],'recover_bot'),'RECOVERY_EXHAUSTED')
})
for(const [cause,field] of [['worker_crash','restartOnCrash'],['disconnect','restartOnDisconnect'],['unexpected_stop','restartOnUnexpectedStop']])test('canonical policy blocks '+cause,async t=>{
 const f=await fixture(t);f.policy({recovery:{[field]:false}});f.life.state.update(1,{intent:'running',requestReason:cause})
 assert.equal(f.life.permission(f.core.readActual().bots[0],'recover_bot'),'RECOVERY_DISABLED')
})
test('Reseller recovery retains production trading block',async t=>{
 const f=await fixture(t),bot=f.core.readActual().bots[0];bot.task={...bot.task,type:'reseller'}
 assert.equal(f.life.permission(bot,'recover_bot'),'TRADING_EXECUTION_DISABLED')
})
for(const type of ['START','REPLACE'])test('startup absent dispatched '+type+' fails without blind replay',async t=>{
 const f=await fixture(t),a=f.reserve(type);f.life.account(f.core.readActual(),true)
 assert.equal(f.ledger.get(a.actionId).state,'FAILED');assert.equal(f.workers[0].children.length,0);assert.equal(f.life.state.get(1).requestReason,'unexpected_stop')
})
test('startup pending reconnect/configuration/binding request remains durable',async t=>{
 const f=await fixture(t);f.life.state.update(1,{intent:'running',requestReason:'configuration',retryAt:Date.now()+10000});const before=f.life.state.get(1)
 f.store.close();await f.store.init();f.life.account(f.core.readActual(),true);assert.deepEqual(f.life.state.get(1),before)
})
test('shutdown gates late recovery and spawn without terminalizing uncertain action',async t=>{
 const f=await fixture(t),a=f.reserve();f.life.close()
 assert.equal(f.life.request(1,'worker_crash'),false);await assert.rejects(f.manager.startBot(1,null,a.actionId),/APPLICATION_STOPPING/);assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED')
})
test('v10 migration creates complete backup, preserves actions, validates and reopens',async t=>{
 const f=await fixture(t),a=f.reserve();f.store.db.exec('DROP TABLE IF EXISTS liveValidationFuse; DELETE FROM schemaMigrations WHERE version=16; DROP INDEX IF EXISTS economic_source_plan; DROP INDEX IF EXISTS economic_autonomous_item; DELETE FROM schemaMigrations WHERE version=15; DROP TABLE tradingPlans; DELETE FROM schemaMigrations WHERE version=14; DROP TABLE proxyDiagnostics; DROP TABLE proxyReservations; DROP TABLE proxies; ALTER TABLE telegramAccounts DROP COLUMN active; DELETE FROM schemaMigrations WHERE version=13; DROP TABLE economicWorkloads; DROP TABLE coreLifecycle; DELETE FROM schemaMigrations WHERE version>=11; PRAGMA user_version=10');f.store.close();await f.store.init()
 assert.equal(f.store.prepare('PRAGMA user_version').get().user_version,16);assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED');assert.equal(f.ledger.resources().length,2)
 assert.equal(f.store.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(f.store.prepare('PRAGMA foreign_key_check').all(),[])
 const backups=await readdir(path.join(f.dir,'backups')),backup=new DatabaseSync(path.join(f.dir,'backups',backups[0],'afina-before-v16.db'),{readOnly:true})
 assert.equal(backup.prepare('PRAGMA user_version').get().user_version,10);assert.equal(backup.prepare('SELECT count(*) n FROM coreActions').get().n,1);backup.close()
 f.store.close();await f.store.init();assert.deepEqual(await readdir(path.join(f.dir,'backups')),backups)
})
test('capability metadata distinguishes supported spacing from unsupported health/window',()=>{
 assert.equal(operationsSetting('transitions.gracefulStopTimeoutMs').status,'SUPPORTED');assert.equal(operationsSetting('recovery.restartOnCrash').status,'PARTIALLY_SUPPORTED')
 assert.equal(operationsSetting('health.maximumCrashesPerWindow').status,'UNSUPPORTED');assert.equal(operationsSetting('recovery.restartWindowMs').status,'UNSUPPORTED')
})
test('ready evidence resets recovery only after the stability interval',async t=>{
 const f=await fixture(t);f.life.state.update(1,{intent:'running',failures:3,retryAt:Date.now()+1000,stableSince:Date.now()})
 const actual=f.core.readActual();actual.bots[0].workReady=true;f.life.account(actual);assert.equal(f.life.state.get(1).failures,3)
 f.life.state.update(1,{stableSince:Date.now()-60001});f.life.account(actual);assert.equal(f.life.state.get(1).failures,0)
})
test('normal live archival cannot bypass the stop protocol',async t=>{
 const f=await fixture(t);f.workers[0].start();await assert.rejects(f.manager.archiveBot(1),/MUST_BE_STOPPED/);assert.throws(()=>f.manager.removeBot(1),/MUST_BE_STOPPED/)
})
test('restart exit continues the same action rather than scheduling a second recovery',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve();f.ledger.annotate(a.actionId,{phase:'quiescing',incarnationId:w.bot.incarnationId,spawnIssued:true})
 child.exit();assert.equal(f.ledger.get(a.actionId).metadata.phase,'stopped');assert.equal(f.ledger.active().length,1);assert.equal(f.life.state.get(1).failures,0)
})
test('autonomous force escalation is forbidden even with an active STOP claim',async t=>{
 const f=await fixture(t);f.workers[0].start();const a=f.reserve('STOP')
 await assert.rejects(f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,force:true,deadlineAt:Date.now()+100}),/FORCED_STOP_NOT_AUTHORIZED/)
})
test('shutdown drains a safe worker and preserves the uncertain action for startup',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve();child.autoExit=true
 f.life.close();const stop=f.manager.shutdown();w.ack('shutdown:'+w.bot.incarnationId);await stop
 assert.equal(child.kills,0);assert.equal(child.alive,false);assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED')
})
test('shutdown supersedes quiescence and leaves STOP recoverable by startup absence',async t=>{
 const f=await fixture(t),w=f.workers[0],child=w.start(),a=f.reserve('STOP')
 const pending=f.manager.stopOwned(1,{actionId:a.actionId,valid:()=>true,deadlineAt:Date.now()+1000})
 f.life.close();await assert.rejects(pending,/STOP_SUPERSEDED/);child.autoExit=true
 const shutdown=f.manager.shutdown();w.ack('shutdown:'+w.bot.incarnationId);await shutdown
 assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED');f.ledger.reconcile(f.core.readActual(),{policyRevision:a.policyRevision,startup:true});assert.equal(f.ledger.get(a.actionId).state,'COMPLETED')
})
test('binding REPLACE continuation restarts once under the same account and bot resources',async t=>{
 const f=await fixture(t),w=f.workers[0],a=f.reserve('REPLACE');w.start();w.bot.process.autoExit=true
 f.life.beforeSpawn(1,a.actionId,w.bot.incarnationId);const old=w.bot.incarnationId;f.life.request(1,'binding',old);f.life.request(1,'heartbeat_timeout',old)
 assert.equal(f.life.state.get(1).requestReason,'binding')
 const plan=f.life.plan({actual:f.core.readActual(),policy:f.core.runtimePolicy(),now:Date.now()})[0]
 await f.core.actions.dispatch(f.ledger.get(a.actionId),plan,{valid:()=>f.life.valid(a.actionId),onAssigned(){}})
 const job=f.core.actions.jobs.get(a.actionId);w.ack(a.actionId);await job.work
 assert.equal(w.children.length,2);assert.notEqual(w.bot.incarnationId,old);assert.equal(f.ledger.active()[0].actionId,a.actionId);assert.equal(f.ledger.resources().length,2);assert.equal(f.life.state.get(1).failures,0)
 assert.equal(f.life.snapshot(f.core.readActual())[0].stopEvidence,null)
})
test('failed binding continuation cannot complete on the old ready incarnation',async t=>{
 const f=await fixture(t),w=f.workers[0],a=f.reserve();w.start();f.life.beforeSpawn(1,a.actionId,w.bot.incarnationId);f.life.request(1,'binding',w.bot.incarnationId)
 const actual=f.core.readActual();Object.assign(actual.bots[0],{workReady:true,role:'analyst',incarnationId:w.bot.incarnationId})
 f.ledger.reconcile(actual,{policyRevision:a.policyRevision});assert.equal(f.ledger.get(a.actionId).state,'DISPATCHED')
})
test('reservation rolls back both lifecycle intent and resources on admission failure',async t=>{
 const f=await fixture(t),original=f.life.admit.bind(f.life);f.life.admit=(...args)=>{original(...args);throw new Error('fixture failure')}
 assert.throws(()=>f.reserve(),/fixture failure/);assert.equal(f.life.state.get(1),null);assert.equal(f.ledger.active().length,0);assert.equal(f.ledger.resources().length,0)
})
test('24 permanently failing workers and a trigger burst remain bounded and fair',async t=>{
 const f=await fixture(t,{count:24});f.policy({controller:{maxActionsPerCycle:2,maxCandidatesPerCycle:8,maxPassesPerDrain:1,continuationDelayMs:60000},transitions:{maximumConcurrentStarts:100},recovery:{maximumRestartAttempts:2,restartDelayMinMs:0,restartDelayMaxMs:0}})
 for(let id=1;id<=24;id++)f.life.state.update(id,{intent:'running',requestReason:'worker_crash'})
 const cycles=[],original=f.core.cycle.bind(f.core);f.core.cycle=async batch=>{await original(batch);cycles.push({...f.core.lastCycle})}
 let last=performance.now(),maxDelay=0,pulses=0;const pulse=setInterval(()=>{const now=performance.now();maxDelay=Math.max(maxDelay,now-last);last=now;pulses++},1)
 const started=performance.now()
 try{
  for(let i=0;i<100;i++)f.core.queueTrigger({type:'WORKER_BURST_'+i,source:'test'})
  for(let turn=0;turn<48;turn++){
   await f.core.evaluateNow({type:'SAFETY_RECONCILIATION'});await tick()
   for(const w of f.workers)if(w.bot.process)w.bot.process.exit()
  }
 }finally{clearInterval(pulse)}
 const launches=f.workers.map(w=>w.children.length)
 assert.ok(launches.every(n=>n===3),JSON.stringify(launches));assert.ok(cycles.every(c=>c.dispatched<=2&&c.candidatesConsidered<=8));assert.ok(pulses>0)
 assert.equal(f.ledger.active().length,0);assert.equal(f.ledger.resources().length,0);assert.ok(f.life.state.rows().every(r=>r.failures===3))
 t.diagnostic(JSON.stringify({workers:24,launches:launches.reduce((a,b)=>a+b,0),cycles:cycles.length,durationMs:performance.now()-started,maxCycleMs:Math.max(...cycles.map(c=>c.durationMs)),maxEventLoopDelayMs:maxDelay,pulses,maxActions:Math.max(...cycles.map(c=>c.dispatched)),maxCandidates:Math.max(...cycles.map(c=>c.candidatesConsidered))}))
})
test('one failed recovery does not starve eleven healthy workers',async t=>{
 const f=await fixture(t,{count:12});f.policy({controller:{maxActionsPerCycle:2,maxCandidatesPerCycle:6,maxPassesPerDrain:1,continuationDelayMs:60000},recovery:{maximumRestartAttempts:2,restartDelayMinMs:0,restartDelayMaxMs:0}})
 for(let id=1;id<=12;id++)f.life.state.update(id,{intent:'running',requestReason:'worker_crash'})
 const started=performance.now(),cycles=[]
 for(let turn=0;turn<12;turn++){
  await f.core.evaluateNow({type:'SAFETY_RECONCILIATION'});cycles.push(f.core.lastCycle);await tick()
  for(const w of f.workers)if(w.bot.process){if(w.bot.botId===1)w.bot.process.exit();else w.bot.process.ready=true}
 }
 assert.equal(f.core.readActual().roles.analyst,11);assert.equal(f.workers[0].children.length,3);assert.ok(f.workers.slice(1).every(w=>w.children.length===1));assert.equal(f.ledger.active().length,0)
 t.diagnostic(JSON.stringify({scenario:'one-failure',workers:12,healthy:11,launches:14,durationMs:performance.now()-started,maxCycleMs:Math.max(...cycles.map(c=>c.durationMs))}))
})
test('multiple graceful stops isolate one unsafe worker and obey cycle limits',async t=>{
 const f=await fixture(t,{count:12});f.policy({roles:{analyst:{target:0}},controller:{maxActionsPerCycle:3,maxCandidatesPerCycle:6,maxPassesPerDrain:1,continuationDelayMs:60000},transitions:{maximumConcurrentStops:3},recovery:{restartDelayMinMs:60000,restartDelayMaxMs:60000}})
 for(const w of f.workers){const child=w.start(),send=child.send;child.autoExit=true;child.send=(m,cb)=>{send(m,cb);if(m.type==='lifecycle:quiesce')queueMicrotask(()=>w.ack(m.actionId,w.bot.botId===1?'unsafe':'safe'))}}
 const started=performance.now(),cycles=[]
 for(let turn=0;turn<8;turn++){await f.core.evaluateNow({type:'SAFETY_RECONCILIATION'});cycles.push(f.core.lastCycle);await tick()}
 assert.equal(f.workers[0].bot.isRunning(),true);assert.ok(f.workers.slice(1).every(w=>!w.bot.isRunning()));assert.ok(f.workers.every(w=>w.children[0].kills===0));assert.equal(f.ledger.resources().length,0)
 assert.equal(f.ledger.recent().filter(a=>a.state==='COMPLETED').length,11);assert.equal(f.ledger.recent().filter(a=>a.state==='FAILED').length,1);assert.ok(cycles.every(c=>c.dispatched<=3))
 t.diagnostic(JSON.stringify({scenario:'graceful-batch',workers:12,stopped:11,unsafe:1,durationMs:performance.now()-started,maxCycleMs:Math.max(...cycles.map(c=>c.durationMs)),maxActions:Math.max(...cycles.map(c=>c.dispatched))}))
})
