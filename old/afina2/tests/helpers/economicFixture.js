import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {DatabaseSync} from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import DatabaseStore from '../../src/data/databaseStore.js'
import Core from '../../src/core/coreMain.js'
import CommandService from '../../src/core/commandService.js'
import EventBus from '../../src/eventBus/eventBusMain.js'
import BotTaskRunner from '../../src/minecraftBot/taskRunner/botTaskRunner.js'
import WorkerWorkload from '../../src/workloads/workerWorkload.js'
import {economicTerminal,economicRequest} from '../../src/workloads/economicContract.js'
import {fixtureObservation} from './fixtureObservation.js'
import {normalizeWorkerEvent} from '../../src/events/workerEventNormalizer.js'
import {coreCapabilities} from '../../src/core/coreCapabilities.js'

const logger={child(){return this},withContext(){return this},info(){},warn(){},error(){},log(){}}
const actor={type:'web',id:'operator'},tick=()=>new Promise(r=>setImmediate(r))
const request=(overrides={})=>({requestId:'manual-test-1',itemId:1,maxBuyPricePerItem:10,targetSellPricePerItem:20,targetQuantity:2,...overrides})
const until=async predicate=>{for(let n=0;n<300;n++){if(predicate())return;await new Promise(r=>setTimeout(r,5))}assert.fail('condition not reached')}
async function fixture(t,{count=1,transport=false,lots=[2],listing='success',purchase='success',limit=2,onConfirm=null,onListing=null}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'afina-economic-')),store=new DatabaseStore({databasePath:path.join(dir,'afina.db')});await store.init()
 store.db.exec(`INSERT INTO serverData VALUES(1,'localhost','1','test');INSERT INTO itemsData VALUES(1,'Apple','apple','{"minecraftName":"apple"}');`)
 const bots=new Map(),runtimes=new Map(),workers=[],sent=[],transactions=[],results=[],eventBus=new EventBus({logger})
 for(let id=1;id<=count;id++){
  store.prepare('INSERT INTO accountsData(accountId,username,password) VALUES(?,?,?)').run(id,'bot'+id,'test')
  store.prepare('INSERT INTO accountPoolState(accountId) VALUES(?)').run(id)
  store.prepare('INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(?,?,?,1,101)').run(id,'Bot'+id,id)
  store.prepare("INSERT INTO tasksData(botId,type,itemId,buyPricePerOne,sellPricePerOne,enabled) VALUES(?,'reseller',1,10,20,1)").run(id)
  const events=new EventEmitter(),incarnationId='fixture-'+(100+id),bot={botId:id,incarnationId,positionStatus:'realm',balance:100000,waitForInventoryUnlock:async()=>true,beginInventoryOperation(){},endInventoryOperation(){}}
  let cursor=null,windowId=0,available=[...lots]
  const client={inventory:{slots:Array(46).fill(null)},_client:{state:'play'},currentWindow:null,chat(text){
   if(text.startsWith('/ah search')){const slots=Array(54).fill(null),count=available[0];if(count)slots[0]={name:'apple',count,slot:0,components:[{type:'lore',data:['Цена $'+count*10]}]};this.currentWindow={id:++windowId,type:'generic_9x6',slots}}
   if(text.startsWith('/ah sell')){transactions.push('list');onListing?.(bot);const outcome=Array.isArray(listing)?listing.shift():listing;if(outcome==='timeout')return;if(outcome==='success'){this.inventory.slots[36]=null;events.emit('bot:message',{botId:id,text:'Предмет выставлен на продажу за $20'})}else events.emit('bot:message',{botId:id,text:'Не удалось выставить: освободите хранилище'})}
  },async clickWindow(slot,button){
   if(this.currentWindow){
    if(this.currentWindow.type==='generic_9x6'){this.currentWindow={id:++windowId,type:'confirmation',slots:[{name:'confirm'}]};return}
    transactions.push('buy');await onConfirm?.(bot);if(purchase==='throw')throw new Error('transport lost');if(purchase==='success'){const count=available.shift();this.inventory.slots[9]={name:'apple',count,slot:9}}
    return
   }
   if(button===1){this.inventory.slots[slot]={...cursor,count:1,slot};cursor.count--;return}
   if(cursor){if(cursor.count)this.inventory.slots[slot]={...cursor,slot};cursor=null}else{cursor=this.inventory.slots[slot];this.inventory.slots[slot]=null}
  },closeWindow(){this.currentWindow=null},setQuickBarSlot(){},async moveSlotItem(from,to){this.inventory.slots[to]={...this.inventory.slots[from],slot:to};this.inventory.slots[from]=null},async tossStack(){throw new Error('MUST_NOT_TOSS')}}
  bot.client=client
  const settings={get(key,fallback){if(/Delay|Jitter/.test(key))return 0;if(/Timeout/.test(key))return 60;return fallback}}
  const runner=new BotTaskRunner({bot,eventBus:events,logger,resellerSettingsStore:settings});bot.taskRunner=runner
  let role;if(transport)role=runner.start({type:'reseller',enabled:1})
  const idle=new WorkerWorkload({role:'reseller',incarnation:()=>incarnationId});idle.generation=1;idle.manualEconomicSupported=true
  bots.set(id,{get workload(){return runner.workload??idle},analysisState:'idle',sendEvent(event,payload){sent.push({botId:id,event,payload});if(transport)events.emit(event,payload);return true}})
  runtimes.set(id,{running:true,desiredState:'running',runtimeStatus:'running',workerPid:100+id})
  events.on('bot:economic.result',p=>{results.push(structuredClone(p));eventBus.publish('bot.economic.result',normalizeWorkerEvent('bot:economic.result','bot.economic.result',p),{kind:'bot',botId:id,workerPid:100+id,incarnationId})})
  workers.push({bot,runner,events,role,client})
 }
 const manager=fixtureObservation({hasBot:id=>bots.has(id),getBot:id=>bots.get(id),getBotRuntimeState:id=>runtimes.get(id)},store)
 const facade=new Core({dataBaseManager:{store},botManager:manager,eventBus,logger,configurationService:{async sync(){}}}),core=facade.autonomy;core.schedule=()=>{};await facade.start()
 core.store.updateOperationsPolicy({controller:{maxActionsPerCycle:limit,maxCandidatesPerCycle:limit,maxPassesPerDrain:1}},core.store.operationsPolicy().revision)
 const commands=facade.commandService
 const submit=async values=>{const r=await commands.execute({command:'core.economic.submit',payload:request(values),actor});assert.equal(r.ok,true,JSON.stringify(r));return r.data}
 const run=async values=>{const row=await submit(values);await core.evaluateNow();if(transport)await until(()=>economicTerminal.has(core.economic.store.get(row.workloadId).status));return core.economic.store.get(row.workloadId)}
 t.after(async()=>{for(const w of workers){w.runner.stop();await w.role}await core.stop();store.close();await rm(dir,{recursive:true,force:true})})
 return {dir,store,core,facade,commands,bots,runtimes,workers,sent,transactions,results,eventBus,manager,submit,run}
}

export {fixture,logger,actor,request,tick,until}
