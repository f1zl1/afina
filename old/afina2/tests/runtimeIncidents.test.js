import {fixtureObservation} from './helpers/fixtureObservation.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {normalizeFunTimeIncident} from '../src/incidents/funtimeIncidents.js'
import RuntimeIncidents,{stackIdentity} from '../src/minecraftBot/runtime/runtimeIncidents.js'
import IncidentStore from '../src/incidents/incidentStore.js'
import DataBaseManager from '../src/data/dataBaseManagerMain.js'
import AccountPool from '../src/accounts/accountPool.js'
import AccountAssignmentService from '../src/accounts/accountAssignmentService.js'
import Core from '../src/core/coreMain.js'
import EventBus from '../src/eventBus/eventBusMain.js'
import BotManager from '../src/botManager/botManagerMain.js'
import InventoryActions from '../src/minecraftBot/taskRunner/modes/reseller/inventory/inventoryActions.js'
import ResellerSeller from '../src/minecraftBot/taskRunner/modes/reseller/resellerSeller.js'
import {WorkerPublicEventMap} from '../src/events/events.js'
import {normalizeWorkerEvent} from '../src/events/workerEventNormalizer.js'
import {createEvent} from '../src/events/eventFactory.js'
import {validateEventPayload} from '../src/events/eventContracts.js'
const logger={child(){return this},info(){},warn(){},error(){}}
const drop='Вы не можете выкидывать этот предмет в этом месте!'
const air='Вы не можете продать Воздух!'
const cheat='Вы были вызваны на проверку читов!'
const ban='§c✦ ВЫ ЗАБАНЕНЫ!\nБан выдан: 19.09.2026 04:05:42\nПо причине: bot\nРазбан через: 1 д, 5 ч, 59 м, 55 с\nID наказания: #20030647'
const item=(slot=36,meta=0)=>({type:1,name:'stone',metadata:meta,count:1,slot,nbt:{display:{Name:'Protected'}}})
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve()}

for(const [raw,type] of [[drop,'ITEM_DROP_REJECTED'],[air,'EMPTY_ITEM_SELL_ATTEMPT'],[cheat,'CHEAT_CHECK_REQUESTED'],[ban,'ACCOUNT_BANNED'],['  ВЫ  ЗАБАНЕНЫ!  ','ACCOUNT_BANNED'],['Disconnected: ***\n'+ban+'\n***','ACCOUNT_BANNED']])
test('normalizes '+type+' '+raw.length,()=>assert.equal(normalizeFunTimeIncident(raw)?.type,type))
test('ban fields are independent, duration is relative and issued timestamp has no invented UTC',()=>{
    const p=normalizeFunTimeIncident(ban,{now:1000})
    assert.equal(p.banReason,'bot');assert.equal(p.punishmentId,'20030647');assert.equal(p.banIssuedAt,null)
    assert.equal(p.banIssuedAtRaw,'19.09.2026 04:05:42');assert.equal(p.banDurationRaw,'1 д, 5 ч, 59 м, 55 с')
    assert.equal(p.banExpiresAt,1000+107995000)
})
test('single-line ban fields remain separate and an ambiguous duration has no invented expiry',()=>{
    const p=normalizeFunTimeIncident(ban.replaceAll('\n','  '))
    assert.equal(p.banReason,'bot');assert.equal(p.banDurationRaw,'1 д, 5 ч, 59 м, 55 с');assert.equal(p.punishmentId,'20030647')
    assert.equal(normalizeFunTimeIncident(ban.replace('1 д, 5 ч, 59 м, 55 с','1 д или навсегда')).banExpiresAt,null)
})
for(const value of ['hello','бот не забанен','ID наказания: #12','По причине: bot'])test('does not infer a ban from '+value,()=>assert.equal(normalizeFunTimeIncident(value),null))

