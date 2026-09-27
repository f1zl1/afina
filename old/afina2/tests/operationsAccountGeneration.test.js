import test from 'node:test'
import assert from 'node:assert/strict'
import CoreReconciler from '../src/core/coreReconciler.js'

const actual=({ready=0,total=0,running=0,starting=0}={})=>({
    roles:{reseller:running,analyst:0},accounts:{available:ready,total},
    bots:Array.from({length:starting},(_,i)=>({botId:i+1,role:null,desiredState:'running',supervisorStatus:'starting'}))
})
const desired=count=>({roles:{reseller:count,analyst:0}})
const operations=(reserve={})=>({automationActive:true,maintenanceMode:false,reserve:{targetReadyAccounts:0,automaticAccountGeneration:true,maximumTotalAccounts:20,maximumPendingAccountGeneration:2,...reserve}})
const planner=state=>new CoreReconciler({accountGeneration:state,executeCommand:async()=>({ok:true,data:{count:1}})})

test('workload generation is independent of a zero reserve and existing accounts are consumed first',()=>{
    const state={available:true,pending:0,retryAt:null},reconciler=planner(state)
    const action=reconciler.planAccountGeneration({desired:desired(5),actual:actual(),operations:operations(),accountGeneration:state,now:1})
    assert.equal(action.result,'planned');assert.equal(action.after.requested,2)
    assert.equal(action.before.workCapacityDeficit,5);assert.equal(action.before.reserveDeficit,0)
    assert.equal(reconciler.planAccountGeneration({desired:desired(2),actual:actual({ready:2,total:2}),operations:operations(),accountGeneration:state,now:1}),null)
})

test('pending reservations prevent generation storms and count against total limits',()=>{
    const state={available:true,pending:2,retryAt:null},reconciler=planner(state)
    let action=reconciler.planAccountGeneration({desired:desired(10),actual:actual({total:17}),operations:operations({maximumTotalAccounts:20}),accountGeneration:state,now:1})
    assert.equal(action.result,'blocked');assert.equal(action.reasons.at(-1).code,'ACCOUNT_PENDING_LIMIT_REACHED')
    state.pending=1
    action=reconciler.planAccountGeneration({desired:desired(10),actual:actual({total:18}),operations:operations({maximumTotalAccounts:20}),accountGeneration:state,now:1})
    assert.equal(action.after.requested,1)
})

test('zero total limit has explicit prohibited semantics and failures release pending state',async()=>{
    const state={available:true,pending:0,retryAt:null},reconciler=planner(state)
    const blocked=reconciler.planAccountGeneration({desired:desired(1),actual:actual(),operations:operations({maximumTotalAccounts:0}),accountGeneration:state,now:1})
    assert.equal(blocked.reasons.at(-1).code,'ACCOUNT_TOTAL_LIMIT_REACHED')
    reconciler.executeCommand=async()=>({ok:false,error:{code:'FAILED'}})
    const action=reconciler.planAccountGeneration({desired:desired(1),actual:actual(),operations:operations({maximumPendingAccountGeneration:1}),accountGeneration:state,now:1})
    await assert.rejects(()=>reconciler.apply(action,{valid:()=>true}),/ACCOUNT_GENERATION_FAILED/)
    assert.equal(state.pending,0);assert.equal(state.state,'failed')
})

test('generation command receives a revision guard and reserves before asynchronous execution',async()=>{
    const state={available:true,pending:0,retryAt:null};let release,observed
    const reconciler=new CoreReconciler({accountGeneration:state,executeCommand:({executionGuard})=>new Promise(resolve=>{observed={pending:state.pending,executionGuard};release=()=>resolve({ok:true,data:{count:1}})} )})
    const action=reconciler.planAccountGeneration({desired:desired(3),actual:actual(),operations:operations({maximumPendingAccountGeneration:1}),accountGeneration:state,now:1})
    const applying=reconciler.apply(action,{valid:()=>true})
    assert.equal(observed.pending,1);assert.equal(typeof observed.executionGuard,'function')
    const repeated=reconciler.planAccountGeneration({desired:desired(3),actual:actual(),operations:operations({maximumPendingAccountGeneration:1}),accountGeneration:state,now:1})
    assert.equal(repeated.reasons.at(-1).code,'ACCOUNT_PENDING_LIMIT_REACHED')
    release();await applying;assert.equal(state.pending,0)
})
