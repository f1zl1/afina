import fs from "node:fs/promises"
import path from "node:path"

export default class RotatingLogWriter{
    constructor({
        directory,
        prefix,
        maxBytes,
        maxEntries
    }){
        this.directory = directory
        this.prefix = prefix
        this.maxBytes = maxBytes
        this.maxEntries = maxEntries

        this.currentDate = null
        this.currentIndex = null
        this.currentPath = null
        this.currentBytes = 0
        this.currentEntries = 0
        this.queue = Promise.resolve()
    }

    write(entry){
        const line = JSON.stringify(entry) + "\n"

        this.queue = this.queue
            .then(() => this.#write(line))
            .catch(error => {
                console.error("[Logger] Failed to write log:", error)
            })

        return this.queue
    }

    async #write(line){
        const date = this.#dateString()
        const bytes = Buffer.byteLength(line, "utf8")

        await this.#ensureFile(date, bytes)

        await fs.appendFile(
            this.currentPath,
            line,
            "utf8"
        )

        this.currentBytes += bytes
        this.currentEntries++
    }

    async #ensureFile(date, incomingBytes){
        if(!this.currentPath || this.currentDate !== date){
            await this.#openLatestFile(date)
        }

        const sizeLimitReached =
            this.currentBytes + incomingBytes >
            this.maxBytes

        const entryLimitReached =
            this.currentEntries >=
            this.maxEntries

        if(sizeLimitReached || entryLimitReached){
            await this.#openFile(
                date,
                this.currentIndex + 1
            )
        }
    }

    async #openLatestFile(date){
        await fs.mkdir(this.directory, {
            recursive: true
        })

        const files = await fs.readdir(this.directory)

        const pattern = new RegExp(
            `^${this.#escapeRegex(this.prefix)}-${date}-(\\d{3})\\.log$`
        )

        let highestIndex = 0

        for(const file of files){
            const match = file.match(pattern)
            if(!match) continue

            highestIndex = Math.max(
                highestIndex,
                Number(match[1])
            )
        }

        const index = highestIndex || 1

        await this.#openFile(date, index)

        if(
            this.currentBytes >= this.maxBytes ||
            this.currentEntries >= this.maxEntries
        ){
            await this.#openFile(date, index + 1)
        }
    }

    async #openFile(date, index){
        await fs.mkdir(this.directory, {
            recursive: true
        })

        const fileName =
            `${this.prefix}-${date}-${String(index).padStart(3, "0")}.log`

        const filePath = path.join(
            this.directory,
            fileName
        )

        let stats = null

        try{
            stats = await fs.stat(filePath)
        }catch{}

        this.currentDate = date
        this.currentIndex = index
        this.currentPath = filePath
        this.currentBytes = stats?.size ?? 0
        this.currentEntries = await this.#countEntries(filePath)
    }

    async #countEntries(filePath){
        try{
            const content = await fs.readFile(
                filePath,
                "utf8"
            )

            if(!content) return 0

            let count = 0

            for(let i = 0; i < content.length; i++){
                if(content.charCodeAt(i) === 10){
                    count++
                }
            }

            return count
        }catch{
            return 0
        }
    }

    #dateString(){
        return new Date()
            .toISOString()
            .slice(0, 10)
    }

    #escapeRegex(value){
        return value.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
        )
    }
}