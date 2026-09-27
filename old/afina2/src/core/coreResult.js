export function success(data = null){
    return {
        ok: true,
        data
    }
}

export function failure(code, message, details = null){
    return {
        ok: false,
        error: {
            code,
            message,
            details
        }
    }
}