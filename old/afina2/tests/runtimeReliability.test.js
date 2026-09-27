import {fixtureObservation} from './helpers/fixtureObservation.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import AntiAfkManager from '../src/minecraftBot/runtime/antiAfkManager.js'
import AfkRecovery from '../src/minecraftBot/runtime/afkRecovery.js'
import RealmReadyGate from '../src/minecraftBot/runtime/realmReadyGate.js'
import {runtimeConfig,validateAntiAfk,antiAfkFields} from '../src/minecraftBot/runtime/runtimeConfig.js'
import Bot from '../src/minecraftBot/bot.js'
import AnalystTask from '../src/minecraftBot/taskRunner/modes/analystTask.js'
import AnalystExecution from '../src/minecraftBot/taskRunner/modes/analyst/analystExecution.js'
import ResellerServerActions from '../src/minecraftBot/taskRunner/modes/reseller/server/resellerServerActions.js'
import {schema,addChangeTracking,upgradeToVersion2,upgradeToVersion3,upgradeToVersion4,upgradeToVersion5} from '../src/data/databaseSchema.js'
import DatabaseStore from '../src/data/databaseStore.js'
import CoreStore from '../src/core/coreStore.js'
import {normalizeWorkerEvent} from '../src/events/workerEventNormalizer.js'
import {WorkerPublicEventMap} from '../src/events/events.js'
import ConfigurationEvents from '../src/minecraftBot/handlers/botEvents/configurationEvents.js'
import SidebarEvents from '../src/minecraftBot/handlers/botEvents/sidebarEvents.js'
import {sendChat} from '../src/minecraftBot/worker/sendChat.js'
import {registerRoleLifecycle} from '../src/minecraftBot/worker/roleLifecycle.js'
import AutonomousCore from '../src/core/autonomousCore.js'
import EventBus from '../src/eventBus/eventBusMain.js'

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
class Clock{
    time=0;id=0;timers=new Map()
    now=()=>this.time
    setTimer=(fn,ms)=>{const id=++this.id;this.timers.set(id,{at:this.time+ms,fn});return id}
    clearTimer=id=>this.timers.delete(id)
    async advance(ms){
        const end=this.time+ms
        for(let i=0;i<1000;i++){
            const next=[...this.timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]
            if(!next)break
            this.time=next[1].at;this.timers.delete(next[0]);next[1].fn();await flush()
        }
        this.time=end;await flush()
    }
    wait=(ms,value,{signal})=>new Promise((resolve,reject)=>{
        const abort=()=>{this.clearTimer(id);reject(signal.reason)}
        const id=this.setTimer(()=>{signal.removeEventListener('abort',abort);resolve(value)},ms)
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort()
    })
}
const logger={info(){},warn(){},error(){},child(){return this}}
function fixture(overrides={}){
    const clock=new Clock(),client=new EventEmitter(),eventBus=new EventEmitter(),events=[],controls={}
    Object.assign(client,{entity:{position:{x:0,y:64,z:0}},_client:{state:'play'},health:20,physicsEnabled:true,
        setControlState:(key,value)=>{controls[key]=value},getControlState:key=>controls[key]===true})
    const bot={client,eventBus,logger,botId:1,accountId:1,accountData:{realm:101},taskData:{type:'analyst'},status:'running',positionStatus:'realm',realmReadyTarget:101,
        isInventoryBusy:()=>false,isInventoryLocked:()=>false,...overrides}
    for(const type of ['scheduled','started','forwardCompleted','returnCompleted','completed','deferred','failed','cancelled','diagnostic'])eventBus.on('bot:antiAfk:'+type,e=>events.push({type,...e}))
    const config={...runtimeConfig(),minIntervalMs:100,maxIntervalMs:200,movementTimeoutMs:1000,retryDelayMs:50}
    const manager=new AntiAfkManager({bot,config,random:()=>.5,now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer})
    bot.antiAfk=manager
    const tick=async x=>{client.entity.position.x=x;client.emit('physicsTick');await flush()}
    return {clock,client,bot,events,controls,manager,tick}
}
const released=f=>assert.ok(Object.values(f.controls).every(v=>v===false))

function recoveryFixture(){
    const f=fixture(),bot=new Bot({accountData:{accountId:1,realm:101},botId:1,taskData:{type:'test'},serverData:{},logger,eventBus:f.bot.eventBus})
    bot.antiAfk=f.manager;f.manager.bot=bot;f.bot=bot
    bot.client=f.client;bot.status='running';bot.requestedRealm=101
    bot.realmReadyGate=new RealmReadyGate({bot,now:f.clock.now,random:()=>0,wait:f.clock.wait})
    bot.afkRecovery=new AfkRecovery({bot,now:f.clock.now,setTimer:f.clock.setTimer,clearTimer:f.clock.clearTimer,transitionTimeoutMs:1000})
    bot.setPositionStatus('realm')
    const protocol=new EventEmitter();protocol.state='play';protocol.write=()=>{};f.client._client=protocol
    f.commands=[];f.client.chat=command=>f.commands.push(command);f.client.waitForTicks=async()=>{}
    f.client.quit=()=>{};f.client.clearControlStates=()=>{for(const key of Object.keys(f.controls))f.controls[key]=false}
    f.detect=()=>bot.eventBus.emit('bot:afkDetected',{botId:1,source:'message'})
    f.recoveryEvents=[]
    for(const type of ['started','hubRequested','hubConfirmed','realmRequested','realmConfirmed','ready','completed','failed','cancelled'])
        bot.eventBus.on('bot:afkRecovery:'+type,e=>f.recoveryEvents.push({type,...e}))
    f.sidebar=new SidebarEvents({bot,botId:1,eventBus:bot.eventBus,logger});f.sidebar.register(f.client)
    f.evidence=()=>protocol.emit('teams',{team:'TAB-Sidebar-1',mode:'add',prefix:'Статистика убийств смертей монет'})
    f.hub=()=>bot.botEventHandler.messageEvents.acceptMessage({message:'Добро пожаловать на FunTime',position:'system'})
    return f
}

