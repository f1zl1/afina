export function telegramError(code, message = code){
    return Object.assign(new Error(message), {code, safeTelegramError:true})
}

// Never propagate library errors: they may contain a request and its secrets.
export function safeTelegramError(error){
    if(error?.safeTelegramError) return error
    const known = new Set(["PHONE_CODE_INVALID", "PHONE_CODE_EXPIRED", "PHONE_NUMBER_INVALID", "PHONE_NUMBER_BANNED",
        "PASSWORD_HASH_INVALID", "SESSION_PASSWORD_NEEDED", "SESSION_REVOKED", "AUTH_KEY_UNREGISTERED", "USER_DEACTIVATED",
        "INVITE_HASH_INVALID", "INVITE_HASH_EXPIRED", "CHANNEL_PRIVATE", "CHANNEL_INVALID", "USER_BANNED_IN_CHANNEL",
        "CHAT_ADMIN_REQUIRED", "CHANNELS_TOO_MUCH", "INVITE_REQUEST_SENT", "STARS_PAYMENT_REQUIRED"])
    const code = known.has(error?.errorMessage) ? error.errorMessage :
        /^FLOOD_WAIT(?:_\d+)?$/.test(error?.errorMessage ?? "") ? "TELEGRAM_FLOOD_WAIT" : "TELEGRAM_REQUEST_FAILED"
    return telegramError(code)
}
