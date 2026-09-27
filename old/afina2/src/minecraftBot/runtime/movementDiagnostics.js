const controls=['forward','back','left','right','jump','sneak','sprint']
const vector=value=>value?{x:value.x,y:value.y,z:value.z}:null
const horizontal=(a,b)=>a && b?Math.hypot(a.x-b.x,a.z-b.z):0

// Bounded observation only. Never enables physics, moves the bot, or reapplies controls.
export default class MovementDiagnostics{
    constructor(manager,action,detailed){
        Object.assign(this,{manager,action,detailed,client:action.client})
        this.ticks=0;this.forcedMoves=0;this.controlClears=0;this.maxDistance=0;this.maxSpeed=0;this.samples=0
        this.startedAt=manager.now();this.origin=vector(this.client.entity?.position)
        this.tick=()=>{this.ticks++;this.observe()}
        this.forced=()=>{this.forcedMoves++}
        this.client.on('physicsTick',this.tick);this.client.on('forcedMove',this.forced)
        if(detailed){
            this.wrapControls()
            this.emit('START')
            this.poll=()=>{
                if(this.samples++>=14)return
                this.emit('SAMPLE')
                this.timer=manager.setTimer(this.poll,750)
            }
            this.timer=manager.setTimer(this.poll,750)
        }
    }
    state(control){
        try{return this.client.getControlState?.(control) ?? this.client.controlState?.[control] ?? null}catch{return null}
    }
    observe(){
        const current=this.client.entity?.position,velocity=this.client.entity?.velocity
        this.maxDistance=Math.max(this.maxDistance,horizontal(current,this.origin))
        if(velocity)this.maxSpeed=Math.max(this.maxSpeed,Math.hypot(velocity.x,velocity.z))
    }
    snapshot(){
        this.observe()
        const c=this.client,e=c.entity
        let chunkLoaded=null
        try{if(e?.position && c.blockAt)chunkLoaded=c.blockAt(e.position)!=null}catch{}
        return {entityExists:Boolean(e),position:vector(e?.position),velocity:vector(e?.velocity),physicsEnabled:c.physicsEnabled,
            protocolState:c._client?.state ?? null,health:c.health ?? null,isAlive:c.isAlive ?? null,
            positionStatus:this.manager.bot.positionStatus,currentWindow:Boolean(c.currentWindow),
            controlStates:Object.fromEntries(controls.map(key=>[key,this.state(key)])),yaw:e?.yaw ?? null,pitch:e?.pitch ?? null,
            onGround:e?.onGround ?? null,vehicleId:c.vehicle?.id ?? null,chunkLoaded,
            blockerCount:this.manager.blocks.size,blockerReasons:[...this.manager.blocks].map(b=>b.reason).slice(0,10),
            activeRole:this.manager.bot.taskRunner?.activeTask?.constructor.name ?? null,
            phase:this.control ?? null,phaseStart:this.phaseStart ?? null,phaseDistance:horizontal(e?.position,this.phaseStart),
            distanceToOrigin:horizontal(e?.position,this.origin),physicsTicks:this.ticks,forcedMoves:this.forcedMoves,
            controlClears:this.controlClears,maxDistance:this.maxDistance,maxHorizontalSpeed:this.maxSpeed,
            controlBefore:this.controlBefore ?? null,controlAfter:this.controlAfter ?? null,elapsedMs:this.manager.now()-this.startedAt}
    }
    emit(stage,extra={}){this.manager.emit('diagnostic',{stage,diagnostics:{...this.snapshot(),...extra}})}
    beforeControl(control){
        this.control=control;this.phaseStart=vector(this.client.entity?.position);this.controlBefore=this.state(control)
        if(this.detailed)this.emit('CONTROL_BEFORE')
    }
    afterControl(){
        this.controlAfter=this.state(this.control)
        if(this.detailed)this.emit('CONTROL_AFTER')
        return this.controlAfter
    }
    wrapControls(){
        const d=this,c=this.client
        this.originalSet=c.setControlState;this.originalClear=c.clearControlStates
        this.wrappedSet=function(control,value){
            const before=d.state(control),result=d.originalSet.call(this,control,value)
            if(!d.manager.internalControlChange && value===false && before===true){
                d.controlClears++
                if(d.controlClears<=3)d.emit('EXTERNAL_CONTROL_CLEAR',{control,caller:new Error().stack.split('\n').slice(2,7).join('\n')})
            }
            return result
        }
        c.setControlState=this.wrappedSet
        if(this.originalClear){
            this.wrappedClear=function(){
                if(!d.manager.internalControlChange && !d.clearCallReported){
                    d.clearCallReported=true;d.emit('EXTERNAL_CLEAR_ALL',{caller:new Error().stack.split('\n').slice(2,7).join('\n')})
                }
                return d.originalClear.call(this)
            }
            c.clearControlStates=this.wrappedClear
        }
    }
    summary(){
        const value=this.snapshot()
        const observation=this.controlAfter===false?'CONTROL_NOT_APPLIED':this.controlClears?'CONTROL_CLEARED':
            !this.ticks?'NO_PHYSICS_TICKS':this.maxDistance<.01?(this.maxSpeed>.001?'VELOCITY_WITHOUT_DISPLACEMENT':'NO_HORIZONTAL_MOTION'):'MOVEMENT_INCOMPLETE'
        return {...value,observation}
    }
    dispose(){
        this.manager.clearTimer(this.timer)
        this.client.off('physicsTick',this.tick);this.client.off('forcedMove',this.forced)
        if(this.client.setControlState===this.wrappedSet)this.client.setControlState=this.originalSet
        if(this.wrappedClear && this.client.clearControlStates===this.wrappedClear)this.client.clearControlStates=this.originalClear
    }
}