function runtime(){
    const events=[],messages=[],eventBus=new EventEmitter(),client={_client:{state:'play'},inventory:{slots:Array(46).fill(null)},chat:text=>messages.push(text)}
    const bot={botId:1,accountId:2,accountData:{password:'secret'},client,status:'running',eventBus,operationalBlock:null,
        afkRecovery:{cancel(){}},antiAfk:{cancel(){}},taskRunner:{stop(){bot.stops=(bot.stops ?? 0)+1}},beginInventoryOperation(){},endInventoryOperation(){},waitForInventoryUnlock:async()=>true}
    eventBus.on('bot:runtimeIncident',e=>events.push(e))
    const incidents=bot.incidents=new RuntimeIncidents({bot,wait:async()=>{}})
    return {bot,client,events,messages,incidents}
}
test('uncorrelated rejection ignores no item; correlated rejection identifies metadata, not item ID',()=>{
    const f=runtime();f.incidents.handle(drop);assert.equal(f.incidents.ignored.size,0)
    const a=item(),b=item(20,1);f.incidents.begin('drop',a);f.incidents.handle(drop)
    assert.equal(f.incidents.ignoredItem(a),true);assert.equal(f.incidents.ignoredItem(b),false)
    assert.equal(f.events.at(-1).operation.slot,36);assert.ok(f.events.at(-1).operation.operationId)
})
test('expired and foreign-session operations cannot blacklist a stack',()=>{
    const f=runtime(),a=item();f.incidents.now=()=>0;f.incidents.begin('drop',a);f.incidents.now=()=>1501;f.incidents.handle(drop)
    assert.equal(f.incidents.ignored.size,0);f.incidents.begin('drop',a);f.bot.client={};f.incidents.handle(drop);assert.equal(f.incidents.ignored.size,0)
})
test('a rejected stack is never dropped twice',async()=>{
    const f=runtime(),a=item();let calls=0
    assert.equal(await f.incidents.drop(f.client,a,async()=>{calls++;f.incidents.handle(drop)}),false)
    assert.equal(await f.incidents.drop(f.client,a,async()=>{calls++}),false);assert.equal(calls,1)
})
test('AIR cancels only the pending sale and never populates ignored inventory',()=>{
    const f=runtime(),p=f.incidents.begin('sell',item());f.incidents.handle(air)
    assert.equal(p.rejected,true);assert.equal(p.controller.signal.aborted,true);assert.equal(f.incidents.ignored.size,0)
    assert.equal(f.bot.operationalBlock,null)
})
test('cheat check replies exactly once through safe chat',async()=>{
    const f=runtime();f.incidents.handle(cheat);f.incidents.handle(cheat);await flush()
    assert.deepEqual(f.messages,['у меня чит']);assert.equal(f.events.length,1)
})
for(const cancel of ['stop','disconnect','replacement'])test('cheat response cancels on '+cancel,async()=>{
    const f=runtime();f.incidents.handle(cheat)
    if(cancel==='stop')f.incidents.stop();if(cancel==='disconnect')f.bot.status='offline';if(cancel==='replacement')f.bot.client={}
    await flush();assert.deepEqual(f.messages,[])
})
test('ignored work-slot stack relocates using server transaction and is excluded from target search',async()=>{
    const f=runtime(),protectedItem=item(),stock={...item(10),metadata:2};f.client.inventory.slots[36]=protectedItem;f.client.inventory.slots[10]=stock
    f.incidents.ignored.add(stackIdentity(protectedItem));const moves=[]
    const actions=new InventoryActions({bot:f.bot,logger,eventBus:f.bot.eventBus,canContinue:()=>true,matcher:{isTarget:()=>true},server:{async moveSlotItem(a,b){moves.push([a,b]);f.client.inventory.slots[b]=f.client.inventory.slots[a];f.client.inventory.slots[a]=null}}})
    assert.equal(actions.findTarget(),stock);await actions.prepareOneForSell(stock)
    assert.deepEqual(moves,[[36,9]]);assert.equal(f.bot.operationalBlock,null)
})
test('full protected inventory blocks safely once instead of restarting',async()=>{
    const f=runtime();for(let i=9;i<=44;i++)f.client.inventory.slots[i]=item(i)
    f.incidents.ignored.add(stackIdentity(item()));const stock={...item(10),metadata:2};f.client.inventory.slots[10]=stock
    const actions=new InventoryActions({bot:f.bot,logger,eventBus:f.bot.eventBus,canContinue:()=>true,matcher:{isTarget:()=>true},server:{moveSlotItem(){assert.fail('no safe slot')}}})
    await actions.prepareOneForSell(stock);await actions.prepareOneForSell(stock)
    assert.equal(f.bot.operationalBlock.type,'INVENTORY_BLOCKED_BY_IGNORED_ITEMS');assert.equal(f.bot.stops,1)
    assert.ok(f.events.at(-1).affectedSlots.includes(36));assert.equal(f.incidents.banPending,false)
})
test('empty sell response aborts waiter, yields inventory synchronization and records no successful listing',async()=>{
    const f=runtime(),listed=[];f.client.heldItem=item();f.bot.eventBus.on('bot:itemListed',e=>listed.push(e));let sync=0
    const seller=new ResellerSeller({bot:f.bot,taskData:{sellPricePerOne:10,item:{itemId:1}},logger,eventBus:f.bot.eventBus,inventory:{prepareOneForSell:async()=>true},canContinue:()=>true,setState(){},
        server:{selectHotbar:async()=>true,chat:async(text,options)=>{options.beforeSend?.();f.incidents.handle(air);return true},delay:async()=>{sync++}}})
    assert.equal(await seller.sellOne(item()),'failed');assert.equal(sync,1);assert.deepEqual(listed,[]);assert.equal(f.incidents.pending,null)
})
test('semantic incident survives public normalization and redacts the known password',()=>{
    const f=runtime();f.incidents.handle(ban+'\nsecret');const e=f.events[0]
    assert.equal(WorkerPublicEventMap['bot:runtimeIncident'],'bot.runtime.incident')
    assert.ok(!normalizeWorkerEvent('','bot.runtime.incident',e).rawMessage.includes('secret'))
    assert.deepEqual(validateEventPayload('bot.runtime.incident',normalizeWorkerEvent('','bot.runtime.incident',e)),[])
    const f2=runtime();f2.incidents.handle(ban.replace('По причине: bot','По причине: secret'))
    assert.equal(JSON.stringify(f2.events).includes('secret'),false)
})