function readinessFixture(){
    const f=recoveryFixture()
    f.manager.configure({...f.manager.config,minIntervalMs:100000,maxIntervalMs:100000})
    let id=0
    f.client.chat=command=>{
        f.commands.push(command)
        if(!command.startsWith('/ah'))return
        const window=new EventEmitter()
        Object.assign(window,{id:++id,type:'minecraft:generic_9x6',title:'Auction search',slots:Array(54).fill(null)})
        f.client.currentWindow=window;f.client.emit('windowOpen',window)
    }
    f.client.closeWindow=window=>{if(f.client.currentWindow===window)f.client.currentWindow=null;f.client.emit('windowClose',window)}
    f.recover=async()=>{await flush();await f.hub();await flush();f.evidence();await f.clock.advance(15000);await flush()}
    return f
}

test('AFK cancels physical prevention and sends one hub command after role cleanup',async()=>{
    const f=recoveryFixture();await f.clock.advance(150);const action=f.manager.action
    f.detect();assert.equal(f.bot.positionStatus,'afk');assert.equal(action.controller.signal.aborted,true);released(f)
    f.detect();f.detect();await flush()
    assert.deepEqual(f.commands,['/hub']);assert.equal(f.bot.positionStatus,'realmConnecting')
    assert.equal(f.manager.timer,null);assert.equal(f.manager.eligible(),false)
    assert.equal(f.events.some(e=>e.mode==='recovery'),false);assert.equal(f.bot.afkGeneration,1)
    f.bot.stop()
})

test('hub waits for actual lobby evidence and reuses configured realm action and ready gate',async()=>{
    const f=recoveryFixture(),unregister=registerRoleLifecycle({bot:f.bot,eventBus:f.bot.eventBus})
    f.bot.accountData.realm=227;f.bot.realmReadyTarget=227;f.bot.requestedRealm=227
    f.detect();await flush();f.evidence();assert.notEqual(f.bot.positionStatus,'realm')
    assert.deepEqual(f.commands,['/hub'])
    await f.hub();await flush();assert.deepEqual(f.commands,['/hub','/an227'])
    assert.equal(f.bot.positionStatus,'realmConnecting');assert.equal(f.bot.realmReadyGate.enteredAt,null)
    await f.hub();assert.deepEqual(f.commands,['/hub','/an227'])
    f.evidence();assert.equal(f.bot.positionStatus,'realm');assert.equal(f.bot.realmReadyGate.enteredAt,0)
    assert.equal(f.bot.taskRunner.activeTask,null);assert.equal(f.manager.timer,null)
    await f.clock.advance(14999);assert.equal(f.bot.taskRunner.activeTask,null)
    await f.clock.advance(1);assert.ok(f.bot.taskRunner.activeTask);assert.equal(f.bot.afkRecovery.active,null)
    assert.equal(f.manager.dueAt,15150);assert.equal(f.manager.lastRelevantActivityAt,15000)
    assert.deepEqual(f.recoveryEvents.map(e=>e.type),['started','hubRequested','hubConfirmed','realmRequested','realmConfirmed','ready','completed'])
    f.bot.stop();unregister();await flush()
})

test('cleanup ownership and independent inventory blockers delay hub without clearing another window',async()=>{
    const f=recoveryFixture(),lifetime=f.bot.taskRunner.start(f.bot.taskData),task=f.bot.taskRunner.activeTask,stop=task.stop.bind(task)
    let finish;task.stop=()=>{finish=()=>{f.client.clearControlStates();stop()}}
    f.detect();await flush();assert.deepEqual(f.commands,[])
    f.bot.beginInventoryOperation();const window={};f.client.currentWindow=window
    finish();await lifetime;await flush();assert.deepEqual(f.commands,[])
    assert.equal(f.client.currentWindow,window);f.bot.endInventoryOperation();f.client.currentWindow=null
    await f.clock.advance(100);assert.deepEqual(f.commands,['/hub']);released(f);f.bot.stop()
})

for(const interruption of ['stop','disconnect','restart','death','authentication','configuration','kick','shutdown'])
test(interruption+' cancels delayed recovery realm command and old generation',async()=>{
    const f=recoveryFixture();f.detect();await flush()
    let ticks;f.client.waitForTicks=()=>new Promise(resolve=>{ticks=resolve})
    const entering=f.hub();await flush();assert.ok(ticks)
    if(interruption==='stop')f.bot.stop()
    if(interruption==='disconnect')f.bot.setStatus('offline')
    if(interruption==='restart'){f.bot.restart()}
    if(interruption==='death')f.bot.setPositionStatus('dead')
    if(interruption==='authentication')f.bot.setPositionStatus('authentication')
    if(interruption==='configuration'){new ConfigurationEvents({bot:f.bot}).register(f.client);f.client._client.emit('start_configuration')}
    if(interruption==='kick' || interruption==='shutdown')f.bot.afkRecovery.cancel(interruption.toUpperCase())
    ticks();await entering;await flush();await f.clock.advance(2000)
    assert.deepEqual(f.commands,['/hub']);assert.equal(f.bot.afkRecovery.active,null)
    assert.ok(f.recoveryEvents.some(e=>e.type==='cancelled'));f.bot.stop()
})

for(const phase of ['hub','realm','cleanup'])test(phase+' timeout uses existing fatal/reconnect policy without command spam',async()=>{
    const f=recoveryFixture(),fatal=[];f.bot.eventBus.on('bot:fatal',e=>fatal.push(e))
    if(phase==='cleanup')f.bot.beginInventoryOperation()
    f.detect();await flush();if(phase==='realm')await f.hub()
    await f.clock.advance(1000);f.detect();await f.hub();await f.clock.advance(10000)
    assert.equal(fatal.length,1);assert.equal(fatal[0].reason,'afk_recovery_failed')
    assert.deepEqual(f.commands,phase==='hub'?['/hub']:phase==='realm'?['/hub','/an101']:[])
    assert.equal(f.recoveryEvents.filter(e=>e.type==='failed').length,1);f.bot.stop()
})

