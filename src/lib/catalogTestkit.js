/**
 * Test-only: `buildCatalogViews` with the fixed test inventory as its default,
 * so a test that builds a catalog from the seed validates loads against known
 * equipment. Production code never imports this.
 */
import { buildCatalogViews as build } from "./catalog.js";
import { TEST_INVENTORY } from "../constants/testInventory.js";

export const buildCatalogViews = (doc, inventory = TEST_INVENTORY) => build(doc, inventory);
