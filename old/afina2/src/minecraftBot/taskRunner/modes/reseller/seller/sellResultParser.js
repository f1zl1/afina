export default class SellResultParser{
    parse(text){
        const normalized = String(text ?? "").toLowerCase()

        if(normalized.includes("выставлен на продажу за")){
            return "success"
        }

        if(
            normalized.includes("не удалось выставить") &&
            normalized.includes("освободите хранилище")
        ){
            return "storage_full"
        }

        if(
            normalized.includes("команда недоступна в режиме afk") ||
            normalized.includes("команда недоступна в режиме афк")
        ){
            return "afk"
        }

        return null
    }
}