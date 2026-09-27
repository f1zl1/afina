import {marketPolicyFields} from '../core/market/marketConfig.js'
import {antiAfkFields} from '../minecraftBot/runtime/runtimeConfig.js'
import {canonicalizePolicy,legacyPolicyProjection} from '../core/canonicalPolicy.js'
import {actionSchema} from '../core/actionLedger.js'
import {lifecycleSchema} from '../core/lifecycleState.js'
import {economicSchema} from '../core/economicStore.js'
import {proxySchema} from '../resources/proxyStore.js'
export const schemaVersion = 16
export function upgradeToVersion13(db){db.exec(proxySchema);db.exec("ALTER TABLE telegramAccounts ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1))")}
export function upgradeToVersion12(db){db.exec(economicSchema)}
export function upgradeToVersion11(db){db.exec(lifecycleSchema)}
export function upgradeToVersion10(db){db.exec(actionSchema)}
export function upgradeToVersion9(db){
    const raw=db.prepare('SELECT * FROM corePolicy WHERE id=1').get()
    const legacy={...raw}
    for(const key of ['enabled','autoAllocateBots','autoReplaceBannedAccounts','allowAutomaticAccountGeneration'])legacy[key]=Boolean(raw[key])
    const row=db.prepare('SELECT * FROM operationsPolicy WHERE id=1').get()
    const {policy,report}=canonicalizePolicy(legacy,JSON.parse(row.document),row.revision+1)
    db.exec("ALTER TABLE operationsPolicy ADD COLUMN canonicalization TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(canonicalization)); DROP TRIGGER IF EXISTS revision_corePolicy_UPDATE;")
    db.prepare('UPDATE operationsPolicy SET document=?,canonicalization=?,revision=revision+1 WHERE id=1').run(JSON.stringify(policy),JSON.stringify(report))
    const aliases=legacyPolicyProjection(policy)
    // Legacy SQL columns have narrower target constraints; API aliases remain exact.
    aliases.targetAnalysts=Math.min(1000,aliases.targetAnalysts);aliases.targetResellers=Math.min(1000,aliases.targetResellers)
    const keys=Object.keys(aliases)
    db.prepare(`UPDATE corePolicy SET ${keys.map(k=>k+'=?').join(',')} WHERE id=1`).run(...keys.map(k=>typeof aliases[k]==='boolean'?Number(aliases[k]):aliases[k]))
}
export function upgradeToVersion8(db){
    db.exec(`
        CREATE TABLE operationsPolicy(
            id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 1,
            document TEXT NOT NULL CHECK(json_valid(document)), updatedAt INTEGER NOT NULL
        ) STRICT;
        INSERT INTO operationsPolicy(id,document,updatedAt) VALUES(1,'{}',unixepoch('subsec')*1000);
        CREATE TRIGGER revision_operationsPolicy_update AFTER UPDATE ON operationsPolicy BEGIN
            UPDATE coreMetadata SET revision=revision+1 WHERE id=1;
        END;
    `)
}
export function upgradeToVersion7(db){
    db.exec(`
        ALTER TABLE accountsData ADD COLUMN banned INTEGER NOT NULL DEFAULT 0 CHECK(banned IN (0,1));
        ALTER TABLE accountsData ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1));
        ALTER TABLE accountsData ADD COLUMN currentBanId INTEGER REFERENCES accountBanHistory(id);
        CREATE TABLE accountBanHistory(id INTEGER PRIMARY KEY,accountId INTEGER NOT NULL REFERENCES accountsData(accountId) ON DELETE RESTRICT,
            detectedAt INTEGER NOT NULL,issuedAt INTEGER,issuedAtRaw TEXT,reason TEXT,expiresAt INTEGER,durationRaw TEXT,punishmentId TEXT,
            rawMessage TEXT NOT NULL,source TEXT NOT NULL,fingerprint TEXT NOT NULL,context TEXT NOT NULL,UNIQUE(accountId,fingerprint)) STRICT;
        CREATE TABLE accountReplacements(requestId TEXT PRIMARY KEY,botId INTEGER NOT NULL REFERENCES botData(botId),
            bannedAccountId INTEGER NOT NULL REFERENCES accountsData(accountId),replacementAccountId INTEGER REFERENCES accountsData(accountId),
            state TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,retryAt INTEGER,reason TEXT,generated INTEGER NOT NULL DEFAULT 0,decisionId TEXT,
            requestedRole TEXT,requestedAssignment TEXT CHECK(requestedAssignment IS NULL OR json_valid(requestedAssignment))) STRICT;
        CREATE UNIQUE INDEX one_active_account_replacement ON accountReplacements(botId) WHERE state NOT IN ('completed','cancelled');
        ALTER TABLE corePolicy ADD COLUMN autoReplaceBannedAccounts INTEGER NOT NULL DEFAULT 0 CHECK(autoReplaceBannedAccounts IN (0,1));
        ALTER TABLE corePolicy ADD COLUMN allowAutomaticAccountGeneration INTEGER NOT NULL DEFAULT 0 CHECK(allowAutomaticAccountGeneration IN (0,1));
        ALTER TABLE corePolicy ADD COLUMN maxAccounts INTEGER NOT NULL DEFAULT 0 CHECK(maxAccounts BETWEEN 0 AND 1000000);
    `)
    for(const op of ['INSERT','UPDATE','DELETE'])db.exec(`DROP TRIGGER IF EXISTS track_accountsData_${op}`)
    addChangeTracking(db,['accountsData','accountBanHistory'])
}
export function upgradeToVersion6(db){
    const existing=new Set(db.prepare('PRAGMA table_info(corePolicy)').all().map(c=>c.name))
    const fields={...antiAfkFields,...Object.fromEntries(Object.entries(marketPolicyFields).filter(([key])=>key.startsWith('analysisRealmReady')))}
    for(const [key,f] of Object.entries(fields)){
        if(existing.has(key)) continue
        const min=f.type==='boolean'?0:f.min,max=f.type==='boolean'?1:f.max
        db.exec(`ALTER TABLE corePolicy ADD COLUMN ${key} ${f.type==='number'?'REAL':'INTEGER'} NOT NULL DEFAULT ${Number(f.defaultValue)} CHECK(${key} BETWEEN ${min} AND ${max})`)
    }
}
export const editableTables = {
    accounts: ["accountsData", "accountPoolState", "accountBanHistory"],
    bots: ["botData"], tasks: ["tasksData"], servers: ["serverData"], items: ["itemsData"],
    reseller: ["resellerSettings", "settingProfiles", "profileSettings", "botSettings"],
    telegram: ["telegramAccounts"],
    core: ["corePolicy", "operationsPolicy", "coreItemOverrides", "coreDesiredState", "coreDecisionJournal", "coreBotControl", "accountReplacements", "coreActions", "coreActionResources", "coreGenerationResults"],
    market: ["analysisSessions", "marketObservations", "marketHistory", "marketModels"],
    history: ["changeLog", "migrationIssues"]
}
export const readOnlyTables = new Set(["changeLog", "migrationIssues", "telegramAccounts", "corePolicy", "operationsPolicy", "coreItemOverrides", "coreDesiredState", "coreDecisionJournal", "coreBotControl"])
for(const table of editableTables.market) readOnlyTables.add(table)
readOnlyTables.add('accountBanHistory');readOnlyTables.add('accountReplacements')
editableTables.core.push('coreLifecycle')
for(const table of ['coreActions','coreActionResources','coreGenerationResults','coreLifecycle'])readOnlyTables.add(table)