async function database(t){
    const dir=await mkdtemp(path.join(os.tmpdir(),'afina-incidents-')),db=new DataBaseManager({config:{databasePath:path.join(dir,'test.db')},logger})
    await db.init();t.after(async()=>{await db.beforeClose?.();db.close();await rm(dir,{recursive:true,force:true})});return db
}
async function replacementFixture(t,{bots=1,spares=0}={}){
    const db=await database(t),events=[],eventBus=new EventBus({logger}),processes=new Map();eventBus.onAny(e=>events.push(e))
    db.store.db.exec("INSERT INTO serverData VALUES(1,'localhost','1.21.11','test');INSERT INTO itemsData VALUES(1,'Stone','stone','{}');")
    for(let id=1;id<=bots+spares;id++){
        db.query('INSERT INTO accountsData(accountId,username,password) VALUES(?,?,?)').run(id,'Test'+id,'test-password')
        db.query('INSERT INTO accountPoolState(accountId) VALUES(?)').run(id)
        if(id<=bots){
            db.query('INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(?,?,?,1,101)').run(id,'Bot'+id,id)
            db.query("INSERT INTO tasksData(botId,type,itemId,buyPricePerOne,sellPricePerOne) VALUES(?,'reseller',1,10,20)").run(id)
            new IncidentStore(db.store).recordBan(id,normalizeFunTimeIncident(ban))
        }
    }
    const botManager={hasBot:id=>Boolean(db.query('SELECT botId FROM botData WHERE botId=?').get(id)),getBot:id=>processes.get(id),
        getBotDefinition:id=>db.query('SELECT * FROM botData WHERE botId=?').get(id),updateBotDefinitionAccount(){},discardBotProcess:id=>processes.delete(id),
        getBotRuntimeState:id=>({running:processes.get(id)?.running ?? false,desiredState:processes.get(id)?.desiredState ?? 'stopped',runtimeStatus:processes.get(id)?.runtimeStatus ?? 'offline'}),
        async startBot(id,guard){guard?.();const definition=this.getBotDefinition(id);const account=await db.getAccountData(definition.connectedAccountId)
            processes.set(id,{running:true,isRunning(){return this.running},desiredState:'running',runtimeStatus:'connecting',workReady:false,accountData:{...account,realm:101},serverData:{serverId:1},taskData:await db.getTasksData(id)})}}
    const accountPool=new AccountPool({logger,dataBaseManager:db}),assignment=new AccountAssignmentService({logger,dataBaseManager:db,accountPool,botManager})
    fixtureObservation(botManager,db.store)
    const core=new Core({logger,eventBus,botManager,dataBaseManager:db,accountPool,accountAssignmentService:assignment,configurationService:{async sync(){}}})
    // Explicit canonical ceiling; legacy target edits cannot raise this safety limit.
    core.autonomy.store.updateOperationsPolicy({capacity:{maximum:1000}},core.autonomy.store.operationsPolicy().revision)
    db.beforeClose=()=>core.stop()
    const set=values=>core.autonomy.updatePolicy({expectedRevision:core.autonomy.store.revision(),values})
    const run=()=>core.autonomy.evaluateNow()
    set({enabled:true,targetResellers:bots,autoReplaceBannedAccounts:true})
    return {db,core,set,run,events,processes,botManager,accountPool,assignment}
}
test('ban transaction persists current state/history and punishment deduplication survives reopen',async t=>{
    const db=await database(t),[account]=db.createGeneratedAccounts(),store=new IncidentStore(db.store)
    const first=store.recordBan(account.accountId,normalizeFunTimeIncident(ban))
    assert.equal(first.created,true);assert.equal((await db.getAccountData(account.accountId)).banned,1)
    assert.equal((await db.getAccountPoolState(account.accountId)).status,'blocked')
    db.close();await db.init();const again=new IncidentStore(db.store).recordBan(account.accountId,normalizeFunTimeIncident(ban.replace('55 с','40 с')))
    assert.equal(again.created,false);assert.equal(db.query('SELECT count(*) n FROM accountBanHistory').get().n,1)
    assert.equal(db.query('PRAGMA user_version').get().user_version,16)
})
test('fallback fingerprint ignores ticking duration but retains independent bans',async t=>{
    const db=await database(t),[a]=db.createGeneratedAccounts(),store=new IncidentStore(db.store),raw=ban.replace(/ID наказания:.*/,'')
    store.recordBan(a.accountId,normalizeFunTimeIncident(raw));store.recordBan(a.accountId,normalizeFunTimeIncident(raw.replace('55 с','20 с')))
    assert.equal(db.query('SELECT count(*) n FROM accountBanHistory').get().n,1)
    store.recordBan(a.accountId,normalizeFunTimeIncident(raw.replace('19.09','20.09')));assert.equal(db.query('SELECT count(*) n FROM accountBanHistory').get().n,2)
})

