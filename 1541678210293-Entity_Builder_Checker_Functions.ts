import { MigrationInterface, QueryRunner } from "typeorm";

// Note: these can't be edited! If a change is required — generate a new migration
const checkerFnName = (numArgs: number) => `execute_if_exists_n${numArgs}`;
const MAX_FN_ARGUMENTS = 99; // Postgres fn can't have more than 100 params. Checker fn has at most this many + 1.

const getFnDef = (numArgs: number) => {
    const argtypes = Array.from(Array(numArgs)).map(() => "int").join(",");
    return `${checkerFnName(numArgs)} (text, ${argtypes})`;
};

const safeCreateFnName = "safe_create_fn";
const safeCreateFnDef = `${safeCreateFnName}(text)`;

export class EntityBuilderCheckerFunctions1541678210293 implements MigrationInterface {

    public static checkerFnName = checkerFnName;
    public static MAX_FN_ARGUMENTS = MAX_FN_ARGUMENTS;
    public static MAX_FN_NAME_LENGTH = 63;
    public static safeCreateFnName = safeCreateFnName;

    public async up(queryRunner: QueryRunner): Promise<any> {
        // Safe create function (handles the case when two independent jobs create a same function in race condition)
        await queryRunner.query(`
            CREATE OR REPLACE FUNCTION ${safeCreateFnDef} RETURNS VOID
            AS $$
                BEGIN
                    EXECUTE $1;
                EXCEPTION
                    WHEN unique_violation THEN RETURN;
                    WHEN duplicate_function THEN RETURN;
                END;
            $$ LANGUAGE plpgsql
        `.replace(/\n/g, " "));

        // Execute if exists
        for (let i = 1; i <= MAX_FN_ARGUMENTS; i++) {
            const placeholders = Array.from(Array(i));
            const callPlaceholders = placeholders.map((x, j) => `\$${j + 1}`).join(",");
            const usingPlaceholders = placeholders.map((x, j) => `\$${j + 2}`).join(",");

            const fnsql = `
                CREATE OR REPLACE FUNCTION ${getFnDef(i)} RETURNS SETOF JSON STABLE
                AS $$
                    BEGIN
                        RETURN QUERY EXECUTE 'select res from ' || $1 || '(${callPlaceholders}) res' using ${usingPlaceholders};
                    EXCEPTION
                        WHEN undefined_function THEN RETURN NEXT null;
                    END;
                $$ LANGUAGE plpgsql ROWS ${i}
            `.replace(/\n/g, " ");

            await queryRunner.query(fnsql);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<any> {
        await queryRunner.query(`DROP FUNCTION IF EXISTS ${safeCreateFnDef} CASCADE`);

        for (let i = 1; i <= MAX_FN_ARGUMENTS; i++) {
            await queryRunner.query(`DROP FUNCTION IF EXISTS ${getFnDef(i)} CASCADE`);
        }
    }

}
