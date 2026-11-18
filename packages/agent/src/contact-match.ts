import { contacts, type Tx } from "@empleado/db";
import { and, inArray, ne, or, sql } from "drizzle-orm";

/**
 * ¿Este cliente podria ser la misma persona que OTRO contacto (por ejemplo, escribio por Facebook y antes por
 * WhatsApp)? Son solo PISTAS: nunca se unen solos, porque quien escribe por una red puede decir cualquier
 * telefono o nombre. Una persona del equipo decide.
 */

export type MatchReason = "phone" | "declared_phone" | "name";

export interface RelatedContact {
  id: string;
  reason: MatchReason;
}

type Me = { id: string; displayName: string | null; phoneE164: string | null; profile: Record<string, unknown> | null };

/** Un mismo numero mexicano puede estar guardado con o sin el "1" despues del 52 (WhatsApp lo trae con "1"). */
export function phoneVariants(e164: string | null | undefined): string[] {
  if (!e164) return [];
  const out = new Set([e164]);
  const m = /^\+52(1?)(\d{10})$/.exec(e164);
  if (m) {
    out.add(`+52${m[2]}`);
    out.add(`+521${m[2]}`);
  }
  return [...out];
}

const FROM = "áéíóúüñ";
const TO = "aeiouun";

/** Minusculas y sin acentos, para comparar nombres. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, (c) => TO[FROM.indexOf(c)]!)
    .replace(/\s+/g, " ")
    .trim();
}

/** Solo un nombre con al menos nombre y apellido es una pista razonable ("Ana" coincide con demasiada gente). */
const isFullName = (n: string) => normalizeName(n).split(" ").length >= 2;

export async function findRelatedContacts(tx: Tx, me: Me): Promise<RelatedContact[]> {
  const profile = me.profile ?? {};
  const declared = typeof profile.telefono_declarado === "string" ? profile.telefono_declarado : null;
  const dismissed = new Set(Array.isArray(profile.no_unir) ? (profile.no_unir as unknown[]).filter((x): x is string => typeof x === "string") : []);

  const phones = phoneVariants(me.phoneE164);
  const declaredPhones = phoneVariants(declared);
  const name = me.displayName && isFullName(me.displayName) ? normalizeName(me.displayName) : null;
  if (phones.length === 0 && declaredPhones.length === 0 && !name) return [];

  const normSql = sql`translate(lower(${contacts.displayName}), ${FROM}, ${TO})`;
  const rows = await tx
    .select({ id: contacts.id, phone: contacts.phoneE164, name: contacts.displayName })
    .from(contacts)
    .where(
      and(
        ne(contacts.id, me.id),
        or(
          phones.length ? inArray(contacts.phoneE164, phones) : undefined,
          declaredPhones.length ? inArray(contacts.phoneE164, declaredPhones) : undefined,
          name ? sql`${normSql} = ${name}` : undefined,
        ),
      ),
    )
    .limit(20);

  const out: RelatedContact[] = [];
  for (const r of rows) {
    if (dismissed.has(r.id)) continue;
    const reason: MatchReason = r.phone && phones.includes(r.phone) ? "phone" : r.phone && declaredPhones.includes(r.phone) ? "declared_phone" : "name";
    out.push({ id: r.id, reason });
  }
  return out;
}
