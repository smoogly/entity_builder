// These imports are made from migration file as there's a strong dependency on particulars of that migration
import { EntityBuilderCheckerFunctions1541678210293 } from "../../../../../migrations/1541678210293-Entity_Builder_Checker_Functions";


import { chunk, uniq, sortBy } from "lodash";
import { Driver, EntityManager, EntityMetadata, SelectQueryBuilder } from "typeorm";
import { RelationMetadata } from "typeorm/metadata/RelationMetadata";
import {
    breadthFirst,
    findBacklinkKeyDirect,
    findBacklinkKeyFromJunction,
    findRelation,
    getIdColumn,
    setupAlias
} from "@lib/server/framework/repositories/typeorm/entity_builder_util";
import { FetchNode, QueryDataNode, QueryIdNode, QueryNode } from "@lib/server/framework/repositories/typeorm/entity_builder_interfaces";
import { Timer } from "@lib/server/utils/timer_utils";
import {
    EntityBuilder_buildQueryTree,
    EntityBuilder_FetchNodes,
    EntityBuilder_GenerateQuery,
    EntityBuilder_Hydrate
} from "@lib/universal/config/apm";
import { isDevEnv } from "@lib/universal/utils/env_utils";
import { isNotNull } from "@lib/universal/utils/check_utils";
import { getIdPropertyName } from "@lib/server/framework/repositories/typeorm/relation_id";
import { hashCode } from "@lib/universal/utils/identity";
import { Ctor } from "@lib/universal/framework/interfaces/types";
import { ENTITY_BUILDER_VERSION } from "@lib/server/framework/repositories/typeorm/entity_builder_version";

type SubqueryToken = (query: string) => string;

const IDS_POSITION_MARKER = ":...ids";
const embedIds = (query: string, ids: (number | string)[]): string => query.replace(IDS_POSITION_MARKER, ids.join(","));

const isIdNode = (node: QueryNode): node is QueryIdNode => node.type === "ids";
const isDataNode = (node: QueryNode): node is QueryDataNode => node.type === "data";

const relationDescription = (relation: RelationMetadata) => {
    return [
        relation.propertyName,
        relation.entityMetadata.tableName,
        relation.inverseEntityMetadata.tableName,
        relation.relationType,
        relation.isOwning
    ].join(":");
};
const metaDescription = (
    meta: EntityMetadata
) => `${meta.tableName}:${Object.keys(meta.propertiesMap).join(":")}:${meta.relations.map(relationDescription)}`;

const _hashTree = breadthFirst<QueryNode, string>((node, recurse) => {
    node.nested.forEach(recurse);

    return `${node.type}-${node.alias}-${node.meta ? metaDescription(node.meta) : "root"}`;
});
const nondigitRe = /[^\d]/g;
const hashTree = (rootNode: QueryNode): string => String(hashCode(_hashTree(rootNode).join(":"))).replace(nondigitRe, "0");



/**********************************
 * Queries selecting relation ids *
 **********************************/
const selectSingleLocalId = (select: SelectQueryBuilder<any>, node: QueryNode, childNode: QueryNode) => {
    const relation = findRelation(node, childNode);
    const idPropertyName = getIdPropertyName(node.meta, relation.propertyName);

    const fkColumn = relation.joinColumns.find(c => c.propertyName === relation.propertyName);
    if (!fkColumn) { throw new Error(`Join column not found for property ${relation.propertyName}`); }
    return select.addSelect(`"${node.alias}"."${fkColumn.databaseName}"`, idPropertyName);
};

const selectSingleRemoteId = (select: SelectQueryBuilder<any>, node: QueryNode, childNode: QueryNode) => {
    const relation = findRelation(node, childNode);
    const idPropertyName = getIdPropertyName(node.meta, relation.propertyName);

    const joinAlias = `${childNode.alias}_join`;
    const ownIdColumn = getIdColumn(node.meta);
    const remoteIdColumn = getIdColumn(childNode.meta);

    const keyName = findBacklinkKeyDirect(relation);
    return select
        .leftJoin(qb => {
            return qb
                .from(childNode.meta.target, childNode.alias)
                .select(`"${childNode.alias}"."${remoteIdColumn}"`, idPropertyName)
                .addSelect(`"${childNode.alias}"."${keyName}"`)
                .where(`"${childNode.alias}"."${keyName}" = "${node.alias}"."${ownIdColumn}"`);
        }, joinAlias, `"${node.alias}"."${ownIdColumn}" = "${joinAlias}"."${keyName}"`)
        .addSelect(`"${joinAlias}"."${idPropertyName}"`);
};

