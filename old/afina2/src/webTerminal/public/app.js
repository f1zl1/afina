import { elements } from "./js/elements.js"
import WebSocketApi from "./js/webSocketApi.js"
import BotController from "./js/botController.js"
import DatabaseController from "./js/databaseController.js"
import CoreController from "./js/coreController.js"
import { setConnection, setTab, showChatFeedback, clearChatFeedback } from "./js/ui.js"

const api = new WebSocketApi()
const controller = new BotController({api})
const refreshBots = () => controller.refreshOverview().catch(console.error)
const databaseController = new DatabaseController({api, onChanged: refreshBots})
const coreController = new CoreController({api})
setInterval(refreshBots, 2000)

for(const page of ["bots", "database", "core"]){
    document.getElementById(page + "PageTab").addEventListener("click", () => {
        for(const name of ["bots", "database", "core"]){
            document.getElementById(name + "Page").classList.toggle("hidden", name !== page)
            const tab = document.getElementById(name + "PageTab")
            tab.classList.toggle("active", name === page)
            tab.setAttribute("aria-pressed", String(name === page))
        }
        databaseController.visible = page === "database"
        if(databaseController.visible) databaseController.show()
        coreController.visible = page === "core"
        if(coreController.visible) coreController.show()
    })
}
let sendingChat = false

function updateChatButton(){
    elements.chatSendButton.disabled = sendingChat || !api.isConnected()
}

elements.chatForm.addEventListener("submit", async event => {
    event.preventDefault()
    if(sendingChat) return
    const botId = controller.store.selectedBotId
    const selectionVersion = controller.store.selectionVersion
    const text = elements.chatInput.value
    if(!botId || !text.trim()) return

    sendingChat = true
    updateChatButton()
    clearChatFeedback()
    try{
        const result = await controller.submitConsole(botId, text)
        if(controller.store.selectedBotId !== botId ||
            controller.store.selectionVersion !== selectionVersion) return
        showChatFeedback("Бот #" + botId + ": " + result.message)
        if(elements.chatInput.value === text) elements.chatInput.value = ""
    }catch(error){
        if(controller.store.selectedBotId !== botId ||
            controller.store.selectionVersion !== selectionVersion) return
        showChatFeedback(error?.message ?? "Не вдалося надіслати.", true)
    }finally{
        sendingChat = false
        updateChatButton()
    }
})

api.setHandlers({
    connection: status => {
        setConnection(status)
        updateChatButton()
    },
    connected: () => {
        controller.connected()
        if(databaseController.visible) databaseController.show()
        if(coreController.visible) coreController.show()
    },
    disconnected: () => controller.disconnected(),
    event: event => {
        if(event.type.startsWith("core.")){coreController.handleEvent(event);return}
        if(event.type.startsWith("telegram.")){
            const payload=event.payload
            const messages={bindingSuccess:"Telegram прив’язано. Для активного бота буде виконано автоматичний перезапуск.",subscriptionJoined:"Підписку на канал виконано. Очікуємо підтвердження прив’язки.",loginConfirmed:"Вхід підтверджено через Telegram.",operationTimeout:"Час очікування Telegram минув."}
            const text=payload.message ?? messages[event.type.slice(9)]
            if(text){
                const error=["telegram.error","telegram.noAvailableAccount","telegram.operationTimeout"].includes(event.type)
                const message=(payload.botId ? `Бот #${payload.botId}: ` : "")+text
                showChatFeedback(message,error)
                databaseController.message(message,error)
            }
        }
        if(event.type === 'bot.runtime.incident') refreshBots()
        if(event.type === "system.bots.changed") refreshBots()
        else if(event.type === "system.database.changed"){
            refreshBots()
            if(databaseController.visible) databaseController.refresh().catch(error => databaseController.message(error.message, true))
        }else controller.handleEvent(event)
    }
})

elements.startButton.addEventListener("click", () => {
    controller.executeCommand("bot.start")
})

elements.stopButton.addEventListener("click", () => {
    controller.executeCommand("bot.stop")
})

elements.restartButton.addEventListener("click", () => {
    controller.executeCommand("bot.restart")
})

elements.deleteButton.addEventListener("click", async () => {
    const bot = controller.store.getBot()
    if(!bot) return

    const botId = bot.snapshot?.botId
    const name = bot.definition?.name ?? `Bot #${botId}`

    if(!window.confirm(`Delete ${name}?`)) return

    try{
        await controller.archiveSelectedBot()
    }catch(error){
        window.alert(error?.message ?? "Failed to delete bot")
    }
})

elements.addBotButton.addEventListener("click", () => {
    elements.newBotName.value = ""
    elements.newBotType.value = "test"
    elements.newBotAccountId.value = ""
    document.getElementById("newBotServerId").value = ""
    document.getElementById("newBotRealm").value = ""
    elements.addBotDialog.showModal()
})

elements.cancelAddBotButton.addEventListener("click", () => {
    elements.addBotDialog.close()
})

elements.addBotForm.addEventListener("submit", async event => {
    event.preventDefault()

    const accountValue = elements.newBotAccountId.value.trim()

    try{
        await controller.createBot({
            name: elements.newBotName.value.trim() || null,
            type: elements.newBotType.value,
            connectedAccountId: accountValue ? Number(accountValue) : null,
            serverId: Number(document.getElementById("newBotServerId").value) || null,
            realm: Number(document.getElementById("newBotRealm").value) || null
        })

        elements.addBotDialog.close()
    }catch(error){
        window.alert(error?.message ?? "Failed to create bot")
    }
})

elements.chatTab.addEventListener("click", () => {
    setTab("chat")
})

elements.eventsTab.addEventListener("click", () => {
    setTab("events")
})

api.connect()
