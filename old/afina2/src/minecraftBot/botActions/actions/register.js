export default async function register({bot, botId}) {
    if(!bot || !botId) return
    bot.setPositionStatus('authentication')
    await bot.client.waitForTicks(Math.floor(Math.random()*40))
    bot.client.chat(`/reg ${bot.accountData.password}`)
}
