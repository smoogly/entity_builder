import { EntityMetadata, Connection } from "typeorm";

type PropMapping = { [prop: string]: string };
const entityMarkers = new Map<Function, PropMapping>();

export function RelationIdMarker(forPropName: string) {
    return function (object: object, propertyName: string) {
        const mapped = entityMarkers.get(object.constructor) || {};
        mapped[forPropName] = propertyName;
        entityMarkers.set(object.constructor, mapped);
    };
}

export function unsetRelationIdMarkerTarget(target: Function) { // Testing helper
    entityMarkers.delete(target);
}


let mappedProps: {[tableName: string]: PropMapping} | null;
const getMappedMarkers = (connection: Connection) => {
    if (mappedProps) { return mappedProps; }
    mappedProps = Array.from(entityMarkers.keys()).reduce((markers, entity) => {
        if (!connection.hasMetadata(entity)) { return markers; }

        const meta = connection.getMetadata(entity);
        markers[meta.tableName] = entityMarkers.get(entity)!;
        return markers;
    }, {} as {[tableName: string]: PropMapping});
    return mappedProps;
};

// Testing helper
// Cache is effective in prod, as schema doesn't change dynamically in runtime,
// but prevents tests for a schema generated on the fly from succeeding.
export function dropMappedPropsCache() {
    mappedProps = null;
}

export function getIdPropertyName(meta: EntityMetadata, propertyName: string) {
    const mapped = getMappedMarkers(meta.connection)[meta.tableName];
    if (!mapped) {
        throw new Error(`Unknown relation id target ${meta.tableName}`);
    }

    const relationIdProp = mapped[propertyName];
    if (!relationIdProp) {
        throw new Error(`No relation id prop defined for ${meta.tableName}.${propertyName}`);
    }

    return relationIdProp;
}
