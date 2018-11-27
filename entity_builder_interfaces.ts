import { EntityMetadata } from "typeorm";
import { Arr, Ctor, Having, Values } from "@lib/universal/framework/interfaces/types";

interface QueryNodeBase {
    alias: string;
    meta: EntityMetadata;
    nested: QueryNode[];
}
export interface QueryIdNode extends QueryNodeBase {
    type: "ids";
}
export interface QueryDataNode extends QueryNodeBase {
    type: "data";
}

export type QueryNode = QueryNodeBase & { type: QueryIdNode["type"] | QueryDataNode["type"] };


type Row = object & { id?: number };

type Rows<Entity> = Having<Row | Arr<Row>, Values<Entity>>;
type Nonoptional<T> = T extends undefined ? never
    : T extends null ? never
    : T;
type Individual<T> = T extends Arr<infer I> ? I : T;
type Referenced<Entity> = Individual<Nonoptional<Rows<Entity>>>;
type FetchNodes<T> = T extends any ? FetchNode<T> : never;

export interface FetchNode<Entity extends Row> {
    type: Ctor<Entity>;
    nested?: FetchNodes<Referenced<Entity>>[];
}