test('new observation after an explicit eligibility reset restores the same ban without duplicating history',async t=>{
    const db=await database(t),[a]=db.createGeneratedAccounts(),store=new IncidentStore(db.store)
    store.recordBan(a.accountId,normalizeFunTimeIncident(ban));db.query('UPDATE accountsData SET banned=0 WHERE accountId=?').run(a.accountId)
    const result=store.recordBan(a.accountId,normalizeFunTimeIncident(ban))
    assert.equal(result.created,false);assert.equal(result.reactivated,true)
    assert.equal((await db.getAccountData(a.accountId)).banned,1);assert.equal(db.query('SELECT count(*) n FROM accountBanHistory').get().n,1)
})
test('replacement and generation policies default off, persist and appear in existing policy contract',async t=>{
    const f=await replacementFixture(t);f.set({autoReplaceBannedAccounts:false});await f.run()
    assert.equal(f.core.autonomy.store.policy().allowAutomaticAccountGeneration,false)
    assert.equal(f.core.autonomy.store.policy().maxAccounts,0);assert.equal(f.processes.size,0)
    f.db.close();await f.db.init();assert.equal(f.core.autonomy.store.policy().autoReplaceBannedAccounts,false)
    assert.ok(f.core.autonomy.snapshot().fields.policy.autoReplaceBannedAccounts)
})
test('existing eligible account is preferred and logical workload survives with clean startup',async t=>{
    const f=await replacementFixture(t,{spares:1});f.db.createGeneratedAccounts=()=>assert.fail('generator must not run')
    await f.run();assert.equal(f.botManager.getBotDefinition(1).connectedAccountId,2)
    const p=f.processes.get(1);assert.equal(p.taskData.type,'reseller');assert.equal(p.taskData.itemId,1);assert.equal(p.accountData.accountId,2)
    assert.equal(f.core.autonomy.replacements.rows()[0].state,'initializing');assert.equal(f.events.some(e=>e.payload.type==='ACCOUNT_REPLACED'),false)
    p.runtimeStatus='running';p.workReady=true;await f.run();assert.equal(f.core.autonomy.replacements.rows()[0].state,'completed')
    assert.ok(f.events.some(e=>e.payload.type==='ACCOUNT_REPLACED'));assert.equal((await f.db.getAccountData(1)).banned,1)
})
for(const state of ['banned','disabled','blocked','retired','cooldown','assigned','reserved'])test('replacement excludes '+state+' spare account',async t=>{
    const f=await replacementFixture(t,{spares:1})
    if(['banned','disabled'].includes(state))f.db.query('UPDATE accountsData SET '+state+'=1 WHERE accountId=2').run()
    else if(state==='assigned')f.db.query("INSERT INTO botData(name,connectedAccountId) VALUES('other',2)").run()
    else if(state==='reserved')f.accountPool.reserved.add(2)
    else f.db.query('UPDATE accountPoolState SET status=?,cooldownUntil=? WHERE accountId=2').run(state,new Date(Date.now()+60000).toISOString())
    await f.run();assert.equal(f.processes.size,0);assert.equal(f.botManager.getBotDefinition(1).connectedAccountId,1)
})
test('pool exhaustion uses existing generator once; concurrent evaluations count pending startup',async t=>{
    const f=await replacementFixture(t);f.set({allowAutomaticAccountGeneration:true,maxAccounts:2})
    const generate=f.db.createGeneratedAccounts.bind(f.db);let calls=0;f.db.createGeneratedAccounts=(...args)=>{calls++;return generate(...args)}
    await Promise.all([f.run(),f.run(),f.run()]);assert.equal(calls,1)
    assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,2)
    const a=await f.db.getAccountData(2);assert.match(a.username,/^[A-Za-z][A-Za-z0-9_]{2,15}$/);assert.equal(a.password.length,24)
    assert.equal((await f.db.getAccountPoolState(2)).status,'available')
    assert.equal(f.core.autonomy.replacements.rows()[0].state,'initializing')
    assert.equal(JSON.stringify(f.events).includes(a.password),false);assert.equal(f.events.some(e=>e.payload.type==='ACCOUNT_REPLACED'),false)
})
test('replacement and ordinary spare generation share the execution-time total limit',async t=>{
    const f=await replacementFixture(t)
    f.core.autonomy.updateOperationsPolicy({expectedRevision:f.core.autonomy.store.operationsPolicy().revision,values:{reserve:{automaticAccountGeneration:true,maximumTotalAccounts:2,targetReadyAccounts:1}}})
    await f.run()
    assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,2)
    assert.equal(f.core.autonomy.replacements.rows()[0].state,'initializing')
    assert.equal(f.core.autonomy.accountGeneration.pending,0)
    assert.equal(f.core.autonomy.accountGeneration.retryAt,null)
    assert.ok(f.core.autonomy.store.decisions().some(d=>d.reasons.some(r=>r.code==='ACCOUNT_TOTAL_LIMIT_REACHED')))
})
for(const allowed of [false,true])test('generation disabled or zero global limit reports deficit: permission='+allowed,async t=>{
    const f=await replacementFixture(t);f.set({allowAutomaticAccountGeneration:allowed,maxAccounts:0})
    f.db.createGeneratedAccounts=()=>assert.fail('must respect cap');await f.run();await f.run()
    assert.equal(f.core.autonomy.replacements.rows()[0].state,'deficit');assert.equal(f.events.filter(e=>e.payload.type==='ACCOUNT_CAPACITY_DEFICIT').length,1)
})
test('multiple bans use existing pool first and generate only remaining capacity',async t=>{
    const f=await replacementFixture(t,{bots:3,spares:1});f.set({allowAutomaticAccountGeneration:true,maxAccounts:6})
    let calls=0;const generate=f.db.createGeneratedAccounts.bind(f.db);f.db.createGeneratedAccounts=(...args)=>{calls++;return generate(...args)}
    await f.run();await f.run();assert.equal(calls,2);assert.equal(f.processes.size,3)
    assert.equal(new Set([...f.processes.values()].map(p=>p.accountData.accountId)).size,3)
})
test('generator failure rolls back and enters bounded failure backoff',async t=>{
    const f=await replacementFixture(t);f.set({allowAutomaticAccountGeneration:true,maxAccounts:2});let calls=0
    f.db.createGeneratedAccounts=()=>{calls++;throw new Error('private failure')};await f.run();await f.run()
    assert.equal(calls,1);assert.equal(f.core.autonomy.replacements.rows()[0].state,'failed')
    assert.equal(JSON.stringify(f.events).includes('private failure'),false);assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,1)
})
test('policy off after irreversible creation prevents startup and preserves created account',async t=>{
    const f=await replacementFixture(t);f.set({allowAutomaticAccountGeneration:true,maxAccounts:2});const generate=f.db.createGeneratedAccounts.bind(f.db)
    f.db.createGeneratedAccounts=(...args)=>{const accounts=generate(...args);f.set({autoReplaceBannedAccounts:false});return accounts}
    await f.run();assert.equal(f.processes.size,0);assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,2)
    assert.equal(f.core.autonomy.replacements.rows()[0].replacementAccountId,2)
})
test('created request survives restart and does not duplicate generation',async t=>{
    const f=await replacementFixture(t);f.set({allowAutomaticAccountGeneration:true,maxAccounts:3})
    const generate=f.db.createGeneratedAccounts.bind(f.db);f.db.createGeneratedAccounts=(...args)=>{const a=generate(...args);f.set({autoReplaceBannedAccounts:false});return a}
    await f.run();f.db.close();await f.db.init();f.db.createGeneratedAccounts=()=>assert.fail('durable creation already exists')
    f.set({autoReplaceBannedAccounts:true});f.db.query('UPDATE accountReplacements SET retryAt=NULL').run();f.core.autonomy.lastPlans.clear();await f.run()
    assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,2);assert.equal(f.processes.size,1)
})
test('ban persists before notification and worker stop; duplicates do not repeat stop',async t=>{
    const db=await database(t),[a]=db.createGeneratedAccounts();await db.createBotData({connectedAccountId:a.accountId})
    const eventBus=new EventBus({logger}),manager=new BotManager({logger,eventBus,dataBaseManager:db});t.after(()=>clearInterval(manager.heartbeatTimer));await manager.loadBots()
    let stops=0;const process={botId:1,accountId:a.accountId,supervisorStatus:'running',taskData:{type:'test'},desiredState:'running',isRunning:()=>true,stop(){assert.equal(db.query('SELECT banned FROM accountsData').get().banned,1);stops++}}
    manager.bots.set(1,process);eventBus.onAny(e=>{if(e.type==='bot.runtime.incident')assert.equal(db.query('SELECT banned FROM accountsData').get().banned,1)})
    const event=createEvent({type:'bot.runtime.incident',payload:normalizeFunTimeIncident(ban),source:{kind:'bot',botId:1,accountId:a.accountId}})
    manager.handleRuntimeIncident(process,event);manager.handleRuntimeIncident(process,event)
    assert.equal(stops,1);assert.equal(process.desiredState,'stopped');assert.equal(process.reconnectBlocked,true)
})
test('inventory blocked main-process incident inhibits reconnect without stopping live worker',async t=>{
    const db=await database(t),eventBus=new EventBus({logger}),manager=new BotManager({logger,eventBus,dataBaseManager:db});t.after(()=>clearInterval(manager.heartbeatTimer))
    const process={botId:1,accountId:1,supervisorStatus:'running',stop(){assert.fail('operational block must not restart or stop worker')}};manager.bots.set(1,process)
    manager.handleRuntimeIncident(process,{type:'bot.runtime.incident',payload:{type:'INVENTORY_BLOCKED_BY_IGNORED_ITEMS',affectedSlots:[36]}})
    assert.equal(process.reconnectBlocked,true);assert.equal(process.operationalBlock.affectedSlots[0],36)
})
test('shared runtime keeps raw FunTime incident literals out of role and Core logic',async()=>{
    for(const file of ['src/minecraftBot/taskRunner/modes/reseller/resellerSeller.js','src/core/accountReplacements.js','src/botManager/botManagerMain.js']){
        const text=await readFile(file,'utf8');assert.ok(!text.includes(drop));assert.ok(!text.includes(air));assert.ok(!text.includes(cheat))
    }
})