export function upgradeToVersion5(db){
    for(const [key,f] of Object.entries(marketPolicyFields)){
        if(key.startsWith('analysisRealmReady'))continue // Added by v6, including fresh installations.
        db.exec(`ALTER TABLE corePolicy ADD COLUMN ${key} INTEGER NOT NULL DEFAULT ${f.defaultValue} CHECK(${key} BETWEEN ${f.min} AND ${f.max})`)
    }
    // SQLite cannot alter a CHECK constraint. No tables reference tasksData.
    for(const op of ['INSERT','UPDATE','DELETE']) db.exec(`DROP TRIGGER IF EXISTS track_tasksData_${op}`)
    for(const op of ['INSERT','UPDATE']) db.exec(`DROP TRIGGER IF EXISTS validate_task_prices_${op}`)
    db.exec('DROP INDEX tasks_item; ALTER TABLE tasksData RENAME TO tasksBeforeV5')
    const taskSchema=schema.slice(schema.indexOf('CREATE TABLE tasksData('),schema.indexOf('CREATE TABLE resellerSettings(')).replace("('reseller','test','afk')","('reseller','test','afk','analyst')")
    db.exec(taskSchema)
    db.exec('INSERT INTO tasksData SELECT * FROM tasksBeforeV5; DROP TABLE tasksBeforeV5')
    addChangeTracking(db,['tasksData'])
    db.exec(`
        CREATE TABLE analysisSessions(
            analysisId TEXT PRIMARY KEY, itemId INTEGER NOT NULL REFERENCES itemsData(itemId) ON DELETE CASCADE,
            botId INTEGER NOT NULL REFERENCES botData(botId) ON DELETE CASCADE,
            serverId INTEGER NOT NULL, realm INTEGER NOT NULL, workerPid INTEGER,
            decisionId TEXT NOT NULL, inputRevision INTEGER NOT NULL,
            startedAt INTEGER NOT NULL, completedAt INTEGER, deadline INTEGER NOT NULL,
            requestedObservations INTEGER NOT NULL, completedObservations INTEGER NOT NULL DEFAULT 0, lotsObserved INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK(status IN ('planned','running','completed','failed','cancelled','timed_out')),
            failureCode TEXT, nextRefreshAt INTEGER,
            task TEXT NOT NULL CHECK(json_valid(task))
        ) STRICT;
        CREATE UNIQUE INDEX analysis_busy_bot ON analysisSessions(botId) WHERE status IN ('planned','running');
        CREATE UNIQUE INDEX analysis_reserved_item ON analysisSessions(serverId,realm,itemId) WHERE status IN ('planned','running');
        CREATE INDEX analysis_item_time ON analysisSessions(serverId,realm,itemId,startedAt);
        CREATE INDEX analysis_completed ON analysisSessions(completedAt);
        CREATE TABLE marketObservations(
            observationId TEXT PRIMARY KEY, analysisId TEXT NOT NULL REFERENCES analysisSessions(analysisId) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, itemId INTEGER NOT NULL REFERENCES itemsData(itemId) ON DELETE CASCADE,
            serverId INTEGER NOT NULL, realm INTEGER NOT NULL, observedAt INTEGER NOT NULL,
            lots TEXT NOT NULL CHECK(json_valid(lots)), UNIQUE(analysisId,ordinal)
        ) STRICT;
        CREATE INDEX market_observation_item_time ON marketObservations(serverId,realm,itemId,observedAt);
        CREATE INDEX market_observation_time ON marketObservations(observedAt);
        CREATE TABLE marketHistory(
            observationId TEXT PRIMARY KEY, analysisId TEXT NOT NULL,
            itemId INTEGER NOT NULL REFERENCES itemsData(itemId) ON DELETE CASCADE,
            serverId INTEGER NOT NULL, realm INTEGER NOT NULL, observedAt INTEGER NOT NULL,
            document TEXT NOT NULL CHECK(json_valid(document))
        ) STRICT;
        CREATE INDEX market_history_item_time ON marketHistory(serverId,realm,itemId,observedAt);
        CREATE INDEX market_history_time ON marketHistory(observedAt);
        CREATE TABLE marketModels(
            serverId INTEGER NOT NULL, realm INTEGER NOT NULL,
            itemId INTEGER NOT NULL REFERENCES itemsData(itemId) ON DELETE CASCADE,
            observedAt INTEGER NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)),
            PRIMARY KEY(serverId,realm,itemId)
        ) STRICT;
        CREATE TABLE marketMetadata(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
        INSERT INTO marketMetadata VALUES(1,1);
    `)
}

