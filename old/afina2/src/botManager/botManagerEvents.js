export default class BotManagerEvents{
    constructor({
        botManager,
        eventBus
    }){
        this.botManager = botManager
        this.eventBus = eventBus

        this.onSettingUpdated = this.#onSettingUpdated.bind(this)
        this.onSettingsReloaded = this.#onSettingsReloaded.bind(this)
    }

    register(){
        this.eventBus.on("reseller:settingUpdated", this.onSettingUpdated)
        this.eventBus.on("reseller:settingsReloaded", this.onSettingsReloaded)
    }

    #onSettingUpdated(data){
        this.botManager.broadcastEvent(
            "reseller:settingUpdated",
            data
        )
    }

    #onSettingsReloaded({changed = []} = {}){
        for(const setting of changed){
            this.botManager.broadcastEvent(
                "reseller:settingUpdated",
                {
                    settingName: setting.settingName,
                    value: setting.value
                }
            )
        }
    }
}