test('hub command rejection produces one structured failure',async()=>{
    const f=recoveryFixture();f.client.chat=async()=>{throw new Error('server command failed')}
    f.detect();await flush();assert.equal(f.recoveryEvents.at(-1).reason,'HUB_COMMAND_FAILED');f.bot.stop()
})

test('realm command rejection and readiness timeout fail without repeated transitions',async()=>{
    for(const stage of ['realm','gate']){
        const f=recoveryFixture();f.detect();await flush()
        if(stage==='realm')f.client.chat=async()=>{throw new Error('rejected')}
        else f.bot.realmReadyGate.ready=()=>new Promise(()=>{})
        await f.hub();if(stage==='gate')f.evidence()
        await f.clock.advance(23000)
        assert.equal(f.recoveryEvents.at(-1).reason,stage==='realm'?'REALM_COMMAND_FAILED':'READINESS_TIMEOUT')
        assert.equal(f.bot.afkRecovery.failed,true);f.bot.stop()
    }
})

test('actual lobby status also reuses realm entry, but an unissued realm command cannot confirm readiness',async()=>{
    const f=recoveryFixture();f.detect();await flush()
    let ticks;f.client.waitForTicks=()=>new Promise(resolve=>{ticks=resolve})
    f.bot.setPositionStatus('lobby');await flush();f.evidence()
    assert.equal(f.bot.positionStatus,'realmConnecting');assert.equal(f.bot.requestedRealm,null)
    ticks();await flush();assert.deepEqual(f.commands,['/hub','/an101']);f.bot.stop()
})

test('stop during cleanup cannot later send hub; replaced client cannot receive old realm callback',async()=>{
    const f=recoveryFixture(),lifetime=f.bot.taskRunner.start(f.bot.taskData),task=f.bot.taskRunner.activeTask
    const stop=task.stop.bind(task);task.stop=()=>{}
    f.detect();f.bot.stop();stop();await lifetime;await flush();assert.deepEqual(f.commands,[])
    const g=recoveryFixture();g.detect();await flush()
    let ticks;g.client.waitForTicks=()=>new Promise(resolve=>{ticks=resolve});const pending=g.hub();await flush()
    g.bot.client={_client:{state:'play'},health:20,chat:()=>assert.fail('stale command on replacement session')}
    ticks();await pending;assert.deepEqual(g.commands,['/hub']);g.bot.stop()
})

test('gate interruption never reports recovery completed or restarts a role',async()=>{
    const f=recoveryFixture(),unregister=registerRoleLifecycle({bot:f.bot,eventBus:f.bot.eventBus})
    f.detect();await flush();await f.hub();f.evidence();await f.clock.advance(100)
    f.bot.stop();await f.clock.advance(20000)
    assert.equal(f.recoveryEvents.some(e=>e.type==='completed'),false)
    assert.equal(f.bot.taskRunner.activeTask,null);assert.equal(f.manager.timer,null);unregister()
})

test('manual transition supersedes delayed recovery and invalidates its command',async()=>{
    const f=recoveryFixture();f.detect();await flush()
    let ticks;f.client.waitForTicks=()=>new Promise(resolve=>{ticks=resolve});const entering=f.hub();await flush()
    sendChat(f.bot,'/an303');ticks();await entering
    assert.deepEqual(f.commands,['/hub','/an303']);assert.equal(f.bot.afkRecovery.active,null)
    assert.ok(f.recoveryEvents.some(e=>e.reason==='EXTERNAL_TRANSITION'));f.bot.stop()
})

test('stale-session deadline cancels instead of failing a replacement session',async()=>{
    const f=recoveryFixture(),fatal=[];f.bot.eventBus.on('bot:fatal',e=>fatal.push(e))
    f.detect();await flush();f.bot.client={health:20,_client:{state:'play'}}
    await f.clock.advance(1000)
    assert.equal(f.recoveryEvents.at(-1).reason,'STALE_SESSION');assert.equal(fatal.length,0);f.bot.stop()
})

test('unexpected readiness rejection is a structured recovery failure',async()=>{
    const f=recoveryFixture();f.bot.realmReadyGate.ready=async()=>{throw new Error('gate failed')}
    f.detect();await flush();await f.hub();f.evidence();await flush()
    assert.equal(f.recoveryEvents.at(-1).reason,'READINESS_FAILED');assert.equal(f.bot.afkRecovery.failed,true);f.bot.stop()
})

test('prevention timeout alone never initiates hub recovery',async()=>{
    const f=recoveryFixture();await f.clock.advance(1150)
    assert.ok(f.events.some(e=>e.reason==='MOVEMENT_TIMEOUT'));assert.deepEqual(f.commands,[])
    assert.deepEqual(f.recoveryEvents,[]);f.bot.stop();await flush()
})

test('known server AFK response triggers runtime transition even with prevention disabled',async()=>{
    const f=recoveryFixture();f.manager.configure({...f.manager.config,enabled:false})
    await f.bot.botEventHandler.messageEvents.acceptMessage({message:'Данная команда недоступна в режиме AFK',position:'system'})
    await flush();assert.deepEqual(f.commands,['/hub']);assert.equal(f.manager.action,null);f.bot.stop()
})

