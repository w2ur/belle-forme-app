/**
 * The inventory editor's draft: text the user types, parsed back to the
 * inventory document on save.
 *
 * Numbers accept the French decimal comma (« 2,5 »). Dumbbells are a list
 * (« 2, 4, 6 »), plates are « poids x quantité » pairs (« 5x4, 2x4 »). Nothing
 * is guessed: an unreadable entry is reported, not dropped, so the user never
 * saves an inventory different from the one they typed.
 */
import {
  EQUIPMENT_VOCABULARY,
  STARTER_INVENTORY,
  normalizeInventory,
  validateInventory,
} from "../constants/equipment.js";

// A list is separated by « ; », by a comma FOLLOWED BY A SPACE, or by spaces alone:
// a bare comma is a decimal comma (« 2,5 »), and splitting on it would turn one
// dumbbell into two.
const LIST_SEPARATOR = /;\s*|,\s+|\s+/;

const toNumber = (text) => {
  const cleaned = String(text).trim().replace(",", ".");
  if (cleaned === "") return NaN;
  return Number(cleaned);
};
const formatNumber = (n) => String(n).replace(".", ",");

/** An inventory document → the strings the form shows. A missing inventory shows the starter. */
export function inventoryToDraft(inventory) {
  const inv = inventory ? normalizeInventory(inventory) : STARTER_INVENTORY;
  return {
    dumbbells: inv.dumbbellOptionsKg.map(formatNumber).join(", "),
    barEmptyKg: formatNumber(inv.barEmptyKg),
    barCount: String(inv.barCount),
    plates: inv.plateStock.map((p) => `${formatNumber(p.weightKg)}x${p.count}`).join(", "),
    ankleWeightKg: formatNumber(inv.ankleWeightKg),
    owned: [...inv.owned],
  };
}

/**
 * The form's strings → an inventory document.
 *
 * @returns {{ inventory: object|null, errors: string[] }} `inventory` is null when anything is unreadable.
 */
export function inventoryFromDraft(draft) {
  const errors = [];

  const dumbbellTexts = String(draft?.dumbbells ?? "").split(LIST_SEPARATOR).map((t) => t.trim()).filter(Boolean);
  const dumbbellOptionsKg = dumbbellTexts.map(toNumber);
  if (dumbbellOptionsKg.some((n) => !Number.isFinite(n))) errors.push("Haltères : une valeur n'est pas un nombre.");

  const plateTexts = String(draft?.plates ?? "").split(LIST_SEPARATOR).map((t) => t.trim()).filter(Boolean);
  const plateStock = plateTexts.map((text) => {
    const [weight, count] = text.toLowerCase().split("x");
    return { weightKg: toNumber(weight ?? ""), count: toNumber(count ?? "") };
  });
  if (plateStock.some((p) => !Number.isFinite(p.weightKg) || !Number.isInteger(p.count))) {
    errors.push("Disques : écris « poids x quantité », par exemple 5x4.");
  }

  const barEmptyKg = toNumber(draft?.barEmptyKg ?? "");
  const barCount = toNumber(draft?.barCount ?? "");
  const ankleWeightKg = toNumber(draft?.ankleWeightKg ?? "");
  if (!Number.isFinite(barEmptyKg)) errors.push("Barre à vide : une valeur n'est pas un nombre.");
  if (!Number.isFinite(barCount)) errors.push("Nombre de barres : une valeur n'est pas un nombre.");
  if (!Number.isFinite(ankleWeightKg)) errors.push("Lest de cheville : une valeur n'est pas un nombre.");
  if (errors.length) return { inventory: null, errors };

  const inventory = {
    dumbbellOptionsKg,
    barEmptyKg,
    barCount,
    plateStock,
    ankleWeightKg,
    owned: EQUIPMENT_VOCABULARY.filter((token) => (draft?.owned ?? []).includes(token)),
  };
  const checked = validateInventory(inventory);
  return checked.ok ? { inventory, errors: [] } : { inventory: null, errors: checked.errors };
}
