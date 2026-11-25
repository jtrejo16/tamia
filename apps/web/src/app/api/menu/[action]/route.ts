import {
  deleteCategory,
  deleteGroup,
  deleteItem,
  importMenuCsv,
  saveCategory,
  saveGroup,
  saveItem,
  setItemAvailable,
  setOptionAvailable,
} from "@empleado/inbox";
import { authed, failure, readJson, respond, str } from "@/lib/api";
import { getDb } from "@/lib/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 *  POST /api/menu/category          { id?, name }
 *  POST /api/menu/category-delete   { id }
 *  POST /api/menu/item              { id?, categoryId, name, description?, price, available?, groupIds? }
 *  POST /api/menu/item-available    { id, available }
 *  POST /api/menu/item-delete       { id }
 *  POST /api/menu/group             { id?, name, required?, multiple?, maxChoices?, options: [{ id?, name, price?, available? }] }
 *  POST /api/menu/option-available  { id, available }
 *  POST /api/menu/group-delete      { id }
 *  POST /api/menu/import            { csv, dryRun? }
 * Ver el menu lo puede cualquier rol; cambiarlo, el dueño y la recepcion (lo valida la logica del dominio).
 */
export const POST = authed<{ action: string }>(async (req, ctx, { action }) => {
  const b = await readJson(req);
  const db = getDb();
  const id = str(b.id);
  if (id && !UUID.test(id)) return failure("bad_request");
  const withId = id ? { id } : {};

  switch (action) {
    case "category":
      return respond(await saveCategory(db, ctx, { ...withId, name: b.name }));
    case "category-delete":
      return id ? respond(await deleteCategory(db, ctx, id)) : failure("bad_request");
    case "item":
      return respond(await saveItem(db, ctx, { ...withId, categoryId: b.categoryId, name: b.name, description: b.description, price: b.price, available: b.available, groupIds: b.groupIds }));
    case "item-available":
      return id ? respond(await setItemAvailable(db, ctx, id, b.available === true)) : failure("bad_request");
    case "item-delete":
      return id ? respond(await deleteItem(db, ctx, id)) : failure("bad_request");
    case "group":
      return respond(await saveGroup(db, ctx, { ...withId, name: b.name, required: b.required, multiple: b.multiple, maxChoices: b.maxChoices, options: b.options }));
    case "option-available":
      return id ? respond(await setOptionAvailable(db, ctx, id, b.available === true)) : failure("bad_request");
    case "group-delete":
      return id ? respond(await deleteGroup(db, ctx, id)) : failure("bad_request");
    case "import":
      return respond(await importMenuCsv(db, ctx, typeof b.csv === "string" ? b.csv : "", { dryRun: b.dryRun === true }));
    default:
      return failure("not_found");
  }
});
