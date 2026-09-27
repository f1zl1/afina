import {randomUUID} from 'node:crypto'
import EconomicStore from './economicStore.js'
import {appendEconomicEvidence,safeEconomicEvidence} from '../workloads/economicEvidence.js'
import {economicRequest,economicItem,economicLimits,economicTerminal,emptyEconomicProgress} from '../workloads/economicContract.js'

export default class EconomicCoordinator{
 constructor(core){this.core=core;this.store=new EconomicStore(core.store.store);core.workloads.economic=id=>this.store.get(id)}
 changed(row){this.core.eventBus.publish('core.economic.changed',{workloadId:row.workloadId,status:row.status});this.core.schedule({type:'ECONOMIC_CHANGED',source:row.source??'MANUAL'});return row}
 save(row,patch){
  const next={...row,...patch}
  if(patch.status&&patch.status!==row.status)next.timeline=appendEconomicEvidence(next,economicTerminal.has(patch.status)?'TERMINAL_WORKLOAD_RESULT':'WORKLOAD_'+patch.status,{status:patch.status,boughtQuantity:next.progress?.boughtQuantity??0,listedQuantity:next.progress?.listedQuantity??0})
  return this.changed(this.store.save(next))
 }
 manualItemConflict(row){return row.source!=='AUTONOMOUS_TRADING'&&this.store.rows().some(r=>r.source==='AUTONOMOUS_TRADING'&&r.itemId===row.itemId&&['ADMITTED','RUNNING','DRAINING','UNCERTAIN'].includes(r.status))}
 eligible(bot){
  const blocked=this.core.workloads.eligible(bot,'manual_economic');if(blocked)return blocked
  if(this.core.effectiveOperations().maintenanceMode)return 'MAINTENANCE_MODE'
  if(this.store.rows().some(r=>r.botId===bot.botId&&['ADMITTED','RUNNING','DRAINING','UNCERTAIN'].includes(r.status)))return 'ECONOMIC_WORKLOAD_BUSY'
  if(this.store.rows().some(r=>r.botId===bot.botId&&this.needsResidualReview(r)))return 'RESIDUAL_INVENTORY_REVIEW_REQUIRED'
  if(['STARTING','RUNNING','DRAINING'].includes(bot.workload.state))return 'WORKLOAD_BUSY'
  return null
 }
 submit(payload,actor){
  if(actor?.type!=='web'||!actor.id)throw new Error('MANUAL_OPERATOR_REQUIRED')
  return this.#create(payload,{source:'MANUAL',actorId:String(actor.id).slice(0,128)})
 }
 submitAutonomous(planId,authority){
  if(!authority||authority!==this.core.tradingExecution)throw new Error('CORE_TRADING_AUTHORITY_REQUIRED')
  const old=this.store.plan(planId);if(old)return old
  const {reason,plan,request,liveValidation}=authority.validate(planId);if(reason)throw new Error(reason)
  return this.#create(request,{source:'AUTONOMOUS_TRADING',actorId:'core:trading',sourcePlanId:plan.planId,sourceTimestamp:plan.sourceTimestamp,sourceMarketRevision:plan.marketModelRevision,serverId:plan.serverId,realm:plan.realm,...(liveValidation?{liveValidation}:{})})
 }
 #create(payload,source){
  const request=economicRequest(payload),old=this.store.request(request.requestId)
  if(old){if(old.source!==source.source||JSON.stringify(old.request)!==JSON.stringify(request))throw new Error('IDEMPOTENCY_CONFLICT');return old}
  if(this.core.stopped)throw new Error('CORE_STOPPED')
  const item=economicItem(this.core.store.store.prepare('SELECT * FROM itemsData WHERE itemId=?').get(request.itemId)),actual=this.core.readActual()
  if(this.store.rows().filter(r=>r.status==='PENDING').length>=economicLimits.maximumPending)throw new Error('PENDING_LIMIT')
  if(request.botId!=null){const blocker=this.eligible(actual.bots.find(b=>b.botId===request.botId));if(blocker)throw new Error(blocker)}
  else if(!actual.bots.some(b=>!this.eligible(b)))throw new Error('NO_ELIGIBLE_RESELLER')
  const row={...request,request,...source,workloadId:randomUUID(),botId:null,item,status:'PENDING',createdAt:Date.now(),progress:emptyEconomicProgress(),sequence:0,reason:null,result:null}
  if(source.sourcePlanId){row.timeline=appendEconomicEvidence(row,'TRADING_PLAN_SELECTED',{planId:source.sourcePlanId});row.timeline=appendEconomicEvidence(row,'AUTONOMOUS_ADMISSION_ACCEPTED',{targetQuantity:row.targetQuantity,maximumPurchaseCommitment:row.targetQuantity*row.maxBuyPricePerItem})}
  const persist=()=>{
   if(row.liveValidation){this.core.liveValidation.consume(row);row.timeline=appendEconomicEvidence(row,'VALIDATION_FUSE_CONSUMED',{generation:row.liveValidation.fuseGeneration})}
   row.timeline=appendEconomicEvidence(row,'ECONOMIC_WORKLOAD_CREATED',{workloadId:row.workloadId})
   return this.store.save(row)
  }
  return this.changed(row.liveValidation?this.core.store.store.transaction(persist):persist())
 }
 placements(row,actual=this.core.readActual(),admission=null,used=new Set()){
  const turns=admission?.botTurns??this.core.scheduler.botTurns
  return actual.bots.filter(b=>(!admission||admission.botIds.has(b.botId))&&!used.has(b.botId)&&(row.request.botId==null||row.request.botId===b.botId)&&(row.source!=='AUTONOMOUS_TRADING'||b.serverId===row.serverId&&b.realm===row.realm)&&!this.eligible(b)).sort((a,b)=>(turns.get(a.botId)??0)-(turns.get(b.botId)??0)||a.botId-b.botId)
 }
 candidates(actual,admission){
  const used=new Set(),result=[]
  for(const row of this.store.rows().filter(r=>r.status==='PENDING')){
   if(this.manualItemConflict(row))continue
   const autonomous=row.source==='AUTONOMOUS_TRADING'
   if(autonomous){const {reason}=this.core.tradingExecution.validate(row.sourcePlanId,{row});if(reason){this.cancel(row.workloadId,reason);continue}}
   const bot=this.placements(row,actual,admission,used)[0]
   if(bot){used.add(bot.botId);result.push({action:'economic_workload',target:{botId:bot.botId},after:{type:'reseller'},result:'planned',workloadId:row.workloadId})}
  }
  return result
 }
 dispatch(candidate){
  let row=this.store.get(candidate.workloadId);if(row?.status!=='PENDING')return false
  if(this.manualItemConflict(row))return false
  const bot=this.core.readActual().bots.find(b=>b.botId===candidate.target.botId),blocked=this.eligible(bot);if(blocked)return false
  if(row.source==='AUTONOMOUS_TRADING'){
   const {reason}=this.core.tradingExecution.validate(row.sourcePlanId,{row,bot})
   if(reason){this.cancel(row.workloadId,reason);return false}
  }
  // Commit before IPC. Any interruption after this point is never replayed.
  row={...row,timeline:appendEconomicEvidence({...row,botId:bot.botId,incarnationId:bot.incarnationId},'BOT_SELECTED')}
  row=this.save(row,{botId:bot.botId,status:'ADMITTED',incarnationId:bot.incarnationId,lifecycleEpoch:this.core.workloads.epoch(bot.botId),workloadGeneration:bot.workload.generation,startedAt:Date.now(),deadlineAt:Date.now()+600000})
  try{const sent=this.core.workloads.dispatch(bot.botId,row,'manual_economic');if(!sent.accepted)this.save(row,{status:'UNCERTAIN',reason:sent.reason??'DISPATCH_UNCONFIRMED',progress:{...row.progress,certainty:'UNCERTAIN'}});else{const current=this.store.get(row.workloadId);this.save(current,{timeline:appendEconomicEvidence(current,'WORKLOAD_DISPATCHED')})}}catch{this.save(row,{status:'UNCERTAIN',reason:'DISPATCH_UNCONFIRMED',progress:{...row.progress,certainty:'UNCERTAIN'}})}
  return true
 }
 cancel(id,reason='OPERATOR_CANCELLED'){
  const row=this.store.get(id);if(!row)throw new Error('WORKLOAD_NOT_FOUND')
  if(economicTerminal.has(row.status))return row
  if(row.status==='PENDING')return this.save(row,{status:'CANCELLED',reason,result:'NO_EXECUTION'})
  const next=row.status==='DRAINING'?row:this.save(row,{status:'DRAINING',reason,drainDeadlineAt:Date.now()+60000})
  const bot=this.core.readActual().bots.find(b=>b.botId===row.botId)
  if(bot?.incarnationId===row.incarnationId)this.core.workloads.send(row.botId,'core:economic.cancel',{workloadId:row.workloadId,incarnationId:row.incarnationId,lifecycleEpoch:row.lifecycleEpoch,workloadGeneration:row.workloadGeneration})
  return next
 }
 cancelBot(botId){for(const r of this.store.rows())if(!economicTerminal.has(r.status)&&(r.botId===botId||r.request.botId===botId))this.cancel(r.workloadId,'LIFECYCLE_CHANGED')}
 needsResidualReview(row){return economicTerminal.has(row.status)&&row.status!=='UNCERTAIN'&&!row.residualReview&&((row.progress?.boughtQuantity??0)>(row.progress?.listedQuantity??0)||['EXISTING_TARGET_INVENTORY','SELL_SLOT_OCCUPIED'].includes(row.reason))}
 oldExecutorStopped(row,bot){return Boolean(bot&&(bot.observationQuality==='PROCESS_MISSING'&&!bot.running||bot.incarnationId&&bot.incarnationId!==row.incarnationId))}
 resolve({workloadId,note},actor){
  if(actor?.type!=='web'||!actor.id)throw new Error('MANUAL_OPERATOR_REQUIRED')
  const row=this.store.get(workloadId);if(!row||(row.status!=='UNCERTAIN'&&!this.needsResidualReview(row))||typeof note!=='string'||note.trim().length<10||note.length>500)throw new Error('RESOLUTION_NOTE_REQUIRED')
  const bot=this.core.readActual().bots.find(b=>b.botId===row.botId)
  if(row.status==='UNCERTAIN'&&!this.oldExecutorStopped(row,bot))throw new Error('OLD_EXECUTOR_MUST_BE_STOPPED')
  const review={at:Date.now(),note:note.trim(),actorId:String(actor.id).slice(0,128)}
  return this.save(row,{...(row.status==='UNCERTAIN'?{status:'CANCELLED',result:'OPERATOR_ACKNOWLEDGED_UNKNOWN',resolvedAt:review.at,resolutionNote:review.note,resolvedBy:review.actorId}:{}),residualReview:review})
 }
 reconcile(){
  const actual=this.core.readActual()
  for(const row of this.store.rows().filter(r=>['ADMITTED','RUNNING','DRAINING'].includes(r.status))){
   const bot=actual.bots.find(b=>b.botId===row.botId)
   if(!bot||bot.incarnationId!==row.incarnationId||bot.observationQuality==='PROCESS_MISSING'||bot.workload&&bot.workload.generation!==row.workloadGeneration){this.save(row,{status:'UNCERTAIN',reason:'EXECUTOR_LOST',progress:{...row.progress,certainty:'UNCERTAIN'}});continue}
   if(row.drainDeadlineAt&&Date.now()>row.drainDeadlineAt){this.save(row,{status:'UNCERTAIN',reason:'DRAIN_UNCONFIRMED',progress:{...row.progress,certainty:'UNCERTAIN'}});continue}
   if(row.source==='AUTONOMOUS_TRADING'&&this.core.tradingExecution.policyBlocker()){this.cancel(row.workloadId,this.core.tradingExecution.policyBlocker());continue}
   if(this.core.workloads.eligible(bot,'manual_economic')||this.core.workloads.epoch(row.botId)!==row.lifecycleEpoch||Date.now()>row.deadlineAt)this.cancel(row.workloadId,'LIFECYCLE_OR_DEADLINE_CHANGED')
  }
 }
 handle(event){
  if(event.type!=='bot.economic.result')return false
  const p=event.payload??{},row=this.store.get(p.workloadId),bot=this.core.readActual().bots.find(b=>b.botId===event.source?.botId)
  if(!row||economicTerminal.has(row.status)||!bot||row.botId!==bot.botId||row.incarnationId!==bot.incarnationId||p.incarnationId!==row.incarnationId||p.lifecycleEpoch!==row.lifecycleEpoch||p.workloadGeneration!==row.workloadGeneration||bot.workload?.generation!==row.workloadGeneration||!Number.isSafeInteger(p.sequence)||p.sequence<=row.sequence)return true
  // Drain results from the same execution preserve proven partial evidence after a
  // lifecycle takeover. They never authorize more work or change lifecycle intent.
  const v=p.progress
  if(!v||!['RUNNING','DRAINING','COMPLETED','FAILED','CANCELLED','UNCERTAIN'].includes(p.status))return true
  for(const k of ['boughtQuantity','listedQuantity','purchaseValue'])if(!Number.isSafeInteger(v[k])||v[k]<row.progress[k])return true
  if(v.boughtQuantity>row.targetQuantity||v.listedQuantity>v.boughtQuantity||v.purchaseValue>row.maxBuyPricePerItem*v.boughtQuantity)return true
  if(p.status==='COMPLETED'&&(v.boughtQuantity!==row.targetQuantity||v.listedQuantity!==row.targetQuantity))return true
  if(row.status==='DRAINING'&&!economicTerminal.has(p.status)&&p.status!=='DRAINING')return true
  const progress={boughtQuantity:v.boughtQuantity,listedQuantity:v.listedQuantity,purchaseValue:v.purchaseValue,spentAmount:null,inventoryBefore:Number.isSafeInteger(v.inventoryBefore)&&v.inventoryBefore>=0?v.inventoryBefore:row.progress.inventoryBefore??null,remainingInventory:Number.isSafeInteger(v.remainingInventory)&&v.remainingInventory>=0?v.remainingInventory:null,soldQuantity:null,receivedAmount:null,certainty:p.status==='UNCERTAIN'?'UNCERTAIN':'KNOWN'}
  const evidence=safeEconomicEvidence(p.evidence)
  const timeline=evidence?appendEconomicEvidence(row,evidence.code,evidence.data,p.sequence):row.timeline
  this.save(row,{timeline,status:p.status,progress,sequence:p.sequence,evidenceAt:Date.now(),operation:typeof p.operation==='string'?p.operation.slice(0,80):null,confirmedOperation:['purchase_verified','listing_acknowledged'].includes(p.confirmedOperation)?p.confirmedOperation:row.confirmedOperation??null,reason:typeof p.reason==='string'?p.reason.slice(0,128):null,result:economicTerminal.has(p.status)?p.status==='COMPLETED'?'BOUGHT_AND_LISTED':v.boughtQuantity?'PARTIAL':'NO_PROVEN_PURCHASE':null});return true
 }
 restore(){for(const row of this.store.rows())if(['ADMITTED','RUNNING','DRAINING'].includes(row.status)){
  this.save(row,{status:'UNCERTAIN',reason:'APPLICATION_RESTARTED',progress:{...row.progress,certainty:'UNCERTAIN'}})
  const bot=this.core.readActual().bots.find(b=>b.botId===row.botId)
  if(bot?.incarnationId===row.incarnationId)this.core.workloads.send(row.botId,'core:economic.cancel',{workloadId:row.workloadId,incarnationId:row.incarnationId,lifecycleEpoch:row.lifecycleEpoch,workloadGeneration:row.workloadGeneration})
 }}
 stop(){for(const row of this.store.rows())if(!economicTerminal.has(row.status))this.cancel(row.workloadId,'APPLICATION_SHUTDOWN')}
 snapshot(){
  const actual=this.core.readActual(),rows=this.store.rows()
  const botReadiness=actual.bots.filter(b=>b.task.type==='reseller'||b.activeTask.type==='reseller').map(b=>{const reason=this.eligible(b);return {botId:b.botId,name:b.name,incarnationId:b.incarnationId,eligible:!reason,reason,workerSafe:b.workload?.safe===true,workerUncertain:b.workload?.uncertain===true,observationQuality:b.observationQuality,message:reason==='RESIDUAL_INVENTORY_REVIEW_REQUIRED'?'Перевірте залишок товару та запишіть результат ручної перевірки.':reason?'Допуск заблоковано: '+reason:'Можна подати ручне завдання. Перед операцією виконавець перевірить інвентар.'}})
  const workloads=rows.slice(-100).reverse().map(row=>{
   const bot=actual.bots.find(b=>b.botId===row.botId),p=row.progress??{},uncertain=row.status==='UNCERTAIN',residual=this.needsResidualReview(row),historicalUnknown=p.certainty==='UNCERTAIN'
   const attributed=!historicalUnknown&&p.boughtQuantity>0&&p.remainingInventory===p.boughtQuantity-p.listedQuantity?p.remainingInventory:null
   return {...row,operator:{reviewRequired:uncertain||residual,reviewKind:uncertain?'UNCERTAIN':residual?'RESIDUAL':null,canResolve:uncertain?this.oldExecutorStopped(row,bot):residual,
    currentIncarnationId:bot?.incarnationId??null,workerUncertain:bot?.workload?.uncertain===true,workerSafe:bot?.workload?.safe===true,admissionReason:bot?this.eligible(bot):'BOT_OBSERVATION_UNAVAILABLE',
    confirmedOperation:row.confirmedOperation??(p.listedQuantity>0?'listing_acknowledged':p.boughtQuantity>0?'purchase_verified':null),observedMatchingInventory:p.remainingInventory??null,inventoryEvidenceAt:row.evidenceAt??null,attributedRemainingQuantity:attributed,unrelatedInventoryAtStart:p.inventoryBefore>0?p.inventoryBefore:null,
    unresolvedEffects:historicalUnknown?'Можлива непідтверджена купівля або виставлення. Кошти, продажі та поточні лоти невідомі.':null,
    guidance:uncertain?'1. Зіставте завдання, запуск процесу та останню операцію. 2. Зупиніть старий процес; небезпечний STOP не примушуйте без окремого рішення оператора. 3. Зовні перевірте інвентар і лоти. 4. Запишіть перевірку. Закриття запису не підтверджує результат і не скидає невизначеність працівника.':residual?'Залишок або сторонні предмети потребують ручної перевірки інвентарю та місць аукціону. Самостійно обробіть тільки перевірені предмети через дозволені сервером ручні дії; ядро не продає, не викидає та не перевиставляє залишки. Запишіть перевірку перед новим завданням.':row.residualReview?'Ручну перевірку записано. Історичні лічильники та невизначеність збережено. Допуск залежить від поточного працівника; нове завдання повторно перевірить інвентар.':'Автоматична обробка залишків і перевиставлення вимкнені. Дані інвентарю — останній знімок виконання, не поточний стан.'}}
  })
  return {limits:economicLimits,workloads,botReadiness,eligibleBots:botReadiness.filter(b=>b.eligible).map(({botId,name})=>({botId,name})),legacyConfiguredTrading:'DISABLED',autonomousTrading:this.core.store.operationsPolicy().autonomousTradingEnabled?'ENABLED':'DISABLED'}
 }
}
