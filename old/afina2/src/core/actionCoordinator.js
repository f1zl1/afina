import ActionLedger from './actionLedger.js'
import {transitionAccounting} from './transitionAccounting.js'

export default class ActionCoordinator{
 constructor(core){this.core=core;this.ledger=new ActionLedger({store:core.store.store,eventBus:core.eventBus});this.jobs=new Map();this.closed=false}
 accounting(actual,desired){return transitionAccounting(actual,desired,this.core.effectiveOperations(),Date.now(),this.core.store.runtimeSettings().actionTimeoutMs)}
 pendingGeneration(exclude=null){
  const results=new Map(this.core.store.store.prepare('SELECT requestId,accountIds FROM coreGenerationResults').all().map(r=>[r.requestId,JSON.parse(r.accountIds).length]))
  return this.ledger.active().filter(a=>a.actionId!==exclude&&(a.type==='GENERATE'||a.type==='REPLACE'&&a.metadata.generation)).reduce((n,a)=>n+Math.max(0,a.quantity-(results.get(a.actionId)??a.created)),0)
 }
 reconcile(actual,startup=false){
  if(startup)this.importLegacy(actual)
  this.ledger.reconcile(actual,{policyRevision:this.core.store.operationsPolicy().revision,startup})
  for(const a of this.ledger.recent(200)){
   const control=this.core.store.control().find(c=>c.pendingActionId===a.actionId)
   if(control)this.core.store.clearPending(control.botId,!a.metadata.lifecycle&&['FAILED','EXPIRED'].includes(a.state)?a.updatedAt+this.core.store.runtimeSettings().failureRetryMs:null)
   if(!a.metadata.lifecycle&&a.botId!=null&&a.type!=='REPLACE'&&['FAILED','EXPIRED'].includes(a.state)&&!this.ledger.active().some(active=>active.botId===a.botId)){
    const until=a.updatedAt+this.core.store.runtimeSettings().failureRetryMs,current=this.core.store.control().find(c=>c.botId===a.botId)
    if(until>Date.now()&&(current?.failedUntil??0)<until)this.core.store.setControl(a.botId,{failedUntil:until})
   }
   const decision=a.decisionId&&this.core.store.getDecision(a.decisionId)
   const result=a.state==='COMPLETED'?'applied':a.state==='CANCELLED'?'blocked':'failed'
   if(decision&&decision.result!==result)this.core.record({...decision,result,updatedAt:a.updatedAt,reasons:[...decision.reasons,{code:a.reason??'ACTION_COMPLETED',message:a.reason??'Action completed.'}]},true)
  }
  const failed=this.ledger.recent(200).find(a=>a.type==='GENERATE'&&['FAILED','EXPIRED'].includes(a.state)&&['ACCOUNT_GENERATION_FAILED','EXECUTION_FAILED','ACTION_TIMEOUT'].includes(a.reason))
  if(failed)this.core.accountGeneration.retryAt=Math.max(this.core.accountGeneration.retryAt??0,failed.updatedAt+this.core.store.runtimeSettings().failureRetryMs)
  this.ledger.prune(this.core.store.runtimeSettings().journalLimit)
 }
 importLegacy(actual){
  const core=this.core,policyRevision=core.store.operationsPolicy().revision,desiredRevision=core.store.desired()?.revision??0,inputRevision=core.store.revision()
  const rows=actual.observation.pending.replacements.rows.filter(r=>['requested','generating','created','selected','initializing'].includes(r.state))
  for(const b of actual.bots){
   const row=rows.find(r=>r.botId===b.botId),control=core.store.control().find(c=>c.botId===b.botId)
   if(row&&this.ledger.recent(200).some(a=>a.metadata.replacementRequestId===row.requestId&&a.state==='COMPLETED'))continue
   if(this.ledger.active().some(a=>a.botId===b.botId)||(!row&&!control?.pendingDecisionId))continue
   // Legacy rows carry executor progress, not a mandate to replay the executor.
   const type=row?'REPLACE':'START',since=row?.updatedAt??control.pendingSince??Date.now()
   const {action}=this.ledger.reserve({logicalKey:'bot:'+b.botId,type,botId:b.botId,accountId:row?.replacementAccountId??(row?null:b.accountId),role:b.task.type,quantity:1,policyRevision,desiredRevision,inputRevision,decisionId:row?.decisionId??control?.pendingDecisionId,deadlineAt:since+core.store.runtimeSettings().actionTimeoutMs,metadata:{imported:true,generation:row?.state==='generating',replacementRequestId:row?.requestId??null}})
   this.ledger.transition(action.actionId,'DISPATCHED');this.ledger.transition(action.actionId,'RUNNING')
   if(control?.pendingDecisionId)core.store.setControl(b.botId,{pendingActionId:action.actionId})
  }
 }
 reserve(plan,{desired,decisionId}){
  const core=this.core,actual=core.readActual(),bot=actual.bots.find(b=>b.botId===plan.target.botId)
  if(plan.action==='continue_binding'){
   const action=this.ledger.get(plan.actionId)
   if(!core.lifecycle.valid(action?.actionId)||this.jobs.has(action.actionId))throw new Error('ACTIVE_CONFLICTING_ACTION')
   return {action,reused:true,continuation:true}
  }
  const type=plan.action==='generate_accounts'?'GENERATE':plan.action==='replace_account'?'REPLACE':['stop_analyst','stop_bot'].includes(plan.action)?'STOP':plan.action==='release'?'ASSIGN':'START'
  if(core.lifecycle&&['START','STOP','REPLACE'].includes(type)){
   const blocker=core.lifecycle.permission(bot,type==='STOP'?'stop_bot':plan.action)
   if(blocker)throw new Error(blocker)
  }
  let accountId=type==='REPLACE'?null:bot?.accountId??null
  if((type==='START'&&accountId==null)||type==='REPLACE')accountId=actual.observation.accounts.find(a=>a.eligible&&!a.assigned&&!a.reserved&&!a.replacementPending)?.accountId??null
  if(type==='START'&&accountId==null)throw new Error('ACCOUNT_UNAVAILABLE')
  const replacement=actual.observation.pending.replacements.rows.find(r=>r.botId===bot?.botId)
  if(type==='REPLACE'&&replacement?.replacementAccountId!=null&&actual.observation.accounts.some(a=>a.accountId===replacement.replacementAccountId&&a.eligible))accountId=replacement.replacementAccountId
  const generation=type==='GENERATE'||type==='REPLACE'&&accountId==null
  let quantity=type==='GENERATE'?plan.after.requested:1
  if(type==='GENERATE'){
   quantity=Math.min(quantity,this.accounting(actual,desired).accounts.uncovered)
   if(!quantity)throw new Error('ACCOUNT_CAPACITY_CHANGED')
   plan.after={...plan.after,requested:quantity}
  }
  const logicalKey=type==='GENERATE'?'generation:reserve':'bot:'+bot.botId
  const result=this.ledger.reserve({type,logicalKey,botId:bot?.botId??null,accountId,role:plan.after.type??bot?.task.type??null,quantity,
   policyRevision:core.store.operationsPolicy().revision,desiredRevision:desired.revision,inputRevision:core.store.revision(),decisionId,
   deadlineAt:Date.now()+(core.lifecycle&&['stop_bot','recover_bot'].includes(plan.action)?Math.max(1000,core.store.operationsPolicy().transitions.gracefulStopTimeoutMs):0)+core.store.runtimeSettings().actionTimeoutMs,metadata:{generation,operation:plan.action,itemId:plan.after.itemId??null,expectedTask:['START','REPLACE'].includes(type)?Object.fromEntries(['type','itemId','buyPrice','sellPrice','enabled'].map(k=>[k,plan.after[k]??null])):null,replacementRequestId:replacement?.requestId??null}})
  if(!result.reused)core.lifecycle?.admit(result.action,plan)
  return {...result,action:this.ledger.get(result.action.actionId)}
 }
 async dispatch(a,plan,{onAssigned,valid}){
  a=this.ledger.get(a.actionId)
  if(this.closed||(!['DISPATCHED','RUNNING'].includes(a.state)&&a.state!=='RESERVED')||!valid()||!a.metadata.manual&&a.policyRevision!==this.core.store.operationsPolicy().revision){this.ledger.transition(a.actionId,'CANCELLED','STALE_REVISION');return}
  if(this.jobs.has(a.actionId))return
  if(a.state==='RESERVED')this.ledger.transition(a.actionId,'DISPATCHED')
  const guard=()=>!this.closed&&valid()&&['DISPATCHED','RUNNING'].includes(this.ledger.get(a.actionId)?.state)&&Date.now()<a.deadlineAt
  const finish=(state,reason=null,patch={})=>{
   if(this.closed)return
   this.ledger.transition(a.actionId,state,reason,patch)
   this.core.schedule({type:'CORE_ACTION_CHANGED',source:'action',details:{actionId:a.actionId}})
  }
  const timer=setTimeout(()=>{finish('EXPIRED','ACTION_TIMEOUT');this.jobs.delete(a.actionId)},Math.max(1,a.deadlineAt-Date.now()));timer.unref?.()
  const work=Promise.resolve().then(()=>{
   if(!guard())throw new Error('STALE_REVISION')
   return this.core.reconciler.apply(plan,{valid:guard,onAssigned,decisionId:a.decisionId,actionId:a.actionId})
  }).then(result=>{
   if(this.closed)return
   const current=this.ledger.get(a.actionId);if(!current||!['DISPATCHED','RUNNING'].includes(current.state))return
   if(a.type==='GENERATE'){
    const ids=result?.accounts?.map(v=>v.accountId)??[]
    // Production generator commits correlation in its transaction. Result count
    // is retained for legacy injected executors, never used to replay a request.
    finish('COMPLETED',null,{created:result?.count??ids.length})
   }else if(a.type==='ASSIGN')finish('COMPLETED')
   else{
    const bot=this.core.botManager.getBot(a.botId)
    const replacement=a.type==='REPLACE'?this.core.replacements.rows().find(r=>r.botId===a.botId&&!['completed','cancelled'].includes(r.state)):null
    finish('RUNNING',null,{metadata:{incarnationId:bot?.incarnationId??null,...(replacement?{replacementRequestId:replacement.requestId}:{})}})
   }
  }).catch(error=>{
   const safe=new Set(['STALE_REVISION','USER_BOT_HOLD','TASK_CHANGED_BY_USER','SAFE_TRANSITION_UNAVAILABLE','ACCOUNT_UNAVAILABLE','BOT_START_REJECTED','ACCOUNT_GENERATION_FAILED','ACCOUNT_TOTAL_LIMIT_REACHED','ACCOUNT_PENDING_LIMIT_REACHED','AUTOMATIC_ACCOUNT_GENERATION_DISABLED','CORE_DISABLED','MAINTENANCE_MODE','ACCOUNT_CAPACITY_CHANGED'])
   for(const code of ['GRACEFUL_STOP_TIMEOUT','PROCESS_STOP_TIMEOUT','STOP_TRANSPORT_UNAVAILABLE','STOP_SUPERSEDED','INVALID_STOP_EVIDENCE','UNSAFE_STOP','TRANSACTION_RESULT_UNCERTAIN','PURCHASE_RESULT_UNCERTAIN','SELL_RESULT_UNCERTAIN','RELIST_RESULT_UNCERTAIN','SERVER_ACTION_RESULT_UNCERTAIN','LIFECYCLE_OWNERSHIP_REQUIRED','NO_ELIGIBLE_PROXY','PROXY_CAPACITY_EXHAUSTED','PROXY_OWNERSHIP_UNRESOLVED'])safe.add(code)
   const code=safe.has(error?.message)?error.message:'EXECUTION_FAILED'
   finish(['STALE_REVISION','USER_BOT_HOLD'].includes(code)?'CANCELLED':'FAILED',code)
  }).finally(()=>{clearTimeout(timer);this.jobs.delete(a.actionId)})
  this.jobs.set(a.actionId,{timer,work})
  // Give synchronous/local acceptance a turn, but never await lifecycle completion.
  let yieldTimer
  await Promise.race([work,new Promise(resolve=>{yieldTimer=setTimeout(resolve,10)})]);clearTimeout(yieldTimer)
 }
 stop(){this.closed=true;for(const job of this.jobs.values())clearTimeout(job.timer);this.jobs.clear()}
}
