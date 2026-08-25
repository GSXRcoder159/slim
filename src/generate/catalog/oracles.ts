/**
 * MIT License
 *
 * Exact oracle versions used to qualify catalog slices. Install these as
 * Slim devDependencies only; they are never runtime dependencies.
 */

export const CATALOG_ORACLES = {
  lodash: "4.17.21",
  "lodash-es": "4.17.21",
  moment: "2.30.1",
  ms: "2.1.3",
  nanoid: "5.1.5",
  uuid: "11.1.0",
  clsx: "2.1.1",
  bluebird: "3.7.2",
  "mime-types": "2.1.35",
  "whatwg-url": "14.2.0",
} as const;

export type CatalogOraclePackage = keyof typeof CATALOG_ORACLES;
