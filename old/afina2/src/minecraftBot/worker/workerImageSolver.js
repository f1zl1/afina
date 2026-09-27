export default class WorkerImageSolver{
    constructor(){
        this.pending = new Map()
        this.nextId = 1
    }

    solve(imageBuffer){
        return new Promise((resolve, reject) => {
            if(!process.connected){
                reject(new Error("Parent process is not connected"))
                return
            }

            if(!Buffer.isBuffer(imageBuffer)){
                reject(new TypeError("imageBuffer must be a Buffer"))
                return
            }

            const id = this.nextId++

            const timeout = setTimeout(() => {
                this.pending.delete(id)
                reject(new Error("Image solver RPC timed out"))
            }, 30_000)

            this.pending.set(id, {
                resolve,
                reject,
                timeout
            })

            try{
                process.send({
                    type: "rpc:request",
                    service: "imageSolver",
                    id,
                    payload: {
                        image: imageBuffer.toString("base64")
                    }
                })
            }catch(error){
                clearTimeout(timeout)
                this.pending.delete(id)
                reject(error)
            }
        })
    }

    handleResponse(message){
        const request = this.pending.get(message.id)
        if(!request) return false

        clearTimeout(request.timeout)
        this.pending.delete(message.id)

        if(message.error){
            request.reject(new Error(message.error))
        }else{
            request.resolve(message.result)
        }

        return true
    }

    destroy(){
        for(const request of this.pending.values()){
            clearTimeout(request.timeout)
            request.reject(new Error("Worker image solver destroyed"))
        }

        this.pending.clear()
    }
}