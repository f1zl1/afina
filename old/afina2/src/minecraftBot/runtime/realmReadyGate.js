import {setTimeout as sleep} from 'node:timers/promises'

// Timestamp is supplied only by the existing position-status lifecycle.
export default class RealmReadyGate{
    constructor({bot,now=Date.now,random=Math.random,wait=sleep}){Object.assign(this,{bot,now,random,wait});this.generation=0}
    enter(){this.invalidate();this.enteredAt=this.now();this.target=this.bot.accountData.realm;this.jitter=this.random()}
    invalidate(){this.generation++;this.enteredAt=null;this.controller?.abort(new Error('CANCELLED'));this.controller=new AbortController()}
    inspect(timing={}){
        const delay=(timing.realmReadyDelayMs??15000)+Math.floor(Math.max(0,Math.min(.999999999,this.jitter??0))*((timing.realmReadyDelayJitterMs??3000)+1))
        const confirmed=this.enteredAt!=null&&this.bot.positionStatus==='realm'&&this.target===this.bot.accountData.realm&&this.bot.status==='running'&&this.bot.client?._client?.state==='play'
        return {ready:Boolean(confirmed&&this.now()>=this.enteredAt+delay),enteredAt:this.enteredAt??null,generation:this.generation}
    }
    async ready(timing={},signal){
        const generation=this.generation
        const check=()=>{
            if(signal?.aborted)throw signal.reason ?? new Error('CANCELLED')
            if(this.enteredAt===null || this.enteredAt===undefined || generation!==this.generation || this.bot.positionStatus!=='realm' || this.target!==this.bot.accountData.realm || this.bot.status!=='running' || this.bot.client?._client?.state!=='play')throw new Error('DISCONNECTED')
        }
        check()
        const base=timing.realmReadyDelayMs ?? 15000,jitter=timing.realmReadyDelayJitterMs ?? 3000
        if(!Number.isInteger(base) || base<0 || base>300000 || !Number.isInteger(jitter) || jitter<0 || jitter>60000)throw new Error('INVALID_ANALYSIS_TIMING')
        const delay=base+Math.floor(Math.max(0,Math.min(.999999999,this.jitter))*(jitter+1))
        const remaining=Math.max(0,this.enteredAt+delay-this.now())
        if(remaining)await this.wait(remaining,undefined,{signal:signal?AbortSignal.any([signal,this.controller.signal]):this.controller.signal})
        check()
    }
}
