import {createHash} from 'node:crypto'

const active=new Set(['PENDING','ADMITTED','RUNNING','DRAINING','UNCERTAIN'])
export const liveValidationDefaults=Object.freeze({enabled:false,itemId:null,maxQuantity:1,maxPurchaseCommitment:null,maxAutonomousWorkloads:1})
const fingerprint=p=>createHash('sha256').update(JSON.stringify([p.itemId,p.maxQuantity,p.maxPurchaseCommitment,p.maxAutonomousWorkloads])).digest('hex')

// A durable safety latch and observational assessment, never an executor.
export default class LiveValidation{
    constructor(core){this.core=core;this.store=core.store.store}
    policy(){return this.core.store.operationsPolicy().liveValidation}
    fuse(){return {...this.store.prepare('SELECT * FROM liveValidationFuse WHERE id=1').get(),id:undefined}}
    configBlocker(p=this.policy()){
        if(!p?.enabled)return 'LIVE_VALIDATION_DISABLED'
        if(!Number.isSafeInteger(p.itemId)||p.itemId<1)return 'VALIDATION_ITEM_REQUIRED'
        if(!Number.isSafeInteger(p.maxPurchaseCommitment)||p.maxPurchaseCommitment<1||p.maxPurchaseCommitment>1000000000)return 'VALIDATION_PURCHASE_CAP_REQUIRED'
        if(p.maxQuantity!==1||p.maxAutonomousWorkloads!==1)return 'VALIDATION_LIMIT_INVALID'
        return null
    }
    proxy(bot){return bot?this.core.proxies.forBot(bot.botId,bot.incarnationId):null}
    proxyBlocker(bot){
        const proxy=this.proxy(bot)
        if(!proxy||!proxy.currentIncarnation||proxy.reservationState!=='RUNNING')return 'VALIDATION_PROXY_RESERVATION_REQUIRED'
        if(!proxy.transportConnected)return 'VALIDATION_PROXY_NOT_CONNECTED'
        if(!bot.minecraftConnected||bot.observationQuality!=='FRESH')return 'WORKER_NOT_READY'
        return null
    }
    effective(plan,{row=null,bot=null}={}){
        const p=this.policy(),fuse=this.fuse(),blockers=[]
        const config=this.configBlocker(p);if(config)blockers.push(config)
        if(plan?.itemId!==p.itemId)blockers.push('VALIDATION_WRONG_ITEM')
        const own=row?.liveValidation&&fuse.state==='CONSUMED'&&fuse.workloadId===row.workloadId&&fuse.generation===row.liveValidation.fuseGeneration
        if(!own&&fuse.state!=='ARMED')blockers.push(fuse.state==='CONSUMED'?'VALIDATION_FUSE_CONSUMED':'VALIDATION_FUSE_UNARMED')
        if(fuse.policyFingerprint!==fingerprint(p))blockers.push('VALIDATION_CONFIGURATION_CHANGED')
        if(plan?.maxBuyPricePerItem>p.maxPurchaseCommitment)blockers.push('VALIDATION_PURCHASE_CAP')
        if(this.core.economic.store.rows().some(r=>r.workloadId!==row?.workloadId&&r.source==='AUTONOMOUS_TRADING'&&active.has(r.status)))blockers.push('VALIDATION_ACTIVE_WORKLOAD')
        const request=plan?{requestId:`trading_${plan.planId}`,itemId:plan.itemId,botId:row?.request.botId??null,maxBuyPricePerItem:plan.maxBuyPricePerItem,targetSellPricePerItem:plan.targetSellPricePerItem,targetQuantity:1}:null
        const candidates=request?this.core.economic.placements({request,serverId:plan.serverId,realm:plan.realm,source:'AUTONOMOUS_TRADING'}):[]
        const selected=bot??candidates.find(b=>!this.proxyBlocker(b))??candidates[0]
        if(!selected)blockers.push('NO_ELIGIBLE_RESELLER')
        else{
            if(row?.request.botId!=null&&row.request.botId!==selected.botId)blockers.push('VALIDATION_BOT_CHANGED')
            const proxyBlocker=this.proxyBlocker(selected);if(proxyBlocker)blockers.push(proxyBlocker)
            if(row?.liveValidation&&(row.liveValidation.incarnationId!==selected.incarnationId||row.liveValidation.proxy.proxyId!==this.proxy(selected)?.proxyId))blockers.push('VALIDATION_EXECUTOR_CHANGED')
            request.botId=selected.botId
        }
        return {blockers:[...new Set(blockers)],request,bot:selected??null,proxy:this.proxy(selected),liveValidation:{fuseGeneration:fuse.generation,policyFingerprint:fingerprint(p),maxPurchaseCommitment:p.maxPurchaseCommitment,planQuantity:plan?.targetQuantity??null,quantityReduced:plan?.targetQuantity>1,incarnationId:selected?.incarnationId??null,proxy:this.proxy(selected)}}
    }
    arm({expectedGeneration},actor){
        if(actor?.type!=='web'||!actor.id)throw new Error('MANUAL_OPERATOR_REQUIRED')
        const result=this.store.transaction(()=>{
            if(this.core.store.operationsPolicy().autonomousTradingEnabled)throw new Error('DISABLE_AUTONOMOUS_BEFORE_ARM')
            const p=this.policy(),blocker=this.configBlocker(p);if(blocker)throw new Error(blocker)
            if(!this.store.prepare('SELECT 1 FROM itemsData WHERE itemId=?').get(p.itemId))throw new Error('INVALID_ITEM')
            if(this.core.store.overrides().some(o=>o.itemId===p.itemId&&(o.disabled||o.maxBots===0)))throw new Error('ITEM_DISABLED')
            if(this.core.economic.store.rows().some(r=>r.source==='AUTONOMOUS_TRADING'&&active.has(r.status)||r.itemId===p.itemId&&(r.status==='UNCERTAIN'||this.core.economic.needsResidualReview(r))))throw new Error('VALIDATION_RECONCILIATION_REQUIRED')
            const f=this.fuse();if(!Number.isSafeInteger(expectedGeneration)||f.generation!==expectedGeneration)throw new Error('VALIDATION_FUSE_CONFLICT')
            this.store.prepare("UPDATE liveValidationFuse SET state='ARMED',generation=generation+1,policyFingerprint=?,armedAt=?,armedBy=?,consumedAt=NULL,workloadId=NULL WHERE id=1").run(fingerprint(p),Date.now(),String(actor.id).slice(0,128))
            return this.fuse()
        })
        this.core.eventBus.publish('core.liveValidation.changed',{state:result.state,generation:result.generation})
        return result
    }
    disable({expectedRevision},actor){
        if(actor?.type!=='web'||!actor.id)throw new Error('MANUAL_OPERATOR_REQUIRED')
        return this.core.updateOperationsPolicy({expectedRevision,values:{autonomousTradingEnabled:false,liveValidation:{enabled:false}}})
    }
    consume(row){
        // Called inside the same BEGIN IMMEDIATE transaction as workload creation.
        const v=row.liveValidation
        const changed=this.store.prepare("UPDATE liveValidationFuse SET state='CONSUMED',consumedAt=?,workloadId=? WHERE id=1 AND state='ARMED' AND generation=? AND policyFingerprint=?").run(Date.now(),row.workloadId,v.fuseGeneration,v.policyFingerprint).changes
        if(changed!==1)throw new Error('VALIDATION_FUSE_NOT_ARMED')
    }
    preflight(trading=this.core.tradingSnapshot()){
        const p=this.policy(),fuse=this.fuse(),matching=trading.plans.filter(plan=>plan.itemId===p.itemId)
        const plan=matching.find(plan=>plan.decision==='BUY_RESELL'&&this.effective(plan).bot)??matching[0]??null
        const effective=plan?this.effective(plan):null
        const ordinary=plan?this.core.tradingExecution.validate(plan.planId,{preview:true}):{reason:'TRADING_PLAN_UNAVAILABLE'}
        const blockers=[this.configBlocker(p),this.core.tradingExecution.policyBlocker(),ordinary.reason,...(effective?.blockers??[])].filter(Boolean)
        if(!plan)blockers.push('TRADING_PLAN_UNAVAILABLE')
        if(fuse.state!=='ARMED')blockers.push(fuse.state==='CONSUMED'?'VALIDATION_FUSE_CONSUMED':'VALIDATION_FUSE_UNARMED')
        const item=this.store.prepare('SELECT name FROM itemsData WHERE itemId=?').get(p.itemId??-1)
        const itemEnabled=Boolean(item)&&!this.core.store.overrides().some(o=>o.itemId===p.itemId&&(o.disabled||o.maxBots===0))
        if(!itemEnabled)blockers.push(item?'ITEM_DISABLED':'INVALID_ITEM')
        const selected=effective?.bot
        const preview=effective?.request?{...effective.request,planId:plan.planId,sourceTimestamp:plan.sourceTimestamp,itemName:item?.name??null,botName:selected?.name??null,incarnationId:selected?.incarnationId??null,serverId:plan.serverId,realm:plan.realm,proxy:effective.proxy,maximumPurchaseCommitment:effective.request.maxBuyPricePerItem,planQuantity:plan.targetQuantity,quantityReduced:plan.targetQuantity>1}:null
        const checks=[{code:'VALIDATION_ENABLED',ok:p.enabled},{code:'FUSE_ARMED',ok:fuse.state==='ARMED'},{code:'ITEM_ENABLED',ok:itemEnabled},
            {code:'AUTONOMOUS_ENABLED',ok:this.core.store.operationsPolicy().autonomousTradingEnabled},{code:'PLAN_CURRENT_BUY_RESELL',ok:plan?.decision==='BUY_RESELL'&&plan.expiresAt>Date.now()},
            {code:'RESELLER_READY',ok:Boolean(selected)},{code:'PROXY_CONNECTED',ok:Boolean(effective?.proxy?.transportConnected)},
            {code:'QUANTITY_ONE',ok:preview?.targetQuantity===1},{code:'PURCHASE_CAP_VALID',ok:Number.isSafeInteger(p.maxPurchaseCommitment)&&p.maxPurchaseCommitment>0&&preview?.maximumPurchaseCommitment>0&&preview.maximumPurchaseCommitment<=Math.min(p.maxPurchaseCommitment,this.core.store.operationsPolicy().autonomousTradingMaxPurchaseValue)}]
        const workload=fuse.workloadId?this.core.economic.store.get(fuse.workloadId):null
        return {policy:p,fuse,ready:blockers.length===0,blockers:[...new Set(blockers)],checks,preview,execution:workload?{workloadId:workload.workloadId,planId:workload.sourcePlanId,botId:workload.botId,incarnationId:workload.incarnationId??null,status:workload.status,effectiveTerms:workload.request,liveValidation:workload.liveValidation,timeline:workload.timeline??[]}:null}
    }
}