test('connected replacement is pending capacity until realm readiness and journal completes only then',async t=>{
    const f=await replacementFixture(t,{spares:1});await f.run();const p=f.processes.get(1)
    p.runtimeStatus='running';p.workReady=false;await f.run()
    assert.equal(f.core.autonomy.readActual().roles.reseller,0)
    assert.equal(f.core.autonomy.readActual().pendingReplacements,1)
    const row=f.core.autonomy.replacements.rows()[0]
    assert.equal(f.core.autonomy.store.getDecision(row.decisionId).result,'applying')
    p.workReady=true;await f.run()
    assert.equal(f.core.autonomy.store.getDecision(row.decisionId).result,'applied')
    assert.equal(f.core.autonomy.readActual().roles.reseller,1)
})

test('higher-ID pending replacement reserves a reduced target before lower-ID bans are considered',async t=>{
    const f=await replacementFixture(t,{bots:3,spares:1});f.set({targetResellers:2,allowAutomaticAccountGeneration:true,maxAccounts:10})
    f.db.query('UPDATE botData SET connectedAccountId=4 WHERE botId=3').run()
    f.db.query("INSERT INTO accountReplacements(requestId,botId,bannedAccountId,replacementAccountId,state,createdAt,updatedAt) VALUES('existing',3,3,4,'initializing',?,?)").run(Date.now(),Date.now())
    await f.botManager.startBot(3)
    await f.run();await f.run()
    assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,5)
    assert.equal(f.processes.size,2)
})

