import {failureKind} from '../workloads/workloadContract.js'

// A gate/adapter, not another queue. analysisSessions own durable Analyst work;
// worker facts own live execution evidence. No bot/account reservation is added.
export default class WorkloadCoordinator{
 constructor({actual,actions,epoch,send,sessions,requestRecovery,requireEvidence=false}){Object.assign(this,{actual,actions,epoch,send,sessions,requestRecovery,requireEvidence})}
 eligible(bot,type='analysis'){
  if(!['analysis','manual_economic'].includes(type))return 'UNSUPPORTED_WORKLOAD_TYPE'
  if(!bot?.workReady||bot.activeTask.type!==(type==='analysis'?'analyst':'reseller')||bot.desiredState!=='running')return 'WORKER_NOT_READY'
  if(bot.manualHold||bot.lifecycle?.owner==='manual')return 'MANUAL_OWNERSHIP'
  if(bot.lifecycle?.intent==='stopped'||bot.lifecycle?.requestReason||bot.replacementPending||bot.externalTransition||bot.configurationStale)return 'LIFECYCLE_OWNED'
  if(this.actions().some(a=>a.botId===bot.botId))return 'LIFECYCLE_OWNED'
  if(this.requireEvidence&&(!bot.workload||bot.workload.incarnationId!==bot.incarnationId))return 'WORKLOAD_BOUNDARY_UNAVAILABLE'
  if(bot.workload?.draining||bot.workload?.uncertain)return 'WORKLOAD_DRAINING'
  if(type==='manual_economic'&&(!bot.workload?.manualEconomicSupported||!Number.isSafeInteger(bot.workload.generation)))return 'WORKLOAD_BOUNDARY_UNAVAILABLE'
  return null
 }
 dispatch(botId,task,type='analysis'){
  const bot=this.actual().bots.find(b=>b.botId===botId),blocked=this.eligible(bot,type)
  if(blocked)return {accepted:false,reason:blocked}
  if(task.incarnationId!==bot.incarnationId||task.lifecycleEpoch!==this.epoch(botId)||(task.workloadGeneration!=null&&task.workloadGeneration!==bot.workload?.generation))return {accepted:false,reason:'STALE_WORKLOAD_OWNER'}
  if(type==='manual_economic'){
   const admitted=this.economic?.(task.workloadId)
   if(!admitted||admitted.status!=='ADMITTED'||admitted.botId!==botId||admitted.incarnationId!==task.incarnationId||admitted.lifecycleEpoch!==task.lifecycleEpoch||admitted.workloadGeneration!==task.workloadGeneration)return {accepted:false,reason:'MANUAL_ADMISSION_REQUIRED'}
   if(['STARTING','RUNNING','DRAINING'].includes(bot.workload.state))return {accepted:false,reason:'WORKLOAD_BUSY'}
   return {accepted:this.send(botId,'core:economic.assign',admitted)===true,reason:null}
  }
  if(this.sessions().some(s=>s.botId===botId&&s.analysisId!==task.analysisId))return {accepted:false,reason:'WORKLOAD_BUSY'}
  return {accepted:this.send(botId,'core:analysis.assign',task)===true,reason:null}
 }
 owns(session,bot){
  const task=typeof session.task==='string'?JSON.parse(session.task):session.task
  return Boolean(bot)&&task.incarnationId===bot.incarnationId&&(task.lifecycleEpoch??0)===this.epoch(bot.botId)&&(task.workloadGeneration==null||task.workloadGeneration===bot.workload?.generation)
 }
 current(session,bot){return !this.eligible(bot)&&this.owns(session,bot)}
 cancel(session){
  const task=typeof session.task==='string'?JSON.parse(session.task):session.task,bot=this.actual().bots.find(b=>b.botId===session.botId)
  if(task.incarnationId===bot?.incarnationId)this.send(session.botId,'core:analysis.cancel',{analysisId:session.analysisId,incarnationId:task.incarnationId,workloadGeneration:task.workloadGeneration})
 }
 runtimeFailure(botId,incarnationId){
  const actual=this.actual(),bot=actual.bots.find(b=>b.botId===botId)
  if(!bot||bot.incarnationId!==incarnationId||bot.manualHold)return false
  const worker=actual.observation.workers.find(w=>w.botId===botId)
  const missing=bot.observationQuality==='PROCESS_MISSING',failed=bot.observationQuality==='FRESH'&&worker?.facts?.health.alive===false
  return (missing||failed)?this.requestRecovery(botId,missing?'worker_crash':'fatal_error',incarnationId):false
 }
 snapshot(actual){
  const sessions=this.sessions()
  return actual.bots.map(bot=>{
   const session=sessions.find(s=>s.botId===bot.botId),worker=bot.workload
   const valid=worker&&worker.incarnationId===bot.incarnationId&&bot.observationQuality==='FRESH'&&(!session||session.analysisId===worker.workloadId)
   return {botId:bot.botId,role:bot.activeTask.type,type:session?'analysis':valid?worker.type:null,workloadId:session?.analysisId??(valid?worker.workloadId:null),
    owner:session?'core':valid?worker.owner:null,incarnationId:bot.incarnationId,state:valid?worker.state:session?'STARTING':'UNCERTAIN',
    startedAt:session?.startedAt??(valid?worker.startedAt:null),updatedAt:valid?worker.updatedAt:null,draining:valid?worker.draining:false,
    safe:valid?worker.safe:false,uncertain:!valid||worker.uncertain,reason:session?.failureCode??(valid?worker.reason:null)??this.eligible(bot,bot.activeTask.type==='reseller'?'manual_economic':'analysis')??(valid?null:'WORKLOAD_OBSERVATION_UNAVAILABLE'),
    failureKind:session?.failureCode?failureKind(session.failureCode):valid?worker.failureKind:null,operation:valid?worker.operation:null,source:valid?'worker_facts':session?'analysis_session':'observation'}
  })
 }
}
