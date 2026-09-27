import nbtComponentToString
    from "../../utils/nbtComponentToString.js"



export default class SidebarEvents {
    constructor({
        bot,
        botId,
        eventBus,
        logger = null
    }) {
        this.bot =
            bot

        this.botId =
            botId

        this.eventBus =
            eventBus

        this.logger =
            logger

        this.teams =
            new Map()

        this.lastBalanceLine =
            null
    }


    register(client) {
        const protocol =
            client._client

        this.eventBus.on('bot:positionStatusUpdated',data=>{
            if(data.botId===this.botId && data.newStatus!=='realm'){
                this.teams.clear();this.lastBalanceLine=null
            }
        })

        protocol.on(
            "teams",
            packet => {
                this.#onTeam(
                    packet
                )
            }
        )


        protocol.on(
            "start_configuration",
            () => {

                this.teams.clear()

                this.lastBalanceLine =
                    null
            }
        )
    }


    #onTeam(packet) {
        const teamName =
            packet.team


        if (!teamName) {
            return
        }


        if (
            packet.mode === "add"
        ) {
            this.teams.set(
                teamName,
                {
                    prefix:
                        packet.prefix ??
                        null,

                    suffix:
                        packet.suffix ??
                        null
                }
            )
        }


        if (
            packet.mode === "change" ||
            packet.mode === "update"
        ) {
            const oldTeam =
                this.teams.get(
                    teamName
                ) ?? {
                    prefix:
                        null,

                    suffix:
                        null
                }


            this.teams.set(
                teamName,
                {
                    prefix:
                        packet.prefix ??
                        oldTeam.prefix,

                    suffix:
                        packet.suffix ??
                        oldTeam.suffix
                }
            )
        }


        if (
            packet.mode === "remove"
        ) {
            this.teams.delete(
                teamName
            )
        }


        const freshRealmLine=teamName.startsWith('TAB-Sidebar-') && ['add','change','update'].includes(packet.mode) && (packet.prefix!=null || packet.suffix!=null)
        this.#updateSidebarState(freshRealmLine)
    }


    #updateSidebarState(freshRealmLine) {
        const lines =
            this.#getSidebarLines()


        if (
            lines.length === 0
        ) {
            return
        }


        this.#checkRealmStatus(
            lines, freshRealmLine
        )


        this.#updateBalance(
            lines
        )
    }


    #checkRealmStatus(lines, freshRealmLine) {
        if(this.bot.positionStatus==='dead')return
        if(this.bot.positionStatus==='afk' || !freshRealmLine)return
        if(this.bot.requestedRealm!==this.bot.accountData.realm) return
        if (
            this.bot.positionStatus ===
            "realm"
        ) {
            return
        }


        const text =
            lines
                .join("\n")
                .toLowerCase()


        const isRealm =
            text.includes(
                "статистика"
            ) &&
            text.includes(
                "убийств"
            ) &&
            text.includes(
                "смертей"
            ) &&
            text.includes(
                "монет"
            )


        if (!isRealm) {
            return
        }

        this.bot.setPositionStatus(
            "realm"
        )
    }

    #updateBalance(lines) {
        const result =
            this.#parseBalance(
                lines
            )


        if (!result) {
            return
        }


        const {
            balance,
            line
        } =
            result


        if (
            line !==
            this.lastBalanceLine
        ) {
            this.lastBalanceLine =
                line


            this.logger?.info?.(
                `Bot ${this.botId}: sidebar balance parsed`,
                {
                    line,
                    balance
                }
            )
        }


        const oldBalance =
            this.bot.balance


        const changed =
            this.bot.setBalance(
                balance
            )


        if (!changed) {
            return
        }


        this.eventBus.emit(
            "bot:balanceUpdated",
            {
                botId:
                    this.botId,

                oldBalance,

                balance
            }
        )
    }


    #parseBalance(lines) {
        for (
            const line of lines
        ) {
            const cleanLine =
                this.#stripMinecraftColors(
                    line
                ).trim()


            if (
                !/монет/i.test(
                    cleanLine
                )
            ) {
                continue
            }


            const match =
                cleanLine.match(
                    /монет\s*:?\s*(\d[\d\s,.]*)/i
                )


            if (!match) {
                continue
            }


            const value =
                match[1]
                    .replace(
                        /[\s,.]/g,
                        ""
                    )


            if (
                value.length === 0
            ) {
                continue
            }


            if (
                !/^\d+$/.test(
                    value
                )
            ) {
                continue
            }


            const balance =
                Number(
                    value
                )


            if (
                !Number.isSafeInteger(
                    balance
                )
            ) {
                continue
            }


            if (
                balance < 0
            ) {
                continue
            }


            return {
                balance,

                line:
                    cleanLine
            }
        }


        return null
    }


    #getSidebarLines() {
        const lines =
            []


        for (
            const [
                teamName,
                team
            ] of this.teams
        ) {
            if (
                !teamName.startsWith(
                    "TAB-Sidebar-"
                )
            ) {
                continue
            }


            const prefix =
                nbtComponentToString(
                    team.prefix
                )


            const suffix =
                nbtComponentToString(
                    team.suffix
                )


            const text =
                `${prefix}${suffix}`
                    .trim()


            if (text) {
                lines.push(
                    text
                )
            }
        }


        return lines
    }


    #stripMinecraftColors(text) {
        return String(
            text ??
            ""
        ).replace(
            /§[0-9A-FK-OR]/gi,
            ""
        )
    }
}
