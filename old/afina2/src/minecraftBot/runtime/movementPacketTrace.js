import minecraftData from 'minecraft-data'

const movement=new Set(['position','position_look','look','flying'])
const fields=['x','y','z','dx','dy','dz','yaw','pitch','onGround','flags','teleportId']
const select=data=>Object.fromEntries(fields.filter(key=>data?.[key]!==undefined).map(key=>[key,
    typeof data[key]==='object'?{...data[key]}:data[key]]))

// Observes the existing sender. Never writes packets or changes controls/physics.
export default class MovementPacketTrace{
    constructor({bot,client,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
        Object.assign(this,{bot,client,now,setTimer,clearTimer,remaining:{prevention:1}})
        this.started=data=>{if(data.botId===bot.botId)this.start(data.mode)}
        this.finished=data=>{if(data.botId===bot.botId && this.active){
            const active=this.active
            // physicsTick listeners run before Mineflayer updatePosition in the same tick.
            queueMicrotask(()=>{if(this.active===active)this.finish(data.reason ?? data.type ?? 'ATTEMPT_ENDED')})
        }}
        bot.eventBus.on('bot:antiAfk:started',this.started)
        for(const event of ['completed','failed','cancelled'])bot.eventBus.on('bot:antiAfk:'+event,this.finished)
        this.ended=()=>this.dispose()
        client.once('end',this.ended)
    }
    emit(stage,diagnostics){
        this.bot.eventBus.emit('bot:antiAfk:diagnostic',{botId:this.bot.botId,accountId:this.bot.accountId,
            mode:this.active?.mode,timestamp:this.now(),stage,diagnostics})
    }
    start(mode){
        const p=this.client._client
        if(this.active || !(this.remaining[mode]>0) || !p?.serializer?.write)return
        this.remaining[mode]--
        const a=this.active={mode,startedAt:this.now(),socketBytesStart:p.socket?.bytesWritten,records:[],recordCount:0,truncated:0,
            physicsTicks:0,movementWriteAttempts:0,movementWritesPassed:0,movementSerialized:0,
            clientboundPositionCorrections:0,teleportConfirmAttempts:0,teleportConfirmPassed:0,serializationErrors:0}
        const record=(stage,name,data={})=>{
            if(a.recordCount++<512)a.records.push({stage,timestamp:this.now(),packetName:name,...select(data)})
            else a.truncated++
        }
        this.originalWrite=p.write
        const trace=this
        this.write=function(name,data,...args){
            if(movement.has(name)){a.movementWriteAttempts++;record('MOVEMENT_WRITE_ATTEMPT',name,data)}
            if(name==='teleport_confirm'){a.teleportConfirmAttempts++;record('TELEPORT_CONFIRM_ATTEMPT',name,data)}
            return trace.originalWrite.call(this,name,data,...args)
        }
        p.write=this.write
        this.serializer=p.serializer;this.originalSerialize=this.serializer.write
        this.serialize=function(packet,...args){
            if(movement.has(packet?.name)){a.movementWritesPassed++;record('MOVEMENT_WRITE_PASSED',packet.name,packet.params)}
            if(packet?.name==='teleport_confirm'){a.teleportConfirmPassed++;record('TELEPORT_CONFIRM_PASSED',packet.name,packet.params)}
            return trace.originalSerialize.call(this,packet,...args)
        }
        this.serializer.write=this.serialize
        let mapping={}
        try{mapping=minecraftData(p.version).protocol.play.toServer.types.packet[1][0].type[1].mappings}catch{}
        const ids=new Map(Object.entries(mapping).map(([id,name])=>[Number(id),name]))
        this.serialized=buffer=>{
            if(p.state!=='play')return
            let id=0,shift=0
            for(const byte of buffer){id|=(byte&127)<<shift;if(!(byte&128))break;shift+=7;if(shift>28)return}
            const name=ids.get(id)
            if(movement.has(name)){a.movementSerialized++;record('MOVEMENT_SERIALIZED',name)}
        }
        this.error=()=>{a.serializationErrors++}
        this.serializer.on('data',this.serialized);this.serializer.on('error',this.error)
        this.tick=()=>{a.physicsTicks++};this.client.on('physicsTick',this.tick)
        this.correction=data=>{a.clientboundPositionCorrections++;record('CLIENTBOUND_POSITION_CORRECTION','position',data)}
        p.prependListener('position',this.correction)
        this.state=()=>this.finish('PROTOCOL_STATE_CHANGED');p.on('state',this.state)
        this.emit('PACKET_TRACE_START',{protocolVersion:p.version,positionStatus:this.bot.positionStatus,
            passedBoundary:'serializer.write entry; not server receipt',serializedBoundary:'serializer data before compression/framing/encryption',
            serializerWritable:this.serializer.writable,socketWritable:p.socket?.writable ?? null})
        const poll=()=>{this.flush();this.sampleTimer=this.setTimer(poll,750)}
        this.sampleTimer=this.setTimer(poll,750)
        this.limitTimer=this.setTimer(()=>this.finish('TRACE_LIMIT'),12000)
    }
    counters(){
        const a=this.active,p=this.client._client
        return Object.fromEntries(['physicsTicks','movementWriteAttempts','movementWritesPassed','movementSerialized',
            'clientboundPositionCorrections','teleportConfirmAttempts','teleportConfirmPassed','serializationErrors','truncated']
            .map(key=>[key,a[key]]).concat([['elapsedMs',this.now()-a.startedAt],['protocolState',p.state],
                ['socketWritable',p.socket?.writable ?? null],['socketDestroyed',p.socket?.destroyed ?? null],
                ['socketBytesWrittenDelta',Number.isFinite(a.socketBytesStart) && Number.isFinite(p.socket?.bytesWritten)
                    ?p.socket.bytesWritten-a.socketBytesStart:null]]))
    }
    flush(){if(this.active)this.emit('PACKET_TRACE_SAMPLE',{...this.counters(),records:this.active.records.splice(0)})}
    finish(reason){
        if(!this.active)return
        const p=this.client._client
        this.clearTimer(this.sampleTimer);this.clearTimer(this.limitTimer)
        if(p.write===this.write)p.write=this.originalWrite
        if(this.serializer.write===this.serialize)this.serializer.write=this.originalSerialize
        this.serializer.off('data',this.serialized);this.serializer.off('error',this.error)
        this.client.off('physicsTick',this.tick);p.off('position',this.correction);p.off('state',this.state)
        this.emit('PACKET_TRACE_END',{...this.counters(),reason,records:this.active.records.splice(0)})
        this.active=null
    }
    // Explicit local diagnostic control test; reuses all existing movement safety checks.
    requestNormalMovement(){
        const m=this.bot.antiAfk
        if(this.bot.positionStatus!=='realm' || !m.eligible() || m.blocked() || m.action || !this.remaining.prevention)return false
        m.dueAt=m.now()
        return m.performIfDue()
    }
    dispose(){
        this.finish('DISCONNECTED')
        this.bot.eventBus.off('bot:antiAfk:started',this.started)
        for(const event of ['completed','failed','cancelled'])this.bot.eventBus.off('bot:antiAfk:'+event,this.finished)
        this.client.off('end',this.ended)
    }
}
