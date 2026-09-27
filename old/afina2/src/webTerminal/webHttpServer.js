import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const publicDirectory = path.resolve(currentDirectory, "public")

const contentTypes = new Map([
    [".html", "text/html; charset=utf-8"],
    [".js", "text/javascript; charset=utf-8"],
    [".css", "text/css; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".svg", "image/svg+xml"],
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".ico", "image/x-icon"]
])

export default class WebHttpServer{
    constructor({
        logger,
        host = "127.0.0.1",
        port = 4000
    }){
        this.logger = logger.child("WebHttpServer")
        this.host = host
        this.port = port
        this.server = null
    }

    start(){
        if(this.server) return false

        this.server = http.createServer((request, response) => {
            this.#handleRequest(request, response).catch(error => {
                this.logger.error("HTTP request failed", {
                    error: error?.message ?? String(error),
                    stack: error?.stack ?? null
                })

                if(!response.headersSent){
                    response.writeHead(500, {
                        "Content-Type": "text/plain; charset=utf-8"
                    })
                }

                response.end("Internal Server Error")
            })
        })

        this.server.listen(this.port, this.host, () => {
            this.logger.info("Web server started", {
                host: this.host,
                port: this.port
            })
        })

        this.server.on("error", error => {
            this.logger.error("Web server error", {
                error: error?.message ?? String(error),
                stack: error?.stack ?? null
            })
        })

        return true
    }

    async stop(){
        if(!this.server) return

        const server = this.server
        this.server = null

        await new Promise(resolve => {
            server.close(() => resolve())
        })

        this.logger.info("Web server stopped")
    }

    async #handleRequest(request, response){
        if(request.method !== "GET" && request.method !== "HEAD"){
            response.writeHead(405, {
                "Content-Type": "text/plain; charset=utf-8"
            })
            response.end("Method Not Allowed")
            return
        }

        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
        const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)
        const relativePath = pathname.replace(/^\/+/, "")
        const filePath = path.resolve(publicDirectory, relativePath)

        if(filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${path.sep}`)){
            response.writeHead(403, {
                "Content-Type": "text/plain; charset=utf-8"
            })
            response.end("Forbidden")
            return
        }

        let stat

        try{
            stat = await fs.stat(filePath)
        }catch{
            response.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8"
            })
            response.end("Not Found")
            return
        }

        if(!stat.isFile()){
            response.writeHead(404, {
                "Content-Type": "text/plain; charset=utf-8"
            })
            response.end("Not Found")
            return
        }

        const contentType = contentTypes.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream"
        const content = request.method === "HEAD" ? null : await fs.readFile(filePath)

        response.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "no-cache"
        })

        response.end(content)
    }
}