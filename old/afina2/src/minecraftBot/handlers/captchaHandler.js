import FlayerCaptcha from "flayercaptcha"

export default class CaptchaHandler {
    constructor({
        bot,
        eventBus,
        logger,
        imageSolver
    }) {
        this.bot = bot
        this.eventBus = eventBus
        this.logger = logger
        this.imageSolver = imageSolver

        this.captcha = null
    }

    register(client) {
        this.captcha = new FlayerCaptcha(
            client,
            {
                delay: 150,
                isStopped: false
            }
        )

        this.captcha.on(
            "imageReady",
            async ({ data, image }) => {
                if(this.bot.positionStatus === "captcha")
                await this.#handleImage(
                    data,
                    image
                )
            }
        )
    }

    async #handleImage(data, image) {
    try {
        if (data.facing !== "forward") {
            return
        }

        this.eventBus.emit(
            "bot:captchaDetected",
            {
                botId: this.bot.botId
            }
        )

        let imageBuffer

        if (Buffer.isBuffer(image)) {
            imageBuffer = image
        } else if (
            image &&
            typeof image.toBuffer === "function"
        ) {
            imageBuffer = await image
                .png()
                .toBuffer()
        } else {
            throw new TypeError(
                `Unsupported image type: ${
                    image?.constructor?.name ??
                    typeof image
                }`
            )
        }

        const result =
            await this.imageSolver.solve(
                imageBuffer
            )

        if (!result) {
            this.#emitError(
                "Image solver returned no result"
            )
            return
        }

        if (result.error) {
            this.#emitError(result.error)
            return
        }
        if(this.bot.positionStatus === "captcha"){
        this.bot.client.chat(result.captcha)}
        console.log(
            "Image solver result:",
            result
        )

    } catch (error) {
        this.#emitError(
            error?.message ?? String(error),
            error?.stack
        )
    }
}

    #emitError(error, stack = null) {
        this.eventBus.emit(
            "bot:captchaError",
            {
                botId: this.bot.botId,
                error,
                stack
            }
        )
    }

    destroy() {
        this.captcha = null
    }
}