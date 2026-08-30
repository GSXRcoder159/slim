import { type OsvVuln } from "./osv.ts";
export type Exposure = "exposed" | "unmapped" | "not-exposed";
export interface ExposureMap {
    exposure: Exposure;
    mappedEvidence: string;
    unmappedReason: string | null;
    affectedRange: string;
}
export declare function sliceExposure(vuln: OsvVuln, usedSymbols: string[]): ExposureMap;
