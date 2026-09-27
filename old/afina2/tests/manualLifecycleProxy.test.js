import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {randomUUID} from 'node:crypto'
import {fixture,logger,tick} from './helpers/lifecycleFixture.js'
import CommandService from '../src/core/commandService.js'
import QueryService from '../src/core/queryService.js'
import Core from '../src/core/coreMain.js'
import InterfaceGateway from '../src/interfaces/interfaceGateway.js'
import {proxyConnect} from '../src/minecraftBot/worker/proxyTransport.js'

async function webFixture(t){
 const f=await fixture(t),logs=[],log={...logger,info:(...args)=>logs.push(args),error:(...args)=>logs.push(args)};log.child=()=>log
 const commandService=new CommandService({logger:log,autonomy:f.core,botManager:f.manager,accountAssignmentService:{async ensureAccount(){return {accountId:1,changed:false}}}})
 const queryService=new QueryService({logger,autonomy:f.core,botManager:f.manager,snapshotStore:{get:id=>({botId:id})}})
 // Reuse the fixture's already-installed authority; exercise the actual facade methods.
 const facade=Object.assign(Object.create(Core.prototype),{commandService,queryService}),gateway=new InterfaceGateway({core:facade,eventBus:f.eventBus,logger})
 f.core.reconciler.executeCommand=request=>facade.executeCommand(request)
 const call=(name,payload={botId:1},type='command')=>gateway.handleRequest({type,name,payload},{type:'web',id:'operator'})
 const get=async()=>{const result=await call('bot.get',{botId:1},'query');assert.equal(result.ok,true);return result.data}
 const start=async()=>{const result=await call('bot.start');assert.equal(result.ok,true,JSON.stringify(result));const child=f.workers[0].bot.process;child.emit('spawn');return child}
 return {...f,logs,call,get,start}
}
test('Web START enters lifecycle, commits reservation before spawn and sends private credentials',async t=>{
 const f=await webFixture(t);f.core.proxies.save({proxyId:1,username:'user-secret',password:'pass-secret'})
 const child=await f.start(),r=f.core.proxies.owned()[0],a=f.ledger.active()[0]
 assert.equal(a.type,'START');assert.equal(a.metadata.manual,true);assert.equal(r.actionId,a.actionId);assert.equal(r.incarnationId,f.workers[0].bot.incarnationId);assert.equal(child.messages.find(m=>m.type==='init').payload.proxy.password,'pass-secret')
 assert.equal((await f.get()).proxy.reservationState,'RUNNING');assert.doesNotMatch(JSON.stringify(await f.get()),/user-secret|pass-secret/)
})
for(const blocker of ['NO_ELIGIBLE_PROXY','PROXY_CAPACITY_EXHAUSTED'])test('manual START fails closed: '+blocker,async t=>{
 const f=await webFixture(t)
 if(blocker==='NO_ELIGIBLE_PROXY')f.core.proxies.save({proxyId:1,active:false})
 else{f.policy({maximumBotsPerProxy:1});f.core.proxies.reserve({botId:99,actionId:'other',incarnationId:'other'})}
 const result=await f.call('bot.start');assert.equal(result.ok,false);assert.equal(result.error.message,blocker);assert.equal(f.workers[0].children.length,0);assert.equal(f.ledger.recent()[0].reason,blocker)
})
for(const command of ['bot.start','bot.stop','bot.restart'])test('manual '+command+' never uses compatibility authority without lifecycle',async()=>{
 const commands=new CommandService({logger,botManager:{startBot(){assert.fail('bypass')},stopBot(){assert.fail('bypass')},restartBot(){assert.fail('bypass')}}})
 const result=await commands.execute({command,payload:{botId:1},actor:{type:'web',id:'operator'}});assert.equal(result.error.code,'LIFECYCLE_UNAVAILABLE')
})
test('normal Web STOP drains and retains proxy until exit; no implicit force',async t=>{
 const f=await webFixture(t),child=await f.start();const response=await f.call('bot.stop'),a=f.ledger.get(response.data.actionId)
 assert.equal(a.type,'STOP');assert.equal(a.metadata.force,false);assert.equal(child.kills,0);assert.equal(f.core.proxies.owned().length,1)
 f.workers[0].ack(a.actionId);await tick();assert.equal(f.core.proxies.owned().length,1);assert.equal(child.kills,0)
 child.exit();await tick();assert.equal(f.core.proxies.owned().length,0);assert.equal((await f.get()).proxy,null)
})
test('Web RESTART waits for absence and acquires a fresh active proxy/incarnation',async t=>{
 const f=await webFixture(t),old=await f.start(),oldInc=f.workers[0].bot.incarnationId
 f.core.proxies.save({proxyId:1,active:false});const next=f.core.proxies.save({name:'Next',host:'localhost',port:1081})
 const response=await f.call('bot.restart');assert.equal(response.ok,true);assert.equal(f.workers[0].children.length,1);assert.equal(f.core.proxies.owned()[0].proxyId,1)
 f.workers[0].ack(response.data.actionId);await tick();old.exit();await tick();await tick()
 const child=f.workers[0].bot.process;assert.ok(child);child.emit('spawn');assert.notEqual(f.workers[0].bot.incarnationId,oldInc);assert.equal(f.core.proxies.owned()[0].proxyId,next.proxyId);assert.equal(old.kills,0)
})
test('bot queries expose RESERVED, inactive ownership and list/detail parity',async t=>{
 const f=await webFixture(t),response=await f.call('bot.start');assert.equal(response.ok,true)
 let bot=await f.get();assert.equal(bot.proxy.reservationState,'RESERVED');assert.equal(bot.proxy.transportConnected,false)
 f.core.proxies.save({proxyId:1,active:false});bot=await f.get();assert.equal(bot.proxy.active,false)
 const list=await f.call('bots.get',{},'query');assert.deepEqual(list.data[0].proxy,bot.proxy)
})
test('real SOCKS success evidence is current-incarnation only; closure and IPC loss clear it',async t=>{
 const f=await webFixture(t),child=await f.start(),inc=f.workers[0].bot.incarnationId,proxy=child.messages.find(m=>m.type==='init').payload.proxy
 const socket=new EventEmitter();socket.destroy=()=>{};const client=new EventEmitter();client.setSocket=()=>{}
 proxyConnect({proxy,incarnationId:inc,host:'server',connect:async()=>({socket}),onDiagnostic:(code,connectionId)=>child.emit('message',{type:'proxy:diagnostic',incarnationId:inc,code,connectionId})})(client);await tick()
 assert.equal((await f.get()).proxy.transportConnected,true);socket.emit('close');assert.equal((await f.get()).proxy.transportConnected,false)
 child.emit('message',{type:'proxy:diagnostic',incarnationId:'stale',code:'PROXY_TRANSPORT_CONNECTED',connectionId:randomUUID()});assert.equal((await f.get()).proxy.transportConnected,false)
 child.emit('message',{type:'proxy:diagnostic',incarnationId:inc,code:'PROXY_TRANSPORT_CONNECTED',connectionId:randomUUID()});assert.equal((await f.get()).proxy.transportConnected,true);child.emit('disconnect');assert.equal((await f.get()).proxy.transportConnected,false)
})
test('SOCKS authentication failure never supplies connected evidence or raw errors',async t=>{
 const f=await webFixture(t),child=await f.start(),inc=f.workers[0].bot.incarnationId,proxy=child.messages.find(m=>m.type==='init').payload.proxy,client=new EventEmitter();client.on('error',()=>{})
 proxyConnect({proxy,incarnationId:inc,host:'server',connect:async()=>{throw new Error('Authentication failed pass-secret')},onDiagnostic:(code,connectionId)=>child.emit('message',{type:'proxy:diagnostic',incarnationId:inc,code,connectionId})})(client);await tick()
 const data=await f.get();assert.equal(data.proxy.transportConnected,false);assert.equal(data.proxy.diagnostic.code,'PROXY_AUTHENTICATION_FAILED');assert.doesNotMatch(JSON.stringify(data),/pass-secret/)
})
test('proxy save credentials are absent from command logs and responses',async t=>{
 const f=await webFixture(t),result=await f.call('core.proxy.save',{name:'Private',host:'localhost',port:1082,username:'user-secret',password:'pass-secret'});assert.equal(result.ok,true);assert.doesNotMatch(JSON.stringify([f.logs,result]),/user-secret|pass-secret/)
})
