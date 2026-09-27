import test from 'node:test'
import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import ConfigurationEvents from '../src/minecraftBot/handlers/botEvents/configurationEvents.js'
const require=createRequire(import.meta.url)
const Client=require('minecraft-protocol/src/client.js')
const {createDeserializer}=require('minecraft-protocol/src/transforms/serializer.js')

function fixture(t,state='play'){
    const protocol=new Client(false,'1.21.11');protocol.state=state
    const client=new EventEmitter(),eventBus=new EventEmitter(),events=[],wire=[]
    client._client=protocol
    const bot={botId:9,accountId:10,eventBus,positionStatus:'realm',setPositionStatus(value){this.positionStatus=value}}
    new ConfigurationEvents({bot}).register(client)
    eventBus.on('bot:antiAfk:diagnostic',data=>events.push(data))
    protocol.framer.on('data',buffer=>wire.push(buffer))
    const start=(mode='prevention')=>eventBus.emit('bot:antiAfk:started',{botId:9,mode})
    const finish=()=>bot.movementPacketTrace.finish('TEST_FINISHED')
    t.after(()=>{bot.movementPacketTrace.dispose();protocol.serializer.destroy();protocol.deserializer.destroy();protocol.framer.destroy();protocol.splitter.destroy()})
    return {protocol,client,bot,events,wire,start,finish}
}
const params={x:24.55,y:82,z:43.18,yaw:10,pitch:20,flags:{onGround:true,hasHorizontalCollision:false}}

for(const positionStatus of ['realm','afk'])test('installed 1.21.11 serializes all movement packets through guard in '+positionStatus,async t=>{
    const f=fixture(t),parsed=[],decoder=createDeserializer({state:'play',isServer:true,version:'1.21.11'})
    t.after(()=>decoder.destroy());decoder.on('data',packet=>parsed.push(packet.data))
    f.protocol.serializer.pipe(decoder)
    f.bot.positionStatus=positionStatus;f.start('prevention')
    const originalPosition={...params,flags:{...params.flags}}
    for(const name of ['position','position_look','look','flying']){f.client.emit('physicsTick');f.protocol.write(name,params)}
    f.protocol.emit('position',{...params,teleportId:31,flags:{x:false,y:false,z:false}})
    f.protocol.write('teleport_confirm',{teleportId:31})
    await new Promise(resolve=>setImmediate(resolve));f.finish()
    const d=f.events.at(-1).diagnostics
    assert.equal(d.physicsTicks,4);assert.equal(d.movementWriteAttempts,4);assert.equal(d.movementWritesPassed,4)
    assert.equal(d.movementSerialized,4);assert.equal(d.clientboundPositionCorrections,1)
    assert.equal(d.teleportConfirmPassed,1);assert.equal(d.serializationErrors,0)
    assert.deepEqual(parsed.map(p=>p.name),['position','position_look','look','flying','teleport_confirm'])
    assert.equal(parsed[0].params.x,params.x);assert.equal(parsed[0].params.flags.onGround,true)
    assert.equal(parsed[1].params.yaw,10);assert.equal(parsed[2].params.pitch,20)
    assert.equal(parsed[4].params.teleportId,31);assert.equal(f.wire.length,5)
    assert.deepEqual(params,originalPosition)
})

test('configuration guard still drops its three movement names before serializer',t=>{
    const f=fixture(t,'configuration');f.start()
    for(const name of ['position','position_look','flying'])f.protocol.write(name,params)
    f.finish();const d=f.events.at(-1).diagnostics
    assert.equal(d.movementWriteAttempts,3);assert.equal(d.movementWritesPassed,0);assert.equal(d.movementSerialized,0)
    assert.equal(f.wire.length,0)
})

test('packet trace distinguishes no generation, restores methods and ends on protocol transition',t=>{
    const f=fixture(t),write=f.protocol.write,serializer=f.protocol.serializer,serialize=serializer.write
    f.start();f.client.emit('physicsTick');f.protocol.state='configuration'
    const d=f.events.at(-1).diagnostics
    assert.equal(d.physicsTicks,1);assert.equal(d.movementWriteAttempts,0);assert.equal(d.reason,'PROTOCOL_STATE_CHANGED')
    assert.equal(f.protocol.write,write);assert.equal(serializer.write,serialize)
    assert.equal(f.client.listenerCount('physicsTick'),0);assert.equal(f.protocol.listenerCount('position'),0)
})

test('packet traces have a record cap and one prevention attempt budget',t=>{
    const f=fixture(t);f.start()
    for(let i=0;i<300;i++)f.protocol.write('position',params)
    f.finish();const d=f.events.at(-1).diagnostics
    assert.equal(d.movementWriteAttempts,300);assert.equal(d.movementWritesPassed,300)
    assert.equal(d.records.length,512);assert.ok(d.truncated>0)
    f.start();assert.equal(f.bot.movementPacketTrace.active,null)
    f.start('recovery');assert.equal(f.bot.movementPacketTrace.active,null);f.client.emit('end')
    assert.equal(f.bot.movementPacketTrace.active,null);assert.equal(f.bot.eventBus.listenerCount('bot:antiAfk:started'),0)
})

test('normal control test uses existing safe path and refuses unsafe or occupied runtime',t=>{
    const f=fixture(t);let requests=0
    f.bot.antiAfk={eligible:()=>true,blocked:()=>false,now:()=>123,performIfDue:()=>{requests++;return true}}
    for(const status of ['afk','dead','lobby','realmConnecting']){
        f.bot.positionStatus=status;assert.equal(f.bot.movementPacketTrace.requestNormalMovement(),false)
    }
    f.bot.positionStatus='realm';f.bot.antiAfk.eligible=()=>false
    assert.equal(f.bot.movementPacketTrace.requestNormalMovement(),false)
    f.bot.antiAfk.eligible=()=>true;f.bot.antiAfk.blocked=()=>true
    assert.equal(f.bot.movementPacketTrace.requestNormalMovement(),false)
    f.bot.antiAfk.blocked=()=>false;f.bot.antiAfk.action={}
    assert.equal(f.bot.movementPacketTrace.requestNormalMovement(),false)
    f.bot.antiAfk.action=null;assert.equal(f.bot.movementPacketTrace.requestNormalMovement(),true)
    assert.equal(requests,1);assert.equal(f.bot.antiAfk.dueAt,123)
})

test('shared AntiAfkManager contains no protocol packet sender',async()=>{
    const source=await readFile(new URL('../src/minecraftBot/runtime/antiAfkManager.js',import.meta.url),'utf8')
    assert.doesNotMatch(source,/\.write\s*\(/);assert.match(source,/setControlState\(control,true\)/)
})
