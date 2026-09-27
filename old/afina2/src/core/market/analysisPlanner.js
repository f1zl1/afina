import {randomUUID} from 'node:crypto'
import {AnalysisPlanner as AnalysisPlannerContract} from '../economicContracts.js'
import {reason} from '../corePolicy.js'

export default class AnalysisPlanner extends AnalysisPlannerContract{
    constructor(){super();this.available=true}
    rank({items,market,policy,overrides=[],sessions=[],actual,serverId,realm,now=Date.now()}){
        const disabled=new Set(overrides.filter(o=>o.disabled).map(o=>o.itemId))
        return items.filter(i=>!disabled.has(i.itemId) && typeof i.searchQuery==='string' && i.searchQuery.trim() && i.searchQuery.length<=180 && !/[\r\n]/.test(i.searchQuery)).map(item=>{
            const model=market.items.find(m=>m.itemId===item.itemId && m.serverId===serverId && m.realm===realm)
            const recent=sessions.filter(s=>s.itemId===item.itemId && s.serverId===serverId && s.realm===realm).sort((a,b)=>b.startedAt-a.startedAt)[0]
            const reserved=recent && ['planned','running'].includes(recent.status)
            const retryAt=recent?.completedAt ? recent.completedAt+(recent.failureCode==='AFK_INTERRUPTED'?0:recent.status==='completed'?policy.analysisMinRepeatMs:policy.failureRetryMs) : 0
            const reasons=[]
            const add=(code,score,message,data={})=>{if(score>0) reasons.push(reason(code,message,{...data,contribution:score}))}
            if(!model) add('NEVER_ANALYZED',80,'Товар ще не спостерігався на цьому ринку.')
            else add(model.freshness==='stale'?'DATA_STALE':'DATA_AGING',40*model.dataAgeMs/policy.marketStaleMs,'Пріоритет зростає з віком спостереження.',{dataAgeMs:model.dataAgeMs})
            add('LOW_CONFIDENCE',20*(1-(model?.confidence ?? 0)/100),'Недостатня впевненість у вибірці.',{confidence:model?.confidence ?? 0})
            add('LOW_OBSERVATION_COUNT',10*(1-Math.min(1,(model?.observationCount ?? 0)/5)),'Недостатньо недавніх спостережень.')
            if(model?.volatility!=null) add('HIGH_VOLATILITY',20*Math.min(1,model.volatility/.25),'Мінливість медіан незалежного retail.',{volatility:model.volatility})
            const exposure=actual.bots.filter(b=>b.role==='reseller' && b.serverId===serverId && b.realm===realm && b.activeTask.itemId===item.itemId).length
            add('ACTIVE_RESELLER_EXPOSURE',10*Math.min(1,exposure/3),'На цьому ринку працюють reseller цього товару.',{bots:exposure})
            const observationCount=!model || model.confidence<50 || (model.volatility ?? 0)>.15 ? policy.analysisMaxObservations : policy.analysisMinObservations
            return {itemId:item.itemId,name:item.name,query:item.searchQuery,matcher:JSON.parse(item.matcher),serverId,realm,
                priority:Number(reasons.reduce((n,r)=>n+r.data.contribution,0).toFixed(3)),reasons,observationCount,
                eligible:!reserved && now>=retryAt,reserved:Boolean(reserved),retryAt:retryAt || null}
        }).sort((a,b)=>b.priority-a.priority || a.itemId-b.itemId)
    }
    getNextAnalysisTask(context){
        if(!context?.items) return null
        const candidates=this.rank(context),selected=candidates.find(c=>c.eligible)
        if(!selected) return null
        const p=context.policy
        return {...selected,analysisId:randomUUID(),timing:{realmReadyDelayMs:p.analysisRealmReadyDelayMs,realmReadyDelayJitterMs:p.analysisRealmReadyDelayJitterMs,minimumRefreshIntervalMs:p.analysisRefreshIntervalMs,refreshJitterMs:p.analysisRefreshJitterMs,windowTimeoutMs:p.analysisWindowTimeoutMs},
            alternatives:candidates.filter(c=>c.itemId!==selected.itemId).slice(0,3).map(c=>({itemId:c.itemId,priority:c.priority,eligible:c.eligible}))}
    }
}
