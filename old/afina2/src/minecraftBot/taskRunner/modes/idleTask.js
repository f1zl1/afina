// Runtime owns Anti-AFK for every role, including idle modes.
export default class IdleTask{
    constructor({bot,taskData,logger}){Object.assign(this,{bot,taskData,logger})}
    async start(){await new Promise(resolve=>{this.finish=resolve})}
    stop(){this.finish?.()}
}