const selectManyRemoteIds = (select: SelectQueryBuilder<any>, node: QueryNode, childNode: QueryNode) => {
    const relation = findRelation(node, childNode);
    const idPropertyName = getIdPropertyName(node.meta, relation.propertyName);

    const joinAlias = `${childNode.alias}_join`;
    const ownIdColumn = getIdColumn(node.meta);
    const remoteIdColumn = getIdColumn(childNode.meta);

    const keyName = findBacklinkKeyDirect(relation);
    return select
        .leftJoin(qb => {
            return qb
                .select(`json_agg("${remoteIdColumn}")`, idPropertyName)
                .from(childNode.meta.target, childNode.alias)
                .addSelect(`"${childNode.alias}"."${keyName}"`)
                .where(`"${childNode.alias}"."${keyName}" = "${node.alias}"."${remoteIdColumn}"`)
                .groupBy(`"${childNode.alias}"."${keyName}"`);
        }, joinAlias, `"${node.alias}"."${ownIdColumn}" = "${joinAlias}"."${keyName}"`)
        .addSelect(`"${joinAlias}"."${idPropertyName}"`);
};

const selectManyRemoteIdsViaJunction = (select: SelectQueryBuilder<any>, node: QueryNode, childNode: QueryNode) => {
    const relation = findRelation(node, childNode);
    const idPropertyName = getIdPropertyName(node.meta, relation.propertyName);

    const joinAlias = `${childNode.alias}_join`;
    const ownIdColumn = getIdColumn(node.meta);

    const ownKeyName = findBacklinkKeyFromJunction(relation, node.meta);
    const remoteKeyName = findBacklinkKeyFromJunction(relation, childNode.meta);

    return select
        .leftJoin(qb => {
            return qb
                .from(relation.junctionEntityMetadata!.target, childNode.alias)
                .select(`json_agg("${remoteKeyName}")`, idPropertyName)
                .addSelect(`"${childNode.alias}"."${ownKeyName}"`)
                .where(`"${childNode.alias}"."${ownKeyName}" = "${node.alias}"."${ownIdColumn}"`)
                .groupBy(`"${childNode.alias}"."${ownKeyName}"`);
        }, joinAlias, `"${node.alias}"."${ownIdColumn}" = "${joinAlias}"."${ownKeyName}"`)
        .addSelect(`"${joinAlias}"."${idPropertyName}"`);
};




/****************************************
 * Queries selecting full relation data *
 ****************************************/

// Single local id: one-to-one-owner or many-to-one
const joinUsingSingleLocalId = (
    entityManager: EntityManager,
    getSubqueryToken: SubqueryToken,
    select: SelectQueryBuilder<any>,
    node: QueryNode,
    childNode: QueryNode
) => {
    /* Query looks similar to this:
    SELECT row_to_json(operators) as data FROM (
        SELECT
            "operator"."id",
            "operator"."name",
            "country"."country"
        FROM "main"."operator" "operator"
        LEFT JOIN LATERAL (
            SELECT id, row_to_json(countries) as "country"
            FROM (
                SELECT
                    "countryInner"."id",
                    "countryInner"."name",
                    "region"."region"
                FROM "main"."country" "countryInner"
                LEFT JOIN LATERAL (
                    SELECT id, row_to_json(regions) as "region"
                    FROM (
                        SELECT
                            "region"."id",
                            "region"."name",
                            "region"."developmentType"
                        FROM "main"."region" "region"
                        WHERE "region"."id" = "countryInner"."regionId"
                    ) regions
                ) region on "region"."id" = "countryInner"."regionId"
                WHERE "countryInner"."id" = "operator"."countryId"
            ) countries
        ) country on "country"."id" = "operator"."countryId"
        WHERE "operator"."id" in (1, 2, 3)
    ) operators
     */

    const relation = findRelation(node, childNode);

    const joinAlias = `${childNode.alias}_join`;
    const toJsonAlias = `${childNode.alias}_tojson`;

    const remoteIdColumn = getIdColumn(childNode.meta);

    const fkColumn = relation.joinColumns.find(c => c.propertyName === relation.propertyName);
    if (!fkColumn) { throw new Error(`Join column not found for property ${relation.propertyName}`); }
    return select
        .leftJoin(qb => {
            return qb
                .select(`row_to_json(${toJsonAlias})`, relation.propertyName)
                .addSelect(`"${toJsonAlias}"."${remoteIdColumn}"`)
                .from(getSubqueryToken(_generateQuery(entityManager, node, childNode)), toJsonAlias);
        }, joinAlias, `"${node.alias}"."${fkColumn.databaseName}" = "${joinAlias}"."${remoteIdColumn}"`)
        .addSelect(`"${joinAlias}"."${relation.propertyName}"`);
};
const singleLocalIdSubqueryAdjustment = (select: SelectQueryBuilder<any>, parent: QueryNode, node: QueryNode) => {
    const relation = findRelation(parent, node);
    const ownIdColumn = getIdColumn(node.meta);

    const fkColumn = relation.joinColumns.find(c => c.propertyName === relation.propertyName);
    if (!fkColumn) { throw new Error(`Join column not found for property ${relation.propertyName}`); }
    select.where(`"${node.alias}"."${ownIdColumn}" = "${parent.alias}"."${fkColumn.databaseName}"`);
};



