// Deterministic projection of an immutable CoreObservationSnapshot. No runtime reads or commands.
export default class CoreActualState{
    read(observation){
        const {timestamp:now,accounts:accountRows,workers,definitions,items,controls}=observation
        const accounts=new Map(accountRows.map(a=>[a.accountId,a]))
        const replacements=observation.pending.replacements.rows
        const control=new Map(controls.map(c=>[c.botId,c]))
        const byWorker=new Map(workers.map(w=>[w.botId,w]))
        const bots=definitions.map(row=>{
            const w=byWorker.get(row.botId),f=w.facts,intent=w.intent??{},evidence=w.process
            const processAlive=evidence.alive===true,uncertain=evidence.alive!==false&&w.quality!=='FRESH'
            const fresh=processAlive&&w.quality==='FRESH'&&f?.incarnationId===evidence.incarnationId
            const task={taskId:row.taskId,type:row.type,itemId:row.itemId,buyPrice:row.buyPricePerOne,sellPrice:row.sellPricePerOne,enabled:row.enabled}
            const activeTask=processAlive&&f?{...f.task}:task
            const account=accounts.get(row.connectedAccountId),banned=Boolean(account?.banned)
            const blocked=Boolean(w.operationalBlock||f?.blocked),replacementPending=replacements.some(r=>r.botId===row.botId)
            const minecraftConnected=fresh&&f.connection.connected,spawned=minecraftConnected&&f.connection.spawned
            const targetRealmConfirmed=spawned&&f.position.status==='realm'&&f.position.confirmedRealm===row.realm&&f.position.targetRealm===row.realm&&f.serverId===row.serverId
            const realmReady=targetRealmConfirmed&&f.position.realmReady,roleReady=realmReady&&f.role.ready&&!f.stopping&&f.role.activeRole===activeTask.type
            const workReady=Boolean(roleReady&&f.health.alive&&!blocked&&account?.eligible&&f.accountId===row.connectedAccountId&&activeTask.enabled===1)
            const role=workReady&&['analyst','reseller'].includes(activeTask.type)?activeTask.type:null
            const blocker=evidence.alive===false?'PROCESS_MISSING':uncertain?(w.reason??'WORKER_FACTS_UNAVAILABLE'):!minecraftConnected?'MINECRAFT_DISCONNECTED':!spawned?'WORKER_NOT_SPAWNED':!targetRealmConfirmed?'TARGET_REALM_UNCONFIRMED':!realmReady?'REALM_NOT_READY':!roleReady?'ROLE_NOT_READY':!workReady?'WORKER_NOT_READY':null
            const state=control.get(row.botId)??{}
            return {botId:row.botId,lifecycle:observation.lifecycle?.find(s=>s.botId===row.botId)??null,name:row.name,accountId:row.connectedAccountId,banned,replacementPending,operationalBlock:w.operationalBlock??(blocked?{type:'WORKER_BLOCKED'}:null),workReady,
                processAlive,minecraftConnected,spawned,targetRealmConfirmed,realmReady,roleReady,uncertain,blocker,observationQuality:w.quality,incarnationId:evidence.incarnationId,
                lastObservedAt:w.lastObservedAt??null,lastEventAt:w.lastEventAt??null,lastProgressAt:f?.lastProgressAt??null,observationAgeMs:w.ageMs??null,
                readinessAgeMs:evidence.startedAt==null?null:Math.max(0,now-(f?.lastProgressAt??evidence.startedAt)),positionStatus:f?.position.status??'unknown',factSource:w.source,
                serverId:processAlive?f?.serverId??row.serverId:row.serverId,realm:processAlive?f?.position.targetRealm??row.realm:row.realm,
                configurationStale:w.configurationStale===true,task,activeTask,role,running:processAlive||uncertain,
                analysisState:workReady&&activeTask.type==='analyst'?f.role.state:'unavailable',workload:fresh?f.workload??null:null,
                desiredState:intent.desiredState??'stopped',supervisorStatus:intent.supervisorStatus??'offline',runtimeStatus:f?.runtimeStatus??'unknown',workerPid:evidence.pid??null,
                reconnectBlocked:Boolean(intent.reconnectBlocked),externalTransition:Boolean(intent.reconnectScheduled||intent.startingConfiguration||intent.restartRequested),taskState:f?.role.state??null,
                targetConfigured:row.validServerId!=null&&Number.isInteger(row.realm),accountUsable:account?.eligible===true,
                manualHold:Boolean(state.manualHold),lastAssignmentAt:state.lastAssignmentAt??null,lastSwitchAt:state.lastSwitchAt??null,pendingDecisionId:observation.actions?observation.actions.find(a=>a.botId===row.botId)?.decisionId??(observation.actions.some(a=>a.botId===row.botId)?'ACTION_IN_PROGRESS':null):state.pendingDecisionId??null,failedUntil:state.failedUntil??null}
        })
        return {observedAt:now,dataRevision:observation.dataRevision,observation,bots,items,
            roles:{reseller:bots.filter(b=>b.role==='reseller').length,analyst:bots.filter(b=>b.role==='analyst').length},
            counts:{processes:bots.filter(b=>b.processAlive).length,connected:bots.filter(b=>b.minecraftConnected).length,realmReady:bots.filter(b=>b.realmReady).length,workReady:bots.filter(b=>b.workReady).length,uncertain:bots.filter(b=>b.uncertain).length},
            pendingReplacements:replacements.length,accounts:{total:accounts.size,available:accountRows.filter(a=>!a.assigned&&!a.reserved&&!a.replacementPending&&a.eligible).length},
            allocations:items.map(item=>({...item,actualBots:bots.filter(b=>b.role==='reseller'&&b.activeTask.itemId===item.itemId).length}))}
    }
}
