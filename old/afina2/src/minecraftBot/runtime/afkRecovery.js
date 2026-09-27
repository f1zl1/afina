import {sendChat} from '../worker/sendChat.js'

// Owns a transition, never walking or realm-selection implementation.
export default class AfkRecovery{
    constructor({bot,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,transitionTimeoutMs=30000}){
        Object.assign(this,{bot,now,setTimer,clearTimer,transitionTimeoutMs})
        this.active=null;this.failed=false
    }
    emit(type,details={}){
        this.bot.eventBus.emit('bot:afkRecovery:'+type,{botId:this.bot.botId,accountId:this.bot.accountId,
            generation:this.active?.generation ?? this.bot.afkGeneration,targetRealm:this.active?.target ?? this.bot.accountData.realm,
            phase:this.active?.phase,timestamp:this.now(),...details})
    }
    valid(a=this.active){
        return Boolean(a && a===this.active && !a.controller.signal.aborted && a.client===this.bot.client &&
            a.target===this.bot.accountData.realm && this.bot.status==='running' && !this.bot.antiAfk.stopped && a.client.health>0)
    }
    deadline(reason,ms=this.transitionTimeoutMs){
        this.clearTimer(this.timer)
        const a=this.active
        this.timer=this.setTimer(()=>{
            if(this.active!==a)return
            if(!this.valid(a)){this.cancel('STALE_SESSION');return}
            this.fail(reason)
        },ms);this.timer?.unref?.()
    }
    request(){
        const b=this.bot
        if(this.active || this.failed)return false
        if(b.positionStatus!=='realm' || b.realmReadyTarget!==b.accountData.realm || b.status!=='running' ||
            b.antiAfk.stopped || b.client?._client?.state!=='play' || !(b.client.health>0))return false
        const a=this.active={client:b.client,target:b.accountData.realm,generation:++b.afkGeneration,
            controller:new AbortController(),phase:'cleanup'}
        b.setPositionStatus('afk')
        if(b.taskRunner.activeTask && !b.taskRunner.stopping)b.taskRunner.stop()
        this.emit('started');this.deadline('ROLE_CLEANUP_TIMEOUT')
        void this.prepare(a)
        return true
    }
    async prepare(a){
        try{
            await this.bot.taskRunner.completion
            if(!this.valid(a))return
            // Independent owners must finish too; no GUI is closed on their behalf.
            if(this.bot.antiAfk.blocked()){
                this.poll=this.setTimer(()=>void this.prepare(a),100);return
            }
            if(a.client._client.state!=='play')return this.cancel('PROTOCOL_CHANGED')
            a.phase='hubRequested';this.deadline('HUB_TIMEOUT')
            await sendChat(this.bot,'/hub',false,a)
            if(this.valid(a))this.emit('hubRequested')
        }catch{if(this.valid(a))this.fail('HUB_COMMAND_FAILED')}
    }
    // Called only by existing lobby/server evidence, through BotActions.
    async lobbyConfirmed(enterRealm){
        const a=this.active
        if(!this.valid(a) || a.phase!=='hubRequested')return false
        a.phase='realmRequested'
        this.bot.setPositionStatus('lobby');this.emit('hubConfirmed')
        this.deadline('REALM_TIMEOUT')
        try{
            const sent=await enterRealm(a.controller.signal)
            if(sent && this.valid(a))this.emit('realmRequested')
        }catch{if(this.valid(a))this.fail('REALM_COMMAND_FAILED')}
        return true
    }
    positionChanged(status){
        const a=this.active
        if(!a)return
        if(['dead','authentication','captcha'].includes(status)){this.cancel('POSITION_'+status);return}
        if(status==='lobby' && a.phase==='hubRequested'){
            void this.bot.botEventHandler.botActions.connectToRealmTask();return
        }
        if(status!=='realm')return
        if(!this.valid(a) || a.phase!=='realmRequested' || this.bot.requestedRealm!==a.target){
            this.cancel('UNEXPECTED_REALM');return
        }
        a.phase='readyGate';this.emit('realmConfirmed')
        const timing=this.bot.taskData?.type==='reseller'
            ?{realmReadyDelayMs:this.bot.resellerSettingsStore?.get('realmStartDelayMs',15000) ?? 15000,realmReadyDelayJitterMs:0}:{}
        this.deadline('READINESS_TIMEOUT',(timing.realmReadyDelayMs ?? 15000)+(timing.realmReadyDelayJitterMs ?? 3000)+5000)
        void this.bot.realmReadyGate.ready(timing,a.controller.signal).then(()=>{
            if(!this.valid(a))return
            this.emit('ready')
            if(!this.valid(a))return
            this.emit('completed')
            if(!this.valid(a))return
            this.clear(a)
            this.bot.antiAfk.ready=false;this.bot.antiAfk.sync('AFK_RECOVERY_READY')
            this.bot.eventBus.emit('bot:workReady',{botId:this.bot.botId,generation:a.generation})
        }).catch(()=>{if(this.valid(a))this.fail('READINESS_FAILED')})
    }
    clear(a){
        this.clearTimer(this.timer);this.clearTimer(this.poll)
        a.controller.abort(new Error('RECOVERY_ENDED'))
        if(this.bot.realmEntryPending?.signal===a.controller.signal)this.bot.realmEntryPending=null
        if(this.active===a)this.active=null
    }
    cancel(reason){
        if(!this.active)return
        this.emit('cancelled',{reason});this.clear(this.active)
    }
    fail(reason){
        if(!this.active)return
        this.failed=true;this.emit('failed',{reason});this.clear(this.active)
        // Existing worker exit + BotManager reconnect policy owns retries/backoff.
        this.bot.antiAfk.stop('AFK_RECOVERY_FAILED')
        this.bot.eventBus.emit('bot:fatal',{botId:this.bot.botId,reason:'afk_recovery_failed',error:reason})
    }
}
