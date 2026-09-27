import {liveValidationDefaults} from './liveValidation.js'
import {coreCapabilities,supportedRoles} from './coreCapabilities.js'
const DAY_MS=86_400_000
export const stopModes=Object.freeze(['immediate','graceful','finishCurrentCycle'])
export const startupPolicies=Object.freeze(['restoreDesiredState','keepStopped'])

export const defaultRolePolicy=priority=>({enabled:true,minimum:0,target:0,maximum:0,priority,autoStart:true,autoReplace:true,stopMode:'graceful'})
export const defaultOperationsPolicy=Object.freeze({
    liveValidation:liveValidationDefaults,
    autonomousTradingEnabled:false,autonomousTradingMaxPurchaseValue:100000,autonomousTradingMaxConcurrentWorkloads:1,
    maximumBotsPerProxy:4,automationEnabled:false,allocationEnabled:true,maintenanceMode:false,timezone:'Europe/Oslo',startupPolicy:'restoreDesiredState',
    capacity:{minimum:0,target:0,maximum:0},roles:{analyst:defaultRolePolicy(100),reseller:defaultRolePolicy(80)},schedules:[],
    controller:{maxActionsPerCycle:8,maxCandidatesPerCycle:128,cycleBudgetMs:5000,yieldBudgetMs:10,continuationDelayMs:250,maxPassesPerDrain:2},
    transitions:{maximumConcurrentStarts:1,startIntervalMs:10_000,maximumConcurrentStops:1,stopIntervalMs:10_000,gracefulStopTimeoutMs:300_000},
    stability:{scaleUpCooldownMs:60_000,scaleDownCooldownMs:300_000,minimumBotRuntimeMs:600_000,minimumBotDowntimeMs:60_000},
    recovery:{restartOnCrash:true,restartOnDisconnect:true,restartOnUnexpectedStop:true,maximumRestartAttempts:5,restartWindowMs:600_000,restartDelayMinMs:5_000,restartDelayMaxMs:60_000,replaceUnhealthyAccounts:false,autoReplaceBannedAccounts:false},
    health:{maximumConsecutiveFailures:3,maximumCrashesPerWindow:5,crashWindowMs:600_000,maximumLoginFailures:3,maximumRealmEntryFailures:3,quarantineUnhealthyAccounts:true,quarantineDurationMs:1_800_000},
    reserve:{minimumReadyAccounts:0,targetReadyAccounts:0,automaticAccountGeneration:false,maximumTotalAccounts:0,maximumPendingAccountGeneration:1}
})
const object=value=>value && typeof value==='object' && !Array.isArray(value)
const integer=(value,name,min=0,max=1_000_000_000)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${name}: expected integer in ${min}..${max}`)}
const bool=(value,name)=>{if(typeof value!=='boolean')throw new Error(`${name}: expected boolean`)}
const capacity=(value,name)=>{if(!object(value))throw new Error(`${name}: expected object`);for(const key of ['minimum','target','maximum'])integer(value[key],`${name}.${key}`,0,1_000_000);if(value.target>value.maximum)throw new Error(`${name}.target must not exceed maximum`)}
const duration=(value,name)=>integer(value,name,0,30*DAY_MS)
const time=value=>typeof value==='string'&&/^(?:[01]\d|2[0-4]):[0-5]\d$/.test(value)&&(!value.startsWith('24:')||value==='24:00')
export function validateTimezone(zone){try{new Intl.DateTimeFormat('en',{timeZone:zone}).format()}catch{throw new Error('timezone: expected an IANA timezone')}return zone}
export function validateOperationsPolicy(value){
    if(!object(value))throw new Error('Operations policy must be an object')
    const live=value.liveValidation??liveValidationDefaults
    if(!object(live)||Object.keys(live).some(k=>!Object.hasOwn(liveValidationDefaults,k)))throw new Error('Invalid liveValidation policy')
    bool(live.enabled,'liveValidation.enabled')
    if(live.itemId!=null)integer(live.itemId,'liveValidation.itemId',1,2147483647)
    if(live.maxPurchaseCommitment!=null)integer(live.maxPurchaseCommitment,'liveValidation.maxPurchaseCommitment',1,1000000000)
    if(live.maxQuantity!==1||live.maxAutonomousWorkloads!==1)throw new Error('Live validation limits must equal 1')
    bool(value.autonomousTradingEnabled,'autonomousTradingEnabled')
    integer(value.autonomousTradingMaxPurchaseValue,'autonomousTradingMaxPurchaseValue',1,1000000000)
    integer(value.autonomousTradingMaxConcurrentWorkloads,'autonomousTradingMaxConcurrentWorkloads',1,100)
    integer(value.maximumBotsPerProxy===undefined?4:value.maximumBotsPerProxy,'maximumBotsPerProxy',1,1000)
    bool(value.automationEnabled,'automationEnabled');bool(value.allocationEnabled,'allocationEnabled');bool(value.maintenanceMode,'maintenanceMode');validateTimezone(value.timezone)
    if(!startupPolicies.includes(value.startupPolicy))throw new Error('Invalid startupPolicy')
    // Global target is a deprecated derived alias; minimum has no executor.
    if(!object(value.capacity))throw new Error('capacity: expected object')
    integer(value.capacity.minimum,'capacity.minimum',0,1_000_000);integer(value.capacity.maximum,'capacity.maximum',0,1_000_000)
    if(!object(value.roles))throw new Error('roles: expected object')
    for(const [role,r] of Object.entries(value.roles)){if(!/^[a-z][a-z0-9_-]{0,63}$/i.test(role)||!object(r))throw new Error('Invalid role policy');bool(r.enabled,`${role}.enabled`);capacity(r,`roles.${role}`);integer(r.priority,`${role}.priority`,0,1_000_000);bool(r.autoStart,`${role}.autoStart`);bool(r.autoReplace,`${role}.autoReplace`);if(!stopModes.includes(r.stopMode))throw new Error(`${role}.stopMode: invalid`)}
    if(!Array.isArray(value.schedules))throw new Error('schedules: expected array')
    const ids=new Set(),coverage=new Map();for(const [i,w] of value.schedules.entries()){if(!object(w)||typeof w.id!=='string'||!w.id||ids.has(w.id))throw new Error(`schedules[${i}].id: invalid or duplicate`);ids.add(w.id);if(!Object.hasOwn(value.roles,w.role))throw new Error(`schedules[${i}].role: unknown role`);bool(w.enabled,`schedules[${i}].enabled`);if(!Array.isArray(w.weekdays)||!w.weekdays.length||w.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7))throw new Error(`schedules[${i}].weekdays: expected ISO weekdays 1..7`);if(!time(w.start)||!time(w.end)||w.start===w.end)throw new Error(`schedules[${i}]: invalid time interval`);if(w.capacity!=null)capacity(w.capacity,`schedules[${i}].capacity`);if(w.roleEnabled!=null)bool(w.roleEnabled,`schedules[${i}].roleEnabled`);if(w.enabled){const occupied=coverage.get(w.role)??new Map(),start=minute(w.start),end=minute(w.end);for(const day of w.weekdays){const spans=start<end?[[day,start,end]]:[[day,start,1440],[day===7?1:day+1,0,end]];for(const [d,a,b] of spans)for(let m=a;m<b;m++){const key=d*1440+m,owner=occupied.get(key);if(owner)throw new Error(`Schedule conflict for role ${w.role}: ${owner} overlaps ${w.id}`);occupied.set(key,w.id)}}coverage.set(w.role,occupied)}}
    const t=value.transitions;integer(t.maximumConcurrentStarts,'maximumConcurrentStarts',1,100);duration(t.startIntervalMs,'startIntervalMs');integer(t.maximumConcurrentStops,'maximumConcurrentStops',1,100);duration(t.stopIntervalMs,'stopIntervalMs');duration(t.gracefulStopTimeoutMs,'gracefulStopTimeoutMs')
    for(const [k,v] of Object.entries(value.stability))duration(v,k)
    const r=value.recovery;for(const k of ['restartOnCrash','restartOnDisconnect','restartOnUnexpectedStop','replaceUnhealthyAccounts','autoReplaceBannedAccounts'])bool(r[k],k);integer(r.maximumRestartAttempts,'maximumRestartAttempts',0,1000);for(const k of ['restartWindowMs','restartDelayMinMs','restartDelayMaxMs'])duration(r[k],k);if(r.restartDelayMinMs>r.restartDelayMaxMs)throw new Error('restartDelayMinMs must not exceed restartDelayMaxMs')
    const h=value.health;for(const k of ['maximumConsecutiveFailures','maximumCrashesPerWindow','maximumLoginFailures','maximumRealmEntryFailures'])integer(h[k],k,1,1000);duration(h.crashWindowMs,'crashWindowMs');bool(h.quarantineUnhealthyAccounts,'quarantineUnhealthyAccounts');duration(h.quarantineDurationMs,'quarantineDurationMs')
    const a=value.reserve;integer(a.minimumReadyAccounts,'minimumReadyAccounts',0,1_000_000);integer(a.targetReadyAccounts,'targetReadyAccounts',0,1_000_000);bool(a.automaticAccountGeneration,'automaticAccountGeneration');integer(a.maximumTotalAccounts,'maximumTotalAccounts',0,1_000_000);integer(a.maximumPendingAccountGeneration,'maximumPendingAccountGeneration',0,1000)
    const c=value.controller??defaultOperationsPolicy.controller
    const bounds={maxActionsPerCycle:[1,100],maxCandidatesPerCycle:[1,2000],cycleBudgetMs:[50,30000],yieldBudgetMs:[1,50],continuationDelayMs:[50,60000],maxPassesPerDrain:[1,10]}
    for(const key of Object.keys(c))if(!Object.hasOwn(bounds,key))throw new Error('Unknown controller setting: '+key)
    for(const [key,[min,max]] of Object.entries(bounds))integer(c[key],'controller.'+key,min,max)
    return value
}
export function mergeOperationsPolicy(base,patch){
    if(!object(patch))throw new Error('Operations policy patch must be an object')
    const known=new Set(Object.keys(defaultOperationsPolicy));for(const key of Object.keys(patch))if(!known.has(key))throw new Error(`Unknown operations field: ${key}`)
    if(patch.roles!==undefined&&!object(patch.roles))throw new Error('roles: expected object')
    if(patch.controller!==undefined&&!object(patch.controller))throw new Error('controller: expected object')
    if(patch.liveValidation!==undefined&&!object(patch.liveValidation))throw new Error('Invalid liveValidation policy')
    const roles=structuredClone({...defaultOperationsPolicy.roles,...base.roles})
    for(const [id,role] of Object.entries(patch.roles??{})){
        if(!object(role))throw new Error('Invalid role policy')
        roles[id]={...roles[id],...role}
    }
    const next={autonomousTradingEnabled:false,autonomousTradingMaxPurchaseValue:100000,autonomousTradingMaxConcurrentWorkloads:1,maximumBotsPerProxy:4,...base,...patch,capacity:{...base.capacity,...patch.capacity},roles,schedules:patch.schedules===undefined?base.schedules:patch.schedules,transitions:{...base.transitions,...patch.transitions},stability:{...base.stability,...patch.stability},recovery:{...base.recovery,...patch.recovery},health:{...base.health,...patch.health},reserve:{...base.reserve,...patch.reserve}}
    next.liveValidation={...liveValidationDefaults,...base.liveValidation,...patch.liveValidation}
    next.controller={...defaultOperationsPolicy.controller,...base.controller,...patch.controller}
    next.capacity.target=Math.min(next.capacity.maximum,Object.values(roles).reduce((sum,r)=>sum+(r.enabled?r.target:0),0))
    return validateOperationsPolicy(next)
}
const formatters=new Map()
const parts=(date,zone)=>{if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));return Object.fromEntries(formatters.get(zone).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]))}
const weekday={Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:7}
const minute=s=>s==='24:00'?1440:Number(s.slice(0,2))*60+Number(s.slice(3))
function stateAt(policy,date){const p=parts(date,policy.timezone),now=Number(p.hour)*60+Number(p.minute),day=weekday[p.weekday];const active=[]
    for(const w of policy.schedules.filter(x=>x.enabled)){const start=minute(w.start),end=minute(w.end);let match=false;if(start<end)match=w.weekdays.includes(day)&&now>=start&&now<end;else match=(w.weekdays.includes(day)&&now>=start)||(w.weekdays.includes(day===1?7:day-1)&&now<end);if(match)active.push(w)}
    return {parts:p,active}
}
export function effectiveOperationsPolicy(policy,at=new Date(),{keepStopped=false,capabilities=coreCapabilities({autonomousTradingEnabled:policy.autonomousTradingEnabled})}={}){
    validateOperationsPolicy(policy);const current=stateAt(policy,at),roles={};for(const [id,base] of Object.entries(policy.roles)){const selected=current.active.find(w=>w.role===id);const enabled=selected?.roleEnabled??base.enabled;roles[id]={...base,...(selected?.capacity??{}),enabled,scheduleId:selected?.id??null};if(!enabled)Object.assign(roles[id],{minimum:0,target:0,maximum:0})}
    let remaining=policy.capacity.maximum;for(const [id,r] of Object.entries(roles).sort((a,b)=>b[1].priority-a[1].priority||a[0].localeCompare(b[0]))){r.target=r.enabled?Math.min(r.target,r.maximum,remaining):0;r.minimum=Math.min(r.minimum,r.target);r.maximum=Math.min(r.maximum,policy.capacity.maximum);remaining=Math.max(0,remaining-r.target)}
    const reasons=[]
    for(const [id,r] of Object.entries(roles)){
        const selected=current.active.find(w=>w.role===id),scheduledTarget=selected?.capacity?.target??policy.roles[id].target
        r.configuredTarget=policy.roles[id].target;r.scheduledTarget=scheduledTarget;r.reasons=[]
        if(selected)r.reasons.push({code:'SCHEDULE_APPLIED',message:'Застосовано активний розклад.',data:{scheduleId:selected.id}})
        if(!r.enabled)r.reasons.push({code:'ROLE_DISABLED',message:'Роль вимкнено ефективною політикою.',data:{role:id}})
        if(r.enabled&&r.target<scheduledTarget)r.reasons.push({code:'GLOBAL_CAPACITY_CLIPPED',message:'Ціль обмежено загальним максимумом за пріоритетом ролі.',data:{role:id,requested:scheduledTarget,allowed:r.target}})
        if(policy.maintenanceMode){r.target=0;r.minimum=0;r.reasons.push({code:'MAINTENANCE_MODE',message:'Обслуговування блокує нові запуски; зупинка потребує дозволу й підтвердження безпеки.',data:{role:id}})}
        const capability=id==='analyst'?capabilities.analystExecution:id==='reseller'?capabilities.resellerTrading:null
        r.supportedRole=supportedRoles.includes(id);r.executable=capability?.supported===true
        r.blocker=capability?.blocker??(r.supportedRole?null:'UNSUPPORTED_OPERATIONAL_ROLE')
        reasons.push(...r.reasons)
    }
    const automationActive=policy.automationEnabled&&!policy.maintenanceMode&&!keepStopped
    const permissions={mayStart:automationActive&&policy.allocationEnabled,mayStopManaged:(automationActive||policy.automationEnabled&&policy.maintenanceMode&&capabilities.gracefulManagedStop.status!=='UNSUPPORTED')&&!keepStopped&&policy.allocationEnabled,
        mayGenerate:automationActive&&policy.reserve.automaticAccountGeneration&&capabilities.accountGeneration.supported,
        mayReplace:automationActive&&policy.recovery.autoReplaceBannedAccounts,mayDispatchWork:automationActive}
    if(keepStopped)reasons.push({code:'STARTUP_KEEP_STOPPED',message:'Після запуску автономні дії залишено зупиненими.',data:{}})
    const derivedTarget=Object.values(roles).reduce((sum,r)=>sum+r.target,0),next=findNextTransition(policy,at)
    return {...policy,capacity:{...policy.capacity,target:derivedTarget},effectiveAt:at.getTime(),automationActive,keepStopped,permissions,capabilities,reasons,roles,currentScheduleProfile:current.active.map(w=>w.id).sort(),nextTransition:next}
}
export function findNextTransition(policy,at=new Date()){
    if(!policy.schedules.some(w=>w.enabled))return null
    const before=JSON.stringify(stateAt(policy,at).active.map(w=>w.id).sort());for(let mins=1;mins<=8*24*60;mins++){const candidate=new Date(at.getTime()+mins*60_000),after=JSON.stringify(stateAt(policy,candidate).active.map(w=>w.id).sort());if(after!==before){const old=effectiveOperationsPolicyNoNext(policy,at),next=effectiveOperationsPolicyNoNext(policy,candidate),changes=Object.keys(policy.roles).filter(k=>JSON.stringify(old.roles[k])!==JSON.stringify(next.roles[k])).map(role=>({role,before:old.roles[role],after:next.roles[role]}));return {at:candidate.getTime(),timezone:policy.timezone,profile:JSON.parse(after),changes}}}return null
}
const effectiveOperationsPolicyNoNext=(policy,at)=>{const current=stateAt(policy,at),roles={};for(const [id,base] of Object.entries(policy.roles)){const selected=current.active.find(w=>w.role===id),enabled=selected?.roleEnabled??base.enabled;roles[id]={...base,...(selected?.capacity??{}),enabled,scheduleId:selected?.id??null};if(!enabled)Object.assign(roles[id],{minimum:0,target:0,maximum:0})}return {roles}}

export const operationsHelp={automationEnabled:'Єдиний дозвіл автономних дій ядра.',maintenanceMode:'Блокує нові запуски та відновлення; безпечна зупинка потребує дозволу автоматизації й розподілу.',timezone:'Часовий пояс IANA для серверного розкладу.',capacity:'Загальна ціль є похідною; максимум обмежує план.',roles:'Аналітик і перепродажник мають різні можливості виконання.',schedules:'Розклад змінює ефективну політику, а не керує процесами напряму.',transitions:'Спільні ліміти переходів, інтервали та граничний час безпечної зупинки.',stability:'Мінімальна тривалість роботи та простою підтримуються; затримки масштабування не підтримуються.',recovery:'LifecycleArbiter: Reseller recovery requires autonomousTradingEnabled; shared retry and backoff limits apply.',health:'Автоматичні пороги й карантин ще не підтримуються.',reserve:'Резерв придатних облікових даних та спільні ліміти автоматичного створення.'}
