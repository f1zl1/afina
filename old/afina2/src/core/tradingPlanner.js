import {createHash,randomUUID} from 'node:crypto'
import {economicItem,economicLimits} from '../workloads/economicContract.js'

export const tradingMinimumConfidence=50
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const price=value=>Number.isSafeInteger(value)&&value>0&&value<=economicLimits.maximumPrice

// Pure recommendation logic. No execution, bot or scheduler dependencies.
export function tradingPlan({item,model,override={},policy,now=Date.now(),marketRevision=0}){
    const reasons=[]
    const plan={planId:randomUUID(),itemId:item.itemId,serverId:model?.serverId??null,realm:model?.realm??null,
        decision:'HOLD',maxBuyPricePerItem:null,targetSellPricePerItem:null,targetQuantity:0,
        expectedProfitPerItem:null,expectedMargin:null,confidence:model?.confidence??null,
        marketModelRevision:marketRevision,sourceTimestamp:model?.lastObservedAt??null,
        reasons,createdAt:now,expiresAt:now}
    if(override.disabled)reasons.push('ITEM_DISABLED')
    if(Math.min(policy.maxResellersPerItem,override.maxBots??policy.maxResellersPerItem)===0)reasons.push('ITEM_MAX_BOTS_LIMIT')
    try{economicItem(item)}catch{reasons.push('INVALID_ITEM')}
    if(!model)reasons.push('MARKET_UNAVAILABLE')
    else{
        if(model.freshness!=='fresh'||!Number.isSafeInteger(model.lastObservedAt)||model.lastObservedAt>now||now>=model.lastObservedAt+policy.marketFreshMs)reasons.push('DATA_STALE')
        if(!Number.isFinite(model.confidence)||model.confidence<tradingMinimumConfidence)reasons.push('LOW_CONFIDENCE')
        if(!Number.isSafeInteger(model.independentSupply)||model.independentSupply<=0)reasons.push('INSUFFICIENT_SUPPLY')
        // Expire before either freshness or confidence can become insufficient.
        const confidenceDeadline=model.confidenceBase>0 ? model.lastObservedAt+2*policy.marketStaleMs*(1-tradingMinimumConfidence/(100*model.confidenceBase)) : now
        plan.expiresAt=Math.max(now,Math.floor(Math.min(model.lastObservedAt+policy.marketFreshMs,confidenceDeadline)))
    }
    if(reasons.length)return plan
    const retail=model.retail
    const sell=Math.floor(retail?.medianPricePerItem)
    if(!(retail?.lotCount>=3)||!(model.sellerCount>=2)||!price(sell)){reasons.push('PRICES_UNAVAILABLE');return plan}
    if(override.minSellPrice!=null&&sell<override.minSellPrice){reasons.push('MIN_SELL_PRICE');return plan}
    const opportunities=model.potentialWholesaleOpportunities??[]
    if(!Array.isArray(opportunities)){reasons.push('PRICES_UNAVAILABLE');return plan}
    const candidates=opportunities.filter(l=>Number.isSafeInteger(l.amount)&&l.amount>0&&Number.isFinite(l.pricePerItem)&&l.pricePerItem>0)
        .map(l=>({...l,buy:Math.ceil(l.pricePerItem)})).sort((a,b)=>a.buy-b.buy||a.amount-b.amount)
    let selected=null
    const blockers=new Set()
    for(const lot of candidates){
        if(!price(lot.buy)||lot.buy>=sell||lot.pricePerItem>.75*retail.medianPricePerItem)continue
        if(override.maxBuyPrice!=null&&lot.buy>override.maxBuyPrice){blockers.add('MAX_BUY_PRICE');continue}
        const cap=Math.min(economicLimits.maximumQuantity,Math.floor(economicLimits.maximumPurchaseValue/lot.buy),model.independentSupply)
        // Existing buyer purchases whole lots: never recommend a fraction of a lot.
        if(lot.amount>cap){blockers.add(lot.amount*lot.buy>economicLimits.maximumPurchaseValue?'PURCHASE_VALUE_LIMIT':'INSUFFICIENT_SUPPLY');continue}
        selected=lot;break
    }
    if(!selected){
        reasons.push(...(blockers.size?[...blockers].sort():['NO_PROFITABLE_SPREAD']))
        return plan
    }
    if(plan.expiresAt<=now){reasons.push('LOW_CONFIDENCE');return plan}
    Object.assign(plan,{decision:'BUY_RESELL',maxBuyPricePerItem:selected.buy,targetSellPricePerItem:sell,targetQuantity:selected.amount,
        expectedProfitPerItem:sell-selected.buy,expectedMargin:(sell-selected.buy)/selected.buy})
    reasons.push('PROFITABLE_SPREAD')
    return plan
}

export default class TradingPlanner{
    constructor(store){this.store=store}
    evaluate({items,market,overrides,policy,now=Date.now()}){
        const plans=[]
        for(const item of items){
            const models=market.items.filter(m=>m.itemId===item.itemId)
            for(const model of models.length?models:[null]){
                const override=overrides.find(o=>o.itemId===item.itemId)??{}
                const scope=`${item.itemId}:${model?.serverId??''}:${model?.realm??''}`
                const {dataAgeMs,confidence,freshness,...evidence}=model??{}
                const fingerprint=hash({item,evidence,fresh:freshness==='fresh',confident:confidence>=tradingMinimumConfidence,override,
                    maxResellersPerItem:policy.maxResellersPerItem,marketFreshMs:policy.marketFreshMs,marketStaleMs:policy.marketStaleMs})
                const row=this.store.prepare('SELECT document,fingerprint FROM tradingPlans WHERE scope=? ORDER BY sequence DESC LIMIT 1').get(scope)
                const previous=row?JSON.parse(row.document):null
                if(row?.fingerprint===fingerprint&&(previous.expiresAt>now||previous.decision==='HOLD'&&previous.expiresAt<=previous.createdAt)){plans.push(previous);continue}
                const plan=tradingPlan({item,model,override,policy,now,marketRevision:market.revision})
                this.store.transaction(()=>{
                    this.store.prepare('INSERT INTO tradingPlans(scope,fingerprint,document) VALUES(?,?,?)').run(scope,fingerprint,JSON.stringify(plan))
                    this.store.prepare('DELETE FROM tradingPlans WHERE scope=? AND sequence NOT IN (SELECT sequence FROM tradingPlans WHERE scope=? ORDER BY sequence DESC LIMIT 20)').run(scope,scope)
                })
                plans.push(plan)
            }
        }
        return {mode:'SHADOW',executionEnabled:false,minimumConfidence:tradingMinimumConfidence,plans,
            history:this.store.prepare('SELECT document FROM tradingPlans ORDER BY sequence DESC LIMIT 100').all().map(r=>JSON.parse(r.document))}
    }
}
