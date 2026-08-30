/** Single source of truth for the minimum supported Node version. */
export declare const MIN_NODE_MAJOR = 22;
export declare const MIN_NODE_MINOR = 18;
export declare const MIN_NODE_LABEL = "22.18";
export declare const MIN_NODE_ENGINES = ">=22.18.0";
export declare function nodeMeetsMinimum(version?: string): boolean;
