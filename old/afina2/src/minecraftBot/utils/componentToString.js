export default function componentToString(component) {
    if (component == null) {
        return ""
    }

    if (typeof component === "string") {
        return component
    }

    if (Array.isArray(component)) {
        return component
            .map(item =>
                componentToString(item)
            )
            .join("")
    }

    if (typeof component !== "object") {
        return String(component)
    }

    if (
        component.type === "string" &&
        typeof component.value === "string"
    ) {
        return component.value
    }

    if (component.text) {
        return componentToString(
            component.text
        )
    }

    if (component.extra) {
        return componentToString(
            component.extra
        )
    }

    if (component.value !== undefined) {
        return componentToString(
            component.value
        )
    }

    return ""
}