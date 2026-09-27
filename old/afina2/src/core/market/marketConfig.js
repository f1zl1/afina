// Shared persisted policy descriptors and execution constraints; prices are never configured here.
export const auctionConstraints=Object.freeze({windowType:'minecraft:generic_9x6',firstLotSlot:0,lastLotSlot:44,refreshSlot:45,maxActiveListingsPerAccount:5,minimumRefreshMs:5000})
const integer=(label,min,max,defaultValue)=>({type:'integer',label,min,max,defaultValue})
export const marketPolicyFields={
    analysisRealmReadyDelayMs:integer('Затримка після входу на realm, мс',0,300000,15000),
    analysisRealmReadyDelayJitterMs:integer('Випадкова добавка до затримки, мс',0,60000,3000),
    analysisMinObservations:integer('Мінімум спостережень',1,20,3),
    analysisMaxObservations:integer('Максимум спостережень',1,20,5),
    analysisRefreshIntervalMs:integer('Мінімальний інтервал refresh, мс',5000,60000,5000),
    analysisRefreshJitterMs:integer('Додатковий jitter refresh, мс',100,10000,1500),
    analysisWindowTimeoutMs:integer('Timeout auction GUI, мс',1000,60000,15000),
    analysisSessionTimeoutMs:integer('Timeout аналізу, мс',30000,3600000,240000),
    analysisMinRepeatMs:integer('Мінімальна пауза між аналізами товару, мс',10000,3600000,60000),
    marketFreshMs:integer('Свіжі market data, мс',10000,3600000,300000),
    marketStaleMs:integer('Застарілі market data, мс',20000,86400000,1800000),
    marketRetailMaxAmount:integer('Retail: максимальний розмір лота',1,1024,4),
    marketMediumMaxAmount:integer('Medium: максимальний розмір лота',2,4096,16),
    marketRawRetentionHours:integer('Raw history, годин',1,720,24),
    marketHistoryRetentionHours:integer('Історія агрегатів, годин',1,2160,168),
    marketRawLimit:integer('Максимум raw observations',100,100000,5000),
    marketHistoryLimit:integer('Максимум агрегатів',100,200000,20000)
}
export const marketDefaults=Object.fromEntries(Object.entries(marketPolicyFields).map(([k,f])=>[k,f.defaultValue]))
export function validateMarketPolicy(policy){
    for(const [a,b] of [['analysisMinObservations','analysisMaxObservations'],['marketFreshMs','marketStaleMs'],['marketRetailMaxAmount','marketMediumMaxAmount']]){
        if(policy[a]>=policy[b] && !(a==='analysisMinObservations' && policy[a]===policy[b])) throw new Error(`${a} must be less than ${b}`)
    }
    const maxDuration=(policy.analysisRealmReadyDelayMs ?? 15000)+(policy.analysisRealmReadyDelayJitterMs ?? 3000)+policy.analysisWindowTimeoutMs+(policy.analysisMaxObservations-1)*(policy.analysisRefreshIntervalMs+policy.analysisRefreshJitterMs+policy.analysisWindowTimeoutMs)
    if(maxDuration>policy.analysisSessionTimeoutMs) throw new Error('analysisSessionTimeoutMs is too short for the maximum observation count')
}
