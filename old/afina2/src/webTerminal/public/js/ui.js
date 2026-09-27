import { elements } from "./elements.js"

let feedbackTimer = null

export function clearChatFeedback(){
    clearTimeout(feedbackTimer)
    elements.chatFeedback.classList.remove("visible", "error")
    elements.chatFeedback.textContent = ""
}

export function showChatFeedback(message, error = false){
    clearTimeout(feedbackTimer)
    elements.chatFeedback.classList.toggle("error", error)
    elements.chatFeedback.textContent = message
    elements.chatFeedback.classList.add("visible")
    feedbackTimer = setTimeout(() => {
        elements.chatFeedback.classList.remove("visible")
        feedbackTimer = setTimeout(clearChatFeedback, 200)
    }, 5000)
}

export function setConnection(status){
    elements.connection.classList.remove("connected", "disconnected")

    if(status === "connected"){
        elements.connection.classList.add("connected")
        elements.connectionText.textContent = "Connected"
    }else if(status === "disconnected"){
        elements.connection.classList.add("disconnected")
        elements.connectionText.textContent = "Disconnected"
    }else{
        elements.connectionText.textContent = "Connecting"
    }
}

export function renderBotList(store, onSelect){
    elements.botList.textContent = ""
    elements.botsCount.textContent = store.bots.size

    for(const [botId, bot] of store.bots){
        const snapshot = bot.snapshot
        const incident=bot.runtime?.incident ?? snapshot?.incident
        const status = incident?.type==='ACCOUNT_BANNED'?'Banned':incident?.type==='INVENTORY_BLOCKED_BY_IGNORED_ITEMS'?'Blocked':snapshot?.supervisor?.status ?? "offline"
        const button = document.createElement("button")
        const dot = document.createElement("span")
        const content = document.createElement("span")
        const name = document.createElement("span")
        const stateText = document.createElement("span")

        button.className = "bot-item"
        dot.className = `bot-status-dot ${status.toLowerCase()}`
        content.className = "bot-item-content"
        name.className = "bot-item-name"
        stateText.className = "bot-item-state"

        if(botId === store.selectedBotId){
            button.classList.add("active")
        }

        name.textContent = bot.definition?.name ?? `Bot #${botId}`
        stateText.textContent = [
            status,
            snapshot?.runtime?.position
        ].filter(Boolean).join(" / ")

        content.append(name, stateText)
        button.append(dot, content)
        const configuration = bot.runtime?.configuration
        if(configuration?.restartRequired){
            const badge = document.createElement("span")
            badge.className = "configuration-badge"
            badge.textContent = "!"
            badge.title = configuration.error ?? `Потрібен перезапуск: ${configuration.changes.join(", ")}`
            badge.setAttribute("aria-label", badge.title)
            button.append(badge)
        }
        button.addEventListener("click", () => onSelect(botId))
        elements.botList.append(button)
    }
}

