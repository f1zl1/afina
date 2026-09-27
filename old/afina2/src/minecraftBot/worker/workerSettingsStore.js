export default class WorkerSettingsStore{
    constructor({
        settings = {},
        eventBus
    }){
        this.settings = new Map(Object.entries(settings))
        this.eventBus = eventBus

        this.onSettingUpdated = this.#onSettingUpdated.bind(this)

        this.eventBus.on(
            "reseller:settingUpdated",
            this.onSettingUpdated
        )
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

    destroy(){
        this.eventBus.off(
            "reseller:settingUpdated",
            this.onSettingUpdated
        )
    }

    #onSettingUpdated({settingName, value} = {}){
        if(!settingName) return

        this.settings.set(settingName, value)
    }
}