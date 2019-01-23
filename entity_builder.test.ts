// tslint:disable:no-use-before-declare

import { stub, SinonStub } from "sinon";
import { expect } from "chai";

import {
    Column,
    createConnection,
    Entity,
    JoinColumn,
    JoinTable,
    ManyToMany,
    ManyToOne,
    OneToMany,
    OneToOne,
    PrimaryGeneratedColumn
} from "typeorm";
import { RdbmsSchemaBuilder } from "typeorm/schema-builder/RdbmsSchemaBuilder";
import { typeOrmConfig } from "@lib/server/framework/db/typeorm_config";
import { SqlInMemory } from "typeorm/driver/SqlInMemory";
import { Connection } from "typeorm/connection/Connection";

import { fetchEntities } from "@lib/server/framework/repositories/typeorm/entity_builder";
import {
    dropMappedPropsCache,
    RelationIdMarker,
    unsetRelationIdMarkerTarget
} from "@lib/server/framework/repositories/typeorm/relation_id";
import { randomInteger } from "@lib/universal/utils/math_utils";
import { Ctor } from "@lib/universal/framework/interfaces/types";
import { LocalDate } from "js-joda";
import { LocalDateColumn } from "@lib/server/domain/entities/entities_utils";
import {
    generateTstEntityTypes,
    isTstRelationToMany,
    TstEntityShape,
    tstRelations, TstRelationType, setupTstRelation
} from "@lib/server/framework/repositories/typeorm/db_testing_util";

type ArrVal<T> = T extends Array<infer I> ? I : never;
type Res<T> = {
    [P in keyof T]?: T[P] extends {id: number} ? Res<T[P]> | number | null
        : T[P] extends {id: number}[] ? Res<ArrVal<T[P]>>[] | number[] | null
        : T[P]
};

