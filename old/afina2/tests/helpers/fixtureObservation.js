// Explicit observation source for pre-existing executor unit fixtures.
// These tests model ready workers; production has no cached-status fallback.
export function fixtureObservation(manager,store,liveBot=null){
    manager.observeBots=async ids=>({workers:ids.length,queried:0,refreshed:0,timeouts:0,durationMs:0})
    manager.getWorkerObservation=(id)=>{
        const r=manager.getBotRuntimeState(id)??{},p=manager.getBot(id),row=store.prepare('SELECT * FROM botData WHERE botId=?').get(id),task=p?.taskData??store.prepare('SELECT * FROM tasksData WHERE botId=?').get(id)??{}
        const alive=r.running===true,incarnationId='fixture-'+(r.workerPid??id)
        if(liveBot)liveBot.incarnationId=incarnationId
        const ready=alive&&(liveBot?liveBot.positionStatus==='realm'&&Boolean(liveBot.taskRunner.activeTask)&&!liveBot.taskRunner.stopping:p?.workReady??r.runtimeStatus==='running')
        return {botId:id,quality:alive?'FRESH':'PROCESS_MISSING',source:'worker_query',lastObservedAt:Date.now(),lastEventAt:null,ageMs:0,
            process:{alive,ipcConnected:alive,pid:r.workerPid??null,incarnationId,startedAt:Date.now(),observedAt:Date.now(),source:'process_observation'},
            intent:{...r,reconnectBlocked:p?.reconnectBlocked},operationalBlock:p?.operationalBlock,configurationStale:r.configuration?.restartRequired===true,
            facts:{version:1,sequence:1,incarnationId,botId:id,accountId:row?.connectedAccountId,serverId:p?.serverData?.serverId??row?.serverId,runtimeStatus:r.runtimeStatus,
                connection:{connected:alive,spawned:alive},position:{status:ready?'realm':'lobby',targetRealm:p?.accountData?.realm??row?.realm,confirmedRealm:ready?row.realm:null,realmReady:ready},
                role:{configuredRole:task.type,activeRole:ready?task.type:null,state:p?.analysisState??'idle',ready},task:{taskId:task.taskId,type:task.type,itemId:task.itemId,buyPrice:task.buyPricePerOne,sellPrice:task.sellPricePerOne,enabled:task.enabled},
                health:{alive:true},blocked:Boolean(p?.operationalBlock),stopping:false,workload:(liveBot?.taskRunner?.workload??p?.workload)?.read()??null}}
    }
    return manager
}