test('realm recovery telemetry is normalized without secrets and roles contain no recovery',async()=>{
    assert.equal(WorkerPublicEventMap['bot:antiAfk:recoveryRequested'],undefined)
    const type=WorkerPublicEventMap['bot:afkRecovery:started'];assert.equal(type,'bot.afkRecovery.started')
    assert.deepEqual(normalizeWorkerEvent('',type,{generation:3,targetRealm:227,password:'hidden'}),{generation:3,targetRealm:227})
    for(const file of ['analystTask.js','idleTask.js','reseller/resellerTask.js'])assert.doesNotMatch(await readFile('src/minecraftBot/taskRunner/modes/'+file,'utf8'),/requestRecovery|afkRecovery|\/hub/)
    assert.doesNotMatch(await readFile('src/minecraftBot/runtime/antiAfkManager.js','utf8'),/requestRecovery|canRestoreWork|recoveryPending|\.chat\(/)
})

test('prevention snapshots mutable coordinates and observes real control state before and after input',async()=>{
    const f=fixture(),position=f.client.entity.position
    f.manager.sync();await f.clock.advance(150)
    const before=f.events.find(e=>e.stage==='CONTROL_BEFORE'),after=f.events.find(e=>e.stage==='CONTROL_AFTER')
    assert.equal(before.diagnostics.controlBefore,false);assert.equal(after.diagnostics.controlAfter,true)
    assert.equal(f.client.physicsEnabled,true);assert.equal(f.bot.positionStatus,'realm')
    position.y+=100;await f.tick(0)
    assert.equal(f.controls.forward,true)
    await f.tick(2);assert.equal(f.controls.back,true)
    assert.equal(f.client.entity.position,position)
    assert.deepEqual(f.events.find(e=>e.type==='started').startPosition,{x:0,y:64,z:0})
    await f.tick(.1);released(f)
    assert.equal(f.events.find(e=>e.type==='completed').forwardDistance,2)
    f.manager.stop()
})

for(const [observation,ticks,velocity] of [
    ['NO_PHYSICS_TICKS',0,0],['NO_HORIZONTAL_MOTION',5,0],['VELOCITY_WITHOUT_DISPLACEMENT',5,.1]
])test('prevention diagnosis distinguishes '+observation,async()=>{
    const f=fixture();f.client.entity.velocity={x:velocity,y:0,z:0};f.client.blockAt=()=>null
    f.manager.sync();await f.clock.advance(150)
    for(let i=0;i<ticks;i++)await f.tick(0)
    await f.clock.advance(750)
    const sample=f.events.find(e=>e.stage==='SAMPLE').diagnostics
    assert.equal(sample.controlStates.forward,true);assert.equal(sample.physicsTicks,ticks);assert.equal(sample.chunkLoaded,false)
    await f.clock.advance(250)
    const failed=f.events.find(e=>e.type==='failed')
    assert.equal(failed.reason,'MOVEMENT_TIMEOUT');assert.equal(failed.diagnostics.observation,observation)
    assert.equal(failed.diagnostics.controlStates.forward,true);released(f)
    await f.clock.advance(50);assert.equal(f.controls.forward,true)
    await f.tick(2);await f.tick(0);assert.ok(f.events.some(e=>e.type==='completed'));f.manager.stop()
})

test('external control cleanup is identified with caller and wrappers are restored',async()=>{
    const f=fixture()
    f.client.clearControlStates=()=>{for(const key of Object.keys(f.controls))f.client.setControlState(key,false)}
    const set=f.client.setControlState,clear=f.client.clearControlStates
    f.manager.sync();await f.clock.advance(150);f.client.clearControlStates()
    assert.ok(f.events.find(e=>e.stage==='EXTERNAL_CLEAR_ALL').diagnostics.caller.includes('runtimeReliability.test.js'))
    assert.equal(f.events.find(e=>e.stage==='EXTERNAL_CONTROL_CLEAR').diagnostics.control,'forward')
    await f.clock.advance(1000)
    assert.equal(f.events.find(e=>e.type==='failed').diagnostics.observation,'CONTROL_CLEARED')
    assert.equal(f.client.setControlState,set);assert.equal(f.client.clearControlStates,clear)
    assert.equal(f.client.listenerCount('physicsTick'),0);assert.equal(f.client.listenerCount('forcedMove'),0)
    f.manager.stop();assert.equal(f.clock.timers.size,0)
})

test('ignored forward input fails explicitly instead of assuming controls were applied',async()=>{
    const f=fixture();f.client.setControlState=(key,value)=>{if(!value)f.controls[key]=false}
    f.manager.sync();await f.clock.advance(150)
    assert.equal(f.events.find(e=>e.type==='failed').reason,'CONTROL_NOT_APPLIED');released(f);f.manager.stop()
})

test('detailed prevention traces are bounded while later failures retain physics summaries',async()=>{
    const f=fixture(),set=f.client.setControlState
    f.manager.sync();await f.clock.advance(150)
    for(let i=0;i<4;i++){
        await f.clock.advance(1000)
        assert.equal(f.client.setControlState,set);assert.equal(f.client.listenerCount('physicsTick'),0)
        if(i<3)await f.clock.advance(50)
    }
    assert.equal(f.events.filter(e=>e.stage==='START').length,1)
    assert.equal(f.events.filter(e=>e.stage==='SAMPLE').length,1)
    assert.equal(f.events.filter(e=>e.type==='failed').length,4)
    assert.equal(f.events.filter(e=>e.type==='failed').at(-1).diagnostics.observation,'NO_PHYSICS_TICKS')
    f.manager.stop();assert.equal(f.clock.timers.size,0)
})

test('movement diagnostics survive the worker public event boundary',()=>{
    const type=WorkerPublicEventMap['bot:antiAfk:diagnostic']
    assert.equal(type,'bot.antiAfk.diagnostic')
    const payload={botId:1,stage:'SAMPLE',diagnostics:{physicsTicks:0,controlStates:{forward:true}}}
    assert.deepEqual(normalizeWorkerEvent('bot:antiAfk:diagnostic',type,payload),payload)
})

for(const [name,overrides] of [
    ['disconnected',{status:'offline'}],['authentication',{positionStatus:'authentication'}],['hub',{positionStatus:'lobby'}],
    ['before realm ready',{positionStatus:'realmConnecting'}],['wrong target',{realmReadyTarget:102}]
])test('Anti-AFK is inactive '+name,async()=>{
    const f=fixture(overrides);f.manager.sync();await f.clock.advance(10000)
    assert.equal(f.clock.timers.size,0);assert.equal(f.events.length,0);assert.deepEqual(f.controls,{})
})
test('realm confirmation schedules randomized inactivity, never immediate movement',async()=>{
    const f=fixture();f.manager.sync();assert.equal(f.manager.dueAt,150)
    await f.clock.advance(149);assert.equal(f.controls.forward,undefined)
    await f.clock.advance(1);assert.equal(f.controls.forward,true);f.manager.stop();await flush();released(f)
})
test('movement uses displacement, reverses toward origin, cleans controls and randomizes again',async()=>{
    const f=fixture();f.manager.sync();await f.clock.advance(150)
    await f.tick(1.9);assert.equal(f.controls.forward,true);assert.equal(f.controls.back,undefined)
    await f.tick(2);assert.equal(f.controls.forward,false);assert.equal(f.controls.back,true)
    await f.tick(.1);released(f)
    assert.equal(f.events.filter(e=>e.type==='completed').length,1)
    assert.equal(f.events.find(e=>e.type==='completed').forwardDistance,2)
    assert.equal(f.manager.dueAt,300);f.manager.stop()
})
test('return also stops at configured backward displacement',async()=>{
    const f=fixture();f.manager.config.backwardBlocks=1;f.manager.sync();await f.clock.advance(150)
    await f.tick(2);await f.tick(1);released(f);assert.ok(f.events.some(e=>e.type==='completed'));f.manager.stop()
})
test('timeout releases every control and retries after retryDelayMs',async()=>{
    const f=fixture();f.manager.sync();await f.clock.advance(1150);released(f)
    assert.ok(f.events.some(e=>e.type==='failed' && e.reason==='MOVEMENT_TIMEOUT'))
    await f.clock.advance(49);assert.equal(f.controls.forward,false)
    await f.clock.advance(1);assert.equal(f.controls.forward,true);f.manager.stop();await flush()
})
test('movement exception releases controls and emits a structured failure',async()=>{
    const f=fixture(),set=f.client.setControlState
    f.client.setControlState=(key,value)=>{set(key,value);if(value)throw new Error('simulated')}
    f.manager.sync();await f.clock.advance(150);released(f)
    assert.ok(f.events.some(e=>e.type==='failed' && e.reason==='MOVEMENT_ERROR'));f.manager.stop()
})
for(const reason of ['DISCONNECTED','RESTART','ROLE_STOPPED'])test(reason+' cancels pending and active movement synchronously',async()=>{
    const f=fixture();f.manager.sync();f.manager.stop(reason);await f.clock.advance(500);assert.deepEqual(f.controls,{})
    const g=fixture();g.manager.sync();await g.clock.advance(150);g.manager.stop(reason);released(g)
    await flush();assert.equal(g.clock.timers.size,0);assert.ok(g.events.some(e=>e.type==='cancelled'))
})
test('leaving realm invalidates movement and next entry starts a fresh idle interval',async()=>{
    const f=fixture();f.manager.sync();await f.clock.advance(150)
    f.bot.positionStatus='lobby';f.manager.sync();released(f);await flush()
    await f.clock.advance(1000);assert.equal(f.events.filter(e=>e.type==='started').length,1)
    f.bot.positionStatus='realm';f.manager.sync();assert.equal(f.manager.dueAt,f.clock.time+150);f.manager.stop()
})
test('token blockers defer overdue work and cannot release another owner',async()=>{
    const f=fixture();f.manager.sync();const a=f.manager.acquireBlock('A'),b=f.manager.acquireBlock('B')
    await f.clock.advance(200);await f.manager.performIfDue();assert.ok(f.events.some(e=>e.type==='deferred'))
    a();a();await f.clock.advance(100);assert.equal(f.controls.forward,undefined)
    b();await f.clock.advance(1);assert.equal(f.controls.forward,true);f.manager.stop();await flush()
})
test('open GUI and inventory busy state defer without closing someone else\'s window',async()=>{
    for(const kind of ['window','busy','locked']){
        const f=fixture();if(kind==='window')f.client.currentWindow={};else f.bot[kind==='busy'?'isInventoryBusy':'isInventoryLocked']=()=>true
        f.manager.sync();await f.clock.advance(300);assert.equal(f.controls.forward,undefined)
        f.client.currentWindow=null;f.bot.isInventoryBusy=()=>false;f.bot.isInventoryLocked=()=>false
        await f.clock.advance(100);assert.equal(f.controls.forward,true);f.manager.stop();await flush()
    }
})
test('cancelled Anti-AFK cleanup cannot clear the new movement owner\'s controls',async()=>{
    const f=fixture();f.manager.sync();await f.clock.advance(150)
    const release=f.manager.acquireBlock('OTHER_MOVEMENT');released(f)
    f.client.setControlState('left',true);await flush();assert.equal(f.controls.left,true)
    f.client.setControlState('left',false);release();f.manager.stop()
})
test('only one action per bot; independent bots own their timers and cancellation',async()=>{
    const a=fixture(),b=fixture();a.manager.sync();b.manager.sync();await a.clock.advance(150);await b.clock.advance(150)
    void a.manager.performIfDue();void a.manager.performIfDue();assert.equal(a.events.filter(e=>e.type==='started').length,1)
    a.manager.stop();released(a);assert.equal(b.controls.forward,true);b.manager.stop();await flush()
})
test('confirmed intentional movement postpones deadline, passive packets do not',async()=>{
    const f=fixture();f.manager.sync();f.manager.observeMovement();await f.clock.advance(50)
    f.client.entity.position.x=1;f.manager.observeMovement();assert.equal(f.manager.dueAt,150)
    f.controls.forward=true;f.client.entity.position.x=2;f.manager.observeMovement();assert.equal(f.manager.dueAt,200)
    f.controls.forward=false;f.manager.stop()
})
test('runtime config validation and disabling cancels active movement',async()=>{
    for(const patch of [{minIntervalMs:0},{maxIntervalMs:1},{forwardBlocks:0},{backwardBlocks:-1},{movementTimeoutMs:0},{retryDelayMs:-1},{enabled:1}])assert.throws(()=>validateAntiAfk({...runtimeConfig(),...patch}))
    const f=fixture();f.manager.sync();await f.clock.advance(150)
    f.manager.configure({...f.manager.config,enabled:false});released(f);await flush();assert.equal(f.clock.timers.size,0)
})
test('Reseller and idle have no legacy Anti-AFK implementation; server operation owns a common token',async()=>{
    const reseller=await readFile(new URL('../src/minecraftBot/taskRunner/modes/reseller/resellerTask.js',import.meta.url),'utf8')
    const idle=await readFile(new URL('../src/minecraftBot/taskRunner/modes/idleTask.js',import.meta.url),'utf8')
    assert.doesNotMatch(reseller+idle,/ResellerAntiAfk|new AntiAfk|resetTimer/)
    await assert.rejects(readFile(new URL('../src/minecraftBot/taskRunner/modes/reseller/antiAfk/resellerAntiAfk.js',import.meta.url)),{code:'ENOENT'})
    const f=fixture();f.client.chat=()=>assert.equal(f.manager.blocks.size,1)
    const server=new ResellerServerActions({bot:f.bot,canContinue:()=>true,delay:{async wait(){},markInteraction(){}}})
    await server.chat('/test');assert.equal(f.manager.blocks.size,0);f.manager.stop()
})
function gateFixture(){
    const f=fixture();f.gate=new RealmReadyGate({bot:f.bot,now:f.clock.now,random:()=>.5,wait:f.clock.wait});return f
}
test('Analyst realm delay starts only on realm confirmation and includes injected jitter',async()=>{
    const f=gateFixture();await assert.rejects(f.gate.ready(),/DISCONNECTED/)
    f.gate.enter();let ready=false;const pending=f.gate.ready().then(()=>{ready=true})
    await f.clock.advance(16499);assert.equal(ready,false)
    await f.clock.advance(1);await pending;assert.equal(ready,true)
    await f.gate.ready();assert.equal(f.clock.timers.size,0)
})
for(const reason of ['disconnect','restart','realm transition'])test(reason+' invalidates Analyst delay and prevents stale task start',async()=>{
    const f=gateFixture();f.gate.enter();const pending=f.gate.ready(),rejected=assert.rejects(pending,/CANCELLED/)
    await f.clock.advance(1000);f.gate.invalidate();await rejected;await f.clock.advance(20000);assert.equal(f.clock.timers.size,0)
    f.gate.enter();let ready=false;const next=f.gate.ready().then(()=>{ready=true})
    await f.clock.advance(16499);assert.equal(ready,false);await f.clock.advance(1);await next
})
test('Analyst task waits through gate, cancellation cannot send auction chat',async()=>{
    const f=gateFixture(),calls=[];f.bot.realmReadyGate=f.gate;f.gate.enter()
    const task=new AnalystTask({bot:f.bot,eventBus:f.bot.eventBus,logger});const lifetime=task.start()
    f.client.chat=message=>calls.push(message)
    const running=task.assign({analysisId:'cancel-before-ready',timing:{}})
    await f.clock.advance(1000);assert.deepEqual(calls,[])
    task.stop();await running;await lifetime;await f.clock.advance(20000);assert.deepEqual(calls,[])
})
test('actual Bot lifecycle shares readiness cancellation with Anti-AFK',async()=>{
    const f=fixture(),bot=new Bot({accountData:{accountId:1,realm:101},botId:1,taskData:{type:'test'},serverData:{},logger,eventBus:f.bot.eventBus})
    bot.client=f.client;bot.status='running';bot.setPositionStatus('realm')
    assert.equal(bot.realmReadyTarget,101);assert.ok(bot.realmReadyGate.enteredAt)
    const generation=bot.realmReadyGate.generation
    bot.setPositionStatus('lobby');assert.equal(bot.realmReadyTarget,null);assert.ok(bot.realmReadyGate.generation>generation)
    bot.setPositionStatus('realm');bot.stop();assert.equal(bot.antiAfk.stopped,true);assert.equal(bot.realmReadyGate.enteredAt,null)
})
test('Analyst sends the first search only after the confirmed-entry delay elapses',async()=>{
    const f=gateFixture(),calls=[],window=new EventEmitter()
    f.manager.configure({...f.manager.config,enabled:false});f.bot.realmReadyGate=f.gate;f.gate.enter()
    Object.assign(window,{id:1,type:'minecraft:generic_9x6',title:'Auction search',slots:Array(54).fill(null)})
    f.client.chat=message=>{calls.push({message,at:f.clock.time});f.client.currentWindow=window;f.client.emit('windowOpen',window)}
    f.client.closeWindow=()=>{f.client.currentWindow=null}
    const task=new AnalystTask({bot:f.bot,eventBus:f.bot.eventBus,logger}),lifetime=task.start()
    const running=task.assign({analysisId:'delayed-search',query:'apple',matcher:{},observationCount:1,timing:{minimumRefreshIntervalMs:5000,refreshJitterMs:0,windowTimeoutMs:1000}})
    await f.clock.advance(16499);assert.deepEqual(calls,[])
    await f.clock.advance(1);await running
    assert.deepEqual(calls,[{message:'/ah search apple',at:16500}]);task.stop();await lifetime
})
test('Bot applies live runtime settings through the existing worker event bus',()=>{
    const f=fixture(),bot=new Bot({accountData:{accountId:1,realm:101},botId:1,taskData:{type:'reseller'},serverData:{},logger,eventBus:f.bot.eventBus})
    f.bot.eventBus.emit('runtime:configure',{antiAfkEnabled:false,antiAfkForwardBlocks:3,antiAfkMaxIntervalMs:55000})
    assert.equal(bot.antiAfk.config.enabled,false);assert.equal(bot.antiAfk.config.forwardBlocks,3);assert.equal(bot.antiAfk.config.maxIntervalMs,55000)
    bot.stop()
})
test('configuration and manual realm/hub commands invalidate ready state before sending',()=>{
    const f=fixture(),statuses=[];f.bot.setPositionStatus=value=>{statuses.push(value);f.bot.positionStatus=value}
    f.client._client=new EventEmitter();f.client._client.state='play';f.client._client.write=()=>{}
    new ConfigurationEvents({bot:f.bot}).register(f.client);f.client._client.emit('start_configuration')
    assert.equal(statuses[0],'realmConnecting')
    f.client.chat=()=>assert.equal(f.bot.positionStatus,'realmConnecting')
    sendChat(f.bot,'/an102');assert.equal(f.bot.requestedRealm,102)
    sendChat(f.bot,'/hub');assert.equal(f.bot.requestedRealm,null)
})
test('sidebar confirms the requested target only, and cannot revive known AFK state',()=>{
    const f=fixture({positionStatus:'realmConnecting'}),protocol=new EventEmitter()
    f.bot.setPositionStatus=status=>{f.bot.positionStatus=status}
    f.bot.setBalance=()=>false
    const sidebar=new SidebarEvents({bot:f.bot,botId:1,eventBus:f.bot.eventBus,logger})
    sidebar.register({_client:protocol})
    const packet={team:'TAB-Sidebar-1',mode:'add',prefix:'Статистика убийств смертей монет'}
    f.bot.requestedRealm=102;protocol.emit('teams',packet);assert.equal(f.bot.positionStatus,'realmConnecting')
    f.bot.requestedRealm=101;protocol.emit('teams',packet);assert.equal(f.bot.positionStatus,'realm')
    f.bot.positionStatus='afk';protocol.emit('teams',packet);assert.equal(f.bot.positionStatus,'afk')
})
test('Analyst yields its own GUI between observations for overdue runtime movement',async()=>{
    const client=new EventEmitter(),window=new EventEmitter(),trace=[]
    Object.assign(window,{id:1,type:'minecraft:generic_9x6',title:'Auction search',slots:Array(54).fill(null)})
    client.chat=()=>{trace.push('search');client.currentWindow=window;client.emit('windowOpen',window)}
    client.closeWindow=w=>{assert.equal(w,window);client.currentWindow=null;client.emit('windowClose',w);trace.push('close')}
    let blocked=false
    const antiAfk={acquireBlock(){blocked=true;return ()=>{blocked=false}},isDue:()=>true,async performIfDue(){assert.equal(blocked,false);assert.equal(client.currentWindow,null);trace.push('move')}}
    const execution=new AnalystExecution({client,logger,antiAfk,parser:{scan:()=>[]},wait:async()=>{}})
    await execution.execute({analysisId:'safe-point',query:'apple',observationCount:2,timing:{minimumRefreshIntervalMs:5000,refreshJitterMs:0,windowTimeoutMs:1000}},{onObservation(){},onProgress(){}})
    assert.deepEqual(trace,['search','close','move','search','close']);assert.equal(blocked,false)
})
test('v5 migration persists runtime defaults and validated policy edits across reopen',async t=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'afina-runtime-')),config={databasePath:path.join(dir,'afina.db')}
    const old=new DatabaseSync(config.databasePath);old.exec(schema);addChangeTracking(old)
    upgradeToVersion2(old);upgradeToVersion3(old);upgradeToVersion4(old);upgradeToVersion5(old)
    old.exec('PRAGMA user_version=5')
    old.close();let store=new DatabaseStore(config);await store.init()
    t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})})
    const core=new CoreStore(store),policy=core.policy()
    assert.equal(policy.analysisRealmReadyDelayMs,15000);assert.equal(policy.analysisRealmReadyDelayJitterMs,3000)
    for(const [key,f] of Object.entries(antiAfkFields))assert.equal(policy[key],f.defaultValue)
    assert.throws(()=>core.updatePolicy({antiAfkMinIntervalMs:50001},core.revision()),/maxInterval/)
    assert.throws(()=>core.updatePolicy({analysisRealmReadyDelayMs:-1},core.revision()))
    core.updatePolicy({antiAfkEnabled:false,antiAfkForwardBlocks:1.5,analysisRealmReadyDelayMs:12345},core.revision())
    store.close();store=new DatabaseStore(config);await store.init();const next=new CoreStore(store).policy()
    assert.equal(next.antiAfkEnabled,false);assert.equal(next.antiAfkForwardBlocks,1.5);assert.equal(next.analysisRealmReadyDelayMs,12345)
    assert.deepEqual(store.prepare('PRAGMA foreign_key_check').all(),[])
    assert.equal((await readdir(path.join(dir,'backups'))).length,1)
})
test('Anti-AFK lifecycle events cross existing public bridge without secret payload fields',()=>{
    const type=WorkerPublicEventMap['bot:antiAfk:completed'];assert.equal(type,'bot.antiAfk.completed')
    assert.deepEqual(normalizeWorkerEvent('bot:antiAfk:completed',type,{botId:1,durationMs:500,password:'hidden'}),{botId:1,durationMs:500})
})


