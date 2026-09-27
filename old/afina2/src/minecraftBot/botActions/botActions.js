import acceptTeleport from "./actions/acceptTeleport.js"
import register from "./actions/register.js"
import connectToRealm from "./actions/connectToRealm.js"
import logining from "./actions/logining.js"
export default class BotActions{
    constructor({bot, logger, eventBus, botId}){
        this.bot = bot
        this.logger = logger
        this.eventBus = eventBus
        this.botId = botId
    }
    async acceptTeleportTask(){
        await acceptTeleport(this.bot)
    }
    async registrationTask(){
        await register({bot: this.bot, botId: this.botId})
    }
    updatePositionStatus(status){
        this.bot.setPositionStatus(status)
    }
    async connectToRealmTask(){
        if(this.bot.afkRecovery?.failed || this.bot.antiAfk?.stopped)return false
        if(this.bot.afkRecovery?.active)return this.bot.afkRecovery.lobbyConfirmed(signal=>connectToRealm({bot:this.bot,signal}))
        await connectToRealm({bot: this.bot})
    }
    async loginingTask(){
        await logining({bot: this.bot})
    }
}
