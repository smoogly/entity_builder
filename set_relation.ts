import { Ctor } from "@lib/universal/framework/interfaces/types";
import { EntityManager } from "typeorm/entity-manager/EntityManager";

type Entity = { id?: number }; // DB entity constructor
interface SpecificEntity {
    type: Ctor<Entity>;
    id: string;
}

export async function setRelation(entityManager: EntityManager, from: SpecificEntity, to: SpecificEntity): Promise<void> {
    const ownMeta = entityManager.connection.getMetadata(from.type);
    const targetMeta = entityManager.connection.getMetadata(to.type);
    const relation = ownMeta.relations
        .find(rel => rel.inverseEntityMetadata.tableName === targetMeta.tableName);

    if (!relation) { throw new Error(`No relation from ${ ownMeta.tableName } to ${ targetMeta.tableName }`); }

    const ownEntity = await entityManager.findOne<Entity>(ownMeta.tableName, from.id);
    if (!ownEntity) { throw new Error(`${ownMeta.tableName} with id ${from.id} does not exists`); }

    const targetEntity = await entityManager.findOne<Entity>(targetMeta.tableName, to.id);
    if (!targetEntity) { throw new Error(`${targetMeta.tableName} with id ${to.id} does not exists`); }

    let savedEntity: Entity;
    if (relation.isOwning || relation.isManyToMany) {
        const remoteIsArray = relation.isManyToMany;
        const propertyName = relation.propertyName;
        ownEntity[propertyName] = remoteIsArray
            ? [...(ownEntity[propertyName] || []), targetEntity]
            : targetEntity;

        savedEntity = await entityManager.save(from.type, ownEntity);
        if (String(savedEntity.id) !== from.id) { throw new Error("Implementation error"); }
    } else {
        const inverseRelation = relation.inverseRelation;
        if (!inverseRelation) { throw new Error(`No inverse relation from ${ targetMeta.tableName } to ${ ownMeta.tableName }`); }

        targetEntity[inverseRelation.propertyName] = ownEntity;
        savedEntity = await entityManager.save(to.type, targetEntity);
        if (String(savedEntity.id) !== to.id) { throw new Error("Implementation error"); }
    }
}
