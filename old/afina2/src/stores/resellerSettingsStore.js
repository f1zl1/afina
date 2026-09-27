export default class ResellerSettingsStore{
    constructor({dataBaseManager, eventBus, logger}){
        this.dataBaseManager = dataBaseManager
        this.eventBus = eventBus
        this.logger = logger.child("ResellerSettingsStore")
        this.settings = new Map()
        this.subscribed = false

        this.onSettingUpdated = this.#onSettingUpdated.bind(this)
    }

    async load(){
        const rows = await this.dataBaseManager.getResellerSettings()

        this.settings.clear()

        for(const row of rows){
            this.settings.set(row.settingName, row.value)
        }

        if(!this.subscribed){
            this.eventBus.on("reseller:settingUpdated", this.onSettingUpdated)
            this.subscribed = true
        }

        this.logger.info("Reseller settings loaded", {
            count: this.settings.size
        })

        return this.getAll()
    }

    get(settingName, defaultValue = null){
        return this.settings.has(settingName)
            ? this.settings.get(settingName)
            : defaultValue
    }

    has(settingName){
        return this.settings.has(settingName)
    }

    getAll(){
        return Object.fromEntries(this.settings)
    }

    async set(settingName, value){
        return this.dataBaseManager.updateResellerSetting(settingName, value)
    }

    async reload(){
        const oldSettings = new Map(this.settings)
        const rows = await this.dataBaseManager.getResellerSettings()

        this.settings.clear()

        for(const row of rows){
            this.settings.set(row.settingName, row.value)
        }

        const changed = []

        for(const [settingName, value] of this.settings){
            const oldValue = oldSettings.get(settingName)

            if(oldValue !== value){
                changed.push({
                    settingName,
                    oldValue,
                    value
                })
            }
        }

        this.eventBus.emit("reseller:settingsReloaded", {changed})

        this.logger.info("Reseller settings reloaded", {
            count: this.settings.size,
            changed: changed.length
        })

        return changed
    }

    destroy(){
        if(!this.subscribed) return

        this.eventBus.off("reseller:settingUpdated", this.onSettingUpdated)
        this.subscribed = false
    }

    #onSettingUpdated({settingName, value}){
        if(!settingName) return

        this.settings.set(settingName, value)

        this.logger.info(`Reseller setting applied: ${settingName}`, {
            value
        })
    }
}