export const schema = `
CREATE TABLE schemaMigrations(version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL);
CREATE TABLE dataRevision(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO dataRevision VALUES(1,0);
CREATE TABLE migrationIssues(id INTEGER PRIMARY KEY, entity TEXT NOT NULL, message TEXT NOT NULL);
CREATE TABLE legacyImportRecords(id INTEGER PRIMARY KEY, source TEXT NOT NULL, tableName TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE changeLog(id INTEGER PRIMARY KEY, tableName TEXT NOT NULL, operation TEXT NOT NULL, rowKey INTEGER, changedAt TEXT NOT NULL, beforeJson TEXT, afterJson TEXT);
CREATE TABLE serverData(
 serverId INTEGER PRIMARY KEY, serverIp TEXT NOT NULL UNIQUE, version TEXT NOT NULL, serverName TEXT NOT NULL
) STRICT;
CREATE TABLE accountsData(
 accountId INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
 createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE accountPoolState(
 accountId INTEGER PRIMARY KEY REFERENCES accountsData(accountId) ON UPDATE CASCADE ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','blocked','cooldown','retired')),
 reason TEXT, failureCount INTEGER NOT NULL DEFAULT 0 CHECK(failureCount>=0), cooldownUntil TEXT,
 lastUsedAt TEXT, updatedAt TEXT
) STRICT;
CREATE TABLE settingProfiles(profileId INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '') STRICT;
CREATE TABLE botData(
 botId INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '',
 connectedAccountId INTEGER REFERENCES accountsData(accountId) ON UPDATE CASCADE ON DELETE RESTRICT,
 serverId INTEGER REFERENCES serverData(serverId) ON UPDATE CASCADE ON DELETE RESTRICT,
 realm INTEGER CHECK(realm IS NULL OR realm>0),
 settingsProfileId INTEGER REFERENCES settingProfiles(profileId) ON UPDATE CASCADE ON DELETE SET NULL,
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE UNIQUE INDEX one_account_per_active_bot ON botData(connectedAccountId) WHERE archived=0 AND connectedAccountId IS NOT NULL;
CREATE INDEX bots_server ON botData(serverId);
CREATE INDEX bots_profile ON botData(settingsProfileId);
CREATE TABLE itemsData(
 itemId INTEGER PRIMARY KEY, name TEXT NOT NULL, searchQuery TEXT NOT NULL,
 matcher TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(matcher))
) STRICT;
CREATE TABLE tasksData(
 taskId INTEGER PRIMARY KEY, botId INTEGER UNIQUE REFERENCES botData(botId) ON UPDATE CASCADE ON DELETE CASCADE,
 type TEXT NOT NULL DEFAULT 'test' CHECK(type IN ('reseller','test','afk')),
 itemId INTEGER REFERENCES itemsData(itemId) ON UPDATE CASCADE ON DELETE RESTRICT,
 buyPricePerOne REAL CHECK(buyPricePerOne IS NULL OR buyPricePerOne>=0),
 sellPricePerOne REAL CHECK(sellPricePerOne IS NULL OR sellPricePerOne>=0),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(type!='reseller' OR (itemId IS NOT NULL AND buyPricePerOne IS NOT NULL AND sellPricePerOne IS NOT NULL AND buyPricePerOne>0 AND sellPricePerOne>0))
) STRICT;
CREATE INDEX tasks_item ON tasksData(itemId);
CREATE TABLE resellerSettings(
 id INTEGER PRIMARY KEY, settingName TEXT NOT NULL UNIQUE, settingDescription TEXT NOT NULL DEFAULT '',
 settingType TEXT NOT NULL CHECK(settingType IN ('integer','float','boolean','string','json')),
 settingValue TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general', updatedAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(CASE settingType
 WHEN 'integer' THEN CASE WHEN json_valid(settingValue) THEN json_type(settingValue)='integer' ELSE 0 END
 WHEN 'float' THEN CASE WHEN json_valid(settingValue) THEN json_type(settingValue) IN ('integer','real') ELSE 0 END
 WHEN 'boolean' THEN settingValue IN ('true','false') WHEN 'json' THEN json_valid(settingValue) ELSE 1 END)
) STRICT;
CREATE TABLE profileSettings(
 id INTEGER PRIMARY KEY, profileId INTEGER NOT NULL REFERENCES settingProfiles(profileId) ON UPDATE CASCADE ON DELETE CASCADE,
 settingName TEXT NOT NULL REFERENCES resellerSettings(settingName) ON UPDATE CASCADE ON DELETE CASCADE,
 settingValue TEXT NOT NULL, UNIQUE(profileId,settingName)
) STRICT;
CREATE TABLE botSettings(
 id INTEGER PRIMARY KEY, botId INTEGER NOT NULL REFERENCES botData(botId) ON UPDATE CASCADE ON DELETE CASCADE,
 settingName TEXT NOT NULL REFERENCES resellerSettings(settingName) ON UPDATE CASCADE ON DELETE CASCADE,
 settingValue TEXT NOT NULL, UNIQUE(botId,settingName)
) STRICT;
`

