/**
 * MIT License
 *
 * Original Slim catalog types. Not derived from lodash source.
 */

export interface CatalogEntry {
  id: string;
  pkg: string;
  symbol: string;
  source: string; // not required if you export the function directly
}
