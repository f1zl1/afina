export const InterfaceProtocolVersion = 1

export const InterfaceMessageType = Object.freeze({
    COMMAND: "command",
    QUERY: "query",
    RESPONSE: "response",
    EVENT: "event"
})

export function createResponse({
    requestId,
    result
}){
    if(result?.ok){
        return {
            version: InterfaceProtocolVersion,
            type: InterfaceMessageType.RESPONSE,
            requestId,
            ok: true,
            data: result.data ?? null
        }
    }

    return {
        version: InterfaceProtocolVersion,
        type: InterfaceMessageType.RESPONSE,
        requestId,
        ok: false,
        error: {
            code: result?.error?.code ?? "UNKNOWN_ERROR",
            message: result?.error?.message ?? "Unknown error",
            details: result?.error?.details ?? null
        }
    }
}

export function createEventMessage(event){
    return {
        version: InterfaceProtocolVersion,
        type: InterfaceMessageType.EVENT,
        event
    }
}

export function validateInterfaceRequest(request){
    if(!request || typeof request !== "object" || Array.isArray(request)){
        return {
            ok: false,
            code: "INVALID_REQUEST",
            message: "Request must be an object"
        }
    }

    if(
        request.version !== undefined &&
        request.version !== InterfaceProtocolVersion
    ){
        return {
            ok: false,
            code: "UNSUPPORTED_PROTOCOL_VERSION",
            message: `Unsupported protocol version: ${request.version}`
        }
    }

    if(
        request.type !== InterfaceMessageType.COMMAND &&
        request.type !== InterfaceMessageType.QUERY
    ){
        return {
            ok: false,
            code: "INVALID_REQUEST_TYPE",
            message: `Invalid request type: ${request.type}`
        }
    }

    if(typeof request.name !== "string" || !request.name){
        return {
            ok: false,
            code: "INVALID_REQUEST_NAME",
            message: "Request name must be a non-empty string"
        }
    }

    if(
        request.payload !== undefined &&
        (
            !request.payload ||
            typeof request.payload !== "object" ||
            Array.isArray(request.payload)
        )
    ){
        return {
            ok: false,
            code: "INVALID_REQUEST_PAYLOAD",
            message: "Request payload must be an object"
        }
    }

    return {
        ok: true
    }
}