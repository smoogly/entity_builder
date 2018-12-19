import { expect } from "chai";

import { RdbmsSchemaBuilder } from "typeorm/schema-builder/RdbmsSchemaBuilder";
import { typeOrmConfig } from "@lib/server/framework/db/typeorm_config";
import { SqlInMemory } from "typeorm/driver/SqlInMemory";
import { Connection } from "typeorm/connection/Connection";

import { dropMappedPropsCache, unsetRelationIdMarkerTarget } from "@lib/server/framework/repositories/typeorm/relation_id";
import { createConnection } from "typeorm";
import {
    generateTstEntityTypes,
    TstEntityShape,
    tstRelations,
    TstRelationType
} from "@lib/server/framework/repositories/typeorm/db_testing_util";
import { setRelation } from "@lib/server/framework/repositories/typeorm/set_relation";
import { Ctor } from "@lib/universal/framework/interfaces/types";
import { randomInteger } from "@lib/universal/utils/math_utils";
import { fetchEntities } from "@lib/server/framework/repositories/typeorm/entity_builder";

const schema = "main"; // Must be an existing schema as typeorm doesn't create one.
describe("Typeorm set relation", function() {
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

    const pad = async (Type: Ctor<any>) => {
        const num = randomInteger(1, 5);
        for (let i = 0; i < num; i++) {
            await connection.manager.save(new Type());
        }
    };

    const prepare = async (relation: TstRelationType) => {
        const shapes: { [name: string]: TstEntityShape } = {
            Origin: {
                originProp: "own",
                Target: relation
            },
            Target: {
                targetProp: "own",
                Origin: "inverse"
            },
            Unrelated: {
                unrelatedProp: "own"
            }
        };

        const { Origin, Target, Unrelated } = generateTstEntityTypes(schema, shapes);
        await setup(Origin, Target, Unrelated);

        await Promise.all([
            pad(Origin),
            pad(Target),
            pad(Unrelated)
        ]);

        const rawOriginInstance = new Origin();
        rawOriginInstance.originProp = 1;
        const originInstance = await connection.manager.save(rawOriginInstance);

        const rawTargetInstance = new Target();
        rawTargetInstance.targetProp = 2;
        const targetInstance = await connection.manager.save(rawTargetInstance);

        const rawUnrelatedInstance = new Unrelated();
        rawUnrelatedInstance.unrelatedProp = 3;
        const unrelatedInstance = await connection.manager.save(rawUnrelatedInstance);

        return {
            Origin,
            originInstance,
            Target,
            targetInstance,
            Unrelated,
            unrelatedInstance
        };
    };

    it("Should throw if origin entity doesn't exist", async () => {
        const { Origin, Target, targetInstance } = await prepare("owner-to-one");

        try {
            await setRelation(connection.manager, { type: Origin, id: "999" }, { type: Target, id: String(targetInstance.id) });
            throw new Error("Expected to throw");
        } catch (e) {
            expect(e.message).to.contain("does not exists");
        }
    });

    it("Should throw if target entity doesn't exist", async () => {
        const { Origin, Target, originInstance } = await prepare("owner-to-one");

        try {
            await setRelation(connection.manager, { type: Origin, id: String(originInstance.id) }, { type: Target, id: "9999" });
            throw new Error("Expected to throw");
        } catch (e) {
            expect(e.message).to.contain("does not exists");
        }
    });

    it("Should throw if entities don't have direct relation", async () => {
        const { Origin, Unrelated, originInstance, unrelatedInstance } = await prepare("owner-to-one");

        try {
            await setRelation(
                connection.manager,
                { type: Origin, id: String(originInstance.id) },
                { type: Unrelated, id: String(unrelatedInstance.id) }
            );
            throw new Error("Expected to throw");
        } catch (e) {
            expect(e.message).to.contain("No relation");
        }
    });

    it("Should correctly set foreign keys on owner-to-one relation", async () => {
        const { Origin, Target, originInstance, targetInstance } = await prepare("owner-to-one");

        await setRelation(
            connection.manager,
            { type: Origin, id: String(originInstance.id) },
            { type: Target, id: String(targetInstance.id) }
        );

        const updatedOrigin = await fetchEntities(connection.manager, Origin, [String(originInstance.id)]);
        expect((updatedOrigin[0] as any).TargetId).to.eql(targetInstance.id);
    });

    it("Should correctly set foreign keys on one-to-owner relation", async () => {
        const { Origin, Target, originInstance, targetInstance } = await prepare("one-to-owner");

        await setRelation(
            connection.manager,
            { type: Origin, id: String(originInstance.id) },
            { type: Target, id: String(targetInstance.id) }
        );

        const updatedOrigin = await fetchEntities(connection.manager, Origin, [String(originInstance.id)]);
        expect((updatedOrigin[0] as any).TargetId).to.eql(targetInstance.id);
    });

    it("Should correctly set foreign keys on one-to-many relation", async () => {
        const { Origin, Target, originInstance, targetInstance } = await prepare("one-to-many");

        await setRelation(
            connection.manager,
            { type: Origin, id: String(originInstance.id) },
            { type: Target, id: String(targetInstance.id) }
        );

        const updatedOrigin = await fetchEntities(connection.manager, Origin, [String(originInstance.id)]);
        expect((updatedOrigin[0] as any).TargetIds).to.contain(targetInstance.id);
    });

    it("Should correctly set foreign keys on many-to-one relation", async () => {
        const { Origin, Target, originInstance, targetInstance } = await prepare("many-to-one");

        await setRelation(
            connection.manager,
            { type: Origin, id: String(originInstance.id) },
            { type: Target, id: String(targetInstance.id) }
        );

        const updatedOrigin = await fetchEntities(connection.manager, Origin, [String(originInstance.id)]);
        expect((updatedOrigin[0] as any).TargetId).to.eql(targetInstance.id);
    });

    it("Should correctly set foreign keys on many-to-many relation", async () => {
        const { Origin, Target, originInstance, targetInstance } = await prepare("many-to-many");

        await setRelation(
            connection.manager,
            { type: Origin, id: String(originInstance.id) },
            { type: Target, id: String(targetInstance.id) }
        );

        const updatedOrigin = await fetchEntities(connection.manager, Origin, [String(originInstance.id)]);
        expect((updatedOrigin[0] as any).TargetIds).to.contain(targetInstance.id);
    });

    tstRelations.forEach(rel => {
        it(`Should not create additional entities when setting up a ${rel} relation`, async () => {
            const { Origin, Target, originInstance, targetInstance } = await prepare(rel);

            const initialNumOrigin = await connection.manager.count(Origin);
            const initialNumTarget = await connection.manager.count(Target);

            await setRelation(
                connection.manager,
                { type: Origin, id: String(originInstance.id) },
                { type: Target, id: String(targetInstance.id) }
            );

            const updatedNumOrigin = await connection.manager.count(Origin);
            const updatedNumTarget = await connection.manager.count(Target);

            expect(updatedNumOrigin).to.eql(initialNumOrigin);
            expect(updatedNumTarget).to.eql(initialNumTarget);
        });
    });
});
