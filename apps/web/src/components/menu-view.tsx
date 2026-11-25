"use client";

import type { MenuData } from "@empleado/db";
import { useMemo, useState, type ReactNode } from "react";
import { api, usePolling, type ApiError } from "@/lib/client";
import { canAct, usePanel } from "./panel-context";
import { Alert, Badge, Button, EmptyState, Spinner, cx } from "./ui";

type Item = MenuData["categories"][number]["items"][number];
type Group = MenuData["groups"][number];

const field = "w-full rounded-lg bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600";
const pesos = (cents: number) => (cents / 100).toLocaleString("es-MX", { style: "currency", currency: "MXN", minimumFractionDigits: cents % 100 === 0 ? 0 : 2 });
const toPesos = (cents: number) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

type Dialog =
  | { kind: "category"; id?: string; name: string }
  | { kind: "item"; item?: Item; categoryId?: string }
  | { kind: "group"; group?: Group }
  | { kind: "import" };

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 p-3 sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[92vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100" aria-label="Cerrar">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

const Problem = ({ error }: { error: ApiError | null }) =>
  error ? (
    <Alert>
      <p>{error.message}</p>
      {error.details?.map((d) => <p key={d}>{d}</p>)}
    </Alert>
  ) : null;

/** Interruptor de «disponible» / «agotado». */
function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50", on ? "bg-teal-600" : "bg-slate-300")}
    >
      <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}