export function upgradeToVersion4(db){
    db.exec(`
        CREATE TABLE corePolicy(
            id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
            targetResellers INTEGER NOT NULL DEFAULT 0 CHECK(targetResellers BETWEEN 0 AND 1000),
            targetAnalysts INTEGER NOT NULL DEFAULT 0 CHECK(targetAnalysts BETWEEN 0 AND 1000),
            maxResellersPerItem INTEGER NOT NULL DEFAULT 3 CHECK(maxResellersPerItem BETWEEN 1 AND 1000),
            autoAllocateBots INTEGER NOT NULL DEFAULT 1 CHECK(autoAllocateBots IN (0,1)),
            autoSelectItems INTEGER NOT NULL DEFAULT 0 CHECK(autoSelectItems IN (0,1)),
            autoPricing INTEGER NOT NULL DEFAULT 0 CHECK(autoPricing IN (0,1)),
            autoAnalysis INTEGER NOT NULL DEFAULT 0 CHECK(autoAnalysis IN (0,1)),
            minimumAssignmentDurationMs INTEGER NOT NULL DEFAULT 300000 CHECK(minimumAssignmentDurationMs BETWEEN 0 AND 604800000),
            switchCooldownMs INTEGER NOT NULL DEFAULT 300000 CHECK(switchCooldownMs BETWEEN 0 AND 604800000),
            switchImprovementThresholdPercent REAL NOT NULL DEFAULT 10 CHECK(switchImprovementThresholdPercent BETWEEN 0 AND 1000),
            decisionDebounceMs INTEGER NOT NULL DEFAULT 250 CHECK(decisionDebounceMs BETWEEN 20 AND 10000),
            safetyIntervalMs INTEGER NOT NULL DEFAULT 60000 CHECK(safetyIntervalMs BETWEEN 10000 AND 600000),
            journalLimit INTEGER NOT NULL DEFAULT 1000 CHECK(journalLimit BETWEEN 50 AND 10000),
            failureRetryMs INTEGER NOT NULL DEFAULT 60000 CHECK(failureRetryMs BETWEEN 1000 AND 3600000),
            actionTimeoutMs INTEGER NOT NULL DEFAULT 60000 CHECK(actionTimeoutMs BETWEEN 1000 AND 600000)
        ) STRICT;
        INSERT INTO corePolicy(id) VALUES(1);
        CREATE TABLE coreMetadata(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        INSERT INTO coreMetadata VALUES(1,1);
        CREATE TABLE coreItemOverrides(
            itemId INTEGER PRIMARY KEY REFERENCES itemsData(itemId) ON DELETE CASCADE,
            disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
            minBots INTEGER CHECK(minBots BETWEEN 0 AND 1000), maxBots INTEGER CHECK(maxBots BETWEEN 0 AND 1000),
            forcedBots INTEGER CHECK(forcedBots BETWEEN 0 AND 1000),
            maxBuyPrice REAL CHECK(maxBuyPrice>0), minSellPrice REAL CHECK(minSellPrice>0),
            CHECK(minBots IS NULL OR maxBots IS NULL OR minBots<=maxBots),
            CHECK(forcedBots IS NULL OR maxBots IS NULL OR forcedBots<=maxBots),
            CHECK(forcedBots IS NULL OR minBots IS NULL OR forcedBots>=minBots)
        ) STRICT;
        CREATE TABLE coreDesiredState(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, generatedAt INTEGER NOT NULL, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
        CREATE TABLE coreDecisionJournal(
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, decisionId TEXT NOT NULL UNIQUE, timestamp INTEGER NOT NULL,
            action TEXT NOT NULL, result TEXT NOT NULL CHECK(result IN ('planned','applying','applied','blocked','failed')),
            document TEXT NOT NULL CHECK(json_valid(document))
        ) STRICT;
        CREATE INDEX core_decision_time ON coreDecisionJournal(timestamp);
        CREATE TABLE coreBotControl(
            botId INTEGER PRIMARY KEY REFERENCES botData(botId) ON DELETE CASCADE,
            manualHold INTEGER NOT NULL DEFAULT 0 CHECK(manualHold IN (0,1)),
            lastAssignmentAt INTEGER, lastSwitchAt INTEGER,
            pendingDecisionId TEXT, pendingActionId TEXT, pendingSince INTEGER,
            pendingAfter TEXT CHECK(pendingAfter IS NULL OR json_valid(pendingAfter)),
            failedUntil INTEGER
        ) STRICT;
    `)
    for(const table of ["corePolicy","coreItemOverrides"]){
        for(const op of ["INSERT","UPDATE","DELETE"]) db.exec(`CREATE TRIGGER revision_${table}_${op} AFTER ${op} ON ${table} BEGIN
            UPDATE coreMetadata SET revision=revision+1 WHERE id=1; END`)
    }
}

