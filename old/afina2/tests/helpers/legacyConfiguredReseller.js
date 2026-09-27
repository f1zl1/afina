// TEST ONLY: frozen configured-cycle adapter for pre-migration safety regressions.
import ResellerInventory from "../../src/minecraftBot/taskRunner/modes/reseller/resellerInventory.js"
import ResellerSeller from "../../src/minecraftBot/taskRunner/modes/reseller/resellerSeller.js"
import ResellerAuction from "./legacyResellerAuction.js"
import ResellerBuyer from "../../src/minecraftBot/taskRunner/modes/reseller/resellerBuyer.js"
import ResellerServerDelay from "../../src/minecraftBot/taskRunner/modes/reseller/server/resellerServerDelay.js"
import ResellerServerActions from "../../src/minecraftBot/taskRunner/modes/reseller/server/resellerServerActions.js"
import { sleep } from "../../src/minecraftBot/taskRunner/modes/reseller/resellerUtils.js"
import {randomUUID} from 'node:crypto'
import WorkerWorkload from '../../src/workloads/workerWorkload.js'
import EconomicExecution from '../../src/minecraftBot/taskRunner/modes/reseller/economicExecution.js'
import {emptyEconomicProgress} from '../../src/workloads/economicContract.js'

export default class ResellerTask{
    constructor({
        bot,
        taskData,
        logger,
        eventBus,
        settings,
        manualOnly=false
    }){
        this.bot = bot
        this.manualOnly=manualOnly
        this.workload=new WorkerWorkload({role:'reseller',incarnation:()=>bot.incarnationId,requestDrain:()=>this.requestQuiesce(),completion:()=>this.finished,uncertainty:()=>bot.lifecycleUncertain})
        this.workload.manualEconomicSupported=manualOnly
        this.taskData = taskData
        this.logger = logger
        this.eventBus = eventBus
        this.settings = settings

        this.running = false
        this.paused = false
        this.state = "idle"
        this.cycleRunning = false
        this.realmEnteredAt = null
        this.waitingForSale = false

        const canContinue = () => this.#canContinue()
        const setState = state => this.#setState(state)

        this.serverDelay = new ResellerServerDelay({
            settings: this.settings
        })

        this.server = new ResellerServerActions({
            bot: this.bot,
            canContinue,
            delay: this.serverDelay
        })

        this.inventory = new ResellerInventory({
            bot: this.bot,
            taskData: this.taskData,
            logger: this.logger,
            eventBus: this.eventBus,
            canContinue,
            setState,
            settings: this.settings,
            server: this.server
        })

        this.seller = new ResellerSeller({
            bot: this.bot,
            taskData: this.taskData,
            logger: this.logger,
            eventBus: this.eventBus,
            inventory: this.inventory,
            canContinue,
            setState,
            settings: this.settings,
            server: this.server
        })

        this.auction = new ResellerAuction({
            bot: this.bot,
            inventory: this.inventory,
            logger: this.logger,
            eventBus: this.eventBus,
            canContinue,
            setState,
            settings: this.settings,
            server: this.server
        })

        this.buyer = new ResellerBuyer({
            bot: this.bot,
            taskData: this.taskData,
            logger: this.logger,
            eventBus: this.eventBus,
            inventory: this.inventory,
            canContinue,
            setState,
            settings: this.settings,
            server: this.server
        })


        this.onBalanceUpdated = data => {
            if(data?.botId !== this.bot.botId) return

            const oldBalance = Number(data.oldBalance)
            const newBalance = Number(data.balance)

            if(!Number.isFinite(oldBalance) || !Number.isFinite(newBalance)){
                return
            }

            if(newBalance > oldBalance){
                this.waitingForSale = false
                this.auction.resetOutOfFunds()
                this.auction.requestCapacityProbe()
            }
        }

        this.eventBus.on("bot:balanceUpdated", this.onBalanceUpdated)
    }