test('Reseller window cancellation never closes a replacement GUI or another client',()=>{
    for(const replacement of ['window','client']){
        const f=recoveryFixture(),window={}
        f.client.currentWindow=window;f.client.closeWindow=()=>assert.fail('unowned window must stay open')
        const server=new ResellerServerActions({bot:f.bot,canContinue:()=>true,delay:{}})
        server.rememberWindow(f.client,window)
        if(replacement==='window')f.client.currentWindow={}
        else f.bot.client={_client:{state:'play'},currentWindow:window}
        server.closeOwnedWindow();f.manager.stop()
    }
})
test('restored readiness waits for old role cleanup; later stop cancels queued resumption',async()=>{
    for(const stopAgain of [false,true]){
        const f=recoveryFixture(),runner=f.bot.taskRunner
        let finishOld;runner.activeTask={stop(){}}
        runner.completion=new Promise(resolve=>{finishOld=()=>{runner.activeTask=null;resolve()}})
        runner.stop()
        const resumed=runner.start(f.bot.taskData)
        assert.ok(runner.activeTask);if(stopAgain)runner.stop()
        finishOld();await flush()
        if(stopAgain)assert.equal(runner.activeTask,null)
        else assert.ok(runner.activeTask)
        runner.stop();await resumed;f.manager.stop()
    }
})


