import fs from "node:fs"

export default class ConfigManager{
    async telegramConfig(){
        const config = JSON.parse(fs.readFileSync("./src/config/telegram.json", "utf8"))
        return {...config,apiId:Number(process.env.TELEGRAM_API_ID),apiHash:process.env.TELEGRAM_API_HASH ?? ""}
    }
    async botManagerConfig(){
        return JSON.parse(fs.readFileSync("./src/config/botManager.json", "utf8") || "{}")
    }
    async loggerConfig(){
        const config = JSON.parse(
            fs.readFileSync("./src/config/logger.json", "utf8")
        )
        return config
    }
    async eventBusConfig(){
        const config = JSON.parse(
            fs.readFileSync("./src/config/eventBus.json", "utf8")
        )
        return config
    }
    async dataBaseManagerConfig(){
        const config = JSON.parse(
            fs.readFileSync("./src/config/dataBaseManager.json", "utf8")
        )
        return config
    }
    async captchaSolverConfig(){
        const config = JSON.parse(
            fs.readFileSync("./src/config/captchaSolver.json", "utf8")
        )
        return config
    }
}
