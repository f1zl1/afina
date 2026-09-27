const integer=(label,min,max,defaultValue)=>({type:'integer',label,min,max,defaultValue,group:'runtime'})
export const antiAfkFields={
    antiAfkEnabled:{type:'boolean',label:'Anti-AFK увімкнено',defaultValue:true,group:'runtime'},
    antiAfkMinIntervalMs:integer('Мінімальний інтервал, мс',1,3600000,35000),
    antiAfkMaxIntervalMs:integer('Максимальний інтервал, мс',1,3600000,50000),
    antiAfkForwardBlocks:{type:'number',label:'Відстань вперед, блоків',min:0.1,max:16,defaultValue:2,group:'runtime'},
    antiAfkBackwardBlocks:{type:'number',label:'Відстань назад, блоків',min:0.1,max:16,defaultValue:2,group:'runtime'},
    antiAfkMovementTimeoutMs:integer('Timeout руху, мс',1,60000,10000),
    antiAfkRetryDelayMs:integer('Пауза перед повтором, мс',0,60000,5000)
}
export function runtimeConfig(policy={}){
    return Object.fromEntries(Object.entries(antiAfkFields).map(([key,f])=>[key[7].toLowerCase()+key.slice(8),f.type==='boolean'?Boolean(policy[key] ?? f.defaultValue):policy[key] ?? f.defaultValue]))
}
export function validateAntiAfk(config){
    for(const [key,f] of Object.entries(antiAfkFields)){
        const name=key[7].toLowerCase()+key.slice(8),v=config[name]
        if(f.type==='boolean' ? typeof v!=='boolean' : !Number.isFinite(v) || v<f.min || v>f.max || (f.type==='integer' && !Number.isInteger(v))) throw new Error(`Invalid Anti-AFK ${name}`)
    }
    if(config.maxIntervalMs<config.minIntervalMs) throw new Error('Anti-AFK maxIntervalMs must be >= minIntervalMs')
    return config
}