test('banned worker still stopping cannot allocate a replacement',async t=>{
    const f=await replacementFixture(t,{spares:1})
    f.processes.set(1,{running:true,isRunning:()=>true,desiredState:'stopped',runtimeStatus:'running',taskData:await f.db.getTasksData(1)})
    await f.run();assert.equal(f.core.autonomy.readActual().roles.reseller,0)
    assert.equal(f.core.autonomy.replacements.rows().length,0);assert.equal(f.botManager.getBotDefinition(1).connectedAccountId,1)
})

test('duplicate ban while replacement initializes neither regenerates nor reassigns',async t=>{
    const f=await replacementFixture(t);f.set({allowAutomaticAccountGeneration:true,maxAccounts:10});await f.run()
    assert.equal(new IncidentStore(f.db.store).recordBan(1,normalizeFunTimeIncident(ban)).created,false)
    await f.run();await f.run()
    assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,2)
    assert.equal(f.core.autonomy.replacements.rows().length,1);assert.equal(f.botManager.getBotDefinition(1).connectedAccountId,2)
})

test('candidate disabled after selection cannot start and next controlled retry selects another account',async t=>{
    const f=await replacementFixture(t,{spares:2})
    f.core.eventBus.on('core.account.incident',p=>{if(p.type==='ACCOUNT_REPLACEMENT_SELECTED' && p.replacementAccountId===2)f.db.query('UPDATE accountsData SET disabled=1 WHERE accountId=2').run()})
    await f.run();assert.equal(f.processes.size,0);assert.equal(f.core.autonomy.replacements.rows()[0].state,'failed')
    f.db.query('UPDATE accountReplacements SET retryAt=NULL').run();f.core.autonomy.lastPlans.clear();await f.run()
    assert.equal(f.botManager.getBotDefinition(1).connectedAccountId,3);assert.equal(f.processes.size,1)
    assert.equal(f.db.query('SELECT count(*) n FROM accountsData').get().n,3)
})

