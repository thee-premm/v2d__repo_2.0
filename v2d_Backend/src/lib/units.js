/**
 * Ingredient units. Every ingredient has one dimension and one base unit:
 *   MASS → kg, VOLUME → l, COUNT → unit
 * Quantities are stored in base units. Conversion is only ever performed
 * within a dimension; anything else (e.g. grams → litres) is rejected because
 * it would require a density we do not have.
 */
export const UNITS = Object.freeze({
  kg: { dimension: "MASS", toBase: 1 },
  g: { dimension: "MASS", toBase: 0.001 },
  l: { dimension: "VOLUME", toBase: 1 },
  ml: { dimension: "VOLUME", toBase: 0.001 },
  unit: { dimension: "COUNT", toBase: 1 },
  dozen: { dimension: "COUNT", toBase: 12 },
});

export const BASE_UNIT = Object.freeze({ MASS: "kg", VOLUME: "l", COUNT: "unit" });
export const UNIT_NAMES = Object.keys(UNITS);

export class UnitError extends Error {}

export function toBaseUnits(quantity, unit, dimension) {
  const def = UNITS[unit];
  if (!def) throw new UnitError(`Unknown unit "${unit}"`);
  if (def.dimension !== dimension) {
    throw new UnitError(`Cannot convert ${unit} (${def.dimension.toLowerCase()}) to ${BASE_UNIT[dimension]} (${dimension.toLowerCase()})`);
  }
  if (!Number.isFinite(quantity) || quantity < 0) throw new UnitError("Quantity must be a non-negative number");
  return roundTo(quantity * def.toBase, 6);
}

export function roundTo(value, decimals) {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/** Round `qty` up to a whole number of packs, honouring a minimum order. */
export function applyOrderConstraints(qty, { packSize, minOrder } = {}) {
  if (qty <= 0) return 0;
  let out = qty;
  if (minOrder && out < minOrder) out = minOrder;
  if (packSize && packSize > 0) out = Math.ceil(roundTo(out / packSize, 6)) * packSize;
  return roundTo(out, 4);
}
