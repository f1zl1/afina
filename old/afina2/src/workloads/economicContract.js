export const economicLimits=Object.freeze({maximumQuantity:64,maximumPurchaseValue:1000000000,maximumPrice:1000000000,maximumPending:100})
export const economicTerminal=new Set(['COMPLETED','FAILED','CANCELLED','UNCERTAIN'])
export function economicRequest(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['requestId','botId','itemId','maxBuyPricePerItem','targetSellPricePerItem','targetQuantity'].includes(k)))throw new Error('INVALID_ECONOMIC_REQUEST')
 if(typeof value.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,80}$/.test(value.requestId))throw new Error('INVALID_REQUEST_ID')
 if(!Number.isSafeInteger(value.itemId)||value.itemId<1)throw new Error('INVALID_ITEM')
 if(value.botId!=null&&(!Number.isSafeInteger(value.botId)||value.botId<1))throw new Error('INVALID_BOT')
 for(const key of ['maxBuyPricePerItem','targetSellPricePerItem'])if(!Number.isSafeInteger(value[key])||value[key]<1||value[key]>economicLimits.maximumPrice)throw new Error('INVALID_PRICE')
 if(!Number.isSafeInteger(value.targetQuantity)||value.targetQuantity<1||value.targetQuantity>economicLimits.maximumQuantity)throw new Error('INVALID_QUANTITY')
 if(value.targetQuantity*value.maxBuyPricePerItem>economicLimits.maximumPurchaseValue)throw new Error('PURCHASE_VALUE_LIMIT')
 return {requestId:value.requestId,botId:value.botId??null,itemId:value.itemId,maxBuyPricePerItem:value.maxBuyPricePerItem,targetSellPricePerItem:value.targetSellPricePerItem,targetQuantity:value.targetQuantity}
}
export function economicItem(row){
 let matcher;try{matcher=typeof row?.matcher==='string'?JSON.parse(row.matcher):row?.matcher}catch{}
 if(!row||!matcher||typeof matcher.minecraftName!=='string'||!/^\w{1,80}$/.test(matcher.minecraftName)||Object.keys(matcher).some(k=>!['minecraftName','potionId'].includes(k))||matcher.potionId!=null&&!Number.isSafeInteger(matcher.potionId)||typeof row.searchQuery!=='string'||!row.searchQuery.trim()||row.searchQuery.length>100||/[\r\n\x00-\x1f]/.test(row.searchQuery))throw new Error('INVALID_ITEM')
 return {itemId:row.itemId,name:row.name,searchQuery:row.searchQuery,matcher}
}
// purchaseValue is the sum of quoted lot prices with verified receipt, not an
// independently reconciled balance debit. Sales and cash settlement are unknown.
export const emptyEconomicProgress=()=>({boughtQuantity:0,listedQuantity:0,purchaseValue:0,spentAmount:null,remainingInventory:null,soldQuantity:null,receivedAmount:null,certainty:'KNOWN'})
