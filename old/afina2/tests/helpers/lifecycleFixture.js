import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,rm,readdir} from 'node:fs/promises'
import {DatabaseSync} from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import DatabaseStore from '../../src/data/databaseStore.js'
import AutonomousCore from '../../src/core/autonomousCore.js'
import BotManager from '../../src/botManager/botManagerMain.js'
import BotProcess from '../../src/botManager/botProcess.js'
import EventBus from '../../src/eventBus/eventBusMain.js'
import GracefulStop from '../../src/minecraftBot/worker/gracefulStop.js'
import BotTaskRunner from '../../src/minecraftBot/taskRunner/botTaskRunner.js'
import ResellerBuyer from '../../src/minecraftBot/taskRunner/modes/reseller/resellerBuyer.js'
import WorkerFacts from '../../src/minecraftBot/worker/workerFacts.js'
import {operationsSetting} from '../../src/core/coreCapabilities.js'

const logger={child(){return this},withContext(){return this},info(){},warn(){},error(){},log(){}}
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
async function fixture(t,{count=1}={}){
 const dir=await mkdtemp(path.join(os.tmpdir(),'afina-lifecycle-')),store=new DatabaseStore({databasePath:path.join(dir,'afina.db')});await store.init()
 store.db.exec("INSERT INTO serverData VALUES(1,'localhost','1','test')")
 for(let id=1;id<=count;id++){
  store.prepare('INSERT INTO accountsData(accountId,username,password) VALUES(?,?,?)').run(id,'Test'+id,'fixture-secret')
  store.prepare('INSERT INTO accountPoolState(accountId) VALUES(?)').run(id)
  store.prepare("INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(?,?,?,1,101)").run(id,'Bot'+id,id)
  store.prepare("INSERT INTO tasksData(taskId,botId,type,enabled) VALUES(?,?,'analyst',1)").run(id,id)
 }
 const eventBus=new EventBus({logger}),manager=new BotManager({logger,eventBus,dataBaseManager:{store}}),workers=[]
 for(let id=1;id<=count;id++){
  const children=[]
  const bot=new BotProcess({botId:id,accountData:{accountId:id,realm:101},taskData:{taskId:id,type:'analyst',enabled:1},serverData:{serverId:1},logger,eventBus,probeProcess:()=>bot.process?.alive===true,
   forkWorker:()=>{
    const child=new EventEmitter();Object.assign(child,{pid:1000+id,connected:true,alive:true,exitCode:null,signalCode:null,messages:[],kills:0})
    child.send=(message,cb)=>{
     child.messages.push(message);cb?.()
     if(message.type==='init')child.facts=new WorkerFacts({incarnationId:message.payload.incarnationId,bot:{botId:id,accountId:id,accountData:{realm:101},serverData:{serverId:1},taskData:{taskId:id,type:'analyst',enabled:1},status:'running',positionStatus:'realm',realmReadyTarget:101,realmReadyGate:{inspect:()=>({ready:true})},client:{entity:{},health:20,_client:{state:'play'}},taskRunner:{activeTask:{stopped:false}}}})
     if(message.type==='runtime:getFacts'&&child.ready)queueMicrotask(()=>child.emit('message',{type:'runtime:facts',requestId:message.requestId,incarnationId:message.incarnationId,facts:child.facts.read()}))
     if(message.type==='command'&&message.command==='stop'&&child.autoExit)queueMicrotask(()=>child.exit())
    }
    child.exit=()=>{child.alive=false;child.exitCode=0;child.emit('exit',0,null)}
    child.kill=()=>{child.kills++;child.exit()};children.push(child);return child
   }})
  manager.definitions.set(id,{botId:id,connectedAccountId:id,serverId:1,realm:101});manager.bots.set(id,bot)
  workers.push({bot,children,start(){bot.start();bot.process.emit('spawn');bot.desiredState='running';return bot.process},ack(actionId,state='safe',incarnationId=bot.incarnationId,child=bot.process){child.emit('message',{type:'lifecycle:quiescence',actionId,incarnationId,state,safe:state==='safe',reason:state==='unsafe'?'TRANSACTION_RESULT_UNCERTAIN':null})}})
 }
 const core=new AutonomousCore({dataBaseManager:{store},botManager:manager,eventBus,logger,configurationService:{async sync(){}},executeCommand:async request=>{await manager.startBot(request.payload.botId,request.executionGuard,request.actionId);manager.getBot(request.payload.botId).process.emit('spawn');return {ok:true}},observationOptions:{timeoutMs:5,scanTimeoutMs:100,concurrency:8}})
 core.proxies.save({name:'Fixture proxy',host:'localhost',port:1080,active:true});core.store.updateOperationsPolicy({maximumBotsPerProxy:100},core.store.operationsPolicy().revision)
 core.proxies.probe=pid=>workers.some(w=>w.bot.process?.pid===pid&&w.bot.process.alive)
 const signals=[];core.schedule=signal=>signals.push(signal)
 core.store.updateOperationsPolicy({automationEnabled:true,recovery:{autoReplaceBannedAccounts:true},capacity:{maximum:count},roles:{analyst:{target:count,maximum:count}},transitions:{startIntervalMs:0,stopIntervalMs:0,maximumConcurrentStarts:10,maximumConcurrentStops:10,gracefulStopTimeoutMs:50},stability:{minimumBotRuntimeMs:0,minimumBotDowntimeMs:0}},core.store.operationsPolicy().revision)
 for(const w of workers)w.bot.on('exit',exit=>{core.proxies.release(w.bot.incarnationId,'PROCESS_EXITED');core.lifecycle.exited(w.bot,exit)})
 const reserve=(type='START',id=1,manual=false)=>{
  const a=core.actions.ledger.reserve({type,logicalKey:'bot:'+id,botId:id,accountId:id,role:'analyst',policyRevision:core.store.operationsPolicy().revision,desiredRevision:1,inputRevision:core.store.revision(),deadlineAt:Date.now()+10000,metadata:{manual}}).action
  core.lifecycle.admit(a,{action:type==='STOP'?'stop_bot':type==='REPLACE'?'replace_account':'recover_bot'})
  core.actions.ledger.transition(a.actionId,'DISPATCHED');return core.actions.ledger.get(a.actionId)
 }
 const policy=patch=>core.store.updateOperationsPolicy(patch,core.store.operationsPolicy().revision)
 t.after(async()=>{await core.stop();for(const w of workers){w.bot.cancelQuiescence('TEST_END');w.bot.cancelFactRequest();clearTimeout(w.bot.stopTimer)}store.close();await rm(dir,{recursive:true,force:true})})
 return {dir,store,core,manager,eventBus,workers,reserve,policy,signals,life:core.lifecycle,ledger:core.actions.ledger}
}

export {fixture,logger,tick}
