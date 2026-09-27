import {sendChat} from '../../worker/sendChat.js'

export default async function connectToRealm({bot,signal}){
    if(!bot?.client || signal?.aborted || bot.antiAfk?.stopped || bot.status!=='running' ||
        bot.client._client?.state!=='play' || bot.positionStatus==='dead')return false
    if(bot.realmEntryPending)return false
    const client=bot.client,target=bot.accountData.realm,generation=bot.realmEntryGeneration ?? 0
    const pending={signal};bot.realmEntryPending=pending
    try{
        bot.setPositionStatus("realmConnecting")
        await client.waitForTicks(Math.floor(Math.random()*20))
        if(signal?.aborted || client!==bot.client || generation!==(bot.realmEntryGeneration ?? 0) || bot.antiAfk?.stopped ||
            target!==bot.accountData.realm || bot.status!=='running' || client._client?.state!=='play' || bot.positionStatus!=='realmConnecting')return false
        await sendChat(bot,`/an${target}`,false,bot.afkRecovery?.active)
        return true
    }finally{if(bot.realmEntryPending===pending)bot.realmEntryPending=null}
}