const joinUsingSingleRemoteId = ( // Single remote id: one-to-one-not-owner
    entityManager: EntityManager,
    getSubqueryToken: SubqueryToken,
    select: SelectQueryBuilder<any>,
    node: QueryNode,
    childNode: QueryNode
) => {
    const relation = findRelation(node, childNode);

    const joinAlias = `${childNode.alias}_join`;
    const toJsonAlias = `${childNode.alias}_tojson`;

    const ownIdColumn = getIdColumn(node.meta);

    const backlinkIdPropertyName = getIdPropertyName(childNode.meta, findRelation(childNode, node).propertyName);
    return select
        .leftJoin(qb => {
            return qb
                .select(`row_to_json(${toJsonAlias})`, relation.propertyName)
                .addSelect(`"${toJsonAlias}"."${backlinkIdPropertyName}"`)
                .from(getSubqueryToken(_generateQuery(entityManager, node, childNode)), toJsonAlias);
        }, joinAlias, `"${node.alias}"."${ownIdColumn}" = "${joinAlias}"."${backlinkIdPropertyName}"`)
        .addSelect(`"${joinAlias}"."${relation.propertyName}"`);
};
const joinUsingMultipleRemoteIds = ( // Multiple remote ids: one-to-many
    entityManager: EntityManager,
    getSubqueryToken: SubqueryToken,
    select: SelectQueryBuilder<any>,
    node: QueryNode,
    childNode: QueryNode
) => {
    /* Query looks similar to this:
    SELECT row_to_json(manufacturerOuter) as data FROM (
        SELECT
            "manufacturer"."id",
            "manufacturer"."name",
            "manufacturer"."description",
            "manufacturer"."category",
            "aircraftModels"."aircraftModels"
        FROM "main"."manufacturer" "manufacturer"
        LEFT JOIN LATERAL (
            SELECT
                json_agg("aircraftModels"."aircraftModel") as "aircraftModels",
                "aircraftModels"."manufacturerId"
            FROM (
                SELECT "aircraftModelTwo"."manufacturerId", row_to_json("aircraftModelTwo") as "aircraftModel" from (
                    SELECT
                        "aircraftModelOne"."id",
                        "aircraftModelOne"."type",
                        "aircraftModelOne"."series",
                        "aircraftModelOne"."subSeries",
                        "aircraftModelOne"."engineCount",
                        "aircraftModelOne"."bodyType",
                        "aircraftModelOne"."manufacturerId"
                    FROM "main"."aircraft_model" "aircraftModelOne"
                    WHERE "aircraftModelOne"."manufacturerId" = "manufacturer"."id"
                ) "aircraftModelTwo"
            ) "aircraftModels"
            WHERE "aircraftModels"."manufacturerId" = "manufacturer"."id"
            GROUP BY "aircraftModels"."manufacturerId"
        ) "aircraftModels" ON "aircraftModels"."manufacturerId" = "manufacturer"."id"
        WHERE "manufacturer"."id" in (1, 2)
    ) manufacturerOuter;
     */

    const relation = findRelation(node, childNode);

    const joinAlias = `${childNode.alias}_join`;
    const toJsonAlias = `${childNode.alias}_tojson`;
    const aggregateAlias = `${childNode.alias}_aggregate`;

    const ownIdColumn = getIdColumn(node.meta);
    const remoteIdColumn = getIdColumn(childNode.meta);

    const backlinkIdPropertyName = getIdPropertyName(childNode.meta, findRelation(childNode, node).propertyName);
    return select
        .leftJoin(qb => {
            return qb
                .select(`json_agg("${aggregateAlias}"."${relation.propertyName}")`, relation.propertyName)
                .addSelect(`"${aggregateAlias}"."${backlinkIdPropertyName}"`)
                .from(_qb => {
                    return _qb
                        .select(`"${backlinkIdPropertyName}"`)
                        .addSelect(`row_to_json(${toJsonAlias})`, relation.propertyName)
                        .from(getSubqueryToken(_generateQuery(entityManager, node, childNode)), toJsonAlias);
                }, aggregateAlias)
                .where(`"${aggregateAlias}"."${backlinkIdPropertyName}" = "${node.alias}"."${remoteIdColumn}"`)
                .groupBy(`"${aggregateAlias}"."${backlinkIdPropertyName}"`);
        }, joinAlias, `"${node.alias}"."${ownIdColumn}" = "${joinAlias}"."${backlinkIdPropertyName}"`)
        .addSelect(`"${joinAlias}"."${relation.propertyName}"`);
};