async function coreRecoveryFixture(t,{dropFailure=false}={}){
    const f=readinessFixture(),dir=await mkdtemp(path.join(os.tmpdir(),'afina-afk-lifecycle-'))
    const store=new DatabaseStore({databasePath:path.join(dir,'afina.db')});await store.init()
    store.db.exec(`INSERT INTO serverData VALUES(1,'localhost','1','Test');
        INSERT INTO accountsData(accountId,username,password) VALUES(1,'TestBot','test');
        INSERT INTO accountPoolState(accountId) VALUES(1);
        INSERT INTO botData(botId,name,connectedAccountId,serverId,realm) VALUES(1,'Test',1,1,101);
        INSERT INTO itemsData VALUES(1,'Apple','apple','{}');
        INSERT INTO tasksData(botId,type,enabled) VALUES(1,'analyst',1);`)
    f.bot.taskData=store.prepare('SELECT * FROM tasksData').get()
    const process={taskData:f.bot.taskData,accountData:{realm:101},serverData:{serverId:1},analysisState:'unavailable',sendEvent(event,payload){f.bot.eventBus.emit(event,payload);return true}}
    const eventBus=new EventBus({logger}),runtime={running:true,desiredState:'running',runtimeStatus:'running',workerPid:77}
    const core=new AutonomousCore({dataBaseManager:{store},botManager:fixtureObservation({getBot:()=>process,getBotRuntimeState:()=>runtime},store,f.bot),eventBus,logger,configurationService:{async sync(){}},executeCommand:async()=>({ok:true})})
    f.coreEvents=[];eventBus.onAny(event=>f.coreEvents.push(event))
    for(const [local,type] of Object.entries(WorkerPublicEventMap)){
        f.bot.eventBus.on(local,payload=>{
            if(dropFailure && type==='bot.analysis.failed')return
            eventBus.publish(type,normalizeWorkerEvent(local,type,payload),{kind:'bot',botId:1,workerPid:77})
        })
    }
    const unregister=registerRoleLifecycle({bot:f.bot,eventBus:f.bot.eventBus})
    await core.start()
    // Explicit canonical ceiling; legacy target edits cannot raise this safety limit.
    core.store.updateOperationsPolicy({capacity:{maximum:1000}},core.store.operationsPolicy().revision)
    core.updatePolicy({expectedRevision:core.store.revision(),values:{enabled:true,autoAnalysis:true,targetAnalysts:1,autoAllocateBots:false,
        analysisMinObservations:2,analysisMaxObservations:2,analysisRealmReadyDelayMs:0,analysisRealmReadyDelayJitterMs:0}})
    const role=f.bot.taskRunner.start(f.bot.taskData);await core.evaluateNow();await flush()
    t.after(async()=>{f.bot.stop();unregister();await role;await flush();await core.stop();store.close();await rm(dir,{recursive:true,force:true})})
    return {...f,core,store,process}
}