export function addChangeTracking(db, tables = Object.values(editableTables).flat().filter(t => !readOnlyTables.has(t))){
    for(const table of tables){
        const columns = db.prepare(`PRAGMA table_info("${table}")`).all()
        const json = prefix => "json_object(" + columns.flatMap(c => ["'" + c.name + "'", ["password", "session"].includes(c.name) ? "'[redacted]'" : `${prefix}."${c.name}"`]).join(",") + ")"
        for(const operation of ["INSERT", "UPDATE", "DELETE"]){
            const before = operation === "INSERT" ? "NULL" : json("OLD")
            const after = operation === "DELETE" ? "NULL" : json("NEW")
            db.exec(`CREATE TRIGGER "track_${table}_${operation}" AFTER ${operation} ON "${table}" BEGIN
                UPDATE dataRevision SET revision=revision+1 WHERE id=1;
                INSERT INTO changeLog(tableName,operation,rowKey,changedAt,beforeJson,afterJson)
                VALUES('${table}','${operation}',${operation === "DELETE" ? "OLD" : "NEW"}.rowid,strftime('%Y-%m-%dT%H:%M:%fZ','now'),${before},${after});
            END`)
        }
    }
}

export function upgradeToVersion3(db){
    db.exec(`
        CREATE TABLE telegramAccounts(
            telegramAccountId INTEGER PRIMARY KEY,
            phone TEXT NOT NULL UNIQUE,
            session TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('connected','disconnected','authorization_required','error')),
            createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ) STRICT;
        ALTER TABLE accountsData ADD COLUMN telegramAccountId INTEGER REFERENCES telegramAccounts(telegramAccountId) ON DELETE RESTRICT;
        CREATE INDEX accounts_telegram ON accountsData(telegramAccountId);
    `)
    for(const operation of ["INSERT", "UPDATE"]){
        db.exec(`CREATE TRIGGER telegram_capacity_${operation} BEFORE ${operation} ON accountsData
            WHEN NEW.telegramAccountId IS NOT NULL AND
            (SELECT count(*) FROM accountsData WHERE telegramAccountId=NEW.telegramAccountId AND accountId!=NEW.accountId)>=8
            BEGIN SELECT RAISE(ABORT,'TELEGRAM_CAPACITY_EXCEEDED'); END`)
    }
    for(const operation of ["INSERT", "UPDATE", "DELETE"]) db.exec(`DROP TRIGGER IF EXISTS track_accountsData_${operation}`)
    addChangeTracking(db, ["accountsData", "telegramAccounts"])
}

