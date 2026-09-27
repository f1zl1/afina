import {marketPolicyFields} from './market/marketConfig.js'
import {antiAfkFields} from '../minecraftBot/runtime/runtimeConfig.js'
import {incidentPolicyFields} from '../incidents/incidentPolicy.js'
// Validation and UI descriptors share one contract. Defaults live in the DB migration.
export const policyFields = {
    ...incidentPolicyFields,
    ...antiAfkFields,
    ...marketPolicyFields,
    enabled:{type:"boolean",label:"Ядро увімкнено"},
    targetResellers:{type:"integer",min:0,max:1000,label:"Ціль перепродажників · сумісність"},
    targetAnalysts:{type:"integer",min:0,max:1000,label:"Ціль аналітиків · сумісність"},
    maxResellersPerItem:{type:"integer",min:1,max:1000,label:"Максимум перепродажників на товар"},
    autoAllocateBots:{type:"boolean",label:"Автоматичний розподіл ботів"},
    autoSelectItems:{type:"boolean",label:"Вибір із товарів із заданими цінами"},
    autoPricing:{type:"boolean",label:"Автоматичні ціни · не підтримуються"},
    autoAnalysis:{type:"boolean",label:"Автоматичний аналіз ринку"},
    minimumAssignmentDurationMs:{type:"integer",min:0,max:604800000,label:"Мінімальна тривалість призначення, мс"},
    switchCooldownMs:{type:"integer",min:0,max:604800000,label:"Пауза між змінами товару, мс"},
    switchImprovementThresholdPercent:{type:"number",min:0,max:1000,label:"Поріг покращення для зміни товару, %"},
    decisionDebounceMs:{type:"integer",min:20,max:10000,label:"Об’єднання подій, мс"},
    safetyIntervalMs:{type:"integer",min:10000,max:600000,label:"Контрольна перевірка, мс"},
    journalLimit:{type:"integer",min:50,max:10000,label:"Ліміт записів журналу"},
    failureRetryMs:{type:"integer",min:1000,max:3600000,label:"Пауза після помилки, мс"},
    actionTimeoutMs:{type:"integer",min:1000,max:600000,label:"Очікування запуску, мс"}
}
export const overrideFields = {
    disabled:{type:"boolean",label:"Товар вимкнено"},
    minBots:{type:"integer",min:0,max:1000,nullable:true,label:"Мінімум ботів"},
    maxBots:{type:"integer",min:0,max:1000,nullable:true,label:"Максимум ботів"},
    forcedBots:{type:"integer",min:0,max:1000,nullable:true,label:"Точна кількість ботів"},
    maxBuyPrice:{type:"number",min:0.000001,max:1e15,nullable:true,label:"Максимальна ціна купівлі"},
    minSellPrice:{type:"number",min:0.000001,max:1e15,nullable:true,label:"Мінімальна ціна продажу"}
}
export function validateFields(values, fields){
    if(!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Expected a settings object")
    for(const [key,value] of Object.entries(values)){
        const field=fields[key]
        if(!Object.hasOwn(fields,key)) throw new Error(`Unknown field: ${key}`)
        if(value === null && field.nullable) continue
        if(field.type === "boolean"){
            if(typeof value !== "boolean") throw new Error(`${key}: expected boolean`)
        }else if(typeof value !== "number" || !Number.isFinite(value) || value<field.min || value>field.max || (field.type === "integer" && !Number.isInteger(value))){
            throw new Error(`${key}: expected ${field.type} in ${field.min}..${field.max}`)
        }
    }
    return values
}
export function validateOverride(values){
    validateFields(values,overrideFields)
    for(const [low,high] of [["minBots","maxBots"],["minBots","forcedBots"],["forcedBots","maxBots"]]){
        if(values[low]!=null && values[high]!=null && values[low]>values[high]) throw new Error(`${low} must not exceed ${high}`)
    }
}
export const reason = (code,message,data={}) => ({code,message,data})
