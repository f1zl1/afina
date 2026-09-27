export function percentile(values,q){
    if(!values.length) return null
    const sorted=[...values].sort((a,b)=>a-b),index=(sorted.length-1)*q,lo=Math.floor(index)
    return sorted[lo]+(sorted[Math.ceil(index)]-sorted[lo])*(index-lo)
}
export const median=values=>percentile(values,.5)
export const mad=values=>{const m=median(values);return m==null ? null : median(values.map(v=>Math.abs(v-m)))}
export function distribution(lots){
    const prices=lots.map(l=>l.pricePerItem)
    return {lotCount:lots.length,supply:lots.reduce((n,l)=>n+l.amount,0),
        minPricePerItem:prices.length ? Math.min(...prices) : null,
        medianPricePerItem:median(prices),meanPricePerItem:prices.length ? prices.reduce((n,v)=>n+v/prices.length,0) : null,
        ...Object.fromEntries([10,25,50,75,90].map(p=>['p'+p,percentile(prices,p/100)]))}
}

export function classifyLots(raw,ownNames,policy){
    const lots=raw.slice(0,45).map((lot,index)=>{
        const amount=lot?.amount,totalPrice=lot?.totalPrice
        const seller=typeof lot?.seller==='string' ? lot.seller.replace(/§[0-9a-fk-or]/gi,'').trim() : ''
        const valid=Number.isSafeInteger(amount) && amount>0 && amount<=4096 && Number.isSafeInteger(totalPrice) && totalPrice>0
            && Number.isFinite(totalPrice/amount) && /^[a-z0-9_]{3,16}$/i.test(seller) && !lot?.invalidReason
        const own=ownNames.has(seller.toLowerCase())
        const classification=!valid ? 'INVALID' : own ? 'OWN_LISTING' : 'INDEPENDENT'
        return {slot:Number.isInteger(lot?.slot) ? lot.slot : index,amount:Number.isFinite(amount)?amount:null,
            totalPrice:Number.isFinite(totalPrice)?totalPrice:null,pricePerItem:valid ? totalPrice/amount : null,
            seller:seller.slice(0,32),expires:typeof lot?.expires==='string' ? lot.expires.slice(0,100) : null,
            ownership:own?'own':'independent',classification,includedInIndependentMarket:valid&&!own,
            exclusionReason:!valid?'INVALID_LOT':own?'OWN_LISTING':null,
            parseReason:typeof lot?.invalidReason==='string'?lot.invalidReason.slice(0,80):null,
            segment:amount<=policy.marketRetailMaxAmount?'retail':amount<=policy.marketMediumMaxAmount?'medium':'bulk'}
    })
    // Relative upper fence only; low prices are retained. Own listings never define the fence.
    const prices=lots.filter(l=>l.includedInIndependentMarket).map(l=>l.pricePerItem)
    const m=median(prices),q3=percentile(prices,.75),iqr=q3-percentile(prices,.25)
    const highFence=prices.length>=5 ? Math.max(m*3,m+6*1.4826*mad(prices),q3+3*iqr) : null
    for(const lot of lots) if(lot.includedInIndependentMarket && highFence!=null && lot.pricePerItem>highFence){
        lot.classification='HIGH_PRICE_OUTLIER';lot.includedInIndependentMarket=false;lot.exclusionReason='HIGH_PRICE_OUTLIER'
    }
    const independent=lots.filter(l=>l.includedInIndependentMarket)
    const retail=independent.filter(l=>l.segment==='retail')
    const retailReference=retail.length>=3 ? median(retail.map(l=>l.pricePerItem)) : null
    const opportunityReference=retailReference ?? (independent.length>=5 ? median(independent.map(l=>l.pricePerItem)) : null)
    for(const lot of independent) if(opportunityReference && lot.pricePerItem<=.75*opportunityReference){
        lot.classification='POTENTIAL_WHOLESALE_OPPORTUNITY'
        lot.potentialSpread=retailReference==null ? null : retailReference-lot.pricePerItem
    }
    return {lots,highFence,retailReference,smallSample:prices.length<5}
}

export function summarizeObservation(classified){
    const lots=classified.lots,clean=lots.filter(l=>l.includedInIndependentMarket),own=lots.filter(l=>l.classification==='OWN_LISTING')
    return {...distribution(clean),independentLotCount:clean.length,independentSupply:clean.reduce((n,l)=>n+l.amount,0),
        ownLotCount:own.length,ownSupply:own.reduce((n,l)=>n+l.amount,0),
        excludedHighOutlierCount:lots.filter(l=>l.classification==='HIGH_PRICE_OUTLIER').length,
        invalidLotCount:lots.filter(l=>l.classification==='INVALID').length,sellerCount:new Set(clean.map(l=>l.seller.toLowerCase())).size,
        ...Object.fromEntries(['retail','medium','bulk'].map(s=>[s,distribution(clean.filter(l=>l.segment===s))])),
        potentialWholesaleOpportunities:clean.filter(l=>l.classification==='POTENTIAL_WHOLESALE_OPPORTUNITY').map(l=>({seller:l.seller,amount:l.amount,pricePerItem:l.pricePerItem,potentialSpread:l.potentialSpread ?? null})),
        diagnostics:{highFence:classified.highFence,retailReference:classified.retailReference,smallSample:classified.smallSample}}
}

export function modelFromHistory(latest,history){
    // Temporal variation of retail snapshot medians, not cross-sectional lot spread or sales.
    const medians=history.map(h=>h.retail.medianPricePerItem).filter(v=>v!=null)
    const volatility=medians.length>=3 ? 1.4826*mad(medians)/median(medians) : null
    return {...latest,observationCount:history.length,volatility,volatilitySampleCount:medians.length,
        confidenceBase:latest.independentLotCount===0 ? 0 :
            (.45*Math.min(1,latest.independentLotCount/20)+.25*Math.min(1,latest.sellerCount/5)+.30*Math.min(1,history.length/5))/(1+(volatility ?? 0)),
        salesVelocity:null,realDemand:null,profitPerHour:null}
}
export function withAge(model,policy,now=Date.now()){
    const age=Math.max(0,now-model.lastObservedAt)
    const freshness=age<=policy.marketFreshMs?'fresh':age<=policy.marketStaleMs?'aging':'stale'
    return {...model,dataAgeMs:age,freshness,confidence:Number((100*model.confidenceBase*Math.max(0,1-age/(2*policy.marketStaleMs))).toFixed(1))}
}