export function upgradeToVersion2(db){
    db.exec(`
        CREATE INDEX IF NOT EXISTS profile_setting_name ON profileSettings(settingName);
        CREATE INDEX IF NOT EXISTS bot_setting_name ON botSettings(settingName);
        CREATE INDEX IF NOT EXISTS change_log_entity ON changeLog(tableName,rowKey,id);
    `)
    for(const operation of ["INSERT","UPDATE"]){
        db.exec(`CREATE TRIGGER IF NOT EXISTS validate_task_prices_${operation} BEFORE ${operation} ON tasksData
            WHEN NEW.type='reseller' AND (NEW.itemId IS NULL OR NEW.buyPricePerOne IS NULL OR NEW.sellPricePerOne IS NULL OR NEW.buyPricePerOne<=0 OR NEW.sellPricePerOne<=0)
            BEGIN SELECT RAISE(ABORT,'Reseller task requires an item and positive buy/sell prices'); END`)
    }
    const valid = (value,type) => `CASE ${type}
        WHEN 'integer' THEN CASE WHEN json_valid(${value}) THEN json_type(${value})='integer' ELSE 0 END
        WHEN 'float' THEN CASE WHEN json_valid(${value}) THEN json_type(${value}) IN ('integer','real') ELSE 0 END
        WHEN 'boolean' THEN ${value} IN ('true','false') WHEN 'json' THEN json_valid(${value}) WHEN 'string' THEN 1 ELSE 0 END`
    for(const table of ["profileSettings","botSettings"]){
        for(const operation of ["INSERT","UPDATE"]){
            db.exec(`CREATE TRIGGER IF NOT EXISTS validate_${table}_${operation} BEFORE ${operation} ON ${table}
                WHEN NOT (${valid("NEW.settingValue","(SELECT settingType FROM resellerSettings WHERE settingName=NEW.settingName)")})
                BEGIN SELECT RAISE(ABORT,'Override value does not match setting type'); END`)
        }
        db.exec(`CREATE TRIGGER IF NOT EXISTS validate_setting_type_${table} BEFORE UPDATE OF settingType ON resellerSettings
            WHEN EXISTS(SELECT 1 FROM ${table} s WHERE s.settingName=OLD.settingName AND NOT (${valid("s.settingValue","NEW.settingType")}))
            BEGIN SELECT RAISE(ABORT,'Existing override is incompatible with the new setting type'); END`)
    }
}

