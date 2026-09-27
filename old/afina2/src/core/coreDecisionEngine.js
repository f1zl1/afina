import { reason } from "./corePolicy.js"

export default class CoreDecisionEngine{
    evaluate({policy,overrides,actual,engines}){
        const market=engines.market.getSnapshot()
        const proposals=engines.allocation.propose({policy,overrides,actual,market})
        const byOverride=new Map(overrides.map(o=>[o.itemId,o]))
        const assessments=[]
        const allocations=actual.items.map(item=>{
            const override=byOverride.get(item.itemId) ?? {}
            const tasks=actual.bots.filter(b=>b.task.type === "reseller" && b.task.enabled === 1 && b.task.itemId === item.itemId)
            const configured=tasks.map(b=>({buyPrice:b.task.buyPrice,sellPrice:b.task.sellPrice}))
            const unique=new Map(configured.filter(p=>p.buyPrice>0 && p.sellPrice>0).map(p=>[JSON.stringify(p),p]))
            const quote=policy.autoPricing ? engines.pricing.quote({itemId:item.itemId,market,override}) : null
            const price=quote ?? (unique.size === 1 ? [...unique.values()][0] : null)
            const validPrice=price && Number.isFinite(price.buyPrice) && price.buyPrice>0 && Number.isFinite(price.sellPrice) && price.sellPrice>0
                && (override.maxBuyPrice==null || price.buyPrice<=override.maxBuyPrice) && (override.minSellPrice==null || price.sellPrice>=override.minSellPrice)
            const maxBots=override.disabled ? 0 : Math.min(policy.maxResellersPerItem,override.maxBots ?? policy.maxResellersPerItem)
            const forced=override.forcedBots!=null
            const proposal=proposals?.find(p=>p.itemId===item.itemId)
            const proposalCount=Number.isInteger(proposal?.desiredBots) && proposal.desiredBots>=0 ? proposal.desiredBots : tasks.length
            const reasons=[reason("TARGET_RESELLER_COUNT",`Загальна ціль reseller: ${policy.operations.roles.reseller.target}.`,{target:policy.operations.roles.reseller.target}),
                reason("ITEM_MAX_BOTS_LIMIT",`Ліміт товару: ${maxBots}.`,{policyMax:policy.maxResellersPerItem,overrideMax:override.maxBots ?? null,effectiveMax:maxBots})]
            if(override.disabled) reasons.push(reason("ITEM_DISABLED","Товар вимкнено користувачем."))
            if(forced && !override.disabled && maxBots>0) reasons.push(reason("USER_FORCED_BOTS",`Користувач задав ${override.forcedBots} ботів.`,{requested:override.forcedBots}))
            if(override.minBots!=null && !override.disabled && maxBots>0) reasons.push(reason("USER_MIN_BOTS",`Мінімум за запитом: ${override.minBots}.`,{requested:override.minBots}))
            return {...item,desiredBots:0,maxBots,requested:maxBots===0 ? 0 : forced ? override.forcedBots : Math.max(override.minBots ?? 0,proposalCount),
                minimum:maxBots===0 ? 0 : forced ? override.forcedBots : override.minBots ?? 0,forced,
                hardOverride:override.disabled === true || forced || override.maxBots!=null || override.minBots!=null,
                buyPrice:validPrice ? price.buyPrice : null,sellPrice:validPrice ? price.sellPrice : null,
                priceSource:validPrice ? quote ? "pricing_provider" : "configured_task" : "unavailable",
                improvementPercent:Number.isFinite(proposal?.improvementPercent) ? proposal.improvementPercent : null,
                reasons,constraintsApplied:[{code:"TOTAL_RESELLER_LIMIT",value:policy.operations.roles.reseller.target},{code:"ITEM_MAX_BOTS_LIMIT",value:maxBots},
                    {code:"MAX_BUY_PRICE",value:override.maxBuyPrice ?? null},{code:"MIN_SELL_PRICE",value:override.minSellPrice ?? null}]}
        })
        let remaining=policy.operations.roles.reseller.target
        const order=[...allocations].sort((a,b)=>Number(b.forced)-Number(a.forced) || a.itemId-b.itemId)
        for(const allocation of order){
            allocation.desiredBots=Math.min(allocation.minimum,allocation.maxBots,remaining)
            remaining-=allocation.desiredBots
            if(allocation.minimum>allocation.desiredBots) assessments.push(reason("OVERRIDE_CAPACITY_CONFLICT",`Товар ${allocation.itemId}: запитана кількість перевищує доступний ліміт.`,{itemId:allocation.itemId,requested:allocation.minimum,allowed:allocation.desiredBots}))
        }
        for(const allocation of order){
            const add=Math.min(Math.max(0,allocation.requested-allocation.desiredBots),allocation.maxBots-allocation.desiredBots,remaining)
            allocation.desiredBots+=add;remaining-=add
        }
        // Deterministic use of configured items; no market ranking or fake profitability.
        if(policy.autoSelectItems) for(const allocation of order){
            if(allocation.forced || allocation.buyPrice==null) continue
            const add=Math.min(allocation.maxBots-allocation.desiredBots,remaining)
            allocation.desiredBots+=add;remaining-=add
            if(add) allocation.reasons.push(reason("CONFIGURED_ITEM_AVAILABLE","Товар має однозначні задані ціни; використано порядок itemId, без оцінки прибутковості."))
        }
        if(remaining) assessments.push(reason("UNALLOCATED_RESELLER_SLOTS",`${remaining} слотів не розподілено: немає дозволених товарів із цінами або досягнуто ліміти.`,{count:remaining}))
        if(policy.operations.roles.analyst.target>0 && !engines.analysis.available) assessments.push(reason("ANALYST_UNAVAILABLE","Execution-контракт Analyst ще не реалізовано.",{requested:policy.operations.roles.analyst.target}))
        if(policy.autoPricing) assessments.push(reason("PRICING_ENGINE_UNAVAILABLE","Автоматична оцінка цін недоступна; використовуються лише однозначні задані ціни завдань."))
        if(policy.autoAnalysis && !engines.analysis.available) assessments.push(reason("ANALYSIS_PLANNER_UNAVAILABLE","Планувальник аналізу ще не підключено."))
        return {roles:{reseller:policy.operations.roles.reseller.target,analyst:policy.operations.roles.analyst.target},analystExecutionEnabled:engines.analysis.available===true,allocations,unallocatedResellers:remaining,
            market:{available:market.available===true},analysisTask:policy.autoAnalysis ? engines.analysis.getNextAnalysisTask({market,policy}) : null,assessments}
    }
}
