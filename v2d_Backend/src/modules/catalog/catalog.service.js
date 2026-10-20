import { query, withTransaction } from "../../config/db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { toBaseUnits, UnitError, BASE_UNIT } from "../../lib/units.js";
import { can } from "../../domain/permissions.js";
import { recordAudit } from "../audit/audit.service.js";
import { camel } from "../org/org.service.js";

const assertManage = (p) => {
  if (!can.manageCatalog(p)) throw forbidden();
};
const assertView = (p) => {
  if (!can.viewCatalog(p)) throw forbidden();
};

export async function listIngredients(principal, { q, includeInactive }) {
  assertView(principal);
  const r = await query(
    `SELECT id, name, dimension, cost_per_base_unit, category, is_active, updated_at
       FROM ingredients
      WHERE institution_id = $1 AND ($2::text IS NULL OR lower(name) LIKE $2) AND ($3 OR is_active)
      ORDER BY lower(name)`,
    [principal.institutionId, q ? `%${q.toLowerCase()}%` : null, Boolean(includeInactive)],
  );
  return r.rows.map((row) => ({ ...camel(row), baseUnit: BASE_UNIT[row.dimension] }));
}

export async function createIngredient(principal, i) {
  assertManage(principal);
  return withTransaction(async (client) => {
    const r = await query(
      `INSERT INTO ingredients (institution_id, name, dimension, cost_per_base_unit, category) VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, dimension, cost_per_base_unit, category, is_active`,
      [principal.institutionId, i.name, i.dimension, i.costPerBaseUnit ?? null, i.category ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "ingredient.created", entityType: "ingredient", entityId: r.rows[0].id, after: r.rows[0] });
    return { ...camel(r.rows[0]), baseUnit: BASE_UNIT[i.dimension] };
  });
}

export async function updateIngredient(principal, id, patch) {
  assertManage(principal);
  return withTransaction(async (client) => {
    const before = (await query(`SELECT * FROM ingredients WHERE id = $1 AND institution_id = $2 FOR UPDATE`, [id, principal.institutionId], client)).rows[0];
    if (!before) throw notFound("Ingredient");
    const r = await query(
      `UPDATE ingredients SET name = COALESCE($2, name),
              cost_per_base_unit = CASE WHEN $3::boolean THEN $4 ELSE cost_per_base_unit END,
              category = COALESCE($5, category), is_active = COALESCE($6, is_active)
        WHERE id = $1 RETURNING id, name, dimension, cost_per_base_unit, category, is_active`,
      [id, patch.name ?? null, patch.costPerBaseUnit !== undefined, patch.costPerBaseUnit ?? null, patch.category ?? null, patch.isActive ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "ingredient.updated", entityType: "ingredient", entityId: id, before, after: r.rows[0] });
    return { ...camel(r.rows[0]), baseUnit: BASE_UNIT[r.rows[0].dimension] };
  });
}

const DISH_SELECT = `
  SELECT d.id, d.name, d.category, d.is_vegetarian, d.portion_grams, d.description, d.is_active, d.updated_at,
         COALESCE((SELECT json_agg(json_build_object(
                    'ingredientId', i.id, 'name', i.name, 'dimension', i.dimension,
                    'quantityPerServing', di.quantity_per_serving, 'yieldFactor', di.yield_factor,
                    'costPerBaseUnit', i.cost_per_base_unit) ORDER BY i.name)
                   FROM dish_ingredients di JOIN ingredients i ON i.id = di.ingredient_id WHERE di.dish_id = d.id), '[]') AS ingredients
    FROM dishes d`;

const mapDish = (row) => {
  const d = camel(row);
  d.ingredients = d.ingredients.map((i) => ({ ...i, baseUnit: BASE_UNIT[i.dimension], quantityPerServing: Number(i.quantityPerServing), yieldFactor: Number(i.yieldFactor) }));
  d.hasRecipe = d.ingredients.length > 0;
  return d;
};

export async function listDishes(principal, { q, includeInactive }) {
  // Students see dish names through menus only; the catalogue is staff-facing.
  assertView(principal);
  const r = await query(
    `${DISH_SELECT} WHERE d.institution_id = $1 AND ($2::text IS NULL OR lower(d.name) LIKE $2) AND ($3 OR d.is_active) ORDER BY lower(d.name)`,
    [principal.institutionId, q ? `%${q.toLowerCase()}%` : null, Boolean(includeInactive)],
  );
  return r.rows.map(mapDish);
}