test('stale policy while selection is queued cannot mutate the assignment',async t=>{
    const f=await replacementFixture(t,{spares:1});let release
    f.assignment.queue=new Promise(resolve=>{release=resolve})
    let requested;const waiting=new Promise(resolve=>{requested=resolve})
    f.core.eventBus.on('core.account.incident',p=>{if(p.type==='ACCOUNT_REPLACEMENT_REQUESTED')requested()})
    const evaluation=f.run();await waiting;f.set({autoReplaceBannedAccounts:false});release();await evaluation
    assert.equal(f.botManager.getBotDefinition(1).connectedAccountId,1);assert.equal(f.processes.size,0)
})

test('generated-account transaction rolls back account, pool state and creation callback together',async t=>{
    const db=await database(t)
    assert.throws(()=>db.createGeneratedAccounts(1,undefined,()=>{throw new Error('rollback')}),/rollback/)
    assert.equal(db.query('SELECT count(*) n FROM accountsData').get().n,0)
    assert.equal(db.query('SELECT count(*) n FROM accountPoolState').get().n,0)
})

test('ban transaction cannot leave history without banned account state',async t=>{
    const db=await database(t),[a]=db.createGeneratedAccounts()
    db.store.db.exec("CREATE TRIGGER fail_ban BEFORE UPDATE OF banned ON accountsData BEGIN SELECT RAISE(ABORT,'test storage failure'); END")
    assert.throws(()=>new IncidentStore(db.store).recordBan(a.accountId,normalizeFunTimeIncident(ban)),/test storage failure/)
    assert.equal(db.query('SELECT count(*) n FROM accountBanHistory').get().n,0)
    assert.equal((await db.getAccountData(a.accountId)).banned,0)
    assert.equal((await db.getAccountPoolState(a.accountId)).status,'available')
})

