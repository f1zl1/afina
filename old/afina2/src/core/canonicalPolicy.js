import {defaultOperationsPolicy,defaultRolePolicy,mergeOperationsPolicy} from './operationsPolicy.js'
import {legacyOperationalFields} from './coreCapabilities.js'

const get=(value,path)=>path.split('.').reduce((v,key)=>v?.[key],value)
export function legacyPolicyProjection(operations){
    return Object.fromEntries(Object.entries(legacyOperationalFields).map(([key,path])=>[key,get(operations,path)]))
}

// Migration compatibility only. Never rebuild another role from a legacy mirror.
export function adaptLegacyPolicy(operations,values){
    const patch={},roles={}
    for(const [key,path] of Object.entries(legacyOperationalFields)){
        if(!Object.hasOwn(values,key))continue
        if(path.startsWith('roles.')){
            const id=path.split('.')[1],old=operations.roles[id],target=values[key]
            roles[id]={...old,target,maximum:Math.max(old.maximum,target)}
        }else{
            const [group,field]=path.split('.')
            if(field)(patch[group]??={})[field]=values[key]
            else patch[group]=values[key]
        }
    }
    if(Object.keys(roles).length)patch.roles=roles
    return mergeOperationsPolicy(operations,patch)
}

// Pure v8 -> canonical migration. Conflicting permissions fail closed; originals
// are retained in the migration report, not read by runtime consumers.
export function canonicalizePolicy(legacy,stored,revision){
    const configured=Object.keys(stored).length>0,diagnostics=[]
    let policy=mergeOperationsPolicy(defaultOperationsPolicy,stored)
    const conflict=(field,oldValue,newValue,resolution)=>{
        if(JSON.stringify(oldValue)!==JSON.stringify(newValue))diagnostics.push({code:'CORE_POLICY_CONFLICT',field,legacyValue:oldValue,canonicalValue:newValue,resolution,revision})
    }
    if(!configured){
        const roles={analyst:{...defaultRolePolicy(100),target:legacy.targetAnalysts,maximum:legacy.targetAnalysts},reseller:{...defaultRolePolicy(80),target:legacy.targetResellers,maximum:legacy.targetResellers}}
        policy=mergeOperationsPolicy(policy,{automationEnabled:legacy.enabled,roles,capacity:{maximum:legacy.targetAnalysts+legacy.targetResellers}})
    }else{
        conflict('automationEnabled',legacy.enabled,policy.automationEnabled,'CONFIGURED_OPERATIONS_WAS_RUNTIME_AUTHORITY')
        conflict('roles.analyst.target',legacy.targetAnalysts,policy.roles.analyst.target,'CONFIGURED_OPERATIONS_WAS_RUNTIME_AUTHORITY')
        conflict('roles.reseller.target',legacy.targetResellers,policy.roles.reseller.target,'CONFIGURED_OPERATIONS_WAS_RUNTIME_AUTHORITY')
    }
    // The Operations replacement flag was inert before Phase 1. Preserve the
    // permission actually used by AccountReplacements, never activate the inert flag.
    conflict('recovery.autoReplaceBannedAccounts',policy.recovery.autoReplaceBannedAccounts,legacy.autoReplaceBannedAccounts,'PRESERVE_EXECUTED_REPLACEMENT_PERMISSION')
    policy.recovery.autoReplaceBannedAccounts=legacy.autoReplaceBannedAccounts
    policy.allocationEnabled=legacy.autoAllocateBots
    const generationWasSplit=legacy.autoReplaceBannedAccounts||!configured
    if(generationWasSplit){
        const allowed=policy.reserve.automaticAccountGeneration&&legacy.allowAutomaticAccountGeneration
        const maximum=Math.min(policy.reserve.maximumTotalAccounts,legacy.maxAccounts)
        conflict('reserve.automaticAccountGeneration',{operations:policy.reserve.automaticAccountGeneration,replacement:legacy.allowAutomaticAccountGeneration},allowed,'CONSERVATIVE_SHARED_PERMISSION_REQUIRES_EXPLICIT_EDIT')
        conflict('reserve.maximumTotalAccounts',{operations:policy.reserve.maximumTotalAccounts,replacement:legacy.maxAccounts},maximum,'CONSERVATIVE_SHARED_LIMIT_ZERO_FORBIDS')
        policy.reserve.automaticAccountGeneration=allowed;policy.reserve.maximumTotalAccounts=maximum
    }else{
        conflict('reserve.automaticAccountGeneration',legacy.allowAutomaticAccountGeneration,policy.reserve.automaticAccountGeneration,'PRESERVE_OPERATIONS_GENERATION_REPLACEMENT_WAS_DISABLED')
        conflict('reserve.maximumTotalAccounts',legacy.maxAccounts,policy.reserve.maximumTotalAccounts,'PRESERVE_OPERATIONS_GENERATION_REPLACEMENT_WAS_DISABLED')
    }
    // Avoid meaningless fresh-install conflicts while retaining meaningful splits.
    const meaningful=diagnostics.filter(d=>typeof d.legacyValue!=='object'||Object.values(d.legacyValue).some(v=>v!==d.canonicalValue))
    return {policy:mergeOperationsPolicy(policy,{}),report:{code:'CORE_POLICY_CANONICALIZED',version:1,revision,source:configured?'operations':'legacy',diagnostics:meaningful,
        original:{operations:stored,legacy:Object.fromEntries(Object.keys(legacyOperationalFields).map(k=>[k,legacy[k]]))}}}
}

// One canonical budget calculation for both creation paths. Production callers
// supply ledger-derived pending quantities; this function does not own reservations.
export function accountGenerationAllowance(operations,{total,pending=0,requested=1}){
    const r=operations.reserve
    let blocker=null
    if(!operations.automationActive)blocker=operations.maintenanceMode?'MAINTENANCE_MODE':'CORE_DISABLED'
    else if(!r.automaticAccountGeneration)blocker='AUTOMATIC_ACCOUNT_GENERATION_DISABLED'
    else if(r.maximumTotalAccounts===0||total+pending>=r.maximumTotalAccounts)blocker='ACCOUNT_TOTAL_LIMIT_REACHED'
    else if(r.maximumPendingAccountGeneration===0||pending>=r.maximumPendingAccountGeneration)blocker='ACCOUNT_PENDING_LIMIT_REACHED'
    const count=blocker?0:Math.min(requested,Math.max(0,r.maximumTotalAccounts-total-pending),Math.max(0,r.maximumPendingAccountGeneration-pending),100)
    return {count,blocker}
}
