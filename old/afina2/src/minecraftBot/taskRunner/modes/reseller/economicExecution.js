import ResellerInventory from './resellerInventory.js'
import ResellerBuyer from './resellerBuyer.js'
import ResellerSeller from './resellerSeller.js'
import ResellerServerActions from './server/resellerServerActions.js'
import ResellerServerDelay from './server/resellerServerDelay.js'
import {economicRequest,economicItem,emptyEconomicProgress} from '../../../../workloads/economicContract.js'
import {sleep} from './resellerUtils.js'

// A bounded composition of existing mechanics, not another trader or scheduler.
export default class EconomicExecution{
 constructor({bot,eventBus,logger,settings,task,workload}){
  Object.assign(this,{bot,eventBus,logger,settings,task,workload});this.progress=emptyEconomicProgress();this.sequence=0;this.cancelled=false;this.inFlight=false
  const taskData={manualEconomic:true,item:economicItem(task.item),buyPricePerOne:task.maxBuyPricePerItem,sellPricePerOne:task.targetSellPricePerItem}
  const request=economicRequest(task.request)
  if(['itemId','targetQuantity','maxBuyPricePerItem','targetSellPricePerItem'].some(k=>request[k]!==task[k])||task.item.itemId!==task.itemId||!Number.isSafeInteger(task.deadlineAt)||task.deadlineAt<=Date.now()||!Number.isSafeInteger(task.lifecycleEpoch))throw new Error('INVALID_ECONOMIC_REQUEST')
  const canContinue=()=>bot.client&&bot.positionStatus==='realm'&&!bot.lifecycleUncertain&&(!this.cancelled||this.inFlight),setState=operation=>{this.operation=operation;workload.progress(task.workloadId,operation);this.emit(this.cancelled?'DRAINING':'RUNNING',null,{code:operation.toUpperCase()})}
  this.server=new ResellerServerActions({bot,canContinue,delay:new ResellerServerDelay({settings})})
  const common={bot,eventBus,logger,settings,taskData,canContinue,setState,server:this.server}
  this.inventory=new ResellerInventory(common);common.inventory=this.inventory
  this.buyer=new ResellerBuyer(common);this.seller=new ResellerSeller(common)
 }
 count(){return this.buyer.purchaseVerifier.countTargetInventory()}
 emit(status,reason=null,evidence=null){
  this.progress.remainingInventory=this.bot.client?this.count():null
  this.progress.certainty=status==='UNCERTAIN'?'UNCERTAIN':'KNOWN'
  this.eventBus.emit('bot:economic.result',{workloadId:this.task.workloadId,incarnationId:this.task.incarnationId,lifecycleEpoch:this.task.lifecycleEpoch,workloadGeneration:this.task.workloadGeneration,sequence:++this.sequence,status,progress:{...this.progress},operation:this.operation??null,confirmedOperation:this.confirmedOperation??null,reason,evidence})
 }
 cancel(){if(this.cancelled)return;this.cancelled=true;this.workload.change({state:'DRAINING',draining:true,safe:false});this.emit('DRAINING')}
 async run(){
  let status='FAILED',reason=null
  try{
   this.progress.inventoryBefore=this.count()
   this.emit('RUNNING',null,{code:'INVENTORY_BEFORE',data:{beforeCount:this.progress.inventoryBefore}})
   // Existing inventory is not attributed to this request and must not be sold.
   if(this.count()!==0)throw new Error('EXISTING_TARGET_INVENTORY')
   // Existing inventory preparation can toss a non-target hotbar stack. Refuse
   // that situation instead of silently disposing of operator property.
   const slot=this.settings?.get('sellInventorySlot',36)??36
   if(this.bot.client?.inventory?.slots[slot])throw new Error('SELL_SLOT_OCCUPIED')
   while(this.progress.listedQuantity<this.task.targetQuantity&&!this.cancelled){
    if(Date.now()>this.task.deadlineAt)throw new Error('EXECUTION_DEADLINE')
    if(this.bot.lifecycleUncertain)throw new Error(this.bot.lifecycleUncertain)
    if(!this.bot.client||this.bot.positionStatus!=='realm')throw new Error('WORKER_NOT_READY')
    if(this.count()!==this.progress.boughtQuantity-this.progress.listedQuantity)throw new Error('UNATTRIBUTED_TARGET_INVENTORY')
    if(!this.inventory.findTarget()){
     const result=await this.buyer.buyUntilSuccess({remainingQuantity:this.task.targetQuantity-this.progress.boughtQuantity,
      onEvidence:(code,data)=>this.emit(this.cancelled?'DRAINING':'RUNNING',null,{code,data}),
      onRequest:()=>{this.inFlight=true;this.operation='purchase_requested';this.emit(this.cancelled?'DRAINING':'RUNNING',null,{code:'BUY_ATTEMPT_STARTED'})},
      onPurchase:(count,value)=>{this.progress.boughtQuantity+=count;this.progress.purchaseValue+=value;this.confirmedOperation='purchase_verified';this.inFlight=false;this.emit(this.cancelled?'DRAINING':'RUNNING',null,{code:'PURCHASE_ATTRIBUTED',data:{count,totalPrice:value,afterCount:this.count()}})}})
     if(result!=='success')throw new Error(this.bot.lifecycleUncertain??result.toUpperCase())
    }
    if(this.cancelled)break
    const item=this.inventory.findTarget();if(!item)throw new Error('INVENTORY_UNCONFIRMED')
    const held=this.bot.client.inventory?.slots[slot];if(held&&!this.inventory.isTarget(held))throw new Error('SELL_SLOT_OCCUPIED')
    const result=await this.seller.sellOne(item,{canList:()=>this.count()===this.progress.boughtQuantity-this.progress.listedQuantity,onEvidence:(code,data)=>this.emit(this.cancelled?'DRAINING':'RUNNING',null,{code,data}),onRequest:()=>{this.inFlight=true;this.operation='listing_requested';this.emit('RUNNING',null,{code:'LISTING_ATTEMPT_STARTED'})},onListed:()=>{this.progress.listedQuantity++;this.confirmedOperation='listing_acknowledged';this.inFlight=false;this.emit(this.cancelled?'DRAINING':'RUNNING',null,{code:'LISTING_ACKNOWLEDGED',data:{afterCount:this.count()}})}})
    if(result!=='success'){
     // Explicit server rejection proves no listing; timeout/transport cannot.
     if(['storage_full','failed','afk'].includes(result)&&!this.bot.lifecycleUncertain)this.inFlight=false
     throw new Error(this.bot.lifecycleUncertain??result.toUpperCase())
    }
    const expected=this.progress.boughtQuantity-this.progress.listedQuantity,until=Date.now()+(this.settings?.get('purchaseVerifyTimeoutMs',5000)??5000)
    while(this.count()!==expected&&Date.now()<until&&this.bot.client&&this.bot.positionStatus==='realm')await sleep(50)
    if(this.count()!==expected){this.bot.lifecycleUncertain='INVENTORY_RESULT_UNCERTAIN';throw new Error(this.bot.lifecycleUncertain)}
   }
   status=this.cancelled?'CANCELLED':'COMPLETED'
  }catch(error){reason=/^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)?error.message:'ECONOMIC_EXECUTION_ERROR';status=this.cancelled?'CANCELLED':'FAILED'}
  finally{
   this.server.closeOwnedWindow()
   if(this.inFlight||this.bot.lifecycleUncertain){this.bot.lifecycleUncertain??='TRANSACTION_RESULT_UNCERTAIN';status='UNCERTAIN';reason=this.bot.lifecycleUncertain}
   if(status==='UNCERTAIN')this.workload.read()
   else {this.workload.finish(this.task.workloadId,status,reason);if(!this.workload.drainPromise)this.workload.change({draining:false,safe:true})}
   this.emit(status,reason)
  }
 }
}
