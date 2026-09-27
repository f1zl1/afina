const codes=new Set(['OPENING_BUY_SEARCH','SCANNING_BUY_LOTS','BUY_SEARCH_RESULT','BUY_LOT_SELECTED','OPENING_BUY_CONFIRMATION','BUY_CONFIRMATION_RESULT','CONFIRMING_PURCHASE','VERIFYING_PURCHASE','BUY_INVENTORY_RESULT','PREPARING_SELL','SELLING','BUY_ATTEMPT_STARTED','PURCHASE_ATTRIBUTED','LISTING_ATTEMPT_STARTED','LISTING_ACKNOWLEDGED','LISTING_SERVER_RESULT','INVENTORY_BEFORE'])
const outcomes=new Set(['OPENED','MISSING','CLICK_FAILED','CONFIRMATION_MISSING','SLOT_MISSING','INVENTORY_UNCONFIRMED','success','failed','storage_full','afk','timeout','cancelled'])
export function safeEconomicEvidence(value){
    if(!codes.has(value?.code))return null
    const data={}
    for(const key of ['beforeCount','afterCount','receivedCount','count','totalPrice','slot','windowId'])if(Number.isSafeInteger(value.data?.[key])&&value.data[key]>=0)data[key]=value.data[key]
    if(outcomes.has(value.data?.outcome))data.outcome=value.data.outcome
    return {code:value.code,data}
}
export function appendEconomicEvidence(row,code,data={},sequence=null){
    const entries=[...(row.timeline??[]),{at:Date.now(),code,sequence,botId:row.botId??row.request?.botId??null,incarnationId:row.incarnationId??row.liveValidation?.incarnationId??null,data}]
    return entries.length<=128?entries:[...entries.slice(0,6),...entries.slice(-122)]
}
