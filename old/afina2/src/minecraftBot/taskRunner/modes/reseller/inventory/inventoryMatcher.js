export default class InventoryMatcher{
    constructor({taskData}){
        this.taskData = taskData
    }

    isTarget(item){
        if(!item) return false

        const matcher = this.taskData.item?.matcher
        if(!matcher) return false

        if(
            matcher.minecraftName &&
            item.name !== matcher.minecraftName
        ){
            return false
        }

        if(matcher.potionId !== undefined){
            const potion = item.components?.find(
                component => component.type === "potion_contents"
            )

            if(potion?.data?.potionId !== matcher.potionId){
                return false
            }
        }

        return true
    }
}