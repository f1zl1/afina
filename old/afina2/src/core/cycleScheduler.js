import {performance} from 'node:perf_hooks'

const rank={stop_bot:0,stop_analyst:0,recover_bot:1,replace_account:1,assign_analyst:2,assign:2,release:3,generate_accounts:4}
const key=a=>`${String(a.target?.botId??0).padStart(16,'0')}:${String(a.target?.itemId??0).padStart(16,'0')}:${a.action}`
const role=a=>a.after?.type??(a.action.includes('analyst')?'analyst':a.action==='generate_accounts'?'accounts':'reseller')
const group=a=>`${rank[a.action]??9}:${role(a)}:${a.action}`
const compare=(a,b)=>a<b?-1:a>b?1:0

// Ephemeral admission only. This class never owns operational work or calls an executor.
export default class CycleScheduler{
 constructor(){this.sequence=0;this.attempts=new Map();this.botTurns=new Map();this.turn=0;this.botCursor=0;this.itemCursor=0;this.credit=0}
 begin(limits,batch){
  if(batch.some(t=>!['CORE_CONTINUATION','CORE_ACTION_CHANGED'].includes(t.type)))this.credit=Math.max(this.credit,1)
  const start=performance.now(),summary={cycleId:++this.sequence,startedAt:Date.now(),endedAt:null,durationMs:0,stage:'OBSERVE',outcome:'running',candidatesConsidered:0,selected:0,reserved:0,dispatched:0,deferred:0,blocked:0,conflicts:0,failures:[],budgetReason:null,coalescedTriggers:batch.length,continuationRequested:false,limits:{...limits}}
  let lastYield=start
  return {summary,remaining:()=>Math.max(0,limits.cycleBudgetMs-(performance.now()-start)),
   checkpoint:async stage=>{
    summary.stage=stage
    if(performance.now()-lastYield>=limits.yieldBudgetMs){await new Promise(resolve=>setImmediate(resolve));lastYield=performance.now()}
    if(performance.now()-start>=limits.cycleBudgetMs){summary.budgetReason='CYCLE_TIME_BUDGET';summary.outcome='deferred';return false}
    return true
   },finish:()=>{summary.endedAt=Date.now();summary.durationMs=performance.now()-start;if(summary.outcome==='running')summary.outcome=summary.budgetReason?'deferred':summary.failures.length?'partial':'completed';return summary}}
 }
 window(actual,limit,batch,maxActions=limit){
  const pick=(values,cursor)=>{const ids=[...new Set(values)].sort((a,b)=>a-b);let index=ids.findIndex(id=>id>cursor);if(index<0)index=0;const selected=Array.from({length:Math.min(limit,ids.length)},(_,i)=>ids[(index+i)%ids.length]);return {ids:new Set(selected),cursor:selected.at(-1)??cursor,total:ids.length}}
  const bots=pick(actual.bots.map(b=>b.botId),this.botCursor),items=pick(actual.items.map(i=>i.itemId),this.itemCursor)
  this.botCursor=bots.cursor;this.itemCursor=items.cursor
  if(batch.some(t=>!['CORE_CONTINUATION','CORE_ACTION_CHANGED'].includes(t.type)))this.credit=Math.max(1,Math.ceil(Math.max(bots.total,items.total)/limit)+Math.ceil(bots.total/Math.max(1,maxActions)))
  return {botIds:bots.ids,itemIds:items.ids,botTurns:new Map(this.botTurns),unvisited:Math.max(0,bots.total-bots.ids.size)+Math.max(0,items.total-items.ids.size)}
 }
 select(candidates,limits,operations){
  const groups=new Map()
  for(const candidate of candidates.filter(a=>a.result==='planned')){const id=group(candidate);if(!this.attempts.has(id+key(candidate)))this.attempts.set(id+key(candidate),this.turn);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(candidate)}
  const ids=[...groups.keys()].sort((a,b)=>Number(a.split(':')[0])-Number(b.split(':')[0])||(operations.roles[b.split(':')[1]]?.priority??0)-(operations.roles[a.split(':')[1]]?.priority??0)||compare(a,b))
  for(const values of groups.values())values.sort((a,b)=>(this.attempts.get(group(a)+key(a))??0)-(this.attempts.get(group(b)+key(b))??0)||compare(key(a),key(b)))
  // Age groups by their oldest eligible member. A global group cursor can
  // phase-lock with rotating inventory windows and starve half their roles.
  ids.sort((a,b)=>(this.attempts.get(a+key(groups.get(a)[0]))??0)-(this.attempts.get(b+key(groups.get(b)[0]))??0))
  const admitted=[]
  while(admitted.length<limits.maxCandidatesPerCycle&&[...groups.values()].some(v=>v.length)){
   for(let i=0;i<ids.length&&admitted.length<limits.maxCandidatesPerCycle;i++){
    const id=ids[i],candidate=groups.get(id).shift();if(!candidate)continue
    admitted.push(candidate)
   }
  }
  const selected=admitted.slice(0,limits.maxActionsPerCycle)
  for(const candidate of selected){this.attempts.set(group(candidate)+key(candidate),++this.turn);if(candidate.target?.botId!=null)this.botTurns.set(candidate.target.botId,this.turn)}
  const diagnostics=candidates.filter(a=>a.result!=='planned').sort((a,b)=>compare(key(a),key(b))).slice(0,Math.max(0,limits.maxCandidatesPerCycle-admitted.length))
  return {selected,diagnostics,considered:admitted.length+diagnostics.length,deferred:candidates.filter(a=>a.result==='planned').length-selected.length,blocked:candidates.filter(a=>a.result==='blocked').length}
 }
 continuation(summary,unvisited){
  if(summary.reserved>0)this.credit=Math.max(this.credit,1)
  const needed=summary.deferred>0||unvisited>0||summary.failures?.length>0||summary.budgetReason==='CYCLE_TIME_BUDGET'
  if(!needed||this.credit<=0)return false
  this.credit--;return true
 }
}
