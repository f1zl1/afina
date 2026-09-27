export function sleep(ms){
    return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitForWindow({
    bot,
    predicate,
    canContinue,
    timeout = 5000
}){
    const startedAt = Date.now()

    while(Date.now() - startedAt < timeout){
        if(!canContinue()) return null

        const client = bot()
        const window = client?.currentWindow

        if(window && predicate(window)) return window

        await sleep(100)
    }

    return null
}