    async start(){
        if(this.manualOnly)return this.startManual()
        if(this.running) return

        let drained;this.finished=new Promise(resolve=>{drained=resolve})

        this.running = true
        this.realmEnteredAt = null
        this.waitingForSale = false
        this.#setState("starting")
        this.logger.info(`Bot ${this.bot.botId}: reseller started`)

        try{
            while(this.running){
                // Finish the current cycle; never cancel an economic operation
                // merely because the parent requested a normal graceful stop.
                if(this.quiescing){this.server.closeOwnedWindow();break}
                if(this.paused){
                    this.#setState("paused")
                    await sleep(this.#setting("idleLoopDelayMs", 250))
                    continue
                }

                if(!this.bot.client || this.bot.positionStatus !== "realm"){
                    this.realmEnteredAt = null
                    this.#setState("waiting_for_realm")
                    await sleep(this.#setting("waitingForRealmDelayMs", 500))
                    continue
                }

                if(!await this.#waitForRealmStart()){
                    continue
                }

                if(this.cycleRunning){
                    await sleep(this.#setting("cycleBusyDelayMs", 50))
                    continue
                }

                this.cycleRunning = true
                const workloadId=randomUUID()
                const blocked=this.workload.begin({workloadId,type:'reseller_cycle',owner:'configured_role',incarnationId:this.bot.incarnationId,generation:this.workload.generation})
                if(blocked){this.cycleRunning=false;await sleep(this.#setting('cycleErrorRetryDelayMs',1000));continue}
                this.workload.progress(workloadId,this.state)

                try{
                    await this.#runCycle()

                    if(this.#canContinue()){
                        await this.bot.antiAfk?.performIfDue()
                    }
                }catch(error){
                    this.bot.lifecycleUncertain='TRANSACTION_RESULT_UNCERTAIN'
                    this.#handleError("cycle", error)
                    await sleep(this.#setting("cycleErrorRetryDelayMs", 1000))
                }finally{
                    this.cycleRunning = false
                    this.workload.finish(workloadId,this.bot.lifecycleUncertain?'FAILED':this.running?'COMPLETED':'CANCELLED',this.bot.lifecycleUncertain??(this.running?null:'CANCELLED'))
                }
            }
        }finally{
            this.running = false
            this.cycleRunning = false
            this.realmEnteredAt = null
            this.waitingForSale = false
            this.#removeEventListener("bot:balanceUpdated", this.onBalanceUpdated)
            this.#setState("stopped")
            this.logger.info(`Bot ${this.bot.botId}: reseller stopped`)
            drained()
        }
    }

    stop(){
        if(this.manualOnly){this.running=false;this.economicJob?.execution.cancel();this.finishManual?.();return}
        this.running = false
        this.server.closeOwnedWindow()
    }

    requestQuiesce(){this.quiescing=true;if(this.manualOnly)this.stop()}

    async startManual(){
        this.running=true;this.state='idle'
        let drained;this.finished=new Promise(resolve=>{drained=resolve})
        const assign=task=>{void this.assignEconomic(task)}
        const cancel=task=>{const job=this.economicJob;if(job&&['workloadId','incarnationId','lifecycleEpoch','workloadGeneration'].every(k=>job.task[k]===task?.[k]))job.execution.cancel()}
        this.eventBus.on('core:economic.assign',assign);this.eventBus.on('core:economic.cancel',cancel)
        this.eventBus.emit('bot:resellerStateUpdated',{botId:this.bot.botId,state:'idle'})
        try{await new Promise(resolve=>{this.finishManual=resolve})}
        finally{this.eventBus.off('core:economic.assign',assign);this.eventBus.off('core:economic.cancel',cancel);await this.economicJob?.finished;this.running=false;this.state='stopped';this.#removeEventListener('bot:balanceUpdated',this.onBalanceUpdated);drained()}
    }
    async assignEconomic(task){
        if(!this.manualOnly||!this.running||this.quiescing||this.economicJob)return
        if(this.workload.begin({workloadId:task?.workloadId,type:'manual_economic',owner:'manual',incarnationId:task?.incarnationId,generation:task?.workloadGeneration}))return
        let execution
        try{execution=new EconomicExecution({bot:this.bot,eventBus:this.eventBus,logger:this.logger,settings:this.settings,task,workload:this.workload})}
        catch{this.workload.finish(task.workloadId,'FAILED','INVALID_ECONOMIC_REQUEST');this.eventBus.emit('bot:economic.result',{workloadId:task.workloadId,incarnationId:task.incarnationId,lifecycleEpoch:task.lifecycleEpoch,workloadGeneration:task.workloadGeneration,sequence:1,status:'FAILED',progress:emptyEconomicProgress(),reason:'INVALID_ECONOMIC_REQUEST'});return}
        const job={task,execution};this.economicJob=job;this.state='economic_workload'
        job.finished=execution.run()
        try{await job.finished}finally{this.economicJob=null;this.state='idle';this.eventBus.emit('bot:resellerStateUpdated',{botId:this.bot.botId,state:'idle'})}
    }

    pause(){
        this.paused = true
    }

    resume(){
        this.paused = false
    }

    async #waitForRealmStart(){
        if(this.realmEnteredAt === null){
            this.realmEnteredAt = Date.now()

            this.#setState("waiting_realm_unlock")

            this.logger.info(`Bot ${this.bot.botId}: waiting for realm auction unlock`, {
                delayMs: this.#setting("realmStartDelayMs", 15000)
            })
        }

        const delay = this.#setting("realmStartDelayMs", 15000)
        const remaining = delay - (Date.now() - this.realmEnteredAt)

        if(remaining <= 0){
            return true
        }

        await sleep(
            Math.min(
                remaining,
                this.#setting("idleLoopDelayMs", 250)
            )
        )

        return false
    }

    async #runCycle(){
        await this.inventory.cleanup()

        if(!this.#canContinue()||this.quiescing) return

        const targetItem = this.inventory.findTarget()

        if(!targetItem){
            if(this.waitingForSale){
                await this.#handleWaitingForSale()
                return
            }

            const buyResult = await this.buyer.buyUntilSuccess()

            if(!this.#canContinue()) return

            if(
                buyResult === "success" ||
                buyResult === "already_have_item"
            ){
                this.waitingForSale = false
                await sleep(this.#setting("cycleSuccessDelayMs", 50))
                return
            }

            if(buyResult === "insufficient_balance"){
                this.waitingForSale = true
                await this.#handleWaitingForSale()
                return
            }

            await sleep(this.#setting("cycleRetryDelayMs", 250))
            return
        }

        this.waitingForSale = false
        this.auction.resetOutOfFunds()

        if(this.auction.isStorageFull()){
            await this.auction.handleStorageFull()

            if(!this.#canContinue()) return

            if(!this.auction.canProbeCapacity()){
                const remaining = this.auction.getCapacityProbeRemainingTime()

                await sleep(
                    Math.min(
                        Math.max(
                            remaining,
                            this.#setting("capacityProbeMinDelayMs", 50)
                        ),
                        this.#setting("capacityProbeMaxDelayMs", 250)
                    )
                )

                return
            }

            this.auction.markCapacityProbeStarted()
            this.#setState("probing_auction_capacity")

            const result = await this.seller.sellOne(targetItem)

            if(result === "afk"){
                this.#setState("recovering_afk")
                return
            }

            if(result === "success"){
                this.auction.markStorageAvailable()
                await sleep(this.#setting("cycleSuccessDelayMs", 50))
                return
            }

            if(result === "storage_full"){
                this.auction.markStorageFull()
                await sleep(this.#setting("storageFullRetryDelayMs", 100))
                return
            }

            await sleep(this.#setting("cycleRetryDelayMs", 250))
            return
        }

        const result = await this.seller.sellOne(targetItem)

        if(result === "afk"){
            this.#setState("recovering_afk")
            return
        }

        if(result === "storage_full"){
            this.auction.markStorageFull()
            await this.auction.handleStorageFull()
            return
        }

        if(result === "success"){
            await sleep(this.#setting("cycleSuccessDelayMs", 50))
            return
        }

        await sleep(this.#setting("cycleFallbackDelayMs", 300))
    }

    async #handleWaitingForSale(){
        const result = await this.auction.handleLowBalance()

        if(!this.#canContinue()) return

        if(result === "waiting_for_sale"){
            this.#setState("waiting_for_sale")
        }else if(result === "out_of_funds"){
            this.#setState("out_of_funds")
        }else{
            this.#setState("checking_sale_liquidity")
        }

        await sleep(this.#setting("waitingForSaleLoopDelayMs", 1000))
    }

    #canContinue(){
        return Boolean(
            this.running &&
            !this.paused &&
            this.bot.client &&
            this.bot.positionStatus === "realm"
        )
    }

    #setState(state){
        if(this.state === state) return

        const oldState = this.state
        this.state = state
        if(this.workload?.value.workloadId)this.workload.progress(this.workload.value.workloadId,state)

        this.logger.info(
            `Bot ${this.bot.botId}: reseller ${oldState} -> ${state}`
        )

        this.eventBus.emit("bot:resellerStateUpdated", {
            botId: this.bot.botId,
            oldState,
            state
        })
    }

    #setting(name, fallback){
        return this.settings?.get(name, fallback) ?? fallback
    }

    #removeEventListener(event, listener){
        if(typeof this.eventBus.off === "function"){
            this.eventBus.off(event, listener)
            return
        }

        if(typeof this.eventBus.removeListener === "function"){
            this.eventBus.removeListener(event, listener)
        }
    }

    #handleError(stage, error){
        const message = error?.message ?? String(error)

        this.logger.error(
            `Bot ${this.bot.botId}: reseller error at ${stage}`,
            {error: message}
        )

        this.eventBus.emit("bot:resellerError", {
            botId: this.bot.botId,
            stage,
            error: message
        })
    }
}
