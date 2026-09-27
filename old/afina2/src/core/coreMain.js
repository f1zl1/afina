import CommandService from "./commandService.js"
import QueryService from "./queryService.js"
import AutonomousCore from "./autonomousCore.js"

export default class Core{
    constructor({
        logger,
        eventBus,
        botManager,
        snapshotStore,
        eventHistoryStore,
        accountPool,
        accountAssignmentService,
        databaseEditor,
        configurationService,
        dataBaseManager,
        telegramManager
    }){
        this.logger = logger.child("Core")
        this.eventBus = eventBus
        this.botManager=botManager
        this.autonomy = dataBaseManager?.store && botManager ? new AutonomousCore({dataBaseManager,botManager,snapshotStore,configurationService,eventBus,logger,accountPool,executeCommand:request=>this.executeCommand(request)}) : null

        this.commandService = new CommandService({
            logger,
            botManager,
            accountPool,
            accountAssignmentService,
            databaseEditor,
            dataBaseManager,
            telegramManager,
            configurationService,
            eventBus,
            autonomy:this.autonomy
        })

        this.queryService = new QueryService({
            logger,
            botManager,
            snapshotStore,
            eventHistoryStore,
            accountPool,
            databaseEditor,
            autonomy:this.autonomy
        })

        this.logger.info("Core started")
    }

    executeCommand(request){
        return this.commandService.execute(request)
    }
    async start(){await this.autonomy?.start()}
    async stop(){await this.autonomy?.stop();await this.botManager?.shutdown?.()}

    executeQuery(request){
        return this.queryService.execute(request)
    }
}
