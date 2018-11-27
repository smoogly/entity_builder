import { getIdColumn } from "@lib/server/framework/repositories/typeorm/entity_builder_util";
import { SelectQueryBuilder } from "typeorm/query-builder/SelectQueryBuilder";
import { RelationMetadata } from "typeorm/metadata/RelationMetadata";

export const filterReferencingRemoteEntity = ( // TODO: test
    qb: SelectQueryBuilder<any>, r: RelationMetadata, parentAlias: string, referencedId: string
) => {
    const refId = Number(referencedId);
    const ownIdColumn = getIdColumn(r.entityMetadata);
    const remoteIdColumn = getIdColumn(r.inverseEntityMetadata);

    if (r.isManyToOne || r.isOneToOneOwner) {
        const column = r.joinColumns.find(c => c.propertyName === r.propertyName);
        if (!column) { throw new Error(`Join column not found for property ${r.propertyName}`); }
        return qb.where(`"${parentAlias}"."${column.databaseName}" = :referencedId`, {referencedId});
    }

    if (r.isOneToMany || r.isOneToOneNotOwner) { // select remote ids
        const key = r.inverseEntityMetadata.foreignKeys
            .find(k => k.referencedEntityMetadata.target === r.entityMetadata.target);

        if (!key) {
            throw new Error(
                `OneToMany: Foreign key not found from "${r.inverseEntityMetadata.tableName}" to "${r.entityMetadata.tableName}"`
            );
        }
        if (key.columnNames.length > 1) {
            throw new Error("Composite foreign keys not supported");
        }

        const keyName = key.columnNames[0];
        return qb.where(() => {
            const remoteAlias = `remote_${r.inverseEntityMetadata.tableName}`;
            const [selectReferencedIds] = qb.connection.createQueryBuilder()
                .from(r.inverseEntityMetadata.target, remoteAlias)
                .select(`"${keyName}"`)
                .where(`"${remoteAlias}"."${remoteIdColumn}" = ${refId}`)
                .getQueryAndParameters();


            return `"${parentAlias}"."${ownIdColumn}" in (${selectReferencedIds})`;
        });
    }

    if (r.isManyToMany) { // many to many — select ids via junction table
        const ownKey = r.junctionEntityMetadata!.foreignKeys
            .find(k => k.referencedEntityMetadata.target === r.entityMetadata.target);
        if (!ownKey) {
            throw new Error(
                `ManyToMany: Foreign key not found from "${r.junctionEntityMetadata!.tableName}" to "${r.entityMetadata.tableName}"`
            );
        }
        if (ownKey.columnNames.length > 1) {
            throw new Error("Composite foreign keys not supported");
        }

        const remoteKey = r.junctionEntityMetadata!.foreignKeys
            .find(k => k.referencedEntityMetadata.target === r.inverseEntityMetadata.target);
        if (!remoteKey) {
            throw new Error(
                `Foreign key not found from "${r.junctionEntityMetadata!.tableName}" to "${r.inverseEntityMetadata.tableName}"`
            );
        }
        if (remoteKey.columnNames.length > 1) {
            throw new Error("Composite foreign keys not supported");
        }

        const ownKeyName = ownKey.columnNames[0];
        const remoteKeyName = remoteKey.columnNames[0];
        return qb.where(() => {
            const [selectReferencedIds] = qb.connection.createQueryBuilder()
                .from(r.junctionEntityMetadata!.target, `remote_${r.inverseEntityMetadata.tableName}`)
                .select(`"${ownKeyName}"`)
                .where(`"${remoteKeyName}" = ${refId}`)
                .getQueryAndParameters();

            return `"${parentAlias}"."${ownIdColumn}" in (${selectReferencedIds})`;
        });
    }

    throw new Error(`Unhandled relation type: ${r.relationType}`);
};