// This subquery adjustment covers both single and multiple remote ids
const singleRemoteIdSubqueryAdjustment = (select: SelectQueryBuilder<any>, parent: QueryNode, node: QueryNode) => {
    const relation = findRelation(parent, node);

    const keyName = findBacklinkKeyDirect(relation);
    const parentIdColumn = getIdColumn(parent.meta);
    select.where(`"${node.alias}"."${keyName}" = "${parent.alias}"."${parentIdColumn}"`);
};



// Fetch many-to-many via junction table
const joinViaJunctionTable = (
    entityManager: EntityManager,
    getSubqueryToken: SubqueryToken,
    select: SelectQueryBuilder<any>,
    node: QueryNode,
    childNode: QueryNode
) => {
    /*  Many-to-many query looks pretty much like this:

        select *
        from main.portfolio portfolio
        left join lateral (
            select
                json_agg(row_to_json(to_agg)),
                to_agg."portfolioId"
            from (
                select *
                from main.aircraft aircraft
                left join main.portfolio_aircraft_aircraft joined       -- These two lines are added
                on joined."aircraftId" = aircraft.id                    -- in recursed call
                where joined."portfolioId" = portfolio.id               -- (see manyToManySubqueryAdjustment)
            ) to_agg
            group by to_agg."portfolioId"
        ) aircrafts on aircrafts."portfolioId" = portfolio.id
        where portfolio.id in (8, 12);
     */

    const relation = findRelation(node, childNode);

    const joinAlias = `${childNode.alias}_join`;
    const aggregateAlias = `${childNode.alias}_aggregate`;

    const ownIdColumn = getIdColumn(node.meta);

    const ownKeyName = findBacklinkKeyFromJunction(relation, node.meta);
    return select
        .leftJoin(qb => {
            return qb
                .select(`json_agg(row_to_json("${aggregateAlias}"))`, relation.propertyName)
                .addSelect(`"${aggregateAlias}"."${ownKeyName}"`)
                .from(getSubqueryToken(_generateQuery(entityManager, node, childNode)), aggregateAlias)
                .groupBy(`"${aggregateAlias}"."${ownKeyName}"`);
        }, joinAlias, `"${node.alias}"."${ownIdColumn}" = "${joinAlias}"."${ownKeyName}"`)
        .addSelect(`"${joinAlias}"."${relation.propertyName}"`);
};
const manyToManySubqueryAdjustment = (select: SelectQueryBuilder<any>, parent: QueryNode, node: QueryNode) => {
    const relation = findRelation(parent, node);
    const ownIdColumn = getIdColumn(node.meta);

    const parentKeyName = findBacklinkKeyFromJunction(relation, parent.meta);
    const currentNodeKeyName = findBacklinkKeyFromJunction(relation, node.meta);
    const junctionAlias = `${parent.alias}_${node.alias}_junction`;
    const parentIdColumn = getIdColumn(parent.meta);

    select
        .leftJoin(
            relation.junctionEntityMetadata!.target, junctionAlias,
            `"${junctionAlias}"."${currentNodeKeyName}" = "${node.alias}"."${ownIdColumn}"`
        )
        .addSelect(`"${junctionAlias}"."${parentKeyName}"`)
        .where(`"${junctionAlias}"."${parentKeyName}" = "${parent.alias}"."${parentIdColumn}"`);
};