export function renderSelectedBot(store){
    const bot = store.getBot()

    if(!bot){
        elements.emptyState.classList.remove("hidden")
        elements.botContent.classList.add("hidden")
        return
    }

    if(elements.chatInput.dataset.botId !== String(store.selectedBotId)){
        elements.chatInput.value = ""
        elements.chatInput.dataset.botId = String(store.selectedBotId)
        clearChatFeedback()
    }

    const snapshot = bot.snapshot ?? {}

    elements.emptyState.classList.add("hidden")
    elements.botContent.classList.remove("hidden")
    elements.botTitle.textContent = `Bot #${snapshot.botId ?? "-"}`
    elements.botAccount.textContent = snapshot.accountId === null || snapshot.accountId === undefined
        ? ""
        : `Account #${snapshot.accountId}`
    elements.supervisorStatus.textContent = snapshot.supervisor?.status ?? "-"
    elements.runtimeStatus.textContent = snapshot.runtime?.status ?? "-"
    elements.position.textContent = snapshot.runtime?.position ?? "-"
    elements.balance.textContent = formatNumber(snapshot.runtime?.balance)
    elements.taskType.textContent = snapshot.task?.type ?? bot.definition?.type ?? "-"
    elements.taskState.textContent = snapshot.task?.state ?? "-"

    const notice = document.getElementById("configurationNotice")
    let proxyView=document.getElementById('botProxy')
    if(!proxyView){proxyView=document.createElement('section');proxyView.id='botProxy';notice.after(proxyView)}
    proxyView.replaceChildren()
    const proxy=bot.proxy,proxyTitle=document.createElement('strong');proxyTitle.textContent='Проксі';proxyView.append(proxyTitle)
    const proxyLine=text=>{const line=document.createElement('p');line.textContent=text;proxyView.append(line)}
    if(!proxy)proxyLine('Проксі: не призначено')
    else{
        proxyLine(`${proxy.label} · ${proxy.host}:${proxy.port} · ${proxy.protocol.toUpperCase()}`)
        proxyLine(proxy.reservationState==='RESERVED'?'Проксі зарезервовано · стан: зарезервовано для запуску':'Резервація: RUNNING · процес запущено через SOCKS5')
        if(!proxy.currentIncarnation)proxyLine('Резервація іншого запуску: поточне володіння потребує перевірки. Це не підтвердження підключення поточного бота.')
        if(!proxy.active)proxyLine('Вимкнений для нових запусків · поточне володіння збережено; запущений бот продовжує роботу')
        proxyLine(proxy.transportConnected?`SOCKS5 з’єднання встановлено · підтверджено ${new Date(proxy.transportConnectedAt).toLocaleString()}`:'З’єднання SOCKS5: не підтверджено')
        if(proxy.diagnostic)proxyLine(`Остання помилка проксі (історія): ${proxy.diagnostic.code}`)
    }
    let incidentView=document.getElementById('runtimeIncidentNotice')
    if(!incidentView){incidentView=document.createElement('section');incidentView.id='runtimeIncidentNotice';notice.after(incidentView)}
    incidentView.replaceChildren()
    const incident=bot.runtime?.incident ?? snapshot.incident
    incidentView.hidden=!incident
    if(incident){
        const title=document.createElement('strong'),description=document.createElement('p')
        const banned=incident.type==='ACCOUNT_BANNED',blocked=incident.type==='INVENTORY_BLOCKED_BY_IGNORED_ITEMS'
        title.textContent=banned?'Banned':blocked?'Blocked — інвентар заблокований невикидуваними предметами':incident.type
        description.textContent=banned?[
            `Причина: ${incident.banReason ?? '—'}`,`Виявлено: ${new Date(incident.banDetectedAt).toLocaleString()}`,
            `Видано: ${incident.banIssuedAtRaw ?? '—'}`,`Тривалість: ${incident.banDurationRaw ?? '—'}`,
            ...(incident.banExpiresAt?[`Орієнтовно до: ${new Date(incident.banExpiresAt).toLocaleString()}`]:[]),`ID: ${incident.punishmentId ?? '—'}`
        ].join(' · '):(incident.itemSummaries ?? []).map(i=>`${i.name ?? i.itemId}: слот ${i.slot}, ${i.amount} шт.`).join('; ')
        incidentView.append(title,description)
        if(incident.rawMessage){const details=document.createElement('details'),summary=document.createElement('summary'),raw=document.createElement('pre');summary.textContent='Діагностика';raw.textContent=incident.rawMessage;details.append(summary,raw);incidentView.append(details)}
        if(banned || blocked)elements.supervisorStatus.textContent=banned?'Banned':'Blocked'
    }
    const configuration = bot.runtime?.configuration
    notice.classList.toggle("hidden", !configuration?.restartRequired)
    notice.textContent = configuration?.restartRequired
        ? configuration.error ?? `Змінено: ${configuration.changes.join(", ") || "налаштування"}. ${configuration.autoRestart && bot.runtime?.desiredState === "running" ? "Очікується автоматичний перезапуск." : "Застосуються після запуску або перезапуску бота."}`
        : ""

    elements.startButton.disabled = snapshot.desiredState === "running"
    elements.stopButton.disabled = snapshot.desiredState === "stopped"
}

export function appendEvent(event){
    if(event?.type === "bot.chat.message") return

    const line = document.createElement("div")
    const time = document.createElement("span")
    const type = document.createElement("span")
    const payload = document.createElement("span")

    line.className = "stream-line"
    time.className = "stream-time"
    type.className = "stream-type"

    time.textContent = formatTime(event.timestamp)
    type.textContent = event.type ?? "event"
    payload.textContent = formatPayload(event.payload)

    line.append(time, type, payload)
    elements.eventsPanel.append(line)
    trim(elements.eventsPanel)
}

export function appendChat(event){
    if(event?.type !== "bot.chat.message") return

    const line = document.createElement("div")
    const time = document.createElement("span")
    const text = document.createElement("span")

    line.className = "stream-line"
    time.className = "stream-time"
    time.textContent = formatTime(event.timestamp)
    text.textContent = event.payload?.text ?? ""

    line.append(time, text)
    elements.chatPanel.append(line)
    trim(elements.chatPanel)
}

export function clearStreams(){
    elements.chatPanel.textContent = ""
    elements.eventsPanel.textContent = ""
}

export function setTab(tab){
    const chat = tab === "chat"

    elements.chatTab.classList.toggle("active", chat)
    elements.eventsTab.classList.toggle("active", !chat)
    elements.chatPanel.classList.toggle("hidden", !chat)
    elements.eventsPanel.classList.toggle("hidden", chat)
}

export function setActionsDisabled(disabled, store = null){
    if(disabled){
        elements.startButton.disabled = true
        elements.stopButton.disabled = true
        elements.restartButton.disabled = true
        return
    }

    elements.restartButton.disabled = false

    if(store){
        renderSelectedBot(store)
    }
}

function trim(panel){
    while(panel.children.length > 100){
        panel.firstElementChild?.remove()
    }

    panel.scrollTop = panel.scrollHeight
}

function formatNumber(value){
    const number = Number(value)
    return Number.isFinite(number) ? new Intl.NumberFormat("uk-UA").format(number) : "-"
}

function formatTime(timestamp){
    if(!timestamp) return "--:--:--"

    return new Date(timestamp).toLocaleTimeString("uk-UA", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    })
}

function formatPayload(payload){
    if(payload === null || payload === undefined) return ""
    if(typeof payload === "string") return payload

    try{
        return JSON.stringify(payload)
    }catch{
        return String(payload)
    }
}
