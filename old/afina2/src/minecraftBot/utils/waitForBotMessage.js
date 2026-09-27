export default function waitForBotMessage({
    eventBus,
    botId,
    matcher,
    timeout = 5000,
    signal = null
}) {
    return new Promise(
        resolve => {
            let finished = false
            let timer = null

            const finish =
                result => {
                    if (finished) {
                        return
                    }

                    finished = true

                    if (timer) {
                        clearTimeout(
                            timer
                        )
                    }

                    eventBus.off(
                        "bot:message",
                        onMessage
                    )

                    if (signal) {
                        signal.removeEventListener(
                            "abort",
                            onAbort
                        )
                    }

                    resolve(
                        result
                    )
                }

            const onMessage =
                data => {
                    if (
                        data?.botId !==
                        botId
                    ) {
                        return
                    }

                    const text =
                        String(
                            data.text ??
                            ""
                        )

                    const result =
                        matcher(
                            text,
                            data
                        )

                    if (
                        result === null ||
                        result === undefined ||
                        result === false
                    ) {
                        return
                    }

                    finish(
                        result
                    )
                }

            const onAbort =
                () => {
                    finish(
                        "cancelled"
                    )
                }

            eventBus.on(
                "bot:message",
                onMessage
            )

            if (signal) {
                if (signal.aborted) {
                    finish(
                        "cancelled"
                    )

                    return
                }

                signal.addEventListener(
                    "abort",
                    onAbort,
                    {
                        once: true
                    }
                )
            }

            timer =
                setTimeout(
                    () => {
                        finish(
                            "timeout"
                        )
                    },
                    timeout
                )
        }
    )
}