test('persisted ban blocks normal BotManager startup after application reopen',async t=>{
    const db=await database(t),[a]=db.createGeneratedAccounts();await db.createBotData({connectedAccountId:a.accountId})
    new IncidentStore(db.store).recordBan(a.accountId,normalizeFunTimeIncident(ban));db.close();await db.init()
    const manager=new BotManager({logger,eventBus:new EventBus({logger}),dataBaseManager:db});t.after(()=>clearInterval(manager.heartbeatTimer));await manager.loadBots()
    const p={botId:1,accountId:a.accountId,desiredState:'stopped',supervisorStatus:'offline',isRunning:()=>false,getRuntimeState(){return {}},start(){assert.fail('banned account cannot fork worker')}}
    manager.bots.set(1,p);await manager.startBot(1)
    assert.equal(p.desiredState,'stopped');assert.equal(p.reconnectBlocked,true);assert.equal(p.supervisorStatus,'blocked')
    assert.equal(manager.getBotRuntimeState(1).incident.type,'ACCOUNT_BANNED')
})

test('ban persistence failure stops the session without claiming successful persistence',async t=>{
    const db=await database(t),[a]=db.createGeneratedAccounts();await db.createBotData({connectedAccountId:a.accountId})
    const eventBus=new EventBus({logger}),manager=new BotManager({logger,eventBus,dataBaseManager:db}),events=[]
    t.after(()=>clearInterval(manager.heartbeatTimer));await manager.loadBots();eventBus.on('bot.runtime.incident',e=>events.push(e))
    let stopped=0;const p={botId:1,accountId:a.accountId,desiredState:'running',supervisorStatus:'running',isRunning:()=>true,stop(){stopped++}}
    manager.bots.set(1,p);manager.incidentStore.recordBan=()=>{throw new Error('storage failure')}
    manager.handleRuntimeIncident(p,{type:'bot.runtime.incident',payload:normalizeFunTimeIncident(ban)})
    assert.equal(stopped,1);assert.equal(p.reconnectBlocked,true);assert.equal(p.desiredState,'stopped')
    assert.deepEqual(events.map(e=>e.type),['BAN_PERSISTENCE_FAILED']);assert.equal((await db.getAccountData(a.accountId)).banned,0)
})

for(const values of [{disabled:true},{maxBots:0},{maxBuyPrice:5},{minSellPrice:30}])test('replacement respects item override '+JSON.stringify(values),async t=>{
    const f=await replacementFixture(t,{spares:1});f.set({allowAutomaticAccountGeneration:true,maxAccounts:10})
    f.core.autonomy.setOverride({itemId:1,values,expectedRevision:f.core.autonomy.store.revision()})
    f.db.createGeneratedAccounts=()=>assert.fail('workload no longer permitted');await f.run()
    assert.equal(f.processes.size,0);assert.equal(f.core.autonomy.replacements.rows().length,0)
})
