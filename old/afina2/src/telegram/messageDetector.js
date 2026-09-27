const normalize = text => String(text ?? "").replace(/§[0-9a-fk-or]/gi, "").replace(/\s+/g, " ").trim()

export function detectMinecraftMessage(text){
    const value = normalize(text).toLowerCase()
    if(value.includes("привяжите аккаунт") && value.includes("/tg")) return "binding"
    if(value.includes("подтвердите вход") && value.includes("личные сообщения") && /(?:тг|телеграм)/.test(value)) return "login_confirmation"
    return null
}

export function detectTelegramMessage(text){
    const value = normalize(text)
    let match = value.match(/Аккаунт\s+([A-Za-z0-9_]{3,16})\s+был привязан/iu)
    if(match) return {type:"binding",nickName:match[1]}
    if(/Подпишитесь на официальный канал/iu.test(value) && /привязать аккаунт/iu.test(value)) return {type:"subscription_required"}
    if(/Подтвердите или отклоните вход/iu.test(value)){
        match = value.match(/пароль от аккаунта\s+([A-Za-z0-9_]{3,16})(?=\s|\()/iu)
        return match ? {type:"login_confirmation",nickName:match[1]} : null
    }
    match = value.match(/Успешный вход в аккаунт\s+([A-Za-z0-9_]{3,16})(?=\s|\(|$)/iu)
    return match ? {type:"login_observed",nickName:match[1]} : null
}
