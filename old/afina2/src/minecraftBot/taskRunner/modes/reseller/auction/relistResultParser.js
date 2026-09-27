export default class RelistResultParser{
    parse(text){
        const normalized = String(text ?? "").toLowerCase()

        if(normalized.includes("предметы успешно перевыставлены")){
            return "success"
        }

        if(normalized.includes("не удалось")){
            return "failed"
        }

        return null
    }
}