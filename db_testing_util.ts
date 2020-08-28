import { RelationIdMarker } from "@lib/server/framework/repositories/typeorm/relation_id";
import {
    Column,
    Entity,
    JoinColumn,
    JoinTable,
    ManyToMany,
    ManyToOne,
    OneToMany,
    OneToOne,
    PrimaryGeneratedColumn,
    EntityManager
} from "typeorm";
import { assertNever } from "@lib/universal/utils/assert_never";

export type TstRelationType = "owner-to-one" | "one-to-owner" | "one-to-many" | "many-to-one" | "many-to-many";
export const isTstRelationToMany = (relation: TstRelationType) => relation.split("-").pop() === "many";

type Relation = TstRelationType | "inverse";
export type TstEntityShape = {[prop: string]: "own" | Relation };

const inverse: {[P in TstRelationType]: TstRelationType} = {
    "owner-to-one": "one-to-owner",
    "one-to-owner": "owner-to-one",
    "one-to-many": "many-to-one",
    "many-to-one": "one-to-many",
    "many-to-many": "many-to-many"
};
export const tstRelations = Object.keys(inverse) as TstRelationType[];

export const generateTstEntityTypes = (schema: string, shapes: {[name: string]: TstEntityShape}) => {
    const names = Object.keys(shapes);
    const types = names.reduce((_types, name) => {
        class EntityType {
            @PrimaryGeneratedColumn()
            public id: number;
        }

        Object.defineProperty(EntityType, "name", { value: name });
        Reflect.decorate([ Entity({
            schema,
            name: `tst_${name}`
        }) ] as any, EntityType);


        _types[name] = EntityType;
        return _types;
    }, {});

    names.forEach(name => {
        const EntityType = types[name];
        const shape = shapes[name];

        Object.keys(shape).forEach(prop => {
            const relation = shape[prop];
            if (relation === "own") {
                Reflect.decorate([ Column({ type: "int", nullable: true }) ] as any, EntityType.prototype, prop, void 0);
            } else {
                const remote = types[prop];
                const isInverse = relation === "inverse";
                const relationType: TstRelationType = isInverse
                    ? inverse[(shapes[prop][name] as Relation)]
                    : relation;

                switch (relationType) {
                    case "owner-to-one":
                        Reflect.decorate([
                            OneToOne(() => remote, (other: typeof remote) => other[name]),
                            JoinColumn()
                        ] as any, EntityType.prototype, prop, void 0);
                        Reflect.decorate([ RelationIdMarker(prop) ] as any, EntityType.prototype, `${prop}Id`, void 0);
                        break;

                    case "one-to-owner":
                        Reflect.decorate([
                            OneToOne(() => remote, (other: typeof remote) => other[name])
                        ] as any, EntityType.prototype, prop, void 0);
                        Reflect.decorate([ RelationIdMarker(prop) ] as any, EntityType.prototype, `${prop}Id`, void 0);
                        break;

                    case "one-to-many":
                        Reflect.decorate([
                            OneToMany(() => remote, (other: typeof remote) => other[name])
                        ] as any, EntityType.prototype, prop, void 0);
                        Reflect.decorate([ RelationIdMarker(prop) ] as any, EntityType.prototype, `${prop}Ids`, void 0);
                        break;

                    case "many-to-one":
                        Reflect.decorate([
                            ManyToOne(() => remote, (other: typeof remote) => other[name])
                        ] as any, EntityType.prototype, prop, void 0);
                        Reflect.decorate([ RelationIdMarker(prop) ] as any, EntityType.prototype, `${prop}Id`, void 0);
                        break;

                    case "many-to-many":
                        const decorators = [
                            ManyToMany(() => remote, (other: typeof remote) => other[name])
                        ];
                        Reflect.decorate(
                            isInverse ? decorators.concat([JoinTable()]) : decorators as any,
                            EntityType.prototype, prop, void 0
                        );
                        Reflect.decorate([ RelationIdMarker(prop) ] as any, EntityType.prototype, `${prop}Ids`, void 0);
                        break;


                    default:
                        assertNever(relationType);
                        throw new Error(`Unhandled relation type ${relation}`);
                }
            }
        });
    });

    return types as any;
};

export const setupTstRelation = (
    manager: EntityManager,
    relation: TstRelationType,
    from: any, to: any
) => {
    switch (relation) {
        case "owner-to-one":
            from[to.constructor.name] = to;
            return manager.save(from);

        case "one-to-owner":
            to[from.constructor.name] = from;
            return manager.save(to);

        case "many-to-one":
            from[to.constructor.name] = to;
            return manager.save(from);

        case "one-to-many":
            to[from.constructor.name] = from;
            return manager.save(to);

        case "many-to-many":
            from[to.constructor.name] = [to];
            return manager.save(from);


        default:
            assertNever(relation);
            throw new Error(`Unhandled relation type ${relation}`);
    }
};
