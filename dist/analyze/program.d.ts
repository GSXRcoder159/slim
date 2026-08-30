import type ts from "typescript";
import type { Project } from "../project.ts";
import type { ProgramCtx } from "./model.ts";
export declare function readTsConfig(ts: typeof import("typescript"), project: Project): ts.ParsedCommandLine | null;
export declare function shouldEscalate(ts: typeof import("typescript"), project: Project, files: string[], getSf: (f: string) => ts.SourceFile, parsed: ts.ParsedCommandLine | null): boolean;
export declare function createScopedProgram(ts: typeof import("typescript"), project: Project, files: string[], parsed: ts.ParsedCommandLine | null): ProgramCtx;
