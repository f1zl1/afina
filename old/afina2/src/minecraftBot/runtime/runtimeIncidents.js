import {randomUUID,createHash} from 'node:crypto'
import {setTimeout as sleep} from 'node:timers/promises'
import {normalizeFunTimeIncident} from '../../incidents/funtimeIncidents.js'
import {sendChat} from '../worker/sendChat.js'

const canonical=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v && typeof v==='object' && !Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)
export const stackIdentity=item=>item?createHash('sha256').update(canonical([item.type,item.name,item.metadata,item.nbt,item.components])).digest('hex'):null
export const itemSummary=item=>({slot:item.slot,itemId:item.type,name:item.name,amount:item.count,identity:stackIdentity(item)})

export default class RuntimeIncidents{
    constructor({bot,now=Date.now,wait=sleep,correlationMs=1500}){Object.assign(this,{bot,now,wait,correlationMs});this.reset()}
    reset(){this.controller?.abort();this.controller=new AbortController();this.ignored=new Set();this.pending=null;this.nextDropAt=0;this.cheatReplied=false;this.banPending=false}
    stop(){this.controller.abort();this.pending?.controller.abort();this.pending=null}
    ignoredItem(item){return item && this.ignored.has(stackIdentity(item))}
    begin(kind,item){
        const operation={operationId:randomUUID(),kind,...(item?itemSummary(item):{}),timestamp:this.now(),client:this.bot.client,controller:new AbortController(),rejected:false}
        this.pending=operation;return operation
    }
    end(operation){if(this.pending===operation)this.pending=null}
    emit(incident){this.bot.eventBus.emit('bot:runtimeIncident',{botId:this.bot.botId,accountId:this.bot.accountId,timestamp:this.now(),...incident})}
    handle(raw){
        const incident=normalizeFunTimeIncident(raw,{now:this.now()});if(!incident)return null
        const password=this.bot.accountData.password
        if(password)for(const [key,value] of Object.entries(incident))if(typeof value==='string')incident[key]=value.replaceAll(password,'[redacted]')
        if(incident.type==='ACCOUNT_BANNED'){
            if(this.banPending)return incident
            this.banPending=true
            // Main process persists before it publishes ACCOUNT_BANNED and stops this worker.
            this.emit(incident);return incident
        }
        if(incident.type==='CHEAT_CHECK_REQUESTED'){
            if(this.cheatReplied || this.controller.signal.aborted)return incident
            this.cheatReplied=true;this.emit(incident)
            const client=this.bot.client,signal=this.controller.signal
            queueMicrotask(()=>{
                if(signal.aborted || this.bot.client!==client || this.bot.status!=='running' || client?._client?.state!=='play')return
                try{sendChat(this.bot,'у меня чит')}catch{this.emit({type:'CHEAT_CHECK_RESPONSE_FAILED'})}
            })
            return incident
        }
        const p=this.pending,kind=incident.type==='ITEM_DROP_REJECTED'?'drop':'sell'
        const correlated=p?.kind===kind && p.sent!==false && p.client===this.bot.client && this.now()-p.timestamp<=this.correlationMs && !p.rejected
        if(correlated){
            p.rejected=true;p.controller.abort(new Error(incident.type))
            if(kind==='drop' && p.identity)this.ignored.add(p.identity)
        }
        this.emit({...incident,correlated,operation:correlated?{operationId:p.operationId,slot:p.slot,itemId:p.itemId,identity:p.identity,amount:p.amount,timestamp:p.timestamp}:null})
        return incident
    }
    async drop(client,item,action){
        if(this.ignoredItem(item) || this.controller.signal.aborted)return false
        const remaining=(this.nextDropAt ?? 0)-this.now()
        if(remaining>0){try{await this.wait(remaining,undefined,{signal:this.controller.signal})}catch{return false}}
        if(client!==this.bot.client || this.controller.signal.aborted)return false
        const p=this.begin('drop',item),signal=AbortSignal.any([this.controller.signal,p.controller.signal])
        this.nextDropAt=p.timestamp+this.correlationMs
        try{
            const rejected=new Promise(resolve=>signal.addEventListener('abort',()=>resolve(false),{once:true}))
            const result=await Promise.race([Promise.resolve().then(action),rejected])
            if(!p.rejected && !signal.aborted)await this.wait(Math.max(0,this.correlationMs-(this.now()-p.timestamp)),undefined,{signal})
            return !p.rejected && !signal.aborted && result!==false && client===this.bot.client
        }catch{return false}finally{this.end(p);p.controller.abort()}
    }
    blockInventory(items){
        if(this.bot.operationalBlock)return
        const incident={type:'INVENTORY_BLOCKED_BY_IGNORED_ITEMS',affectedSlots:items.map(i=>i.slot),itemSummaries:items.map(itemSummary)}
        this.bot.operationalBlock=incident;this.bot.afkRecovery.cancel('INVENTORY_BLOCKED')
        this.bot.antiAfk.cancel('INVENTORY_BLOCKED');this.bot.taskRunner.stop();this.emit(incident)
    }
}
