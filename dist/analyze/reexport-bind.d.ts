import type { Binding, CollectExtra } from "./model.ts";
export declare const MAX_REEXPORT_HOPS = 32;
export declare function bindLocalReexports(bindings: Binding[], extra: CollectExtra): void;
