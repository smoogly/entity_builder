import { difference, flatten, groupBy, map } from "lodash";

import { Ctor } from "@lib/universal/framework/interfaces/types";
import { EntityManager } from "typeorm/entity-manager/EntityManager";
import { EntityMetadata, In } from "typeorm";
import { RelationMetadata } from "typeorm/metadata/RelationMetadata";
import { findBacklinkKeyFromJunction } from "@lib/server/framework/repositories/typeorm/entity_builder_util";

type Entity = { id?: number }; // DB entity constructor
interface SpecificEntity {
    type: Ctor<Entity>;
    id: string | number;
}

interface LocalRelChange {
    type: "local";
    meta: EntityMetadata;
    prop: string;
    from: number | string;
    to: number | string;
}
interface JunctionRelChange {
    type: "junction";
    relation: RelationMetadata;
    from: number | string;
    to: number | string;
}
const isLocalRelChange = (change: LocalRelChange | JunctionRelChange): change is LocalRelChange => change.type === "local";
const isJunctionRelChange = (change: LocalRelChange | JunctionRelChange): change is JunctionRelChange => change.type === "junction";

async function _removeRelation(
    manager: EntityManager,
    changes: ReadonlyArray<{ from: SpecificEntity, to: SpecificEntity }>
): Promise<void> {
    await Promise.all(map(
        groupBy(
            flatten(changes.map(({from, to}) => [from, to])).map(change => ({
                meta: manager.connection.getMetadata(change.type),
                id: change.id
            })),
            etty => etty.meta.tablePath
        ),
        async entities => {
            const requestedIds = entities.map(e => String(e.id));
            const fetched = await manager.find(entities[0].meta.target, { id: In(requestedIds) });
            const diff = difference(requestedIds, fetched.map(e => String(e.id)));
            if (diff.length > 0) {
                throw new Error(`Following entities of ${ entities[0].meta.tablePath } do not exist: ${ diff.join(", ") }`);
            }
        }
    ));

    const relationChanges = changes.map(c => {
        const to = manager.connection.getMetadata(c.to.type);
        const from = manager.connection.getMetadata(c.from.type);
        const rel = from.relations.find(r => r.inverseEntityMetadata.tableName === to.tableName);
        if (!rel) { throw new Error(`No relation from ${ from.tableName } to ${ to.tableName }`); }

        if (rel.relationType === "many-to-one" || (rel.relationType === "one-to-one" && rel.isOneToOneOwner)) {
            // Save on `from`
            const l: LocalRelChange = {
                type: "local",
                meta: rel.entityMetadata,
                prop: rel.propertyName,
                from: c.from.id,
                to: c.to.id,
            };
            return l;
        }

        if (rel.relationType === "one-to-many" || (rel.relationType === "one-to-one" && rel.isOneToOneNotOwner)) {
            // Save on `to` -- reversed direction
            const l: LocalRelChange = {
                type: "local",
                meta: rel.inverseEntityMetadata,
                prop: rel.inverseSidePropertyPath,
                from: c.to.id,
                to: c.from.id,
            };
            return l;
        }

        if (rel.relationType === "many-to-many") {
            // Save via junction
            const j: JunctionRelChange = {
                type: "junction",
                relation: rel,
                from: c.from.id,
                to: c.to.id
            };
            return j;
        }

        throw new Error(`Unhandled relation type ${ rel.relationType }`);
    });

    // Save local changes batched per single entity
    const localRelChanges = map(
        groupBy(relationChanges.filter(isLocalRelChange), change => `${ change.meta.tableName }_${ change.from }`),
        entityChanges => {
            const entity = {} as any;
            entity.id = entityChanges[0].from;
            entityChanges.forEach(change => {
                entity[change.prop] = null;
            });

            return { entity, meta: entityChanges[0].meta };
        }
    );
    await Promise.all(localRelChanges.map(localChange => manager.update(
        localChange.meta.target,
        { id: localChange.entity.id },
        localChange.entity
    )));


    // Save junction changes
    const junctionChanges = relationChanges.filter(isJunctionRelChange);
    await Promise.all(map(groupBy(junctionChanges, change => change.relation.junctionEntityMetadata!.tableName), batchedJunctionChanges => {
        const rel = batchedJunctionChanges[0].relation;
        const ownKeyName = findBacklinkKeyFromJunction(rel, rel.entityMetadata);
        const remoteKeyName = findBacklinkKeyFromJunction(rel, rel.inverseEntityMetadata);

        const tblName = rel.junctionEntityMetadata!.tableName;
        return manager.createQueryBuilder(tblName, tblName)
            .delete()
            .where(batchedJunctionChanges.map(c => ({
                [ownKeyName]: c.from,
                [remoteKeyName]: c.to
            })))
            .execute();
    }));
}

export const removeRelation: typeof _removeRelation = (manager, changes) => {
    if (manager.queryRunner && manager.queryRunner.isTransactionActive) { return _removeRelation(manager, changes); }
    return manager.transaction("REPEATABLE READ", transactionManager => _removeRelation(transactionManager, changes));
};
