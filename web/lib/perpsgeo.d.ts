export declare const PERPS_BLOCKED_COUNTRIES: string[];
export declare const PERPS_BLOCKED_REGIONS: Record<string, string[]>;
export declare function perpsBlocked(country?: string | null, region?: string | null): boolean;
