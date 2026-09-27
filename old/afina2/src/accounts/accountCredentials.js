import { randomInt } from "node:crypto"

const names = ["Alex", "Milo", "Leo", "Niko", "Aron", "Luca", "Theo", "Finn", "Robin", "Oscar", "Felix", "Oliver", "Max", "Evan", "Dylan", "Noah", "Kai", "Riley", "Logan", "Jasper", "Toby", "Sam", "Aiden", "Owen", "Remy", "Nolan", "Ellis", "Jamie", "Chris", "Morgan", "Rowan", "Emery"]
const words = ["River", "Fox", "Pine", "Wolf", "Stone", "Cloud", "Raven", "Oak", "Lake", "Storm", "Frost", "Leaf", "Hawk", "Birch", "Moon", "Ash", "Hill", "Vale", "Cedar", "Reed", "Trail", "Dawn", "Brook", "Night", "Flint", "Snow", "Finch", "Breeze", "Grove", "Ember", "Moss", "Drift"]
const adjectives = ["Quiet", "Little", "Silver", "Blue", "Lucky", "Sunny", "Wild", "Rusty", "Brave", "Gentle", "Sleepy", "Swift", "Cozy", "Misty", "Golden", "Happy"]
const pick = values => values[randomInt(values.length)]

export function generateUsername(){
    const style = randomInt(4)
    let name
    if(style === 0) name = pick(names) + pick(words)
    else if(style === 1) name = pick(adjectives) + pick(words)
    else if(style === 2) name = pick(names) + "_" + pick(words)
    else name = pick(names) + pick(words).toLowerCase()
    if(randomInt(3) === 0) name = name.slice(0, 14) + randomInt(10, 100)
    return name
}

export function generatePassword(){
    const lower = "abcdefghijklmnopqrstuvwxyz"
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    const digits = "0123456789"
    const alphabet = lower + upper + digits
    const characters = [pick(lower), pick(upper), pick(digits)]
    while(characters.length < 24) characters.push(pick(alphabet))
    for(let index = characters.length - 1; index > 0; index--){
        const other = randomInt(index + 1)
        ;[characters[index], characters[other]] = [characters[other], characters[index]]
    }
    return characters.join("")
}

export function generateCredentials(){
    return {username: generateUsername(), password: generatePassword()}
}
