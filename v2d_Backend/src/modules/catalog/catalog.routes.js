import { Router } from "express";
import { z } from "zod";
import { id, parse, send } from "../../lib/http.js";
import { requireAuth } from "../../middleware/guards.js";
import { UNIT_NAMES } from "../../lib/units.js";
import * as catalog from "./catalog.service.js";

const listQuery = z.object({ q: z.string().trim().max(80).optional(), includeInactive: z.enum(["true", "false"]).optional().transform((v) => v === "true") });
const ingredientName = z.string().trim().min(2).max(120);
const category = z.string().trim().max(60);

export const catalogRouter = Router();
catalogRouter.use(requireAuth);

catalogRouter.get("/ingredients", async (req, res) => send(res, await catalog.listIngredients(req.principal, parse(listQuery, req.query))));
catalogRouter.post("/ingredients", async (req, res) => {
  const body = parse(
    z.object({ name: ingredientName, dimension: z.enum(["MASS", "VOLUME", "COUNT"]), costPerBaseUnit: z.number().min(0).max(1_000_000).optional(), category: category.optional() }),
    req.body,
  );
  send(res, await catalog.createIngredient(req.principal, body), { status: 201 });
});
catalogRouter.patch("/ingredients/:id", async (req, res) => {
  const body = parse(
    z
      .object({ name: ingredientName.optional(), costPerBaseUnit: z.number().min(0).max(1_000_000).nullable().optional(), category: category.optional(), isActive: z.boolean().optional() })
      .strict(),
    req.body,
  );
  send(res, await catalog.updateIngredient(req.principal, parse(id, req.params.id), body));
});

const dishFields = {
  name: z.string().trim().min(2).max(120),
  category: category.optional(),
  isVegetarian: z.boolean().optional(),
  portionGrams: z.number().positive().max(5000).optional(),
  description: z.string().trim().max(500).optional(),
};
catalogRouter.get("/dishes", async (req, res) => send(res, await catalog.listDishes(req.principal, parse(listQuery, req.query))));
catalogRouter.get("/dishes/:id", async (req, res) => send(res, await catalog.getDish(req.principal, parse(id, req.params.id))));
catalogRouter.post("/dishes", async (req, res) => send(res, await catalog.createDish(req.principal, parse(z.object(dishFields), req.body)), { status: 201 }));
catalogRouter.patch("/dishes/:id", async (req, res) => {
  const body = parse(
    z.object({ ...dishFields, name: dishFields.name.optional(), portionGrams: dishFields.portionGrams.nullable(), isActive: z.boolean().optional() }).partial().strict(),
    req.body,
  );
  send(res, await catalog.updateDish(req.principal, parse(id, req.params.id), body));
});
catalogRouter.put("/dishes/:id/ingredients", async (req, res) => {
  const body = parse(
    z.object({
      ingredients: z
        .array(
          z.object({
            ingredientId: id,
            quantity: z.number().positive().max(100000),
            unit: z.enum(UNIT_NAMES),
            yieldFactor: z.number().gt(0).max(1).optional(),
          }),
        )
        .max(60),
    }),
    req.body,
  );
  send(res, await catalog.setDishIngredients(req.principal, parse(id, req.params.id), body.ingredients));
});
