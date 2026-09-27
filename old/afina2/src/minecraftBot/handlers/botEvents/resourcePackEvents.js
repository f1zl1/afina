export default class ResourcePackEvents {
    constructor({
        botId,
        eventBus
    }) {
        this.botId = botId
        this.eventBus = eventBus
    }

    register(client) {
        const protocol =
            client._client

        protocol.on(
            "select_known_packs",
            () => {
                this.#onKnownPacks(
                    protocol
                )
            }
        )

        protocol.on(
            "add_resource_pack",
            data => {
                this.#onResourcePack(
                    protocol,
                    data
                )
            }
        )
    }

    #onKnownPacks(protocol) {
        protocol.write(
            "select_known_packs",
            {
                packs: []
            }
        )
    }

    #onResourcePack(
        protocol,
        data
    ) {
        const uuid =
            typeof data.uuid === "string"
                ? data.uuid
                : data.uuid
                    ?.toString?.() ?? ""

        try {
            protocol.write(
                "resource_pack_receive",
                {
                    uuid,
                    result: 3
                }
            )

            protocol.write(
                "resource_pack_receive",
                {
                    uuid,
                    result: 0
                }
            )
        } catch (error) {
            this.eventBus.emit(
                "bot:error",
                {
                    botId: this.botId,

                    error:
                        error?.message ??
                        String(error),

                    stack:
                        error?.stack ??
                        null
                }
            )
        }
    }
}