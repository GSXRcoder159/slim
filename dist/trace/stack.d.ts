export type UserSite = {
    file: string;
    line: number;
    column: number;
};
export declare function captureUserSite(): UserSite | null;
