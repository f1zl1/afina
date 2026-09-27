export default function nbtComponentToString(node) {
    if (node == null) {
        return ""
    }

    if (
        typeof node === "string"
    ) {
        return node
    }

    if (
        Array.isArray(node)
    ) {
        return node
            .map(
                nbtComponentToString
            )
            .join("")
    }

    if (
        node.type === "string" &&
        typeof node.value === "string"
    ) {
        return node.value
    }

    if (
        node.type === "compound" &&
        node.value
    ) {
        return nbtComponentToString(
            node.value
        )
    }

    if (
        node.type === "list" &&
        node.value
    ) {
        const value =
            node.value

        if (
            Array.isArray(value)
        ) {
            return value
                .map(
                    nbtComponentToString
                )
                .join("")
        }

        if (
            Array.isArray(
                value.value
            )
        ) {
            return value.value
                .map(
                    nbtComponentToString
                )
                .join("")
        }

        return ""
    }

    if (
        typeof node === "object"
    ) {
        let result = ""

        if (
            node.text !== undefined
        ) {
            result +=
                nbtComponentToString(
                    node.text
                )
        }

        if (
            node.extra !== undefined
        ) {
            result +=
                nbtComponentToString(
                    node.extra
                )
        }

        return result
    }

    return ""
}