const schema = "main"; // Must be an existing schema as typeorm doesn't create one.
describe("TypeORM entity builder", function() {
    this.slow(500); // These tests have high setup time

    let connection: Connection;
    let setupEntities: (new (...args: any[]) => any)[];
    let setup: (...entities: typeof setupEntities) => Promise<void>;
    let downQueries: SqlInMemory["downQueries"] | null;
    beforeEach(async () => {
        downQueries = null;
        setup = async (...entities) => {
            setupEntities = entities;
            connection = await createConnection({
                name: "typeorm_entity_builder_tests",
                type: "postgres",
                entities: entities,

                username: typeOrmConfig.username,
                password: typeOrmConfig.password,
                database: typeOrmConfig.database
            });

            const schemaBuilder = new RdbmsSchemaBuilder(connection);
            downQueries = (await schemaBuilder.log()).downQueries;
            await schemaBuilder.build();
        };
    });

    afterEach(async () => {
        if (downQueries === null) { throw new Error("Down queries not defined, did the test wait for setup to finish?"); }
        await downQueries.reduceRight(async (prev, query) => {
            await prev;
            await connection.query(query);
        }, Promise.resolve());
        await connection.close();

        dropMappedPropsCache();
        setupEntities.forEach(unsetRelationIdMarkerTarget);
    });

    it("Should return empty array if no ids given", async () => {
        @Entity({
            schema,
            name: "tst_target"
        })
        class TargetEntity {
            @PrimaryGeneratedColumn()
            public id?: number;
        }

        await setup(TargetEntity);
        expect(await fetchEntities(connection.manager, TargetEntity, [])).to.eql([]);
    });

    it("Should fetch an entity that has no relations in its entirety", async () => {
        @Entity({
            schema,
            name: "tst_target"
        })
        class TargetEntity {
            @PrimaryGeneratedColumn()
            public id?: number;

            @Column({ type: "boolean", default: false })
            public booleanProp: boolean;

            @Column({ type: "int" })
            public intProp: number;
        }

        await setup(TargetEntity);

        const target = new TargetEntity();
        target.intProp = 99999;

        const saved = await connection.manager.save(target);
        const expected: Res<TargetEntity> = {
            id: saved.id,
            booleanProp: saved.booleanProp,
            intProp: saved.intProp
        };

        const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);
        expect(read[0]).to.eql(expected);
    });

    it("Should not return a result for non-existent entities", async () => {
        @Entity({
            schema,
            name: "tst_target"
        })
        class TargetEntity {
            @PrimaryGeneratedColumn()
            public id?: number;
        }

        await setup(TargetEntity);

        const saved = await connection.manager.save(new TargetEntity());
        const res = await fetchEntities(connection.manager, TargetEntity, ["123", String(saved.id)]);

        expect(res).to.eql([{ id: saved.id }]);
    });

    it("Should use typeorm builtins to hydrate received properties", async () => {
        @Entity({
            schema,
            name: "tst_target"
        })
        class TargetEntity {
            @PrimaryGeneratedColumn()
            public id?: number;

            @LocalDateColumn()
            public date: LocalDate;
        }

        await setup(TargetEntity);

        const tgt = new TargetEntity();
        tgt.date = LocalDate.now();

        const saved = await connection.manager.save(tgt);
        const res = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

        expect(res[0]).to.have.property("date");
        expect((res[0] as any).date).to.be.an.instanceof(LocalDate);
    });

    describe("Batching", () => {
        it("Should batch requests when lots of ids are requested", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id?: number;
            }

            await setup(TargetEntity);

            const onRequest = stub();

            const ids = Array.from(Array(1000)).map((x, i) => String(i + 1));
            await fetchEntities(connection.manager, TargetEntity, ids, onRequest);

            expect(onRequest.callCount).to.be.greaterThan(5);
        });

        it("Should run a transaction when lots of ids are requested", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id?: number;
            }

            await setup(TargetEntity);

            stub(connection.manager, "transaction");

            const ids = Array.from(Array(1000)).map((x, i) => String(i + 1));
            await fetchEntities(connection.manager, TargetEntity, ids);

            const t = connection.manager.transaction as SinonStub;
            expect(t.calledOnce).to.eql(true);
        });

        it("Should not run a transaction if lots of ids are requested and external transaction is already set up", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id?: number;
            }

            await setup(TargetEntity);
            return connection.manager.transaction(async em => {
                stub(em, "transaction");

                const ids = Array.from(Array(1000)).map((x, i) => String(i + 1));
                await fetchEntities(em, TargetEntity, ids);

                const t = em.transaction as SinonStub;
                expect(t.called).to.eql(false);
            });
        });
    });

    describe("Relation ids", () => {
        it("Should fetch id of one-to-one relation from owner to non-owner", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @OneToOne(type => RelatedEntity, rel => rel.target)
                @JoinColumn()
                public related: RelatedEntity;

                @RelationIdMarker("related")
                public relatedId?: number;
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @OneToOne(type => TargetEntity, tgt => tgt.related)
                public target: TargetEntity;

                @RelationIdMarker("target")
                public targetId?: number;
            }

            await setup(TargetEntity, RelatedEntity);

            const related = new RelatedEntity();
            related.relatedIntProp = 123;

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = await connection.manager.save(related);

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                relatedId: saved.related.id
            };

            const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should fetch id of one-to-one relation from non-owner to owner", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @OneToOne(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity;

                @RelationIdMarker("related")
                public relatedId?: number;
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @OneToOne(type => TargetEntity, tgt => tgt.related)
                @JoinColumn()
                public target: TargetEntity;

                @RelationIdMarker("target")
                public targetId?: number;
            }

            await setup(TargetEntity, RelatedEntity);

            const related = new RelatedEntity();
            related.relatedIntProp = 123;

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = await connection.manager.save(related);

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                relatedId: saved.related.id
            };

            const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should fetch id of many-to-one relation", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @ManyToOne(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity;

                @RelationIdMarker("related")
                public relatedId?: number;
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @OneToMany(type => TargetEntity, tgt => tgt.related)
                public target: TargetEntity[];

                @RelationIdMarker("target")
                public targetIds?: number[];
            }

            await setup(TargetEntity, RelatedEntity);

            const related = new RelatedEntity();
            related.relatedIntProp = 123;

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = await connection.manager.save(related);

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                relatedId: saved.related.id
            };

            const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should fetch ids of one-to-many relation", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @OneToMany(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity[];

                @RelationIdMarker("related")
                public relatedIds?: number[];
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @ManyToOne(type => TargetEntity, tgt => tgt.related)
                public target: TargetEntity;

                @RelationIdMarker("target")
                public targetId?: number;
            }

            await setup(TargetEntity, RelatedEntity);

            const rel1 = await connection.manager.save(Object.assign(new RelatedEntity(), {relatedIntProp: 123}));
            const rel2 = await connection.manager.save(Object.assign(new RelatedEntity(), {relatedIntProp: 321}));

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = [rel2, rel1];

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                relatedIds: [rel1.id, rel2.id] // Sorted in ascending order
            };

            const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should fetch ids of many-to-many relations", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @ManyToMany(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity[];

                @RelationIdMarker("related")
                public relatedIds?: number[];
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @ManyToMany(type => TargetEntity, tgt => tgt.related)
                @JoinTable()
                public target: TargetEntity[];

                @RelationIdMarker("target")
                public targetIds?: number[];
            }

            await setup(TargetEntity, RelatedEntity);

            const rel1 = await connection.manager.save(Object.assign(new RelatedEntity(), {relatedIntProp: 123}));
            const rel2 = await connection.manager.save(Object.assign(new RelatedEntity(), {relatedIntProp: 321}));

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = [rel2, rel1]; // inverse order

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                relatedIds: [rel1.id, rel2.id] // ascending order
            };

            const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should omit id of missing one-to-one relation", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @OneToOne(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity;

                @RelationIdMarker("related")
                public relatedId?: number;
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @OneToOne(type => TargetEntity, tgt => tgt.related)
                @JoinColumn()
                public target: TargetEntity;

                @RelationIdMarker("target")
                public targetId?: number;
            }

            await setup(TargetEntity, RelatedEntity);

            const target = new TargetEntity();
            target.intProp = 3313;

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp
                // relatedId omitted
            };

            const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        describe("Id marker", () => {
            it("Should use relation id name specified by RelationIdMarker when requesting one-to-owner ids", async () => {
                @Entity({
                    schema,
                    name: "tst_target"
                })
                class TargetEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @OneToOne(type => RelatedEntity, rel => rel.target)
                    public related: RelatedEntity;

                    @RelationIdMarker("related")
                    public absolutelyUnrelated?: number;
                }

                @Entity({
                    schema,
                    name: "tst_related_entity"
                })
                class RelatedEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @OneToOne(type => TargetEntity, tgt => tgt.related)
                    @JoinColumn()
                    public target: TargetEntity;

                    @RelationIdMarker("target")
                    public sadfsadDasdsadfsaf?: number;
                }

                await setup(TargetEntity, RelatedEntity);

                const target = new TargetEntity();
                target.related = await connection.manager.save(new RelatedEntity());

                const saved = await connection.manager.save(target);
                const expected: Res<TargetEntity> = {
                    id: saved.id,
                    absolutelyUnrelated: saved.related.id
                };

                const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

                expect(read[0]).to.eql(expected);
            });

            it("Should use relation id name specified by RelationIdMarker when requesting owner-to-one ids", async () => {
                @Entity({
                    schema,
                    name: "tst_target"
                })
                class TargetEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @OneToOne(type => RelatedEntity, rel => rel.target)
                    @JoinColumn()
                    public related: RelatedEntity;

                    @RelationIdMarker("related")
                    public safasdfasdfsadfsdfsadfsdf?: number;
                }

                @Entity({
                    schema,
                    name: "tst_related_entity"
                })
                class RelatedEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @OneToOne(type => TargetEntity, tgt => tgt.related)
                    public target: TargetEntity;

                    @RelationIdMarker("target")
                    public sadfasdfs?: number;
                }

                await setup(TargetEntity, RelatedEntity);

                const target = new TargetEntity();
                target.related = await connection.manager.save(new RelatedEntity());

                const saved = await connection.manager.save(target);
                const expected: Res<TargetEntity> = {
                    id: saved.id,
                    safasdfasdfsadfsdfsadfsdf: saved.related.id
                };

                const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

                expect(read[0]).to.eql(expected);
            });

            it("Should use relation id name specified by RelationIdMarker when requesting one-to-many ids", async () => {
                @Entity({
                    schema,
                    name: "tst_target"
                })
                class TargetEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @OneToMany(type => RelatedEntity, rel => rel.target)
                    public related: RelatedEntity[];

                    @RelationIdMarker("related")
                    public asdfsadfasdfsdafsadsdaf?: number[];
                }

                @Entity({
                    schema,
                    name: "tst_related_entity"
                })
                class RelatedEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @ManyToOne(type => TargetEntity, tgt => tgt.related)
                    public target: TargetEntity;

                    @RelationIdMarker("target")
                    public asasdfsadf?: number;
                }

                await setup(TargetEntity, RelatedEntity);

                const rel1 = await connection.manager.save(new RelatedEntity());
                const rel2 = await connection.manager.save(new RelatedEntity());

                const target = new TargetEntity();
                target.related = [rel2, rel1];

                const saved = await connection.manager.save(target);
                const expected: Res<TargetEntity> = {
                    id: saved.id,
                    asdfsadfasdfsdafsadsdaf: [rel1.id, rel2.id]
                };

                const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

                expect(read[0]).to.eql(expected);
            });

            it("Should use relation id name specified by RelationIdMarker when requesting many-to-one ids", async () => {
                @Entity({
                    schema,
                    name: "tst_target"
                })
                class TargetEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @ManyToOne(type => RelatedEntity, rel => rel.target)
                    public related: RelatedEntity;

                    @RelationIdMarker("related")
                    public AsdfaAsadfgfagsdfg?: number;
                }

                @Entity({
                    schema,
                    name: "tst_related_entity"
                })
                class RelatedEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @OneToMany(type => TargetEntity, tgt => tgt.related)
                    public target: TargetEntity[];

                    @RelationIdMarker("target")
                    public targeasdfsafdsadfsdftIds?: number[];
                }

                await setup(TargetEntity, RelatedEntity);

                const target = new TargetEntity();
                target.related = await connection.manager.save(new RelatedEntity());

                const saved = await connection.manager.save(target);
                const expected: Res<TargetEntity> = {
                    id: saved.id,
                    AsdfaAsadfgfagsdfg: saved.related.id
                };

                const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

                expect(read[0]).to.eql(expected);
            });

            it("Should use relation id name specified by RelationIdMarker when requesting many-to-many ids", async () => {
                @Entity({
                    schema,
                    name: "tst_target"
                })
                class TargetEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @ManyToMany(type => RelatedEntity, rel => rel.target)
                    public related: RelatedEntity[];

                    @RelationIdMarker("related")
                    public safsafsaAAFDSDFsdfasdfsadf?: number[];
                }

                @Entity({
                    schema,
                    name: "tst_related_entity"
                })
                class RelatedEntity {
                    @PrimaryGeneratedColumn()
                    public id: number;

                    @ManyToMany(type => TargetEntity, tgt => tgt.related)
                    @JoinTable()
                    public target: TargetEntity[];

                    @RelationIdMarker("target")
                    public asdfsadfsadfsdfdsfdsf?: number[];
                }

                await setup(TargetEntity, RelatedEntity);

                const rel1 = await connection.manager.save(new RelatedEntity());
                const rel2 = await connection.manager.save(new RelatedEntity());

                const target = new TargetEntity();
                target.related = [rel2, rel1];

                const saved = await connection.manager.save(target);
                const expected: Res<TargetEntity> = {
                    id: saved.id,
                    safsafsaAAFDSDFsdfasdfsadf: [rel1.id, rel2.id]
                };

                const read = await fetchEntities(connection.manager, TargetEntity, [String(saved.id)]);

                expect(read[0]).to.eql(expected);
            });

        });
    });

    describe("Relation data", () => {
        it("Should fetch an entity with one(owner)-to-one relation as having a child entity", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @OneToOne(type => RelatedEntity, rel => rel.target)
                @JoinColumn()
                public related: RelatedEntity;

                @RelationIdMarker("related")
                public relatedId?: number;
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @OneToOne(type => TargetEntity, tgt => tgt.related)
                public target: TargetEntity;

                @RelationIdMarker("target")
                public targetId?: number;
            }

            await setup(TargetEntity, RelatedEntity);

            const related = new RelatedEntity();
            related.relatedIntProp = 123;

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = await connection.manager.save(related);

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                related: {
                    id: saved.related.id,
                    relatedIntProp: saved.related.relatedIntProp,
                    targetId: saved.id
                }
            };

            const read = await fetchEntities(connection.manager, {
                type: TargetEntity,
                nested: [{
                    type: RelatedEntity
                }]
            }, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should fetch an entity with one-to-one(owner) relation as having a child entity", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @OneToOne(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity;

                @RelationIdMarker("related")
                public relatedId?: number;
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @OneToOne(type => TargetEntity, tgt => tgt.related)
                @JoinColumn()
                public target: TargetEntity;

                @RelationIdMarker("target")
                public targetId?: number;
            }

            await setup(TargetEntity, RelatedEntity);

            const related = new RelatedEntity();
            related.relatedIntProp = 123;

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = await connection.manager.save(related);

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                related: {
                    id: saved.related.id,
                    relatedIntProp: saved.related.relatedIntProp,
                    targetId: saved.id
                }
            };

            const read = await fetchEntities(connection.manager, {
                type: TargetEntity,
                nested: [{
                    type: RelatedEntity
                }]
            }, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should fetch an entity with many-to-one relation as having a child entity", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @ManyToOne(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity;

                @RelationIdMarker("related")
                public relatedId?: number;
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @OneToMany(type => TargetEntity, tgt => tgt.related)
                public target: TargetEntity[];

                @RelationIdMarker("target")
                public targetIds?: number[];
            }

            await setup(TargetEntity, RelatedEntity);

            const related = new RelatedEntity();
            related.relatedIntProp = 123;

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = await connection.manager.save(related);

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                related: {
                    id: saved.related.id,
                    relatedIntProp: saved.related.relatedIntProp,
                    targetIds: [saved.id]
                }
            };

            const read = await fetchEntities(connection.manager, {
                type: TargetEntity,
                nested: [{
                    type: RelatedEntity
                }]
            }, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should fetch an entity with one-to-many relation as having a child entity", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @OneToMany(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity[];

                @RelationIdMarker("related")
                public relatedIds?: number[];
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @ManyToOne(type => TargetEntity, tgt => tgt.related)
                public target: TargetEntity;

                @RelationIdMarker("target")
                public targetId?: number;
            }

            await setup(TargetEntity, RelatedEntity);

            const rel1 = await connection.manager.save(Object.assign(new RelatedEntity(), {relatedIntProp: 123}));
            const rel2 = await connection.manager.save(Object.assign(new RelatedEntity(), {relatedIntProp: 321}));

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = [rel2, rel1]; // inverse order

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                related: [
                    {
                        id: rel1.id,
                        relatedIntProp: rel1.relatedIntProp,
                        targetId: saved.id
                    },
                    {
                        id: rel2.id,
                        relatedIntProp: rel2.relatedIntProp,
                        targetId: saved.id
                    }
                ]
            };

            const read = await fetchEntities(connection.manager, {
                type: TargetEntity,
                nested: [{
                    type: RelatedEntity
                }]
            }, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should fetch an entity with many-to-many relation as having a child entity", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @ManyToMany(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity[];

                @RelationIdMarker("related")
                public relatedIds?: number[];
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @ManyToMany(type => TargetEntity, tgt => tgt.related)
                @JoinTable()
                public target: TargetEntity[];

                @RelationIdMarker("target")
                public targetIds?: number[];
            }

            await setup(TargetEntity, RelatedEntity);

            const rel1 = await connection.manager.save(Object.assign(new RelatedEntity(), {relatedIntProp: 123}));
            const rel2 = await connection.manager.save(Object.assign(new RelatedEntity(), {relatedIntProp: 321}));

            const target = new TargetEntity();
            target.intProp = 3313;
            target.related = [rel2, rel1]; // inverse order

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                related: [
                    {
                        id: rel1.id,
                        relatedIntProp: rel1.relatedIntProp,
                        targetIds: [saved.id]
                    },
                    {
                        id: rel2.id,
                        relatedIntProp: rel2.relatedIntProp,
                        targetIds: [saved.id]
                    }
                ]
            };

            const read = await fetchEntities(connection.manager, {
                type: TargetEntity,
                nested: [{
                    type: RelatedEntity
                }]
            }, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should fetch circular relation as ids even if it contains previously unseen ids", async () => {
            // A1 -> B -> A2

            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @ManyToOne(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity;

                @RelationIdMarker("related")
                public relatedId?: number;
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @OneToMany(type => TargetEntity, tgt => tgt.related)
                public target: TargetEntity[];

                @RelationIdMarker("target")
                public targetIds?: number[];
            }

            await setup(TargetEntity, RelatedEntity);

            const relUnsaved = new RelatedEntity();
            relUnsaved.relatedIntProp = 3;
            const related = await connection.manager.save(relUnsaved);

            const target = new TargetEntity();
            target.intProp = 1;
            target.related = related;
            const saved = await connection.manager.save(target);

            const other = new TargetEntity();
            other.intProp = 2;
            other.related = related;
            const otherSaved = await connection.manager.save(other);

            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                related: {
                    id: related.id,
                    relatedIntProp: related.relatedIntProp,
                    targetIds: [
                        saved.id,
                        otherSaved.id
                    ]
                }
            };

            const read = await fetchEntities(connection.manager, {
                type: TargetEntity,
                nested: [{
                    type: RelatedEntity
                }]
            }, [String(saved.id)]);
            expect(read[0]).to.eql(expected);
        });

        it("Should omit an id of missing one-to-one relation", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @OneToOne(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity;

                @RelationIdMarker("related")
                public relatedId?: number;
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @OneToOne(type => TargetEntity, tgt => tgt.related)
                @JoinColumn()
                public target: TargetEntity;

                @RelationIdMarker("target")
                public targetId?: number;
            }

            await setup(TargetEntity, RelatedEntity);

            const target = new TargetEntity();
            target.intProp = 3313;

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp
            };

            const read = await fetchEntities(connection.manager, {
                type: TargetEntity,
                nested: [{
                    type: RelatedEntity
                }]
            }, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });

        it("Should use empty array when there are no ids on a remote side of one-to-many relation", async () => {
            @Entity({
                schema,
                name: "tst_target"
            })
            class TargetEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public intProp: number;

                @OneToMany(type => RelatedEntity, rel => rel.target)
                public related: RelatedEntity[];

                @RelationIdMarker("related")
                public relatedIds?: number[];
            }

            @Entity({
                schema,
                name: "tst_related_entity"
            })
            class RelatedEntity {
                @PrimaryGeneratedColumn()
                public id: number;

                @Column({ type: "int" })
                public relatedIntProp: number;

                @ManyToOne(type => TargetEntity, tgt => tgt.related)
                public target: TargetEntity;

                @RelationIdMarker("target")
                public targetId?: number;
            }

            await setup(TargetEntity, RelatedEntity);

            const target = new TargetEntity();
            target.intProp = 3313;

            const saved = await connection.manager.save(target);
            const expected: Res<TargetEntity> = {
                id: saved.id,
                intProp: saved.intProp,
                related: []
            };

            const read = await fetchEntities(connection.manager, {
                type: TargetEntity,
                nested: [{
                    type: RelatedEntity
                }]
            }, [String(saved.id)]);

            expect(read[0]).to.eql(expected);
        });
    });

    describe("Nested relation data", () => {
        const setupRelation = (relation: TstRelationType, from: any, to: any) => setupTstRelation(connection.manager, relation, from, to);
        const pad = async (Type: Ctor<any>) => {
            const num = randomInteger(1, 5);
            for (let i = 0; i < num; i++) {
                await connection.manager.save(new Type());
            }
        };

        for (let i = 0; i < tstRelations.length; i++) {
            const rel1 = tstRelations[i];
            for (let j = 0; j < tstRelations.length; j++) {
                const rel2 = tstRelations[j];
                for (let k = 0; k < tstRelations.length; k++) {
                    const rel3 = tstRelations[k];

                    it(`Should correctly fetch data via ${rel1} through ${rel2} to ${rel3}`, async () => {
                        const shapes: {[name: string]: TstEntityShape} = {
                            A: {
                                aprop: "own",
                                B: rel1
                            },
                            B: {
                                bprop: "own",
                                A: "inverse",
                                C: rel2
                            },
                            C: {
                                cprop: "own",
                                B: "inverse",
                                D: rel3
                            },
                            D: {
                                dprop: "own",
                                C: "inverse"
                            }
                        };
                        const {A, B, C, D} = generateTstEntityTypes(schema, shapes) as any;

                        await setup(A, B, C, D);
                        await [A, B, C, D].reduce(async (prev, Type) => prev.then(() => pad(Type)), Promise.resolve());

                        const a = await connection.manager.save(Object.assign(new A(), {
                            aprop: randomInteger(0, 100)
                        }));

                        const b = await connection.manager.save(Object.assign(new B(), {
                            bprop: randomInteger(0, 100)
                        }));

                        const c = await connection.manager.save(Object.assign(new C(), {
                            cprop: randomInteger(0, 100)
                        }));

                        const d = await connection.manager.save(Object.assign(new D(), {
                            dprop: randomInteger(0, 100)
                        }));

                        await setupRelation(rel1, a, b);
                        await setupRelation(rel2, b, c);
                        await setupRelation(rel3, c, d);

                        const read: any = await fetchEntities(connection.manager, {
                            type: A,
                            nested: [{
                                type: B,
                                nested: [{
                                    type: C
                                }]
                            }]
                        }, [String(a.id)]);

                        const readA = read[0];

                        expect(readA.id).to.eql(a.id);
                        expect(readA.aprop).to.eql(a.aprop);

                        const readB = isTstRelationToMany(rel1) ? readA.B[0] : readA.B;
                        expect(readB.id).to.eql(b.id);
                        expect(readB.bprop).to.eql(b.bprop);

                        const readC = isTstRelationToMany(rel2) ? readB.C[0] : readB.C;
                        expect(readC.id).to.eql(c.id);
                        expect(readC.cprop).to.eql(c.cprop);

                        if (isTstRelationToMany(rel3)) {
                            expect(readC.DIds).to.eql([d.id]);
                        } else {
                            expect(readC.DId).to.eql(d.id);
                        }
                    });
                }
            }
        }
    });

    it("Should return entities in order of supplied ids", async () => {
        @Entity({
            schema,
            name: "tst_target"
        })
        class TargetEntity {
            @PrimaryGeneratedColumn()
            public id?: number;
        }

        await setup(TargetEntity);

        const entities = await Promise.all(Array.from(Array(3)).map(() => connection.manager.save(new TargetEntity())));
        const reversed = [...entities].reverse();
        const ids = reversed.concat(entities).map(e => String(e.id)); // 3, 2, 1, 1, 2, 3

        const fetched = await fetchEntities(connection.manager, TargetEntity, ids);
        expect(fetched).to.have.lengthOf(entities.length); // Dedupe
        expect(fetched.map(e => e.id)).to.eql(reversed.map(e => e.id));
    });
});
