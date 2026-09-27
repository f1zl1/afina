import "dotenv/config"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ConfigManager from "./config/configManager.js"
import Logger from "./logger/loggerMain.js"
import EventBus from "./eventBus/eventBusMain.js"
import BotSnapshotStore from "./snapshots/botSnapshotStore.js"
import BotManager from "./botManager/botManagerMain.js"
import Core from "./core/coreMain.js"
import WebTerminal from "./webTerminal/webTerminalMain.js"
import DataBaseManager from "./data/dataBaseManagerMain.js"
import AccountManager from "./accountManager/accountManagerMain.js"
import ImageSolver from "./minecraftBot/utils/imageSolver.js"
import PublicEventLogStore from "./events/publicEventLogStore.js"
import EventHistoryStore from "./events/eventHistoryStore.js"
import InterfaceGateway from "./interfaces/interfaceGateway.js"
import AccountPool from "./accounts/accountPool.js"
import AccountAssignmentService from "./accounts/accountAssignmentService.js"
import TelegramAccountPool from "./resources/telegramAccountPool.js"
import TelegramAccountStore from "./telegram/telegramAccountStore.js"
import TelegramManager from "./telegram/telegramManager.js"
import DatabaseEditor from "./data/databaseEditor.js"
import BotConfigurationService from "./botManager/botConfigurationService.js"

const srcDirectory = path.dirname(fileURLToPath(import.meta.url))

const configManager = new ConfigManager()
const logger = new Logger(await configManager.loggerConfig())

const eventBus = new EventBus({
    logger,
    config: await configManager.eventBusConfig()
})

const publicEventLogStore = new PublicEventLogStore({
    eventBus,
    logger,
    config: {
        baseDirectory: path.join(srcDirectory, "logs", "events"),
        maxFileSizeBytes: 20 * 1024 * 1024,
        maxEntriesPerFile: 50_000
    }
})

const eventHistoryStore = new EventHistoryStore({
    eventBus,
    logger,
    limit: 100
})

const dataBaseManager = new DataBaseManager({
    config: await configManager.dataBaseManagerConfig(),
    logger,
    eventBus
})

await dataBaseManager.init()
process.once("exit", () => dataBaseManager.close())

const accountPool = new AccountPool({
    logger,
    dataBaseManager
})

await accountPool.init()

const telegramAccountStore = new TelegramAccountStore(dataBaseManager.store)
const telegramAccountPool = new TelegramAccountPool({logger,store:telegramAccountStore})

const imageSolver = new ImageSolver(
    await configManager.captchaSolverConfig()
)

await imageSolver.start()

const accountManager = new AccountManager({
    logger,
    eventBus,
    dataBaseManager
})

const snapshotStore = new BotSnapshotStore({
    eventBus,
    logger
})

const botManager = new BotManager({
    logger,
    eventBus,
    accountManager,
    dataBaseManager,
    imageSolver,
    snapshotStore
})

await botManager.loadBots()

const databaseEditor = new DatabaseEditor({
    store: dataBaseManager.store,
    beforeMutation: ({table,before,after}) => {
        if(table !== "botData" || !before) return
        const bot = botManager.getBot(before.botId)
        if((bot?.isRunning() || bot?.desiredState === "running") && (!after ||
            before.botId !== after.botId || before.connectedAccountId !== after.connectedAccountId || before.archived !== after.archived)){
            throw new Error("Зупиніть бота перед зміною акаунта, ID, архівуванням або видаленням.")
        }
    }
})
const configurationService = new BotConfigurationService({
    botManager, dataBaseManager, eventBus, logger,
    config: await configManager.botManagerConfig()
})
botManager.configurationService = configurationService
await configurationService.init()

const accountAssignmentService = new AccountAssignmentService({
    logger,
    dataBaseManager,
    botManager,
    accountPool
})

const telegramManager = new TelegramManager({
    store:telegramAccountStore, pool:telegramAccountPool, eventBus, botManager, logger,
    config:await configManager.telegramConfig()
})

const core = new Core({
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
})

const interfaceGateway = new InterfaceGateway({
    logger,
    core,
    eventBus
})

const webTerminal = new WebTerminal({
    logger,
    interfaceGateway,
    config: {
        host: "127.0.0.1",
        port: 4001
    }
})

await core.start()
// Do not admit operator commands while startup recovery is still reconciling.
webTerminal.init()
void telegramManager.start().catch(() => logger.error("Telegram startup failed"))
for(const signal of ["SIGINT","SIGTERM"]){
    process.once(signal, async () => {
        await core.stop()
        await telegramManager.stop()
        await webTerminal.stop()
        process.exit(0)
    })
}

export {
    eventBus,
    logger,
    imageSolver,
    publicEventLogStore,
    eventHistoryStore,
    dataBaseManager,
    accountPool,
    accountAssignmentService,
    telegramAccountPool,
    telegramManager,
    snapshotStore,
    botManager,
    core,
    interfaceGateway,
    webTerminal
}
