import {
  auditLog,
  loadMenu,
  menuCategories,
  menuItemGroups,
  menuItems,
  menuModifierGroups,
  menuModifierOptions,
  tenants,
  withTenant,
  type Database,
  type MenuData,
  type Tx,
} from "@empleado/db";
import { hasModule, modulesFor } from "@empleado/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { markStarterReviewed } from "./starter";
import { parseCsv, parsePriceToCents, toCsv, unguard } from "./csv";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

/**
 * Menu del restaurante (modulo "restaurante"): categorias, platillos y grupos de modificadores reutilizables.
 * Ver todo lo puede cualquier rol; cambiarlo, el dueno y la recepcion. Solo funciona en negocios con el modulo encendido.
 * Los precios entran en pesos (numero o texto como "$85.50") y se guardan en centavos.
 */

export type MenuError = "forbidden" | "module_off" | "not_found" | "duplicate";
export type MenuInvalid = Failure<"invalid"> & { details: string[] };
export type MenuFail = Failure<MenuError> | MenuInvalid;

const invalid = (...details: string[]): MenuInvalid => ({ ok: false, error: "invalid", details });
const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

/** Postgres: 23505 = nombre repetido (indice unico). */
const pgCode = (e: unknown): string | undefined => (e as { code?: string; cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;

/** Permiso y modulo. Se consulta el negocio dentro de la misma transaccion. */
async function gate(tx: Tx, ctx: PanelContext, write: boolean): Promise<Failure<"forbidden" | "module_off"> | null> {
  if (write && !can(ctx.role, "manage_appointments")) return fail("forbidden");
  const [t] = await tx.select({ vertical: tenants.vertical, profile: tenants.profile }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  if (!t || !hasModule(modulesFor(t.vertical, t.profile?.modules), "restaurante")) return fail("module_off");
  return null;
}

async function audit(tx: Tx, ctx: PanelContext, action: string, entityId: string | null, diff: Record<string, unknown>) {
  await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: `menu.${action}`, entity: "menu", entityId, diff });
  await markStarterReviewed(tx, ctx.tenantId); // el menu de ejemplo cuenta como revisado en cuanto el dueno cambia algo
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** Pesos (numero o texto) a centavos; null si no es un precio valido. */
function toCents(price: unknown): number | null {
  if (typeof price === "number") {
    if (!Number.isFinite(price) || price < 0 || price > 100_000) return null;
    return Math.round(price * 100);
  }
  return typeof price === "string" ? parsePriceToCents(price) : null;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// --------------------------------------------------------------------------------------------- leer

export async function getMenu(db: Database, ctx: PanelContext): Promise<Success<{ menu: MenuData }> | Failure<"module_off">> {
  return withTenant(db, scope(ctx), async (tx) => {
    const g = await gate(tx, ctx, false);
    if (g) return fail("module_off" as const);
    return { ok: true as const, menu: await loadMenu(tx) };
  });
}

// ----------------------------------------------------------------------------------- categorias

export async function saveCategory(db: Database, ctx: PanelContext, input: { id?: string; name?: unknown }): Promise<Success<{ id: string }> | MenuFail> {
  const name = text(input.name);
  if (!name || name.length > 60) return invalid("El nombre de la categoría es obligatorio (máximo 60 caracteres).");
  try {
    return await withTenant(db, scope(ctx), async (tx) => {
      const denied = await gate(tx, ctx, true);
      if (denied) return denied;
      if (input.id) {
        const rows = await tx.update(menuCategories).set({ name, updatedAt: new Date() }).where(eq(menuCategories.id, input.id)).returning({ id: menuCategories.id });
        if (rows.length === 0) return fail("not_found" as const);
        await audit(tx, ctx, "category_saved", input.id, { name });
        return { ok: true as const, id: input.id };
      }
      const [last] = await tx.select({ next: sql<number>`coalesce(max(${menuCategories.sortOrder}), 0) + 1` }).from(menuCategories);
      const [row] = await tx.insert(menuCategories).values({ tenantId: ctx.tenantId, name, sortOrder: Number(last?.next ?? 1) }).returning({ id: menuCategories.id });
      await audit(tx, ctx, "category_saved", row!.id, { name });
      return { ok: true as const, id: row!.id };
    });
  } catch (e) {
    if (pgCode(e) === "23505") return fail("duplicate");
    throw e;
  }
}

/** Borra la categoria Y sus platillos. */
export async function deleteCategory(db: Database, ctx: PanelContext, id: string): Promise<Success | MenuFail> {
  return withTenant(db, scope(ctx), async (tx) => {
    const denied = await gate(tx, ctx, true);
    if (denied) return denied;
    const rows = await tx.delete(menuCategories).where(eq(menuCategories.id, id)).returning({ id: menuCategories.id });
    if (rows.length === 0) return fail("not_found" as const);
    await audit(tx, ctx, "category_deleted", id, {});
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------------------------ platillos

export interface ItemInput {
  id?: string;
  categoryId?: unknown;
  name?: unknown;
  description?: unknown;
  /** En pesos: 85, "85.50" o "$85". */
  price?: unknown;
  available?: unknown;
  groupIds?: unknown;
}

export async function saveItem(db: Database, ctx: PanelContext, input: ItemInput): Promise<Success<{ id: string }> | MenuFail> {
  const problems: string[] = [];
  const name = text(input.name);
  const description = text(input.description);
  const cents = toCents(input.price);
  if (!name || name.length > 120) problems.push("El nombre del platillo es obligatorio (máximo 120 caracteres).");
  if (description.length > 500) problems.push("La descripción es demasiado larga (máximo 500 caracteres).");
  if (cents === null) problems.push("El precio no es válido: escríbelo en pesos, por ejemplo 85 o 85.50.");
  if (typeof input.categoryId !== "string" || !input.categoryId) problems.push("Elige una categoría.");
  const groupIds = Array.isArray(input.groupIds) ? [...new Set(input.groupIds.filter((g): g is string => typeof g === "string"))] : [];
  if (groupIds.length > 10) problems.push("Máximo 10 grupos de modificadores por platillo.");
  if (problems.length > 0) return invalid(...problems);

  try {
    return await withTenant(db, scope(ctx), async (tx) => {
      const denied = await gate(tx, ctx, true);
      if (denied) return denied;
      const categoryId = input.categoryId as string;
      const [cat] = await tx.select({ id: menuCategories.id }).from(menuCategories).where(eq(menuCategories.id, categoryId));
      if (!cat) return invalid("Esa categoría ya no existe.");
      if (groupIds.length > 0) {
        const found = await tx.select({ id: menuModifierGroups.id }).from(menuModifierGroups).where(inArray(menuModifierGroups.id, groupIds));
        if (found.length !== groupIds.length) return invalid("Alguno de los modificadores elegidos ya no existe.");
      }

      const values = { categoryId, name, description: description || null, priceCents: cents!, available: input.available !== false, updatedAt: new Date() };
      let id = input.id;
      if (id) {
        const rows = await tx.update(menuItems).set(values).where(eq(menuItems.id, id)).returning({ id: menuItems.id });
        if (rows.length === 0) return fail("not_found" as const);
      } else {
        const [last] = await tx.select({ next: sql<number>`coalesce(max(${menuItems.sortOrder}), 0) + 1` }).from(menuItems).where(eq(menuItems.categoryId, categoryId));
        const [row] = await tx.insert(menuItems).values({ tenantId: ctx.tenantId, ...values, sortOrder: Number(last?.next ?? 1) }).returning({ id: menuItems.id });
        id = row!.id;
      }
      await tx.delete(menuItemGroups).where(eq(menuItemGroups.itemId, id));
      if (groupIds.length > 0) await tx.insert(menuItemGroups).values(groupIds.map((groupId, i) => ({ tenantId: ctx.tenantId, itemId: id!, groupId, sortOrder: i })));
      await audit(tx, ctx, "item_saved", id, { name, priceCents: cents, available: values.available });
      return { ok: true as const, id };
    });
  } catch (e) {
    if (pgCode(e) === "23505") return fail("duplicate");
    throw e;
  }
}

/** «Agotado» / «ya hay»: el cambio rapido del dia a dia. */
export async function setItemAvailable(db: Database, ctx: PanelContext, id: string, available: boolean): Promise<Success | MenuFail> {
  return withTenant(db, scope(ctx), async (tx) => {
    const denied = await gate(tx, ctx, true);
    if (denied) return denied;
    const rows = await tx.update(menuItems).set({ available, updatedAt: new Date() }).where(eq(menuItems.id, id)).returning({ id: menuItems.id });
    if (rows.length === 0) return fail("not_found" as const);
    await audit(tx, ctx, "item_availability", id, { available });
    return { ok: true as const };
  });
}

export async function deleteItem(db: Database, ctx: PanelContext, id: string): Promise<Success | MenuFail> {
  return withTenant(db, scope(ctx), async (tx) => {
    const denied = await gate(tx, ctx, true);
    if (denied) return denied;
    const rows = await tx.delete(menuItems).where(eq(menuItems.id, id)).returning({ id: menuItems.id });
    if (rows.length === 0) return fail("not_found" as const);
    await audit(tx, ctx, "item_deleted", id, {});
    return { ok: true as const };
  });
}

// ------------------------------------------------------------------------------- modificadores

export interface GroupInput {
  id?: string;
  name?: unknown;
  required?: unknown;
  multiple?: unknown;
  maxChoices?: unknown;
  /** Las opciones que debe quedar: las que traen `id` se actualizan, las nuevas se crean y las que falten se borran. */
  options?: unknown;
}

interface OptionInput {
  id?: string;
  name: string;
  priceDeltaCents: number;
  available: boolean;
}

function cleanOptions(raw: unknown, problems: string[]): OptionInput[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push("Agrega al menos una opción.");
    return [];
  }
  if (raw.length > 40) problems.push("Máximo 40 opciones por grupo.");
  const out: OptionInput[] = [];
  const seen = new Set<string>();
  raw.slice(0, 40).forEach((o, i) => {
    const r = (o ?? {}) as Record<string, unknown>;
    const name = text(r.name);
    const cents = r.price === undefined || r.price === "" || r.price === null ? 0 : toCents(r.price);
    if (!name || name.length > 80) problems.push(`Opción ${i + 1}: el nombre es obligatorio (máximo 80 caracteres).`);
    else if (seen.has(name.toLowerCase())) problems.push(`La opción «${name}» está repetida.`);
    if (cents === null) problems.push(`Opción ${i + 1}: el precio extra no es válido.`);
    seen.add(name.toLowerCase());
    out.push({ ...(typeof r.id === "string" && r.id ? { id: r.id } : {}), name, priceDeltaCents: cents ?? 0, available: r.available !== false });
  });
  return out;
}

export async function saveGroup(db: Database, ctx: PanelContext, input: GroupInput): Promise<Success<{ id: string }> | MenuFail> {
  const problems: string[] = [];
  const name = text(input.name);
  if (!name || name.length > 80) problems.push("El nombre del grupo es obligatorio (máximo 80 caracteres).");
  const multiple = input.multiple === true;
  const required = input.required === true;
  let maxChoices: number | null = null;
  if (multiple && input.maxChoices !== undefined && input.maxChoices !== null && input.maxChoices !== "") {
    const n = Number(input.maxChoices);
    if (!Number.isInteger(n) || n < 1 || n > 20) problems.push("El máximo de opciones va de 1 a 20 (o déjalo vacío).");
    else maxChoices = n;
  }
  const options = cleanOptions(input.options, problems);
  if (problems.length > 0) return invalid(...problems);

  try {
    return await withTenant(db, scope(ctx), async (tx) => {
      const denied = await gate(tx, ctx, true);
      if (denied) return denied;
      const values = { name, required, multiple, maxChoices, updatedAt: new Date() };
      let id = input.id;
      if (id) {
        const rows = await tx.update(menuModifierGroups).set(values).where(eq(menuModifierGroups.id, id)).returning({ id: menuModifierGroups.id });
        if (rows.length === 0) return fail("not_found" as const);
      } else {
        const [row] = await tx.insert(menuModifierGroups).values({ tenantId: ctx.tenantId, ...values }).returning({ id: menuModifierGroups.id });
        id = row!.id;
      }

      // Opciones: se borran las que ya no vienen, se actualizan las que traen id y se crean las nuevas.
      const existing = await tx.select({ id: menuModifierOptions.id }).from(menuModifierOptions).where(eq(menuModifierOptions.groupId, id));
      const existingIds = new Set(existing.map((o) => o.id));
      if (options.some((o) => o.id && !existingIds.has(o.id))) return invalid("Alguna de las opciones ya no existe: recarga la pantalla.");
      const keep = new Set(options.flatMap((o) => (o.id ? [o.id] : [])));
      const drop = existing.filter((o) => !keep.has(o.id)).map((o) => o.id);
      if (drop.length > 0) await tx.delete(menuModifierOptions).where(inArray(menuModifierOptions.id, drop));
      // Dos pasadas para que cambiar nombres entre opciones no choque con el indice unico a medio camino.
      for (const o of options) {
        if (o.id) await tx.update(menuModifierOptions).set({ name: `~${o.id}`, updatedAt: new Date() }).where(eq(menuModifierOptions.id, o.id));
      }
      for (const [i, o] of options.entries()) {
        if (o.id) await tx.update(menuModifierOptions).set({ name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available, sortOrder: i, updatedAt: new Date() }).where(eq(menuModifierOptions.id, o.id));
        else await tx.insert(menuModifierOptions).values({ tenantId: ctx.tenantId, groupId: id, name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available, sortOrder: i });
      }
      await audit(tx, ctx, "group_saved", id, { name, options: options.length });
      return { ok: true as const, id };
    });
  } catch (e) {
    if (pgCode(e) === "23505") return fail("duplicate");
    throw e;
  }
}

export async function deleteGroup(db: Database, ctx: PanelContext, id: string): Promise<Success | MenuFail> {
  return withTenant(db, scope(ctx), async (tx) => {
    const denied = await gate(tx, ctx, true);
    if (denied) return denied;
    const rows = await tx.delete(menuModifierGroups).where(eq(menuModifierGroups.id, id)).returning({ id: menuModifierGroups.id });
    if (rows.length === 0) return fail("not_found" as const);
    await audit(tx, ctx, "group_deleted", id, {});
    return { ok: true as const };
  });
}

/** «Hoy no hay masa gruesa»: apaga una opcion sin tocar el grupo. */
export async function setOptionAvailable(db: Database, ctx: PanelContext, id: string, available: boolean): Promise<Success | MenuFail> {
  return withTenant(db, scope(ctx), async (tx) => {
    const denied = await gate(tx, ctx, true);
    if (denied) return denied;
    const rows = await tx.update(menuModifierOptions).set({ available, updatedAt: new Date() }).where(eq(menuModifierOptions.id, id)).returning({ id: menuModifierOptions.id });
    if (rows.length === 0) return fail("not_found" as const);
    await audit(tx, ctx, "option_availability", id, { available });
    return { ok: true as const };
  });
}

// --------------------------------------------------------------------------- importar y exportar

export interface ImportSummary {
  categoriesCreated: number;
  itemsCreated: number;
  itemsUpdated: number;
  /** Renglones que no se importaron, con el motivo. */
  skipped: string[];
  /** Cosas que se importaron pero conviene revisar (por ejemplo un modificador que no existe). */
  warnings: string[];
  dryRun: boolean;
}

const COLUMNS: Record<"category" | "name" | "description" | "price" | "available" | "groups", string[]> = {
  category: ["categoria", "category", "seccion"],
  name: ["nombre", "platillo", "producto", "name", "articulo"],
  description: ["descripcion", "description", "ingredientes"],
  price: ["precio", "price", "costo"],
  available: ["disponible", "disponibilidad", "available", "agotado"],
  groups: ["modificadores", "grupos", "extras"],
};
const NO_WORDS = new Set(["no", "0", "false", "falso", "agotado", "n"]);
const MAX_ROWS = 500;

/** Marca interna para deshacer una prueba (dryRun) sin escribir nada. */
class Rollback extends Error {
  constructor(readonly summary: ImportSummary) {
    super("rollback");
  }
}

/**
 * Importa un menu desde CSV (el que se descarga de Excel o de Google Sheets). Columnas: categoria, nombre y precio son
 * obligatorias; descripcion, disponible y modificadores son opcionales. Es idempotente: volver a importar el mismo archivo
 * actualiza los platillos que ya existen (por categoria y nombre) en vez de duplicarlos. `modificadores` enlaza grupos que
 * YA existen, por nombre y separados con «|». Con dryRun solo cuenta lo que haria.
 */
export async function importMenuCsv(db: Database, ctx: PanelContext, csv: string, options: { dryRun?: boolean } = {}): Promise<Success<{ summary: ImportSummary }> | MenuFail> {
  if (typeof csv !== "string" || csv.trim() === "") return invalid("El archivo está vacío.");
  if (csv.length > 300_000) return invalid("El archivo es demasiado grande (máximo 300 KB).");
  const { rows } = parseCsv(csv);
  const header = (rows[0] ?? []).map((h) => norm(h));
  const col = (key: keyof typeof COLUMNS) => header.findIndex((h) => COLUMNS[key].includes(h));
  const idx = { category: col("category"), name: col("name"), description: col("description"), price: col("price"), available: col("available"), groups: col("groups") };
  const missing = (["category", "name", "price"] as const).filter((k) => idx[k] < 0).map((k) => COLUMNS[k][0]);
  if (missing.length > 0) return invalid(`Faltan columnas en el encabezado: ${missing.join(", ")}. El archivo debe empezar con: categoria, nombre, descripcion, precio, disponible, modificadores.`);
  const body = rows.slice(1);
  if (body.length === 0) return invalid("El archivo no tiene platillos.");
  if (body.length > MAX_ROWS) return invalid(`Máximo ${MAX_ROWS} platillos por archivo (trae ${body.length}).`);
  const dryRun = options.dryRun === true;

  const summary: ImportSummary = { categoriesCreated: 0, itemsCreated: 0, itemsUpdated: 0, skipped: [], warnings: [], dryRun };
  try {
    return await withTenant(db, scope(ctx), async (tx) => {
      const denied = await gate(tx, ctx, true);
      if (denied) return denied;

      const cats = new Map((await tx.select().from(menuCategories)).map((c) => [c.name.toLowerCase(), c.id] as const));
      let nextCat = (await tx.select({ n: sql<number>`coalesce(max(${menuCategories.sortOrder}), 0)` }).from(menuCategories))[0]!.n as number;
      const groups = new Map((await tx.select({ id: menuModifierGroups.id, name: menuModifierGroups.name }).from(menuModifierGroups)).map((g) => [g.name.toLowerCase(), g.id] as const));
      const existing = new Map((await tx.select().from(menuItems)).map((i) => [`${i.categoryId}|${i.name.toLowerCase()}`, i.id] as const));
      const nextItem = new Map<string, number>();
      const seenInFile = new Set<string>();

      for (const [n, r] of body.entries()) {
        const line = n + 2; // 1 = encabezado
        const cell = (i: number) => (i >= 0 ? unguard((r[i] ?? "").trim()) : "");
        const category = cell(idx.category);
        const name = cell(idx.name);
        const cents = parsePriceToCents(cell(idx.price));
        if (!category || !name) {
          summary.skipped.push(`Renglón ${line}: falta la categoría o el nombre.`);
          continue;
        }
        if (category.length > 60 || name.length > 120) {
          summary.skipped.push(`Renglón ${line}: «${name.slice(0, 30)}» tiene un nombre demasiado largo.`);
          continue;
        }
        if (cents === null) {
          summary.skipped.push(`Renglón ${line}: «${name}» tiene un precio no válido («${cell(idx.price)}»).`);
          continue;
        }
        const key = `${category.toLowerCase()}|${name.toLowerCase()}`;
        if (seenInFile.has(key)) {
          summary.skipped.push(`Renglón ${line}: «${name}» está repetido en ${category}; se usa el primero.`);
          continue;
        }
        seenInFile.add(key);

        let categoryId = cats.get(category.toLowerCase());
        if (!categoryId) {
          const [row] = await tx.insert(menuCategories).values({ tenantId: ctx.tenantId, name: category, sortOrder: ++nextCat }).returning({ id: menuCategories.id });
          categoryId = row!.id;
          cats.set(category.toLowerCase(), categoryId);
          summary.categoriesCreated++;
        }

        const set: Partial<typeof menuItems.$inferInsert> = { priceCents: cents, updatedAt: new Date() };
        if (idx.description >= 0) set.description = cell(idx.description).slice(0, 500) || null;
        if (idx.available >= 0 && cell(idx.available) !== "") set.available = !NO_WORDS.has(norm(cell(idx.available)));

        let itemId = existing.get(`${categoryId}|${name.toLowerCase()}`);
        if (itemId) {
          await tx.update(menuItems).set(set).where(eq(menuItems.id, itemId));
          summary.itemsUpdated++;
        } else {
          if (!nextItem.has(categoryId)) nextItem.set(categoryId, Number((await tx.select({ n: sql<number>`coalesce(max(${menuItems.sortOrder}), 0)` }).from(menuItems).where(eq(menuItems.categoryId, categoryId)))[0]!.n));
          const order = nextItem.get(categoryId)! + 1;
          nextItem.set(categoryId, order);
          const [row] = await tx.insert(menuItems).values({ tenantId: ctx.tenantId, categoryId, name, description: set.description ?? null, priceCents: cents, available: set.available ?? true, sortOrder: order }).returning({ id: menuItems.id });
          itemId = row!.id;
          existing.set(`${categoryId}|${name.toLowerCase()}`, itemId);
          summary.itemsCreated++;
        }

        const wanted = cell(idx.groups);
        if (wanted !== "") {
          const ids: string[] = [];
          for (const g of wanted.split("|").map((s) => s.trim()).filter(Boolean)) {
            const id = groups.get(g.toLowerCase());
            if (id) ids.push(id);
            else summary.warnings.push(`Renglón ${line}: el modificador «${g}» no existe. Créalo en la pestaña Modificadores y vuelve a importar.`);
          }
          const unique = [...new Set(ids)];
          await tx.delete(menuItemGroups).where(eq(menuItemGroups.itemId, itemId));
          if (unique.length > 0) await tx.insert(menuItemGroups).values(unique.map((groupId, i) => ({ tenantId: ctx.tenantId, itemId: itemId!, groupId, sortOrder: i })));
        }
      }

      if (dryRun) throw new Rollback(summary);
      await audit(tx, ctx, "imported", null, { categoriesCreated: summary.categoriesCreated, itemsCreated: summary.itemsCreated, itemsUpdated: summary.itemsUpdated, skipped: summary.skipped.length });
      return { ok: true as const, summary };
    });
  } catch (e) {
    if (e instanceof Rollback) return { ok: true, summary: e.summary };
    if (pgCode(e) === "23505") return fail("duplicate");
    throw e;
  }
}

/** El menu como CSV (se puede volver a importar). Los modificadores van por nombre, separados con «|». */
export async function exportMenuCsv(db: Database, ctx: PanelContext): Promise<Success<{ csv: string }> | Failure<"module_off">> {
  return withTenant(db, scope(ctx), async (tx) => {
    if (await gate(tx, ctx, false)) return fail("module_off" as const);
    const menu = await loadMenu(tx);
    const groupName = new Map(menu.groups.map((g) => [g.id, g.name]));
    const rows: string[][] = [["categoria", "nombre", "descripcion", "precio", "disponible", "modificadores"]];
    for (const c of menu.categories)
      for (const i of c.items) rows.push([c.name, i.name, i.description ?? "", (i.priceCents / 100).toFixed(2), i.available ? "si" : "no", i.groupIds.map((g) => groupName.get(g) ?? "").filter(Boolean).join(" | ")]);
    return { ok: true as const, csv: toCsv(rows) };
  });
}
