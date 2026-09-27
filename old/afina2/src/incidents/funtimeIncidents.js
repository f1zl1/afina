// Only trusted server/system messages and kick reasons enter this normalizer.
export function normalizeFunTimeIncident(raw,{now=Date.now()}={}){
    const text=String(raw ?? '').replace(/§[0-9a-fk-or]/gi,'').replace(/\r/g,'').slice(0,16000)
    const flat=text.replace(/\s+/g,' ').toLowerCase()
    const base={source:'funtime',timestamp:now,rawMessage:text}
    if(/вы\s+забанены|вы\s+были\s+забанены/i.test(flat)){
        const field=pattern=>text.match(pattern)?.[1]?.trim() ?? null
        const durationRaw=field(/разбан\s+через\s*:\s*([^\n]*?)(?=\s*(?:ID\s+наказания|по\s+причине|бан\s+выдан)\s*:|\n|$)/i)
        let seconds=0
        if(durationRaw)for(const [pattern,multiplier] of [[/(\d+)\s*д/i,86400],[/(\d+)\s*ч/i,3600],[/(\d+)\s*м/i,60],[/(\d+)\s*с/i,1]]){
            const value=durationRaw.match(pattern);if(value)seconds+=Number(value[1])*multiplier
        }
        const reliableDuration=durationRaw && /^(?:\d+\s*д\s*,?\s*)?(?:\d+\s*ч\s*,?\s*)?(?:\d+\s*м\s*,?\s*)?(?:\d+\s*с\s*)?$/i.test(durationRaw)
        return {...base,type:'ACCOUNT_BANNED',banDetectedAt:now,banIssuedAt:null,
            banIssuedAtRaw:field(/бан\s+выдан\s*:\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/i),
            banReason:field(/по\s+причине\s*:\s*([^\n]*?)(?=\s*(?:разбан\s+через|ID\s+наказания|бан\s+выдан)\s*:|\n|$)/i),banDurationRaw:durationRaw,
            banExpiresAt:reliableDuration && /\d/.test(durationRaw) && Number.isSafeInteger(now+seconds*1000)?now+seconds*1000:null,
            punishmentId:field(/id\s+наказания\s*:\s*#?([\w-]+)/i)}
    }
    const patterns=[['ITEM_DROP_REJECTED',/вы не можете выкидывать этот предмет в этом месте/],
        ['EMPTY_ITEM_SELL_ATTEMPT',/вы не можете продать воздух/],['CHEAT_CHECK_REQUESTED',/вы были вызваны на проверку читов/]]
    const match=patterns.find(([,pattern])=>pattern.test(flat))
    return match?{...base,type:match[0]}:null
}
