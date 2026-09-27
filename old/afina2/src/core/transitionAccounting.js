// Pure accounting: ready capacity, transition coverage and account supply are distinct.
export function transitionAccounting(actual,desired,operations,now=Date.now(),timeoutMs=120000){
 const actions=(actual.observation.actions??[]).filter(a=>a.deadlineAt>now)
 const claimed=new Set(actions.map(a=>a.botId).filter(id=>id!=null)),roles={}
 const external=actual.bots.filter(b=>!claimed.has(b.botId)&&!b.workReady&&!b.banned&&!b.manualHold&&!b.operationalBlock&&
  (b.desiredState==='running'||['starting','restarting'].includes(b.supervisorStatus)||b.externalTransition)&&
  b.readinessAgeMs!=null&&b.readinessAgeMs<timeoutMs)
 for(const [role,target] of Object.entries(desired.roles)){
  const ready=actual.roles[role]??0
  const pending=actions.filter(a=>a.role===role&&['START','REPLACE'].includes(a.type)&&!actual.bots.some(b=>b.botId===a.botId&&b.workReady))
  const outside=external.filter(b=>b.activeTask.type===role).length
  roles[role]={desired:target,workReady:ready,occupied:actual.bots.filter(b=>b.activeTask.type===role&&b.running).length,actionCovered:pending.length,externalTransition:outside,inProgress:pending.length+outside,stopping:actions.filter(a=>a.role===role&&a.type==='STOP').length,uncovered:Math.max(0,target-ready-pending.length-outside),overshoot:Math.max(0,ready+pending.length+outside-target)}
 }
 const generation=actions.filter(a=>a.type==='GENERATE'||a.type==='REPLACE'&&a.metadata.generation)
 const results=new Map((actual.observation.generationResults??[]).map(r=>[r.requestId,JSON.parse(r.accountIds).length]))
 const pendingGeneration=generation.reduce((n,a)=>n+Math.max(0,a.quantity-(results.get(a.actionId)??a.created)),0)
 const boundAvailable=actual.bots.filter(b=>b.accountUsable&&!b.running&&b.desiredState!=='running'&&!claimed.has(b.botId)&&!b.manualHold&&b.targetConfigured).length
 const workerDeficit=Object.values(roles).reduce((n,r)=>n+r.uncovered,0)
 // Banned/replacement workloads belong to the replacement executor, including
 // its durable failure backoff. Ordinary generation must not bypass that owner.
 const replacementOwned=Object.entries(roles).reduce((n,[role,r])=>n+Math.min(r.uncovered,actual.bots.filter(b=>b.task.type===role&&(b.banned||b.replacementPending)&&!claimed.has(b.botId)).length),0)
 const boundCoverage=Math.min(workerDeficit,boundAvailable),free=actual.accounts.available
 const replacementDemand=generation.filter(a=>a.type==='REPLACE'&&!results.has(a.actionId)&&a.accountId==null).length
 const accountDemand=Math.max(0,workerDeficit-boundCoverage-replacementOwned)+replacementDemand
 const uncovered=Math.max(0,accountDemand+operations.reserve.targetReadyAccounts-free-pendingGeneration)
 return {roles,accounts:{workerDeficit,replacementOwned,boundAvailable,boundCoverage,free,pendingGeneration,accountDemand,uncovered,reserveTarget:operations.reserve.targetReadyAccounts},active:actions.length}
}
