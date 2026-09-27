export function sendChat(bot, text, stopping = false, transitionOwner = null, operatorConsole = false){
    if(typeof text !== "string" || !text.trim() || text.length > 256 ||
        /[\x00-\x1f\x7f\u00a7\u2028\u2029]/u.test(text) || text.trim().startsWith("!")){
        throw new Error("Некоректний текст повідомлення.")
    }
    if(stopping || !bot?.client || bot.status !== "running" || bot.client._client?.state !== "play"){
        throw new Error("Бот не підключений до сервера.")
    }
    if(operatorConsole&&text.trim().startsWith('/')){
        const workload=bot.taskRunner?.workload?.read()
        if(bot.lifecycleQuiescing||bot.lifecycleUncertain||workload&&(workload.safe!==true||workload.uncertain))throw new Error('Команди заблоковано: поточна робота ще не завершена безпечно.')
        if(/^\/(?:[\w.-]+:)?(?:ah|auction|auctions|auc)(?:\s|$)/i.test(text.trim()))throw new Error('Торгівля через консоль недоступна. Створіть ручне торгове завдання; залишки перевірте зовні.')
    }
    const realm=text.trim().match(/^\/an(\d+)\s*$/i)
    if(realm || /^\/(hub|lobby)(?:\s|$)/i.test(text.trim())){
        if(bot.afkRecovery?.active && transitionOwner!==bot.afkRecovery.active)bot.afkRecovery.cancel('EXTERNAL_TRANSITION')
        if(!transitionOwner){
            bot.realmEntryGeneration=(bot.realmEntryGeneration ?? 0)+1
            bot.realmEntryPending=null
        }
        bot.requestedRealm=realm?Number(realm[1]):null
        bot.setPositionStatus?.('realmConnecting')
    }
    return bot.client.chat(text)
}
