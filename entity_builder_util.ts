import { EntityMetadata } from "typeorm/metadata/EntityMetadata";
import { RelationMetadata } from "typeorm/metadata/RelationMetadata";
import { QueryNode } from "@lib/server/framework/repositories/typeorm/entity_builder_interfaces";

export const setupAlias = () => {
    let aliasNum = 0;
    return () => `rel_${++aliasNum}`;
};

// Breadth-first traversal
export function breadthFirst<T, R>(cb: (node: T, recurse: (n: T) => void) => R): (node: T) => R[] {
    return node => {
        const queue: T[] = [node];
        const recurse = (n: T) => queue.push(n);

        const res: R[] = [];
        while (queue.length > 0) {
            const nextNode = queue.shift()!;
            res.push(cb(nextNode, recurse));
        }

        return res;
    };
}

export const getIdColumn = (meta: EntityMetadata) => {
    if (meta.primaryColumns.length > 1) { throw new Error("Composite primary keys not supported"); }
    return meta.primaryColumns[0].databaseName;
};

export const findRelation = (from: QueryNode, to: QueryNode) => {
    const relation = from.meta.relations.find(rel => rel.inverseEntityMetadata.tableName === to.meta.tableName);
    if (!relation) { throw new Error(`Relation not found from ${from.meta.tableName} to ${to.meta.tableName}`); }
    return relation;
};


export const findBacklinkKeyDirect = (relation: RelationMetadata) => {
    const local = relation.entityMetadata;
    const remote = relation.inverseEntityMetadata;
    const key = remote.foreignKeys
        .find(k => k.referencedEntityMetadata.tableName === local.tableName);

    if (!key) {
        throw new Error(
            `Direct backlink key: Foreign key not found from "${remote.tableName}" to "${local.tableName}"`
        );
    }
    if (key.columnNames.length > 1) {
        throw new Error("Composite foreign keys not supported");
    }

    return key.columnNames[0];
};

export const findBacklinkKeyFromJunction = (relation: RelationMetadata, to: EntityMetadata) => {
    if (!relation.isManyToMany) { throw new Error("Many to many relation expected"); }

    const key = relation.junctionEntityMetadata!.foreignKeys
        .find(k => k.referencedEntityMetadata.tableName === to.tableName);
    if (!key) {
        throw new Error(
            `Backlink key from junction: Foreign key not found from "${relation.junctionEntityMetadata!.tableName}" to "${to.tableName}"`
        );
    }
    if (key.columnNames.length > 1) {
        throw new Error("Composite foreign keys not supported");
    }

    return key.columnNames[0];
};
