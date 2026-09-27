export default async function logining({bot}) {
    if(!bot) return
    bot.setPositionStatus('authentication')
    await bot.client.waitForTicks(Math.floor(Math.random()*40))
    bot.client.chat(`/login ${bot.accountData.password}`)
}