export function MenuView() {
  const panel = usePanel();
  const res = usePolling<{ ok: true; menu: MenuData }>("/api/menu", 15000);
  const [tab, setTab] = useState<"platillos" | "modificadores">("platillos");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const allowed = canAct(panel.role);
  const menu = res.data?.menu;

  /** Llama a la API y recarga. Devuelve el error, o null si salio bien. */
  async function call(action: string, body: Record<string, unknown>): Promise<ApiError | null> {
    const r = await api<{ ok: true }>(`/api/menu/${action}`, { method: "POST", body });
    if (!r.ok) return r;
    await res.reload();
    return null;
  }
  async function quick(action: string, body: Record<string, unknown>) {
    setNotice(null);
    const e = await call(action, body);
    if (e) setNotice(e.message);
  }

  const groupsById = useMemo(() => new Map((menu?.groups ?? []).map((g) => [g.id, g])), [menu]);
  const usage = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of menu?.categories ?? []) for (const i of c.items) for (const g of i.groupIds) n.set(g, (n.get(g) ?? 0) + 1);
    return n;
  }, [menu]);

  if (!panel.modules.includes("restaurante")) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <Alert tone="amber">El menú es de los restaurantes: no está activado para tu negocio.</Alert>
      </div>
    );
  }

  const total = menu?.categories.reduce((n, c) => n + c.items.length, 0) ?? 0;

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4 lg:p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Menú</h1>
            <p className="text-sm text-slate-500">{menu ? `${total} ${total === 1 ? "platillo" : "platillos"} en ${menu.categories.length} ${menu.categories.length === 1 ? "categoría" : "categorías"}. ` : ""}El asistente contesta con esto: precios, ingredientes y modificadores.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href="/api/menu/export" className="inline-flex items-center rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50">Exportar CSV</a>
            {allowed && <Button variant="secondary" className="py-1.5" onClick={() => setDialog({ kind: "import" })}>Importar CSV</Button>}
            {allowed && tab === "platillos" && <Button variant="secondary" className="py-1.5" onClick={() => setDialog({ kind: "category", name: "" })}>+ Categoría</Button>}
            {allowed && tab === "platillos" && <Button className="py-1.5" onClick={() => setDialog({ kind: "item" })} disabled={!menu || menu.categories.length === 0} title={menu && menu.categories.length === 0 ? "Primero crea una categoría" : undefined}>+ Platillo</Button>}
            {allowed && tab === "modificadores" && <Button className="py-1.5" onClick={() => setDialog({ kind: "group" })}>+ Grupo</Button>}
          </div>
        </div>

        <div className="flex gap-2">
          {(["platillos", "modificadores"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cx("rounded-full px-3 py-1 text-sm font-medium ring-1", tab === t ? "bg-teal-700 text-white ring-teal-700" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")}>
              {t === "platillos" ? "Platillos" : `Modificadores${menu ? ` (${menu.groups.length})` : ""}`}
            </button>
          ))}
        </div>

        {notice && <Alert>{notice}</Alert>}
        {res.loading && !menu ? (
          <div className="flex justify-center p-10 text-slate-400"><Spinner /></div>
        ) : res.error && !menu ? (
          <Alert>{res.error.message}</Alert>
        ) : !menu ? null : tab === "platillos" ? (
          menu.categories.length === 0 ? (
            <div className="rounded-2xl bg-white py-14 ring-1 ring-slate-200">
              <EmptyState title="Todavía no hay menú" hint="Crea una categoría y agrega tus platillos, o importa todo de una vez desde un archivo CSV (Excel o Google Sheets)." />
            </div>
          ) : (
            menu.categories.map((c) => (
              <section key={c.id} className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5">
                  <h2 className="text-sm font-semibold text-slate-800">{c.name} <span className="font-normal text-slate-400">· {c.items.length}</span></h2>
                  {allowed && (
                    <div className="flex gap-1.5">
                      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setDialog({ kind: "item", categoryId: c.id })}>+ Platillo</Button>
                      <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setDialog({ kind: "category", id: c.id, name: c.name })}>Renombrar</Button>
                      <Button
                        variant="ghost"
                        className="px-2 py-1 text-xs text-rose-700"
                        onClick={() => window.confirm(`¿Borrar la categoría «${c.name}» y sus ${c.items.length} platillos? No se puede deshacer.`) && void quick("category-delete", { id: c.id })}
                      >
                        Borrar
                      </Button>
                    </div>
                  )}
                </div>
                {c.items.length === 0 ? (
                  <p className="px-4 py-4 text-sm text-slate-400">Sin platillos todavía.</p>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {c.items.map((i) => (
                      <li key={i.id} className={cx("flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3", !i.available && "bg-slate-50/60")}>
                        <div className="min-w-0 flex-1 basis-48">
                          <p className={cx("font-medium", i.available ? "text-slate-900" : "text-slate-400 line-through")}>{i.name}</p>
                          {i.description && <p className="truncate text-sm text-slate-500">{i.description}</p>}
                          {i.groupIds.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {i.groupIds.map((g) => (groupsById.has(g) ? <Badge key={g} tone="teal">{groupsById.get(g)!.name}</Badge> : null))}
                            </div>
                          )}
                        </div>
                        <p className="w-24 shrink-0 text-right font-semibold tabular-nums text-slate-900">{pesos(i.priceCents)}</p>
                        <label className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                          <Switch on={i.available} label={`${i.name}: ${i.available ? "disponible" : "agotado"}`} disabled={!allowed} onChange={() => void quick("item-available", { id: i.id, available: !i.available })} />
                          <span className="w-14">{i.available ? "Disponible" : "Agotado"}</span>
                        </label>
                        {allowed && <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setDialog({ kind: "item", item: i })}>Editar</Button>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))
          )
        ) : menu.groups.length === 0 ? (
          <div className="rounded-2xl bg-white py-14 ring-1 ring-slate-200">
            <EmptyState title="Todavía no hay modificadores" hint="Son las opciones que se eligen en un platillo: tamaño, masa, tortilla, extras, «sin cebolla»… Se crean una vez y se pegan a varios platillos." />
          </div>
        ) : (
          menu.groups.map((g) => (
            <section key={g.id} className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold text-slate-900">{g.name}</h2>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Badge tone={g.required ? "amber" : "slate"}>{g.required ? "Obligatorio" : "Opcional"}</Badge>
                    <Badge tone="slate">{g.multiple ? `Varias opciones${g.maxChoices ? ` (hasta ${g.maxChoices})` : ""}` : "Una sola opción"}</Badge>
                    <Badge tone="teal">{usage.get(g.id) ?? 0} {(usage.get(g.id) ?? 0) === 1 ? "platillo" : "platillos"}</Badge>
                  </div>
                </div>
                {allowed && (
                  <div className="flex gap-1.5">
                    <Button variant="secondary" className="px-2.5 py-1 text-xs" onClick={() => setDialog({ kind: "group", group: g })}>Editar</Button>
                    <Button
                      variant="danger"
                      className="px-2.5 py-1 text-xs"
                      onClick={() => window.confirm(`¿Borrar el grupo «${g.name}»? Se quita de ${usage.get(g.id) ?? 0} platillos.`) && void quick("group-delete", { id: g.id })}
                    >
                      Borrar
                    </Button>
                  </div>
                )}
              </div>
              <ul className="mt-3 divide-y divide-slate-100">
                {g.options.map((o) => (
                  <li key={o.id} className="flex items-center gap-3 py-2">
                    <span className={cx("flex-1 text-sm", o.available ? "text-slate-800" : "text-slate-400 line-through")}>{o.name}</span>
                    <span className="w-20 text-right text-sm tabular-nums text-slate-500">{o.priceDeltaCents > 0 ? `+${pesos(o.priceDeltaCents)}` : "sin costo"}</span>
                    <Switch on={o.available} label={`${o.name}: ${o.available ? "disponible" : "agotada"}`} disabled={!allowed} onChange={() => void quick("option-available", { id: o.id, available: !o.available })} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {dialog?.kind === "category" && <CategoryDialog dialog={dialog} call={call} onClose={() => setDialog(null)} />}
      {dialog?.kind === "item" && menu && <ItemDialog menu={menu} dialog={dialog} call={call} onClose={() => setDialog(null)} />}
      {dialog?.kind === "group" && <GroupDialog dialog={dialog} call={call} onClose={() => setDialog(null)} />}
      {dialog?.kind === "import" && <ImportDialog reload={async () => void (await res.reload())} onClose={() => setDialog(null)} />}
    </div>
  );
}

type Call = (action: string, body: Record<string, unknown>) => Promise<ApiError | null>;

// ---------------------------------------------------------------------------------------- diálogos

function CategoryDialog({ dialog, call, onClose }: { dialog: Extract<Dialog, { kind: "category" }>; call: Call; onClose: () => void }) {
  const [name, setName] = useState(dialog.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function save() {
    setBusy(true);
    const e = await call("category", { ...(dialog.id ? { id: dialog.id } : {}), name });
    setBusy(false);
    if (e) setError(e);
    else onClose();
  }
  return (
    <Modal title={dialog.id ? "Renombrar categoría" : "Nueva categoría"} onClose={onClose}>
      <label className="block space-y-1 text-sm font-medium text-slate-700">
        Nombre
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} placeholder="Tacos, Pizzas, Bebidas…" onKeyDown={(e) => e.key === "Enter" && void save()} />
      </label>
      <Problem error={error} />
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button onClick={save} loading={busy}>Guardar</Button></div>
    </Modal>
  );
}

function ItemDialog({ menu, dialog, call, onClose }: { menu: MenuData; dialog: Extract<Dialog, { kind: "item" }>; call: Call; onClose: () => void }) {
  const it = dialog.item;
  const [f, setF] = useState({
    categoryId: it?.categoryId ?? dialog.categoryId ?? menu.categories[0]?.id ?? "",
    name: it?.name ?? "",
    description: it?.description ?? "",
    price: it ? toPesos(it.priceCents) : "",
    available: it?.available ?? true,
    groupIds: it?.groupIds ?? ([] as string[]),
  });
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setBusy("save");
    const e = await call("item", { ...(it ? { id: it.id } : {}), ...f });
    setBusy(null);
    if (e) setError(e);
    else onClose();
  }
  async function remove() {
    if (!it || !window.confirm(`¿Borrar «${it.name}»? No se puede deshacer.`)) return;
    setBusy("delete");
    const e = await call("item-delete", { id: it.id });
    setBusy(null);
    if (e) setError(e);
    else onClose();
  }
  const toggleGroup = (id: string) => set("groupIds", f.groupIds.includes(id) ? f.groupIds.filter((g) => g !== id) : [...f.groupIds, id]);

  return (
    <Modal title={it ? "Editar platillo" : "Nuevo platillo"} onClose={onClose}>
      <label className="block space-y-1 text-sm font-medium text-slate-700">
        Categoría
        <select className={field} value={f.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
          {menu.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block space-y-1 text-sm font-medium text-slate-700 sm:col-span-2">
          Nombre
          <input className={field} value={f.name} onChange={(e) => set("name", e.target.value)} autoFocus maxLength={120} placeholder="Taco al pastor" />
        </label>
        <label className="block space-y-1 text-sm font-medium text-slate-700">
          Precio (pesos)
          <input className={field} value={f.price} onChange={(e) => set("price", e.target.value)} inputMode="decimal" placeholder="18" />
        </label>
      </div>
      <label className="block space-y-1 text-sm font-medium text-slate-700">
        Descripción <span className="font-normal text-slate-400">(ingredientes; el asistente la usa)</span>
        <textarea className={field} rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} maxLength={500} />
      </label>
      {menu.groups.length > 0 && (
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium text-slate-700">Modificadores que se pueden elegir</legend>
          <div className="flex flex-wrap gap-2">
            {menu.groups.map((g) => (
              <label key={g.id} className={cx("flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm ring-1", f.groupIds.includes(g.id) ? "bg-teal-50 text-teal-900 ring-teal-300" : "bg-white text-slate-700 ring-slate-300")}>
                <input type="checkbox" className="h-4 w-4 accent-teal-700" checked={f.groupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} />
                {g.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" className="h-4 w-4 accent-teal-700" checked={f.available} onChange={(e) => set("available", e.target.checked)} />
        Disponible hoy <span className="text-slate-400">(si no, el asistente no lo ofrece)</span>
      </label>
      <Problem error={error} />
      <div className="flex items-center justify-between gap-2">
        {it ? <Button variant="danger" onClick={remove} loading={busy === "delete"}>Borrar</Button> : <span />}
        <div className="flex gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button onClick={save} loading={busy === "save"}>Guardar</Button></div>
      </div>
    </Modal>
  );
}

function GroupDialog({ dialog, call, onClose }: { dialog: Extract<Dialog, { kind: "group" }>; call: Call; onClose: () => void }) {
  const g = dialog.group;
  const [f, setF] = useState({ name: g?.name ?? "", required: g?.required ?? false, multiple: g?.multiple ?? false, maxChoices: g?.maxChoices ? String(g.maxChoices) : "" });
  const [options, setOptions] = useState<Array<{ id?: string; name: string; price: string; available: boolean }>>(
    g ? g.options.map((o) => ({ id: o.id, name: o.name, price: o.priceDeltaCents ? toPesos(o.priceDeltaCents) : "", available: o.available })) : [{ name: "", price: "", available: true }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const setOpt = (i: number, patch: Partial<(typeof options)[number]>) => setOptions((p) => p.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  async function save() {
    setBusy(true);
    const e = await call("group", { ...(g ? { id: g.id } : {}), ...f, options });
    setBusy(false);
    if (e) setError(e);
    else onClose();
  }

  return (
    <Modal title={g ? "Editar grupo de modificadores" : "Nuevo grupo de modificadores"} onClose={onClose}>
      <label className="block space-y-1 text-sm font-medium text-slate-700">
        Nombre del grupo
        <input className={field} value={f.name} onChange={(e) => setF((p) => ({ ...p, name: e.target.value }))} autoFocus maxLength={80} placeholder="Tamaño, Masa, Tortilla, Extras…" />
      </label>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-700">
        <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-teal-700" checked={f.required} onChange={(e) => setF((p) => ({ ...p, required: e.target.checked }))} />Obligatorio</label>
        <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-teal-700" checked={f.multiple} onChange={(e) => setF((p) => ({ ...p, multiple: e.target.checked }))} />Se pueden elegir varias</label>
        {f.multiple && (
          <label className="flex items-center gap-2">Máximo
            <input className={cx(field, "w-16")} value={f.maxChoices} onChange={(e) => setF((p) => ({ ...p, maxChoices: e.target.value }))} inputMode="numeric" placeholder="∞" />
          </label>
        )}
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium text-slate-700">Opciones <span className="font-normal text-slate-400">· el precio es lo que SUMA al platillo</span></p>
        {options.map((o, i) => (
          <div key={o.id ?? `n${i}`} className="flex items-center gap-2">
            <input className={cx(field, "flex-1")} value={o.name} onChange={(e) => setOpt(i, { name: e.target.value })} placeholder="Grande" maxLength={80} aria-label={`Opción ${i + 1}`} />
            <input className={cx(field, "w-24")} value={o.price} onChange={(e) => setOpt(i, { price: e.target.value })} inputMode="decimal" placeholder="+ $0" aria-label={`Precio extra de la opción ${i + 1}`} />
            <button onClick={() => setOptions((p) => p.filter((_, j) => j !== i))} disabled={options.length === 1} className="rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30" aria-label={`Quitar la opción ${i + 1}`}>✕</button>
          </div>
        ))}
        <Button variant="ghost" className="px-2 py-1 text-xs" onClick={() => setOptions((p) => [...p, { name: "", price: "", available: true }])} disabled={options.length >= 40}>+ Opción</Button>
      </div>
      <Problem error={error} />
      <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button onClick={save} loading={busy}>Guardar</Button></div>
    </Modal>
  );
}

type ImportSummary = { categoriesCreated: number; itemsCreated: number; itemsUpdated: number; skipped: string[]; warnings: string[]; dryRun: boolean };

const EXAMPLE = `categoria,nombre,descripcion,precio,disponible,modificadores
Tacos,Taco al pastor,Con piña y cebolla,18,si,Tortilla
Pizzas,Hawaiana,Jamón y piña,129.50,si,Tamaño | Extras
Bebidas,Refresco,,25,no,`;

function ImportDialog({ reload, onClose }: { reload: () => Promise<void>; onClose: () => void }) {
  const [csv, setCsv] = useState("");
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [busy, setBusy] = useState<"test" | "import" | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(dryRun ? "test" : "import");
    setError(null);
    const r = await api<{ ok: true; summary: ImportSummary }>("/api/menu/import", { method: "POST", body: { csv, dryRun } });
    setBusy(null);
    if (!r.ok) return setError(r);
    setSummary(r.summary);
    if (!dryRun) {
      setDone(true);
      await reload();
    }
  }
  function onFile(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ""));
      setSummary(null);
      setDone(false);
    };
    reader.readAsText(file);
  }

  return (
    <Modal title="Importar menú desde CSV" onClose={onClose}>
      <p className="text-sm text-slate-600">
        Guarda tu hoja de Excel o Google Sheets como <b>CSV</b>. Las columnas obligatorias son <code>categoria</code>, <code>nombre</code> y <code>precio</code>; las demás son opcionales. Si vuelves a importar, los platillos que ya existen se actualizan, no se duplican.
        En <code>modificadores</code> pon los nombres de grupos que ya creaste, separados con <code>|</code>.
      </p>
      <details className="text-xs text-slate-500">
        <summary className="cursor-pointer font-medium text-teal-800">Ver ejemplo</summary>
        <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-50 p-2 text-[11px] leading-relaxed text-slate-700">{EXAMPLE}</pre>
        <button className="mt-1 underline" onClick={() => { setCsv(EXAMPLE); setSummary(null); setDone(false); }}>Usar este ejemplo</button>
      </details>
      <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium" aria-label="Elegir archivo CSV" />
      <textarea className={cx(field, "font-mono text-xs")} rows={6} value={csv} onChange={(e) => { setCsv(e.target.value); setSummary(null); setDone(false); }} placeholder="…o pega aquí el contenido del archivo" aria-label="Contenido del CSV" />
      <Problem error={error} />
      {summary && (
        <div className="space-y-2">
          <Alert tone={done ? "green" : "sky"}>
            {done ? "Importado ✓ " : "Prueba (no se guardó nada): "}
            {summary.itemsCreated} {summary.itemsCreated === 1 ? "platillo nuevo" : "platillos nuevos"}, {summary.itemsUpdated} {summary.itemsUpdated === 1 ? "actualizado" : "actualizados"}, {summary.categoriesCreated} {summary.categoriesCreated === 1 ? "categoría nueva" : "categorías nuevas"}.
          </Alert>
          {summary.skipped.length > 0 && (
            <Alert tone="amber"><p className="font-medium">No se importaron {summary.skipped.length} renglones:</p><ul className="ml-4 list-disc">{summary.skipped.slice(0, 15).map((s) => <li key={s}>{s}</li>)}{summary.skipped.length > 15 && <li>…y {summary.skipped.length - 15} más</li>}</ul></Alert>
          )}
          {summary.warnings.length > 0 && (
            <Alert tone="amber"><p className="font-medium">Para revisar:</p><ul className="ml-4 list-disc">{summary.warnings.slice(0, 15).map((s) => <li key={s}>{s}</li>)}</ul></Alert>
          )}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>{done ? "Cerrar" : "Cancelar"}</Button>
        {!done && <Button variant="secondary" onClick={() => run(true)} loading={busy === "test"} disabled={!csv.trim()}>Probar</Button>}
        {!done && <Button onClick={() => run(false)} loading={busy === "import"} disabled={!csv.trim() || (summary !== null && summary.itemsCreated + summary.itemsUpdated === 0)}>Importar</Button>}
      </div>
    </Modal>
  );
}
