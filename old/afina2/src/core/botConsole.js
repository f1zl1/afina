import { success, failure } from "./coreResult.js"

export async function executeBotConsole({botId, text, botManager}){
    if(typeof text !== "string" || !text.trim() || text.length > 256 ||
        /[\x00-\x1f\x7f\u00a7\u2028\u2029]/u.test(text)){
        return failure("INVALID_CHAT_TEXT", "Введіть один рядок від 1 до 256 символів без керувальних символів.")
    }

    const input = text.trim()
    if(input.startsWith("!")){
        const [command, ...args] = input.slice(1).split(/\s+/)
        const name = command.toLowerCase()
        if(args.length){
            return failure("INVALID_LOCAL_COMMAND", "Ця команда не приймає аргументів. Довідка: !help")
        }
        if(name === "help"){
            return success({botId, kind: "local", message:
                "Звичайний текст — повідомлення від імені вибраного бота. /команда — команда Minecraft-сервера. !help — ця підказка, лише на сайті. Enter або «Надіслати» — відправити. Бот має бути підключений для надсилання на сервер."})
        }
        return failure("UNKNOWN_LOCAL_COMMAND", "Невідома локальна команда. Наразі доступна лише !help.")
    }

    const worker = botManager.getBot(botId)
    if(!worker || worker.desiredState !== "running" || worker.runtimeStatus !== "running"){
        return failure("BOT_NOT_CONNECTED", "Бот не підключений до сервера.")
    }
    try{
        await worker.sendChat(input)
        return success({botId, kind: "chat", message: "Передано ігровому клієнту: " + input})
    }catch(error){
        return failure("CHAT_SEND_FAILED", error?.message ?? "Не вдалося надіслати повідомлення.")
    }
}
