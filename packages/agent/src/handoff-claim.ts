/**
 * ¿La respuesta le promete al cliente que una persona lo atendera? (p. ej. "le paso tu mensaje a la recepción",
 * "te contactan en breve"). Si el modelo lo dice SIN haber llamado a escalar_a_humano, el cliente se queda esperando
 * a alguien que nunca recibio el aviso: el codigo lo detecta y escala de verdad.
 */
const TEAM = "(recepci[oó]n|equipo|asesor(?:es|a)?|personal|encargad[oa]s?|humano|persona|compa[nñ]ero|doctor(?:a)?|especialista|cl[ií]nica|consultorio)";

const PATTERNS: RegExp[] = [
  // "le paso / pasaré / transfiero / canalizo ... a/con la recepción"
  new RegExp(`\\b(paso|pasar[eé]|pasamos|pasar|transfiero|transferir[eé]|canalizo|derivo|comparto|env[ií]o|mando)\\b[^.!?\\n]{0,60}\\b(a|con|al|a la)\\b[^.!?\\n]{0,25}\\b${TEAM}`, "i"),
  // "tu mensaje / tu caso / tu solicitud ... recepción / equipo"
  new RegExp(`\\b(tu|su|el)\\s+(mensaje|caso|solicitud|consulta|petici[oó]n|cita)\\b[^.!?\\n]{0,50}\\b${TEAM}`, "i"),
  // "te contactan / le contestarán / te llamarán / te atenderán"
  /\b(te|le|se)\s+(contactan|contactar[aá]n?|contestan|contestar[aá]n?|responder[aá]n?|llamar[aá]n?|atender[aá]n?|escribir[aá]n?|confirmar[aá]n?|confirman|comunicar[aá]n?)\b/i,
  // "un asesor / alguien del equipo te ayudará"
  new RegExp(`\\b(un|una|alguien del|alguien de la|nuestro|nuestra)\\s+${TEAM}\\b[^.!?\\n]{0,40}\\b(te|le|lo)\\s+(ayud|atend|contact|llam|escrib|confirm)`, "i"),
];

export function claimsHandoff(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 0 && PATTERNS.some((p) => p.test(t));
}