for(const dropFailure of [false,true])test('Core releases AFK job and reassigns after hub recovery; dropped failure='+dropFailure,async t=>{
    const f=await coreRecoveryFixture(t,{dropFailure}),old=f.core.marketStore.sessions()[0]
    assert.ok(old);assert.equal(f.bot.taskRunner.activeTask.job.id,old.analysisId)
    f.detect();f.detect();await flush()
    assert.equal(f.bot.taskRunner.activeTask,null)
    assert.equal(f.core.marketStore.session(old.analysisId).failureCode,'AFK_INTERRUPTED')
    assert.equal(f.core.marketStore.sessions().length,0);assert.equal(f.process.analysisState,'unavailable')
    await f.core.evaluateNow();assert.equal(f.core.marketStore.sessions().length,0)
    await f.recover();assert.equal(f.bot.positionStatus,'realm');assert.ok(f.bot.taskRunner.activeTask)
    await f.core.evaluateNow();await flush()
    const replacement=f.core.marketStore.sessions()[0]
    assert.ok(replacement);assert.notEqual(replacement.analysisId,old.analysisId)
    assert.equal(f.bot.taskRunner.activeTask.job.id,replacement.analysisId)
    assert.equal(f.commands.filter(c=>c==='/hub').length,1);assert.equal(f.commands.filter(c=>c==='/an101').length,1)
    assert.equal(f.bot.eventBus.listenerCount('core:analysis.assign'),1)
})