export async function getDish(principal, id, client) {
  assertView(principal);
  const r = await query(`${DISH_SELECT} WHERE d.id = $1 AND d.institution_id = $2`, [id, principal.institutionId], client);
  if (!r.rows[0]) throw notFound("Dish");
  return mapDish(r.rows[0]);
}

export async function createDish(principal, d) {
  assertManage(principal);
  return withTransaction(async (client) => {
    const r = await query(
      `INSERT INTO dishes (institution_id, name, category, is_vegetarian, portion_grams, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [principal.institutionId, d.name, d.category ?? null, d.isVegetarian ?? null, d.portionGrams ?? null, d.description ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "dish.created", entityType: "dish", entityId: r.rows[0].id, after: d });
    return getDish(principal, r.rows[0].id, client);
  });
}

export async function updateDish(principal, id, patch) {
  assertManage(principal);
  return withTransaction(async (client) => {
    const before = (await query(`SELECT * FROM dishes WHERE id = $1 AND institution_id = $2 FOR UPDATE`, [id, principal.institutionId], client)).rows[0];
    if (!before) throw notFound("Dish");
    await query(
      `UPDATE dishes SET name = COALESCE($2, name), category = COALESCE($3, category), is_vegetarian = COALESCE($4, is_vegetarian),
              portion_grams = CASE WHEN $5::boolean THEN $6 ELSE portion_grams END, description = COALESCE($7, description), is_active = COALESCE($8, is_active)
        WHERE id = $1`,
      [id, patch.name ?? null, patch.category ?? null, patch.isVegetarian ?? null, patch.portionGrams !== undefined, patch.portionGrams ?? null, patch.description ?? null, patch.isActive ?? null],
      client,
    );
    await recordAudit(client, { principal, action: "dish.updated", entityType: "dish", entityId: id, before, after: patch });
    return getDish(principal, id, client);
  });
}

/**
 * Replace a dish's recipe. Each line gives a quantity in any unit of the
 * ingredient's dimension; it is stored in the base unit. Cross-dimension
 * conversions (e.g. g → l) are rejected.
 */
export async function setDishIngredients(principal, dishId, lines) {
  assertManage(principal);
  return withTransaction(async (client) => {
    const dish = (await query(`SELECT id FROM dishes WHERE id = $1 AND institution_id = $2 FOR UPDATE`, [dishId, principal.institutionId], client)).rows[0];
    if (!dish) throw notFound("Dish");
    const ids = lines.map((l) => l.ingredientId);
    if (new Set(ids).size !== ids.length) throw badRequest("An ingredient appears more than once");
    const ingredients = new Map(
      (await query(`SELECT id, name, dimension FROM ingredients WHERE id = ANY($1::bigint[]) AND institution_id = $2`, [ids, principal.institutionId], client)).rows.map((i) => [
        Number(i.id),
        i,
      ]),
    );
    const problems = [];
    const rows = lines.map((l, idx) => {
      const ing = ingredients.get(Number(l.ingredientId));
      if (!ing) {
        problems.push({ field: `ingredients.${idx}.ingredientId`, message: "Unknown ingredient" });
        return null;
      }
      try {
        const qty = toBaseUnits(l.quantity, l.unit, ing.dimension);
        if (qty <= 0) throw new UnitError("Quantity must be greater than zero");
        return { ingredientId: l.ingredientId, quantity: qty, yieldFactor: l.yieldFactor ?? 1 };
      } catch (err) {
        if (!(err instanceof UnitError)) throw err;
        problems.push({ field: `ingredients.${idx}.unit`, message: `${ing.name}: ${err.message}` });
        return null;
      }
    });
    if (problems.length) throw badRequest("Some recipe lines are invalid", problems);
    const before = (await query(`SELECT ingredient_id, quantity_per_serving, yield_factor FROM dish_ingredients WHERE dish_id = $1`, [dishId], client)).rows;
    await query(`DELETE FROM dish_ingredients WHERE dish_id = $1`, [dishId], client);
    for (const r of rows) {
      await query(`INSERT INTO dish_ingredients (dish_id, ingredient_id, quantity_per_serving, yield_factor) VALUES ($1, $2, $3, $4)`, [dishId, r.ingredientId, r.quantity, r.yieldFactor], client);
    }
    await recordAudit(client, { principal, action: "dish.recipe_updated", entityType: "dish", entityId: dishId, before, after: rows });
    return getDish(principal, dishId, client);
  });
}
