export default class ResellerServerActions{
    constructor({
        bot,
        canContinue,
        delay
    }){
        this.bot = bot
        this.canContinue = canContinue
        this.delayManager = delay
        this.queue = Promise.resolve()
    }

    chat(message, options = {}){
        return this.#run(options.category ?? "server", options.client, client => {
            if(options.guard?.(client)===false)return false
            options.beforeSend?.(client)
            client.chat(message)
            return true
        })
    }

    rememberWindow(client,window){
        if(!window || this.bot.client!==client || client.currentWindow!==window)return
        this.ownedWindow={client,window}
        if(!this.canContinue())this.closeOwnedWindow()
    }

    closeOwnedWindow(){
        const owned=this.ownedWindow;this.ownedWindow=null
        if(!owned || this.bot.client!==owned.client || owned.client.currentWindow!==owned.window || owned.client._client?.state!=='play')return
        // Cancellation cleanup of a window this role acquired; no recovery decision here.
        try{owned.client.closeWindow(owned.window)}catch{this.bot.lifecycleUncertain='SERVER_ACTION_RESULT_UNCERTAIN'}
    }

    clickWindow(slot, button = 0, mode = 0, options = {}){
        return this.#run(options.category ?? "window", options.client, client => {
            options.beforeSend?.(client)
            return client.clickWindow(slot, button, mode)
        })
    }

    closeWindow(window = null, options = {}){
        return this.#run(options.category ?? "window", options.client, client => {
            const target = window ?? client.currentWindow
            if(!target) return false

            client.closeWindow(target)
            return true
        })
    }

    selectHotbar(index, options = {}){
        return this.#run(options.category ?? "inventory", options.client, client => {
            client.setQuickBarSlot(index)
            return true
        })
    }

    moveSlotItem(fromSlot, toSlot, options = {}){
        return this.#run(options.category ?? "inventory", options.client, client => {
            return client.moveSlotItem(fromSlot, toSlot)
        })
    }

    tossStack(item, options = {}){
        return this.#run(options.category ?? "inventory", options.client, client => {
            return this.bot.incidents?this.bot.incidents.drop(client,item,()=>client.tossStack(item)):client.tossStack(item)
        })
    }

    delay(category = "server"){
        return this.delayManager.pause(category)
    }

    #run(category, expectedClient, action){
        const execution = this.queue.then(async () => {
            if(!this.canContinue()) return false

            const client = this.bot.client
            if(!client) return false

            if(expectedClient && client !== expectedClient){
                return false
            }

            await this.delayManager.wait(category)

            if(!this.canContinue()) return false
            if(this.bot.client !== client) return false

            if(expectedClient && client !== expectedClient){
                return false
            }

            const release=this.bot.antiAfk?.acquireBlock('ROLE_SERVER_ACTION')
            try{
                const result = await action(client)
                this.delayManager.markInteraction()
                return result
            }catch(error){this.bot.lifecycleUncertain='SERVER_ACTION_RESULT_UNCERTAIN';throw error}
            finally{release?.()}
        })

        this.queue = execution.catch(() => {})

        return execution
    }
}
