import MovementPacketTrace from '../../runtime/movementPacketTrace.js'

export default class ConfigurationEvents {
    constructor({ bot }) {
        this.bot = bot
    }

    register(client) {
        const protocol = client._client

        protocol.on(
            "start_configuration",
            () => {
                this.#onStartConfiguration(
                    client
                )
            }
        )

        this.#registerWriteGuard(
            protocol
        )
        this.bot.movementPacketTrace?.dispose()
        this.bot.movementPacketTrace=new MovementPacketTrace({bot:this.bot,client})
    }

    #onStartConfiguration(client) {
        this.bot.afkRecovery?.cancel('CONFIGURATION_RESTARTED')
        this.bot.realmEntryGeneration=(this.bot.realmEntryGeneration ?? 0)+1
        this.bot.realmEntryPending=null
        this.bot.setPositionStatus('realmConnecting')
        client.physicsEnabled = false

        try {
            client.clearControlStates()
        } catch {}
    }

    #registerWriteGuard(protocol) {
        const originalWrite =
            protocol.write.bind(protocol)

        const blockedPackets =
            new Set([
                "position",
                "position_look",
                "flying"
            ])

        protocol.write = (
            name,
            params
        ) => {
            if (
                protocol.state ===
                    "configuration" &&
                blockedPackets.has(name)
            ) {
                return
            }

            return originalWrite(
                name,
                params
            )
        }
    }
}
