import {runtimeConfig,validateAntiAfk} from './runtimeConfig.js'
import MovementDiagnostics from './movementDiagnostics.js'

const controls=['forward','back','left','right','jump','sneak','sprint']
const position=client=>({x:client.entity.position.x,y:client.entity.position.y,z:client.entity.position.z})
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z)

// One instance per Bot. Roles only acquire tokens; scheduling and movement live here.
export default class AntiAfkManager{
    constructor({bot,config=runtimeConfig(),random=Math.random,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}){
        Object.assign(this,{bot,random,now,setTimer,clearTimer})
        this.config=validateAntiAfk(config)
        this.blocks=new Set();this.timer=null;this.action=null;this.stopped=false;this.ready=false
        this.diagnosticBudget={prevention:1}
    }
    emit(type,data={}){
        this.bot.eventBus.emit(`bot:antiAfk:${type}`,{botId:this.bot.botId,accountId:this.bot.accountId,
            role:this.bot.taskData?.type ?? 'test',realm:this.bot.accountData.realm,timestamp:this.now(),
            mode:'prevention',...data})
    }
    eligible(){
        const b=this.bot,c=b.client
        const validLocation=b.positionStatus==='realm' && b.realmReadyTarget===b.accountData.realm && !b.afkRecovery?.active
        return Boolean(!this.stopped && !b.operationalBlock && this.config.enabled && b.status==='running' && validLocation &&
            c?.entity?.position && c._client?.state==='play' && c.physicsEnabled===true && c.health>0)
    }
    nextDelay(){return Math.max(0,this.dueAt-this.now())}
    blocked(){
        const c=this.bot.client
        return this.blocks.size>0 || Boolean(c?.currentWindow) || this.bot.isInventoryBusy() || this.bot.isInventoryLocked() ||
            (!this.action && controls.some(key=>c?.getControlState?.(key)))
    }
    sync(reason='STATE_CHANGED'){
        if(!this.eligible()){
            this.ready=false;this.cancel(reason);return
        }
        if(!this.ready){this.ready=true;this.markActivity('REALM_READY');return}
        if(!this.timer && !this.action) this.schedule(Math.max(0,this.dueAt-this.now()))
    }
    configure(config){this.config=validateAntiAfk(config);this.cancel('CONFIG_CHANGED');this.ready=false;this.sync()}
    markActivity(reason='INTENTIONAL_MOVEMENT'){
        this.lastRelevantActivityAt=this.now()
        const {minIntervalMs:min,maxIntervalMs:max}=this.config
        this.dueAt=this.now()+min+Math.floor(Math.max(0,Math.min(.999999999,this.random()))*(max-min+1))
        if(this.eligible() && !this.action && this.bot.positionStatus==='realm'){
            this.schedule(this.dueAt-this.now())
            if(reason!=='INTENTIONAL_MOVEMENT' || this.now()-(this.lastScheduleLogAt ?? -Infinity)>=5000){
                this.lastScheduleLogAt=this.now();this.emit('scheduled',{reason,dueAt:this.dueAt})
            }
        }
    }
    observeMovement(){
        if(!this.eligible()) {this.sync();return}
        const client=this.bot.client,current=position(client),previous=this.lastPosition
        this.lastPosition=current
        if(!this.action && previous && distance(current,previous)>.01 && ['forward','back','left','right'].some(key=>client.getControlState?.(key))){
            // A real position change with intentional controls; passive packets do not count.
            this.markActivity('INTENTIONAL_MOVEMENT')
        }
    }
    schedule(delay){
        this.clearTimer(this.timer)
        this.timer=this.setTimer(()=>{this.timer=null;void this.performIfDue()},Math.max(1,delay))
        this.timer?.unref?.()
    }
    acquireBlock(reason){
        const token={reason};this.blocks.add(token)
        this.cancel('BLOCKED:'+reason)
        let released=false
        return ()=>{
            if(released)return;released=true;this.blocks.delete(token)
            this.clearTimer(this.timer);this.timer=null;this.sync('BLOCK_RELEASED')
        }
    }
    isDue(){return this.eligible() && this.now()>=this.dueAt}
    async performIfDue(){
        if(this.action) return this.action.promise
        if(!this.eligible()){this.sync();return false}
        if(!this.isDue()){this.schedule(this.nextDelay());return false}
        if(this.blocked()){
            if(!this.deferred){this.emit('deferred',{reason:'BUSY'});this.deferred=true}
            this.schedule(Math.max(100,this.config.retryDelayMs));return false
        }
        this.deferred=false;this.clearTimer(this.timer);this.timer=null
        const action={client:this.bot.client,controller:new AbortController(),mode:'prevention'}
        this.action=action
        action.promise=this.move(action).finally(()=>{
            if(this.action===action)this.action=null
            if(this.eligible())this.schedule(this.nextDelay())
        })
        return action.promise
    }
    releaseControls(client){
        this.internalControlChange=true
        try{for(const key of controls){try{client?.setControlState(key,false)}catch{}}}
        finally{this.internalControlChange=false}
    }
    releaseOwnedControls(action){
        if(!action.controlsOwned)return
        action.controlsOwned=false
        this.releaseControls(action.client)
    }
    cancel(reason='CANCELLED'){
        this.clearTimer(this.timer);this.timer=null
        if(this.action){this.releaseOwnedControls(this.action);this.action.controller.abort(new Error(reason))}
    }
    stop(reason='BOT_STOPPING'){this.stopped=true;this.ready=false;this.cancel(reason)}
    dispose(){this.stop('DISPOSED');this.blocks.clear()}
    async move(action){
        const {client,controller}=action,startPosition=position(client),started=this.now()
        const timeout=this.setTimer(()=>{
            action.timeoutDiagnostics=action.diagnostics.summary()
            controller.abort(new Error('MOVEMENT_TIMEOUT'))
        },this.config.movementTimeoutMs)
        let forwardDistance=0,returnDistance=0
        action.diagnostics=new MovementDiagnostics(this,action,this.diagnosticBudget[action.mode]-- > 0)
        this.emit('started',{startPosition,reason:'IDLE_THRESHOLD'})
        try{
            await this.phase(action,'forward',()=>distance(position(client),startPosition)>=this.config.forwardBlocks)
            forwardDistance=distance(position(client),startPosition)
            this.emit('forwardCompleted',{forwardDistance})
            const turnPosition=position(client)
            await this.phase(action,'back',()=>distance(position(client),startPosition)<=.2 || distance(position(client),turnPosition)>=this.config.backwardBlocks)
            returnDistance=distance(position(client),turnPosition)
            this.emit('returnCompleted',{returnDistance})
            this.markActivity('ANTI_AFK_MOVEMENT')
            this.emit('completed',{startPosition,endPosition:position(client),forwardDistance,returnDistance,durationMs:this.now()-started})
            return true
        }catch(error){
            const reason=controller.signal.reason?.message ?? (error?.message==='CONTROL_NOT_APPLIED'?'CONTROL_NOT_APPLIED':'MOVEMENT_ERROR')
            this.emit(reason==='MOVEMENT_TIMEOUT' || !controller.signal.aborted?'failed':'cancelled',{reason,durationMs:this.now()-started,diagnostics:action.timeoutDiagnostics ?? action.diagnostics.summary()})
            this.dueAt=this.now()+Math.max(1,this.config.retryDelayMs)
            return false
        }finally{this.clearTimer(timeout);this.releaseOwnedControls(action);action.diagnostics.dispose()}
    }
    phase(action,control,done){
        const {client,controller}=action
        return new Promise((resolve,reject)=>{
            const finish=error=>{
                client.off('physicsTick',tick);client.off('end',disconnected);client.off('death',disconnected)
                controller.signal.removeEventListener('abort',aborted)
                this.releaseOwnedControls(action)
                error?reject(error):resolve()
            }
            const aborted=()=>finish(controller.signal.reason)
            const disconnected=()=>controller.abort(new Error('DISCONNECTED'))
            const tick=()=>{
                try{
                    if(!this.eligible() || this.bot.client!==client || this.blocked()) throw new Error('STATE_CHANGED')
                    if(done())finish()
                }catch(error){finish(error)}
            }
            client.on('physicsTick',tick);client.on('end',disconnected);client.on('death',disconnected)
            controller.signal.addEventListener('abort',aborted,{once:true})
            if(controller.signal.aborted){aborted();return}
            try{
                if(!this.eligible() || this.blocked())throw new Error('STATE_CHANGED')
                action.controlsOwned=true
                action.diagnostics.beforeControl(control)
                client.setControlState(control,true)
                if(action.diagnostics.afterControl()===false)throw new Error('CONTROL_NOT_APPLIED')
            }catch(error){finish(error)}
        })
    }
}
