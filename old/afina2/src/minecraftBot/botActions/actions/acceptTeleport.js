export default async function acceptTeleport(bot) {
    if(!bot) return
    await bot.client.waitForTicks(Math.floor(Math.random()*10))
    bot.client.chat("/tpaacept")
}