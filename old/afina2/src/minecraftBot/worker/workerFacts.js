import {workloadEvidence} from '../../workloads/workloadContract.js'
// Read-only, bounded projection of the live runtime. Never serializes client/config objects.
const number=v=>Number.isFinite(v)?v:null
const text=v=>typeof v==='string'?v.slice(0,96):null
export function sanitizeWorkerFacts(f){
    if(f?.version!==1||!Number.isSafeInteger(f.sequence)||typeof f.incarnationId!=='string'||!Number.isFinite(f.observedAt))return null
    return {version:1,botId:number(f.botId),accountId:number(f.accountId),incarnationId:text(f.incarnationId),sequence:f.sequence,
        observedAt:f.observedAt,workerStartedAt:number(f.workerStartedAt),lastSemanticChangeAt:number(f.lastSemanticChangeAt),lastProgressAt:number(f.lastProgressAt),
        runtimeStatus:text(f.runtimeStatus),connection:{connected:f.connection?.connected===true,protocolState:text(f.connection?.protocolState),spawned:f.connection?.spawned===true},
        position:{status:text(f.position?.status),targetRealm:number(f.position?.targetRealm),confirmedRealm:number(f.position?.confirmedRealm),realmReady:f.position?.realmReady===true,enteredAt:number(f.position?.enteredAt)},
        role:{configuredRole:text(f.role?.configuredRole),activeRole:text(f.role?.activeRole),state:text(f.role?.state),ready:f.role?.ready===true},
        task:{taskId:number(f.task?.taskId),type:text(f.task?.type),itemId:number(f.task?.itemId),enabled:f.task?.enabled===1?1:0,buyPrice:number(f.task?.buyPrice),sellPrice:number(f.task?.sellPrice)},
        serverId:number(f.serverId),blocked:f.blocked===true,health:{alive:f.health?.alive===true},stopping:f.stopping===true,workload:workloadEvidence(f.workload)}
}

export default class WorkerFacts{
    constructor({bot,incarnationId,workerStartedAt=Date.now(),now=Date.now,isStopping=()=>false}){
        Object.assign(this,{bot,incarnationId,workerStartedAt,now,isStopping});this.sequence=0;this.lastProgressAt=workerStartedAt;this.lastSemanticChangeAt=workerStartedAt
    }
    read(){
        const b=this.bot,at=this.now(),client=b.client,protocol=client?._client,task=b.taskRunner?.activeTask,configured=b.taskData??{}
        const stopping=this.isStopping()||b.taskRunner?.stopping===true
        const connected=Boolean(protocol&&protocol.state==='play'&&protocol.ended!==true&&protocol.socket?.destroyed!==true&&client?.endCalled!==true)
        const spawned=connected&&b.status==='running'&&Boolean(client?.entity)
        const confirmed=b.positionStatus==='realm'&&b.realmReadyTarget===b.accountData.realm
        const realmReady=b.realmReadyGate?.inspect?.().ready===true
        const active=Boolean(task&&!stopping)
        const roleReady=active&&(configured.type==='analyst'?task.stopped===false:configured.type==='reseller'?task.running===true&&!task.paused&&!['starting','waiting_for_realm','waiting_realm_unlock','stopped'].includes(task.state):false)
        const state=!active?'unavailable':configured.type==='analyst'?(task.stopped?'unavailable':task.job?'busy':'idle'):task.state??'unknown'
        const f={version:1,botId:b.botId,accountId:b.accountId,incarnationId:this.incarnationId,sequence:++this.sequence,observedAt:at,workerStartedAt:this.workerStartedAt,
            runtimeStatus:b.status,connection:{connected,protocolState:protocol?.state??null,spawned},
            position:{status:b.positionStatus,targetRealm:b.accountData.realm,confirmedRealm:confirmed?b.realmReadyTarget:null,realmReady,enteredAt:b.realmReadyGate?.enteredAt??null},
            role:{configuredRole:configured.type??null,activeRole:active?configured.type:null,state,ready:roleReady},
            task:{taskId:configured.taskId,type:configured.type,itemId:configured.itemId,enabled:configured.enabled,buyPrice:configured.buyPricePerOne,sellPrice:configured.sellPricePerOne},
            serverId:b.serverData?.serverId,blocked:Boolean(b.operationalBlock||b.afkRecovery?.active||b.afkRecovery?.failed),health:{alive:client?.health>0},stopping,workload:b.taskRunner?.workload?.read()??null}
        const semantic=JSON.stringify({...f,sequence:0,observedAt:0})
        if(semantic!==this.semantic){this.semantic=semantic;this.lastSemanticChangeAt=at}
        const progress=JSON.stringify([connected,spawned,b.positionStatus,confirmed,realmReady,f.role.activeRole,roleReady,f.blocked,stopping])
        if(progress!==this.progress){this.progress=progress;this.lastProgressAt=at}
        return sanitizeWorkerFacts({...f,lastSemanticChangeAt:this.lastSemanticChangeAt,lastProgressAt:this.lastProgressAt})
    }
}

export const semanticFactEvents=new Set(['bot.status.changed','bot.position.changed','bot.disconnected','bot.kicked','bot.runtime.ready','bot.realm.readiness','bot.analysis.status','task.state.changed','bot.runtime.incident'])
