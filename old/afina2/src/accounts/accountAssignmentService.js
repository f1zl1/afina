export default class AccountAssignmentService{
    constructor({logger, dataBaseManager, botManager, accountPool}){
        Object.assign(this,{dataBaseManager,botManager,accountPool})
        this.logger=logger.child("AccountAssignmentService")
        this.queue=Promise.resolve()
    }
    ensureAccount(botId,options={}){return this.serialize(async () => {
        options.executionGuard?.()
        const definition=this.definition(botId)
        if(this.botManager.getBot(botId)?.isRunning()){
            if(definition.connectedAccountId != null && await this.accountPool.isUsable(definition.connectedAccountId)){
                return {changed:false,accountId:definition.connectedAccountId}
            }
            throw new Error("Stop the bot before changing its account")
        }
        return this.assign(botId,options)
    })}
    rotateAccount(botId,options={}){return this.serialize(() => {
        options.executionGuard?.()
        this.requireStopped(botId)
        return this.assign(botId,{...options,rotate:true})
    })}
    releaseAccount(botId){return this.serialize(async () => {
        this.requireStopped(botId)
        const previousAccountId=this.definition(botId).connectedAccountId
        await this.dataBaseManager.updateBotAccount(botId,null)
        this.botManager.updateBotDefinitionAccount(botId,null)
        this.botManager.discardBotProcess(botId)
        return {changed:previousAccountId !== null,previousAccountId,accountId:null}
    })}
    assign(botId,options={}){
        options.executionGuard?.()
        const result=this.dataBaseManager.assignAvailableAccount(botId,{...options,excludeAccountIds:[...(this.accountPool.reserved ?? [])]})
        this.botManager.updateBotDefinitionAccount(botId,result.accountId)
        if(result.changed) this.botManager.discardBotProcess(botId)
        return result
    }
    requireStopped(botId){
        this.definition(botId)
        const bot=this.botManager.getBot(botId)
        if(bot?.isRunning() || bot?.desiredState === "running") throw new Error("Stop the bot before changing its account")
    }
    definition(botId){
        const definition=this.botManager.getBotDefinition(botId)
        if(!definition) throw new Error(`Bot ${botId} not found`)
        return definition
    }
    serialize(operation){
        const next=this.queue.then(operation)
        this.queue=next.catch(()=>{})
        return next
    }
}