/****************************
 * Queries generation logic *
 ****************************/
function _generateQuery(entityManager: EntityManager, parent: QueryNode | null, node: QueryNode) {
    const select = entityManager.createQueryBuilder().select()
        .from(node.meta.tablePath, node.alias);

    const ownIdColumn = getIdColumn(node.meta);
    if (parent === null) {
        // Restrict search by externally supplied list of ids
        select.where(`"${node.alias}"."${ownIdColumn}" in (${IDS_POSITION_MARKER})`);
    } else {
        // Restrict search by referencing parent
        const relation = findRelation(parent, node);

        if (relation.isManyToOne || relation.isOneToOneOwner) {
            singleLocalIdSubqueryAdjustment(select, parent, node);
        } else if (relation.isOneToOneNotOwner || relation.isOneToMany) {
            singleRemoteIdSubqueryAdjustment(select, parent, node);
        } else if (relation.isManyToMany) {
            manyToManySubqueryAdjustment(select, parent, node);
        } else {
            throw new Error(`Unhandled id node from ${parent.meta.tableName} ${relation.relationType} ${node.meta.tableName}`);
        }
    }

    // Select value columns
    node.meta.ownColumns
        .filter(col => !col.relationMetadata)
        .forEach(col => select.addSelect(`"${node.alias}"."${col.databaseName}"`, col.propertyName));

    // Select ids
    node.nested.filter(isIdNode).forEach(childNode => {
        const relation = findRelation(node, childNode);

        if (relation.isManyToOne || relation.isOneToOneOwner) { // Select local id
            return selectSingleLocalId(select, node, childNode);
        }

        if (relation.isOneToOneNotOwner) { // Select single remote id
            return selectSingleRemoteId(select, node, childNode);
        }

        if (relation.isOneToMany) { // select remote ids
            return selectManyRemoteIds(select, node, childNode);
        }

        if (relation.isManyToMany) { // select via junction table
            return selectManyRemoteIdsViaJunction(select, node, childNode);
        }

        throw new Error(`Unhandled id node from ${node.meta.tableName} ${relation.relationType} ${childNode.meta.tableName}`);
    });


    // Select nested data nodes

    let subqueryIdx = 0;
    const subqueries: {[token: string]: string} = {};
    const getSubqueryToken = (subquery: string) => {
        const token = `$$$subquery_${subqueryIdx++}$$$`;
        subqueries[token] = subquery;
        return token;
    };

    node.nested.filter(isDataNode).forEach(childNode => {
        const relation = findRelation(node, childNode);

        if (relation.isManyToOne || relation.isOneToOneOwner) { // Join using local id
            return joinUsingSingleLocalId(entityManager, getSubqueryToken, select, node, childNode);
        }

        if (relation.isOneToOneNotOwner) { // Join using single remote id
            return joinUsingSingleRemoteId(entityManager, getSubqueryToken, select, node, childNode);
        }

        if (relation.isOneToMany) { // Join and aggregate using remote ids
            return joinUsingMultipleRemoteIds(entityManager, getSubqueryToken, select, node, childNode);
        }

        if (relation.isManyToMany) { // Join and aggregate via junction table
            return joinViaJunctionTable(entityManager, getSubqueryToken, select, node, childNode);
        }

        throw new Error(`Unhandled full node from ${node.meta.tableName} ${relation.relationType} ${childNode.meta.tableName}`);
    });

    // There isn't a way to mark a join as "lateral", but this feature is used to avoid scanning entire tables
    // so I'm hacking together a string-replaced query.
    const withLateralJoins = select.getQuery().replace(/LEFT\s*JOIN\s*\(SELECT/g, "LEFT JOIN LATERAL (SELECT");

    // There isn't a way to embed a string subquery into `from` via typeorm,
    // so I'm hacking them in via string-replace.
    return Object.keys(subqueries).reduce(
        (resultingQuery, subqToken) => {
            // Saved token is escaped, because typeorm will escape on embedding,
            // but resulting query must not be escaped. Same for wrapping query in brackets.
            return resultingQuery.replace(`"${subqToken}"`, `(${subqueries[subqToken]})`);
        }, withLateralJoins
    );
}
const generateQuery = (entityManager: EntityManager, node: QueryNode) => {
    const timer = new Timer(
        EntityBuilder_GenerateQuery,
        `entity=${node.meta.name} hash=${hashTree(node)}`
    );

    const query = _generateQuery(entityManager, null, node);
    timer.stop();
    return query;
};

const hydrateResults = (driver: Driver, node: QueryNode, entities: any[]): void => {
    const childNodes = node.nested.map(childNode => {
        const relation = findRelation(node, childNode);

        return {
            childNode,
            relation,
            idColumn: getIdColumn(childNode.meta),
            propertyName: relation.propertyName,
            idPropertyName: getIdPropertyName(node.meta, relation.propertyName),
            toOne: relation.isOneToOne || relation.isManyToOne
        };
    });

    entities.forEach(entity => {
        // Hydrate value columns
        node.meta.ownColumns
            .filter(col => !col.relationMetadata)
            .forEach(col => {
                entity[col.propertyName] = driver.prepareHydratedValue(entity[col.propertyName], col);
            });

        // Handle id nodes
        childNodes.filter(n => isIdNode(n.childNode)).forEach(({idPropertyName, childNode, toOne, relation}) => {
            if (toOne) {
                // Wipe null
                if (entity[idPropertyName] === null) {
                    delete entity[idPropertyName];
                }
            } else {
                // Filter nulls and sort
                entity[idPropertyName] = ((entity[idPropertyName] || [])as (number | null)[]).filter(isNotNull).sort((a, b) => a - b);

                if (relation.isManyToMany) {
                    // Cleanup a property that is a helper for a query
                    const ownKeyName = findBacklinkKeyFromJunction(relation, childNode.meta);
                    delete entity[ownKeyName];
                }
            }
        });

        // Recurse into child entities
        childNodes.filter(n => isDataNode(n.childNode)).forEach(({propertyName, childNode, toOne, idColumn, relation}) => {
            if (toOne) {
                // Wipe null
                if (entity[propertyName] === null) {
                    delete entity[propertyName];
                } else {
                    hydrateResults(driver, childNode, [entity[propertyName]]);
                }
            } else {
                entity[propertyName] = ((entity[propertyName] || []) as any[]).sort((a, b) => a[idColumn] - b[idColumn]);
                hydrateResults(driver, childNode, entity[propertyName]);

                if (relation.isManyToMany) {
                    // Cleanup a property that is a helper for a query
                    const ownKeyName = findBacklinkKeyFromJunction(relation, childNode.meta);
                    delete entity[ownKeyName];
                }
            }
        });
    });
};

const {MAX_FN_ARGUMENTS, MAX_FN_NAME_LENGTH, checkerFnName, safeCreateFnName} = EntityBuilderCheckerFunctions1541678210293;

const storedFnName = (
    rootNode: QueryNode, ids: number[]
) => {
    const name = `builder_${ENTITY_BUILDER_VERSION}_${rootNode.meta.tableName.slice(0, 15)}_${hashTree(rootNode)}_n${ids.length}`;
    if (isDevEnv && name.length > MAX_FN_NAME_LENGTH) {
        throw new Error(`Generated function name is longer than psql limit: ${name}`);
    }
    return name;
};

const createStoredFn = (
    rootNode: QueryNode,
    ids: number[],
    entityManager: EntityManager
) => {
    const fnName = storedFnName(rootNode, ids);
    const argtypes = ids.map(() => "integer").join(",");
    const argplaceholders = ids.map((x, i) => `\$${i + 1}`);
    const fnsql = `
        CREATE FUNCTION ${fnName} (${argtypes}) RETURNS SETOF JSON STABLE
        AS $$
            BEGIN
                RETURN QUERY select
                    row_to_json(rows) as res
                from (${ embedIds(generateQuery(entityManager, rootNode), argplaceholders) }) rows;
            END;
        $$ LANGUAGE plpgsql ROWS ${ids.length}
    `.replace(/\n/g, " ");
    return entityManager.query(`select ${safeCreateFnName}('${fnsql}')`);
};

const fetchNodes = (
    entityManager: EntityManager,
    rootNode: QueryDataNode,
    ids: number[],
    onRequset: () => void
): Promise<{id: number}[]> => {
    const timerContext = `entity=${rootNode.meta.name} hash=${hashTree(rootNode)} ids=${JSON.stringify(ids)}}`;
    const runQueryTimer = new Timer(EntityBuilder_FetchNodes, timerContext);

    return chunk(ids, MAX_FN_ARGUMENTS).reduce((prev, idsBatch) => prev.then(prevRes => {
        onRequset();

        const storedFn = storedFnName(rootNode, idsBatch);
        const checker = checkerFnName(idsBatch.length);
        return entityManager.query(`SELECT res FROM ${checker}('${storedFn}', ${idsBatch.join(",")}) res`)
            .then(rows => {
                if (rows.length === 1 && rows[0].res === null) {
                    // This is a response of a checker function when target doesn't exists.

                    if (entityManager.queryRunner && entityManager.queryRunner.isTransactionActive) {
                        // If running in transaction, attempting to create a function might cause a deadlock.
                        // In that case generate and run the query.
                        return entityManager.query(`
                            select
                                row_to_json(rows) as res
                            from (${ embedIds(generateQuery(entityManager, rootNode), idsBatch) }) rows;
                        `);
                    }

                    // Not in transaction. Force create stored fn and re-run directly.
                    return createStoredFn(rootNode, idsBatch, entityManager)
                        .then(() => entityManager.query(`SELECT res FROM ${storedFn}(${idsBatch.join(",")}) res`));
                }

                return rows;
            })
            .then(rows => [...prevRes, ...rows.map((r: {res: any}) => r.res)]);
    }), Promise.resolve([])).then(
        rows => {
            runQueryTimer.stop();

            const hydrateTimer = new Timer(EntityBuilder_Hydrate, timerContext);
            hydrateResults(entityManager.connection.driver, rootNode, rows);
            hydrateTimer.stop();

            return rows;
        },
        e => {
            runQueryTimer.stop();
            throw e;
        }
    );
};

const isFetchNode = (val: any): val is FetchNode<any> => val && typeof val === "object" && "type" in val;

const _buildQueryTree = (entityManager: EntityManager, getAlias: () => string, node: FetchNode<any>): QueryDataNode => {
    const nested = node.nested || [];

    const meta = entityManager.connection.getMetadata(node.type);
    return {
        type: "data",
        alias: getAlias(),
        meta: meta,
        nested: meta.relations.map(rel => {
            const definedChildNode = nested.find(
                c => entityManager.connection.getMetadata(c.type).tableName === rel.inverseEntityMetadata.tableName
            );

            if (definedChildNode) {
                return _buildQueryTree(entityManager, getAlias, definedChildNode);
            }

            const idNode: QueryIdNode = {
                type: "ids",
                alias: getAlias(),
                nested: [],
                meta: rel.inverseEntityMetadata
            };
            return idNode;
        })
    };
};
const buildQueryTree = (entityManager: EntityManager, rootNode: FetchNode<any>) => {
    const timer = new Timer(
        EntityBuilder_buildQueryTree,
        `entity=${entityManager.connection.getMetadata(rootNode.type).name}`
    );
    const root = _buildQueryTree(entityManager, setupAlias(), rootNode);
    timer.stop();
    return root;
};

const noopOnRequest = () => void 0;
export const fetchEntities = (
    entityManager: EntityManager,
    entity: Ctor<any> | FetchNode<any>,
    ids: string[],
    onRequset?: () => void
): Promise<{id: number}[]> => {
    if (ids.length === 0) { return Promise.resolve([]); }
    if (isDevEnv) {
        const incorrectId = ids.find(id => !id || typeof id !== "string");
        if (incorrectId) {
            throw new Error(`Non-string or empty id given: ${incorrectId}`);
        }
    }

    const numericIds = ids.map(parseFloat);
    const uniqIds = uniq(numericIds);
    const execute = async (em: EntityManager) => {
        const rootFetchNode: FetchNode<any> = isFetchNode(entity) ? entity : { type: entity };
        const fetched = await fetchNodes(em, buildQueryTree(em, rootFetchNode), uniqIds, onRequset || noopOnRequest);
        return sortBy(fetched, e => numericIds.indexOf(e.id)); // Preserve oreder of requested ids
    };

    if (uniqIds.length > MAX_FN_ARGUMENTS && !(entityManager.queryRunner && entityManager.queryRunner.isTransactionActive)) {
        // When large number of ids is requested, query will be batched.
        // This needs to happen in transaction
        return entityManager.transaction(execute);
    }

    return execute(entityManager);
};
