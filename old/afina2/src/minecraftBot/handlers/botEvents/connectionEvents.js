import componentToString
    from "../../utils/componentToString.js"

export default class ConnectionEvents {
    constructor({
        bot,
        botId,
        eventBus,
        messageEvents
    }) {
        this.bot = bot
        this.botId = botId
        this.eventBus = eventBus
        this.messageEvents = messageEvents
    }

    register(client) {
        client.on(
            "spawn",
            () => {
                this.#onSpawn(
                    client
                )
            }
        )

        client.on(
            "message",
            (message, position, sender) => {
                this.#onMessage(
                    message, position, sender
                )
            }
        )

        client.on(
            "error",
            error => {
                this.#onError(
                    error
                )
            }
        )

        client.on(
            "kicked",
            reason => {
                this.#onKicked(
                    reason
                )
            }
        )

        client.on(
            "end",
            reason => {
                this.#onEnd(
                    client,
                    reason
                )
            }
        )
    }

    #onSpawn(client) {
        client.physicsEnabled =
            true

        this.bot.setStatus(
            "running"
        )
    }

    #onMessage(message, position, sender) {
        this.messageEvents
            .acceptMessage({
                message, position, sender
            })
            .catch(error => {
                this.eventBus.emit(
                    "bot:error",
                    {
                        botId:
                            this.botId,

                        error:
                            error?.message ??
                            String(error),

                        stack:
                            error?.stack ??
                            null
                    }
                )
            })
    }

    #onError(error) {
        this.eventBus.emit(
            "bot:error",
            {
                botId:
                    this.botId,

                error:
                    error?.message ??
                    String(error),

                stack:
                    error?.stack ??
                    null
            }
        )
    }

    #onKicked(reason) {
        const text =
            componentToString(
                reason
            )
        this.bot.incidents?.handle(text)
        this.bot.incidents?.stop()

        this.eventBus.emit(
            "bot:kicked",
            {
                botId:
                    this.botId,

                reason:
                    text,
                rawReason: reason
            }
        )
    }

    #onEnd(
        client,
        reason
    ) {
        this.bot.incidents?.stop()
        client.physicsEnabled =
            false

        try {
            client.clearControlStates()
        } catch {}

        if (
            this.bot.client ===
            client
        ) {
            this.bot.client =
                null
        }

        this.bot.captcha =
            null

        this.bot.setStatus(
            "offline"
        )

        this.eventBus.emit(
            "bot:disconnected",
            {
                botId:
                    this.botId,

                reason
            }
        )
    }
}
