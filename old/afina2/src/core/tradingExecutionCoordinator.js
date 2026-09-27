import {economicLimits,economicRequest} from '../workloads/economicContract.js'

export const autonomousSource='AUTONOMOUS_TRADING'
const active=new Set(['PENDING','ADMITTED','RUNNING','DRAINING','UNCERTAIN'])
const terms=p=>({requestId:`trading_${p.planId}`,itemId:p.itemId,botId:null,maxBuyPricePerItem:p.maxBuyPricePerItem,targetSellPricePerItem:p.targetSellPricePerItem,targetQuantity:p.targetQuantity})

// Admission only. EconomicCoordinator owns every durable request and result.
export default class TradingExecutionCoordinator{
    constructor(core){this.core=core;this.diagnostics=new Map()}
    policyBlocker({preview=false}={}){
        let p
        try{p=this.core.store.operationsPolicy()}catch{return 'AUTONOMOUS_RISK_LIMIT_INVALID'}
        if(p.autonomousTradingEnabled!==true&&!preview)return 'TRADING_EXECUTION_DISABLED'
        // Do not turn a missing/corrupt durable risk control into implicit budget.
        let raw
        try{raw=JSON.parse(this.core.store.store.prepare('SELECT document FROM operationsPolicy WHERE id=1').get().document)}catch{return 'AUTONOMOUS_RISK_LIMIT_INVALID'}
        if(!Number.isSafeInteger(raw.autonomousTradingMaxPurchaseValue)||raw.autonomousTradingMaxPurchaseValue<1||raw.autonomousTradingMaxPurchaseValue>economicLimits.maximumPurchaseValue||!Number.isSafeInteger(raw.autonomousTradingMaxConcurrentWorkloads)||raw.autonomousTradingMaxConcurrentWorkloads<1||raw.autonomousTradingMaxConcurrentWorkloads>100)return 'AUTONOMOUS_RISK_LIMIT_INVALID'
        const effective=this.core.effectiveOperations()
        if(effective.maintenanceMode)return 'MAINTENANCE_MODE'
        if(!effective.automationActive)return effective.keepStopped?'STARTUP_KEEP_STOPPED':'CORE_DISABLED'
        if(!effective.roles.reseller?.enabled)return 'ROLE_DISABLED'
        if(effective.roles.reseller.target<1)return 'RESELLER_CAPACITY_DISABLED'
        if(this.core.stopped)return 'CORE_STOPPED'
        return null
    }
    validate(planId,{row=null,bot=null,preview=false}={}){
        const reject=reason=>({reason,plan:null})
        const blocked=this.policyBlocker({preview});if(blocked)return reject(blocked)
        const plan=this.core.tradingSnapshot().plans.find(p=>p.planId===planId)
        if(!plan)return reject('TRADING_PLAN_SUPERSEDED')
        if(plan.decision!=='BUY_RESELL')return reject('TRADING_PLAN_HOLD')
        if(plan.expiresAt<=Date.now())return reject('TRADING_PLAN_EXPIRED')
        let validation=null
        if(this.core.liveValidation.policy().enabled){
            validation=this.core.liveValidation.effective(plan,{row,bot})
            if(validation.blockers.length)return reject(validation.blockers[0])
        }else if(row?.liveValidation)return reject('VALIDATION_MODE_CHANGED')
        let request;try{request=economicRequest(validation?.request??terms(plan))}catch{return reject('INVALID_ECONOMIC_REQUEST')}
        if(row&&JSON.stringify(request)!==JSON.stringify(row.request))return reject('TRADING_PLAN_TERMS_CHANGED')
        const p=this.core.store.operationsPolicy(),override=this.core.store.overrides().find(o=>o.itemId===plan.itemId)??{}
        if(override.disabled)return reject('ITEM_DISABLED')
        if(override.maxBots===0)return reject('ITEM_MAX_BOTS_LIMIT')
        if(override.maxBuyPrice!=null&&plan.maxBuyPricePerItem>override.maxBuyPrice)return reject('MAX_BUY_PRICE')
        if(override.minSellPrice!=null&&plan.targetSellPricePerItem<override.minSellPrice)return reject('MIN_SELL_PRICE')
        if(request.targetQuantity*request.maxBuyPricePerItem>p.autonomousTradingMaxPurchaseValue)return reject('AUTONOMOUS_PURCHASE_VALUE_LIMIT')
        const rows=this.core.economic.store.rows().filter(r=>r.workloadId!==row?.workloadId)
        const sameItem=rows.filter(r=>r.itemId===plan.itemId)
        if(sameItem.some(r=>r.status==='UNCERTAIN'))return reject('ITEM_ECONOMIC_UNCERTAIN')
        if(sameItem.some(r=>this.core.economic.needsResidualReview(r)))return reject('RESIDUAL_INVENTORY_REVIEW_REQUIRED')
        if(sameItem.some(r=>active.has(r.status)))return reject('ITEM_ECONOMIC_WORKLOAD_BUSY')
        if(rows.filter(r=>r.source===autonomousSource&&active.has(r.status)).length>=p.autonomousTradingMaxConcurrentWorkloads)return reject('AUTONOMOUS_CONCURRENCY_LIMIT')
        if(sameItem.some(r=>r.source===autonomousSource&&r.serverId===plan.serverId&&r.realm===plan.realm&&r.sourceTimestamp>=plan.sourceTimestamp))return reject('MARKET_EVIDENCE_ALREADY_USED')
        const fits=b=>b.serverId===plan.serverId&&b.realm===plan.realm&&!this.core.economic.eligible(b)
        if(bot?!fits(bot):!this.core.readActual().bots.some(fits))return reject('NO_ELIGIBLE_RESELLER')
        return {reason:null,plan,request,liveValidation:validation?.liveValidation??null}
    }
    evaluate(plans,admission,limit){
        this.diagnostics.clear()
        let created=0
        for(const plan of plans){
            if(!admission.itemIds.has(plan.itemId)||created>=limit||this.diagnostics.size>=100)continue
            if(this.core.economic.store.plan(plan.planId))continue
            const validation=this.validate(plan.planId)
            if(validation.reason){this.diagnostics.set(plan.planId,validation.reason);continue}
            try{this.core.economic.submitAutonomous(plan.planId,this);created++}
            catch(error){this.diagnostics.set(plan.planId,error.message)}
        }
    }
    snapshot(trading){
        const enabled=this.core.store.operationsPolicy().autonomousTradingEnabled===true
        return {...trading,mode:enabled?'AUTONOMOUS':'SHADOW',executionEnabled:enabled,executionBlocker:this.policyBlocker(),liveValidation:this.core.liveValidation.preflight(trading),plans:trading.plans.map(plan=>{
            const row=this.core.economic.store.plan(plan.planId)
            const reason=row?.reason??(row?null:this.validate(plan.planId).reason)
            return {...plan,execution:{source:row?.source??null,workloadId:row?.workloadId??null,botId:row?.botId??null,status:row?.status??(reason?'BLOCKED':'PENDING'),reason}}
        })}
    }
}
