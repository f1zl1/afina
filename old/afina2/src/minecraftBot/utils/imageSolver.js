import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import readline from "node:readline"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default class ImageSolver {
    constructor() {
        this.process = null
        this.pending = new Map()
        this.nextId = 1
        this.ready = false
    }

    start() {
        if (this.process) {
            return
        }

        const pythonFile = path.resolve(
            __dirname,
            "../utils/imageSolver.py"
        )

        this.process = spawn(
            "python",
            [pythonFile],
            {
                stdio: [
                    "pipe",
                    "pipe",
                    "pipe"
                ]
            }
        )

        const rl = readline.createInterface({
            input: this.process.stdout
        })

        rl.on("line", line => {
            let message

            try {
                message = JSON.parse(line)
            } catch {
                return
            }

            if (message.type === "ready") {
                this.ready = true
                return
            }

            const request = this.pending.get(
                message.id
            )

            if (!request) {
                return
            }

            this.pending.delete(message.id)

            if (message.error) {
                request.reject(
                    new Error(message.error)
                )
            } else {
                request.resolve(message.result)
            }
        })

        this.process.stderr.on(
            "data",
            data => {
                console.error(
                    "[ImageSolver]",
                    data.toString()
                )
            }
        )

        this.process.on(
            "exit",
            code => {
                this.ready = false
                this.process = null

                for (
                    const { reject }
                    of this.pending.values()
                ) {
                    reject(
                        new Error(
                            `Python worker exited: ${code}`
                        )
                    )
                }

                this.pending.clear()
            }
        )
    }

    solve(imageBuffer) {
        return new Promise(
            (resolve, reject) => {

                if (!this.process) {
                    reject(
                        new Error(
                            "ImageSolver is not running"
                        )
                    )

                    return
                }

                const id = this.nextId++

                this.pending.set(
                    id,
                    {
                        resolve,
                        reject
                    }
                )

                const message = {
                    id,
                    image:
                        imageBuffer.toString("base64")
                }

                this.process.stdin.write(
                    JSON.stringify(message) + "\n"
                )
            }
        )
    }

    stop() {
        if (!this.process) {
            return
        }

        this.process.kill()
        this.process = null
        this.ready = false
    }
}