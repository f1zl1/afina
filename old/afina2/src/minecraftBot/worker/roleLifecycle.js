// The worker's existing role lifecycle, shared with integration tests without starting IPC.
export function registerRoleLifecycle({bot,eventBus,isStopping=()=>false}){
    const changed=data=>{
        if(data?.botId!==bot.botId || isStopping())return
        if(data.newStatus==='realm'){
            if(!bot.taskData || bot.taskData.enabled===0 || bot.afkRecovery?.active || bot.afkRecovery?.failed || bot.operationalBlock)return
            eventBus.emit('bot:realmReadiness',{botId:bot.botId,phase:'ROLE_START_REQUESTED',role:bot.taskData.type,generation:bot.afkGeneration})
            bot.taskRunner.start(bot.taskData).catch(error=>eventBus.emit('bot:error',{
                botId:bot.botId,error:error?.message ?? String(error),stack:error?.stack ?? null
            }))
            const client=bot.client,generation=bot.realmReadyGate.generation
            void bot.realmReadyGate.ready().then(()=>{
                if(!isStopping() && bot.client===client && generation===bot.realmReadyGate.generation && !bot.operationalBlock && !bot.antiAfk.stopped && bot.taskRunner.activeTask && !bot.taskRunner.stopping)
                    eventBus.emit('bot:runtimeReady',{botId:bot.botId})
            }).catch(()=>{})
        }else{
            eventBus.emit('bot:realmReadiness',{botId:bot.botId,phase:'ROLE_INTERRUPTED',role:bot.taskData?.type,
                analysisId:bot.taskRunner.activeTask?.job?.id ?? null,generation:bot.afkGeneration,reason:data.newStatus})
            bot.taskRunner.stop()
        }
    }
    eventBus.on('bot:positionStatusUpdated',changed)
    const ready=data=>{if(bot.positionStatus==='realm')changed({...data,newStatus:'realm'})}
    eventBus.on('bot:workReady',ready)
    return ()=>{eventBus.off('bot:positionStatusUpdated',changed);eventBus.off('bot:workReady',ready)}
}