test('Reseller stops and starts exactly one new instance after hub recovery readiness',async()=>{
    const f=readinessFixture();f.bot.taskData={type:'reseller',enabled:1}
    f.bot.resellerSettingsStore={get:(name,fallback)=>name==='realmStartDelayMs'?100:name==='idleLoopDelayMs'?1:fallback}
    f.bot.taskRunner.resellerSettingsStore=f.bot.resellerSettingsStore
    const unregister=registerRoleLifecycle({bot:f.bot,eventBus:f.bot.eventBus})
    const lifetime=f.bot.taskRunner.start(f.bot.taskData),old=f.bot.taskRunner.activeTask
    f.detect();f.detect();await lifetime;await flush()
    assert.equal(f.bot.taskRunner.activeTask,null);assert.equal(old.running,false)
    await f.hub();f.evidence();await f.clock.advance(99);assert.equal(f.bot.taskRunner.activeTask,null)
    await f.clock.advance(1);const next=f.bot.taskRunner.activeTask
    assert.ok(next);assert.notEqual(next,old);f.evidence();assert.equal(f.bot.taskRunner.activeTask,next)
    const completion=f.bot.taskRunner.completion;f.bot.stop();await completion;unregister()
    assert.deepEqual(f.commands,['/hub','/an101'])
})
