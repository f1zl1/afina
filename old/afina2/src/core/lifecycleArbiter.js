import LifecycleState from './lifecycleState.js'

const active=a=>a&&['RESERVED','DISPATCHED','RUNNING'].includes(a.state)
const reason=code=>({code,message:'Перехід життєвого циклу очікує дозволу або підтвердження.',data:{}})

// Permission/ownership only. BotManager retains process and IPC mechanics.
export default class LifecycleArbiter{
 constructor(core){
  this.core=core;this.manager=core.botManager;this.ledger=core.actions.ledger;this.state=new LifecycleState(core.store.store);this.closed=false
  this.ledger.onTransition=(a,state,code)=>this.terminal(a,state,code)
  this.ledger.onReserve=a=>this.admit(a,{action:a.metadata.operation??a.type},{inTransaction:true})
  this.manager.installLifecycle(this)
 }
 owned(botId){return this.ledger.active().find(a=>a.botId===Number(botId))??null}
 signal(){this.core.schedule({type:'LIFECYCLE_CHANGED',source:'lifecycle'})}
 manualHold(botId){
  const row=this.state.get(botId)
  if(!this.manager.hasBot(botId))return
  this.state.update(botId,{owner:'manual',epoch:(row?.epoch??0)+1,requestReason:null,requestIncarnation:null,requestAt:null,blockedReason:'MANUAL_OWNERSHIP'})
  this.manager.cancelLifecycleMechanics(botId)
 }
 release(botId){const row=this.state.get(botId);if(row)this.state.update(botId,{owner:'core',blockedReason:null});this.signal()}
 safetyStop(botId,code){this.ledger.cancelBot(botId);const row=this.state.get(botId);this.state.update(botId,{intent:'stopped',epoch:(row?.epoch??0)+1,requestReason:null,blockedReason:code});this.manager.cancelLifecycleMechanics(botId)}
 request(botId,requestReason,incarnationId=null){
  if(this.closed||!this.manager.hasBot(botId))return false
  const row=this.state.get(botId),bot=this.manager.getBot(botId)
  if(incarnationId&&bot?.incarnationId!==incarnationId)return false
  if(row?.intent==='stopped'||(!row&&bot?.desiredState!=='running'))return false
  if(row?.requestReason==='binding'&&this.owned(botId)?.metadata.bindingRequested&&requestReason!=='binding')return true
  if(row?.requestReason===requestReason&&row.requestIncarnation===incarnationId)return true
  const action=this.owned(botId)
  this.state.store.transaction(()=>{
   this.state.update(botId,{intent:'running',requestReason,requestIncarnation:incarnationId,requestAt:Date.now()})
   if(requestReason==='binding'&&action&&['START','REPLACE'].includes(action.type))this.ledger.annotate(action.actionId,{bindingRequested:true},{inTransaction:true})
  })
  this.core.eventBus.publish('core.lifecycle.changed',{botId,actionId:action?.actionId??null,state:action?'request_deferred':'recovery_requested',reason:requestReason})
  this.signal();return true
 }
 permission(bot,operation,now=Date.now(),manual=false,view=null){
  if(this.closed)return 'APPLICATION_STOPPING'
  if(manual)return null
  const p=view?.policy??this.core.effectiveOperations(),row=view?bot.lifecycle:this.state.get(bot.botId)
  if(bot.manualHold||(!view&&this.core.store.control().some(c=>c.botId===bot.botId&&c.manualHold))||row?.owner==='manual')return 'MANUAL_OWNERSHIP'
  const stop=operation==='stop_bot'
  if(!(stop?p.permissions.mayStopManaged:operation==='replace_account'?p.permissions.mayReplace:p.permissions.mayStart))return p.maintenanceMode?'MAINTENANCE_MODE':'CORE_DISABLED'
  if(!stop&&operation==='recover_bot'){
   if(bot.task.type==='reseller'&&!p.autonomousTradingEnabled)return 'TRADING_EXECUTION_DISABLED'
   const cause=row?.requestReason??'unexpected_stop',r=p.recovery
   if(['disconnect','kicked'].includes(cause)?!r.restartOnDisconnect:['worker_crash','startup_error','fatal_error','heartbeat_timeout'].includes(cause)?!r.restartOnCrash:!r.restartOnUnexpectedStop)return 'RECOVERY_DISABLED'
   if((row?.failures??0)>r.maximumRestartAttempts)return 'RECOVERY_EXHAUSTED'
  }
  if(row?.retryAt>now)return 'RECOVERY_BACKOFF'
  if(operation==='recover_bot'&&bot.running){
   const actions=view?.actions??this.ledger.active(),rows=view?.rows??this.state.rows(),t=p.transitions
   const stopping=actions.filter(a=>a.type==='STOP'||['recover_bot','continue_binding'].includes(a.metadata.operation)&&a.metadata.phase!=='starting')
   if(stopping.length>=t.maximumConcurrentStops)return 'TRANSITION_CONCURRENCY'
   if(Math.max(0,...rows.map(s=>s.lastStopAt??0),...stopping.map(a=>a.createdAt))+t.stopIntervalMs>now)return 'TRANSITION_SPACING'
  }
  const t=p.transitions,kind=stop?'STOP':'START',inFlight=(view?.actions??this.ledger.active()).filter(a=>kind==='STOP'?a.type==='STOP':['START','REPLACE'].includes(a.type))
  if(inFlight.length>=(stop?t.maximumConcurrentStops:t.maximumConcurrentStarts))return 'TRANSITION_CONCURRENCY'
  const timestamp=stop?'lastStopAt':'lastStartAt',latest=Math.max(0,...(view?.rows??this.state.rows()).map(s=>s[timestamp]??0),...inFlight.map(a=>a.createdAt))
  if(latest+(stop?t.stopIntervalMs:t.startIntervalMs)>now)return 'TRANSITION_SPACING'
  if(operation!=='recover_bot'){
   const last=stop?row?.lastStartAt:row?.lastStopAt,minimum=stop?p.stability.minimumBotRuntimeMs:p.stability.minimumBotDowntimeMs
   if(last&&last+minimum>now)return 'MINIMUM_LIFETIME'
  }
  return null
 }
 plan({actual,policy,admission,now}){
  const actions=[],owned=new Set((actual.observation.actions??[]).map(a=>a.botId)),chosen={}
  const stopIds=new Set()
  for(const [role,r] of Object.entries(policy.operations.roles)){
   const running=actual.bots.filter(b=>b.activeTask.type===role&&(b.running||b.desiredState==='running')).sort((a,b)=>a.botId-b.botId)
   for(const b of running.slice(r.target))stopIds.add(b.botId)
  }
  for(const bot of [...actual.bots].sort((a,b)=>(admission?.botTurns?.get(a.botId)??0)-(admission?.botTurns?.get(b.botId)??0)||a.botId-b.botId)){
   if(admission&&!admission.botIds.has(bot.botId)||bot.banned||bot.operationalBlock)continue
   const row=bot.lifecycle
   const current=(actual.observation.actions??[]).find(a=>a.botId===bot.botId)
   if(current&&row?.requestReason==='binding'&&row.requestIncarnation===bot.incarnationId&&['START','REPLACE'].includes(current.type)&&current.metadata.phase==='starting'){
    actions.push({action:'continue_binding',target:{botId:bot.botId},before:bot.task,after:bot.task,result:'planned',actionId:current.actionId,reasons:[reason('BINDING_RESTART_REQUESTED')],constraintsApplied:[],alternatives:[]});continue
   }
   if(owned.has(bot.botId)||bot.manualHold)continue
   let operation=null
   if(stopIds.has(bot.botId)&&bot.running)operation='stop_bot'
   else if(row?.intent==='running'&&row.requestReason){
    const role=bot.task.type,target=policy.operations.roles[role]?.target??0
    const covered=(actual.roles[role]??0)+(actual.accounting?.roles[role]?.actionCovered??0)+(chosen[role]??0)
    if(target<=0||(!bot.running&&covered>=target))continue
    operation='recover_bot'
   }
   if(!operation)continue
   const blocker=this.permission(bot,operation,now,false,{policy:policy.operations,actions:actual.observation.actions??[],rows:actual.observation.lifecycle??[]})
   actions.push({action:operation,target:{botId:bot.botId,itemId:bot.task.itemId},before:bot.task,after:{...bot.task,type:bot.task.type},result:blocker?'blocked':'planned',reasons:[reason(blocker??(operation==='stop_bot'?'GRACEFUL_STOP_REQUESTED':'RECOVERY_REQUESTED'))],constraintsApplied:[],alternatives:[]})
   if(!blocker&&operation==='recover_bot'&&!bot.workReady)chosen[bot.task.type]=(chosen[bot.task.type]??0)+1
  }
  return actions
 }
 admit(a,plan,{inTransaction=false}={}){
  if(!['START','STOP','REPLACE'].includes(a.type)||a.metadata.imported)return
  if(a.metadata.lifecycle)return
  const row=this.state.get(a.botId),stop=a.type==='STOP'
  this.state.update(a.botId,{intent:stop?'stopped':'running',owner:a.metadata.manual?'manual':row?.owner??'core',requestReason:stop?null:row?.requestReason??null})
  this.ledger.annotate(a.actionId,{lifecycle:true,epoch:row?.epoch??0,phase:'reserved',originIncarnation:this.manager.getBot(a.botId)?.incarnationId??null,operation:plan.action},{inTransaction})
 }
 valid(actionId){
  const a=this.ledger.get(actionId),row=a&&this.state.get(a.botId)
  if(this.closed||!active(a)||a.deadlineAt<=Date.now()||row?.epoch!==a.metadata.epoch)return false
  const owner=this.core.store.store.prepare('SELECT actionId FROM coreActionResources WHERE resourceKey=?').get('bot:'+a.botId)
  if(owner?.actionId!==actionId)return false
  if(a.metadata.manual)return true
  const p=this.core.effectiveOperations()
  return a.policyRevision===this.core.store.operationsPolicy().revision&&!this.core.store.control().some(c=>c.botId===a.botId&&c.manualHold)&&(a.type==='STOP'?p.permissions.mayStopManaged:a.type==='REPLACE'?p.permissions.mayReplace:p.permissions.mayStart)
 }
 authorize(botId,actionId,operation){
  const a=this.ledger.get(actionId)
  if(!this.valid(actionId)||a.botId!==Number(botId)||operation==='start'&&!['START','REPLACE'].includes(a.type)||operation==='stop'&&!['START','STOP','REPLACE'].includes(a.type))throw new Error('LIFECYCLE_OWNERSHIP_REQUIRED')
  return a
 }
 beforeSpawn(botId,actionId,incarnationId){
  this.authorize(botId,actionId,'start')
  const proxy=this.core.proxies.reserve({botId,actionId,incarnationId})
  try{this.state.store.transaction(()=>{
   this.ledger.annotate(actionId,{incarnationId,phase:'starting',spawnIssued:true,bindingRequested:false},{inTransaction:true})
   this.state.update(botId,{lastStartAt:Date.now(),stableSince:null,requestReason:null,requestIncarnation:null,requestAt:null,blockedReason:null})
  })}catch(error){this.core.proxies.release(incarnationId,'SPAWN_NOT_ISSUED');throw error}
  return proxy
 }
 evidence(actionId,evidence){
  if(!this.valid(actionId))return
  this.ledger.annotate(actionId,{stopEvidence:evidence,phase:evidence.safe?'safe_to_stop':'quiescing'})
  this.core.eventBus.publish('core.lifecycle.changed',{actionId,botId:this.ledger.get(actionId).botId,state:evidence.state,reason:evidence.reason})
 }
 exited(bot,exit){
  if(this.closed)return
  const a=this.owned(bot.botId)
  if(a?.metadata.lifecycle&&a.metadata.incarnationId&&a.metadata.incarnationId!==bot.incarnationId)return
  this.state.update(bot.botId,{lastStopAt:Date.now(),stableSince:null})
  if(a&&['quiescing','safe_to_stop'].includes(a.metadata.phase)&&['START','REPLACE'].includes(a.type)){this.ledger.annotate(a.actionId,{phase:'stopped',spawnIssued:false});this.signal();return}
  if(a?.type==='STOP')this.ledger.transition(a.actionId,'COMPLETED')
  else if(a?.metadata.lifecycle){this.state.update(bot.botId,{requestReason:exit.reason,requestIncarnation:bot.incarnationId,requestAt:Date.now()});this.ledger.transition(a.actionId,'FAILED','WORKER_EXITED')}
  else{
   const row=this.state.get(bot.botId)
   if(row?.intent==='running'){
    this.failure(bot.botId,exit.reason)
    this.request(bot.botId,exit.reason,bot.incarnationId)
   }
  }
  this.signal()
 }
 failure(botId,code){
  const row=this.state.get(botId),r=this.core.store.operationsPolicy().recovery,failures=(row?.failures??0)+1
  this.state.update(botId,{failures,lastFailureAt:Date.now(),stableSince:null,retryAt:Date.now()+Math.min(r.restartDelayMaxMs,r.restartDelayMinMs*2**Math.min(failures-1,20)),blockedReason:failures>r.maximumRestartAttempts?'RECOVERY_EXHAUSTED':code,...(row?.intent==='running'&&!row.requestReason?{requestReason:'unexpected_stop',requestAt:Date.now()}: {})})
 }
 terminal(a,state,code){
  if(!a.metadata.lifecycle)return
  if(['FAILED','EXPIRED'].includes(state))this.failure(a.botId,code??'LIFECYCLE_FAILED')
  if(a.type==='STOP'&&state==='COMPLETED')this.state.update(a.botId,{intent:'stopped',lastStopAt:Date.now(),requestReason:null,blockedReason:null})
 }
 account(actual,startup=false){
  for(const a of this.ledger.active().filter(a=>a.metadata.lifecycle)){
   const b=actual.bots.find(b=>b.botId===a.botId)
   if(a.type!=='STOP'&&b?.observationQuality==='PROCESS_MISSING'&&(startup&&a.state!=='RESERVED'||a.metadata.spawnIssued&&!this.core.actions.jobs.has(a.actionId)))this.ledger.transition(a.actionId,'FAILED','INTERRUPTED_LIFECYCLE')
  }
  for(const b of actual.bots){
   const row=this.state.get(b.botId);if(!row)continue
   if(b.workReady){
    if(row.stableSince==null)this.state.update(b.botId,{stableSince:Date.now()})
    else if(Date.now()-row.stableSince>=60000&&(row.failures||row.retryAt))this.state.update(b.botId,{failures:0,retryAt:null,lastFailureAt:null,blockedReason:null})
   }else if(row.stableSince!=null)this.state.update(b.botId,{stableSince:null})
   if(startup&&row.intent==='running'&&!b.running&&!this.owned(b.botId)&&!row.requestReason)this.request(b.botId,'unexpected_stop')
  }
 }
 async execute(plan,{actionId,valid}){
  const a=this.authorize(plan.target.botId,actionId,['stop_bot','stop_analyst','manual_stop'].includes(plan.action)?'stop':'start'),bot=this.manager.getBot(a.botId)
  const stop=a.type==='STOP',restart=['recover_bot','manual_restart','continue_binding'].includes(plan.action)||bot?.stopEvidence
  if(stop||restart&&bot?.isRunning()){
   this.ledger.annotate(actionId,{phase:'quiescing',incarnationId:bot?.incarnationId??null})
   await this.manager.stopOwned(a.botId,{actionId,valid:()=>valid()&&this.valid(actionId),force:a.metadata.force===true,deadlineAt:a.deadlineAt,quiesceDeadlineAt:Math.min(a.deadlineAt,Date.now()+this.core.store.operationsPolicy().transitions.gracefulStopTimeoutMs)})
  }
  if(stop)return
  if(!valid()||!this.valid(actionId))throw new Error('STALE_REVISION')
  const result=await this.core.reconciler.executeCommand({command:'bot.start',payload:{botId:a.botId},actor:{type:'internal',id:'lifecycle'},actionId,executionGuard:()=>{if(!valid()||!this.valid(actionId))throw new Error('STALE_REVISION')}})
  if(!result.ok)throw new Error(['NO_ELIGIBLE_PROXY','PROXY_CAPACITY_EXHAUSTED','PROXY_OWNERSHIP_UNRESOLVED'].includes(result.error?.message)?result.error.message:'BOT_START_REJECTED')
 }
 async manual(command,payload){
  const botId=Number(payload.botId)
  if(!Number.isSafeInteger(botId)||!this.manager.hasBot(botId))throw new Error('UNKNOWN_BOT')
  const operation='manual_'+command.slice(4),stop=operation==='manual_stop',p=this.core.store.operationsPolicy(),bot=this.core.readActual().bots.find(b=>b.botId===botId)
  if(operation==='manual_start'&&this.manager.getBot(botId)?.isRunning())throw new Error('BOT_ALREADY_RUNNING')
  const {action:a}=this.ledger.reserve({type:stop?'STOP':'START',logicalKey:'bot:'+botId,botId,accountId:bot.accountId,role:bot.task.type,quantity:1,policyRevision:p.revision,desiredRevision:0,inputRevision:this.core.store.revision(),deadlineAt:Date.now()+Math.max(1000,p.transitions.gracefulStopTimeoutMs)+this.core.store.runtimeSettings().actionTimeoutMs,metadata:{manual:true,force:stop&&payload.force===true}})
  const plan={action:operation,target:{botId},before:bot.task,after:bot.task}
  this.admit(a,plan)
  await this.core.actions.dispatch(this.ledger.get(a.actionId),plan,{valid:()=>this.valid(a.actionId),onAssigned(){}})
  const result=this.ledger.get(a.actionId);if(result?.state==='FAILED')throw new Error(result.reason)
  return {botId,actionId:a.actionId,accepted:true,command}
 }
 close(){this.closed=true;this.manager.closeLifecycleAdmission()}
 snapshot(actual){
  const recent=this.ledger.recent(200)
  return actual.bots.map(b=>{
   const action=this.owned(b.botId),operation=b.lifecycle?.intent==='stopped'?'stop_bot':'recover_bot'
   const blockedReason=action?null:this.permission(b,operation)??b.lifecycle?.blockedReason??null
   const evidence=[this.manager.getBot(b.botId)?.stopEvidence,action?.metadata.stopEvidence,...recent.filter(a=>a.botId===b.botId).map(a=>a.metadata.stopEvidence)].find(e=>e&&(!b.incarnationId||e.incarnationId===b.incarnationId))??null
   return {botId:b.botId,...b.lifecycle,action,supervisorState:b.supervisorStatus,incarnationId:b.incarnationId,manualHold:b.manualHold,observationQuality:b.observationQuality,blockedReason,
    stopEvidence:evidence,
    nextTransition:action?({reserved:'Очікування передачі',quiescing:'Очікування безпечної межі',safe_to_stop:'Очікування виходу процесу',stopped:'Повторний запуск',starting:'Очікування готовності'}[action.metadata.phase]??'Очікування доказу завершення'):blockedReason?'Очікування дозволу':b.lifecycle?.requestReason?'Відновлення':'Немає запиту'}
  })
 }
}