export function upgradeToVersion14(db){db.exec(`
    CREATE TABLE tradingPlans(sequence INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,fingerprint TEXT NOT NULL,document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
    CREATE INDEX tradingPlans_scope ON tradingPlans(scope,sequence DESC);
`)}

export function upgradeToVersion15(db){db.exec(`
    CREATE UNIQUE INDEX economic_source_plan ON economicWorkloads(json_extract(document,'$.sourcePlanId')) WHERE json_extract(document,'$.sourcePlanId') IS NOT NULL;
    CREATE UNIQUE INDEX economic_autonomous_item ON economicWorkloads(itemId) WHERE json_extract(document,'$.source')='AUTONOMOUS_TRADING' AND status IN ('PENDING','ADMITTED','RUNNING','DRAINING','UNCERTAIN');
    UPDATE operationsPolicy SET document=json_set(document,'$.autonomousTradingEnabled',json('false'),'$.autonomousTradingMaxPurchaseValue',100000,'$.autonomousTradingMaxConcurrentWorkloads',1);
`)}

export function upgradeToVersion16(db){db.exec(`
    CREATE TABLE liveValidationFuse(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL CHECK(state IN ('UNARMED','ARMED','CONSUMED')),generation INTEGER NOT NULL,policyFingerprint TEXT,armedAt INTEGER,armedBy TEXT,consumedAt INTEGER,workloadId TEXT) STRICT;
    INSERT INTO liveValidationFuse(id,state,generation) VALUES(1,'UNARMED',0);
    UPDATE operationsPolicy SET document=json_set(document,'$.liveValidation',json('{"enabled":false,"itemId":null,"maxQuantity":1,"maxPurchaseCommitment":null,"maxAutonomousWorkloads":1}'));
`)}
