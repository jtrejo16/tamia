/**
 * Busqueda de conocimiento por palabras clave. Es el reemplazo TEMPORAL del RAG con
 * embeddings (paso 8): funciona bien con preguntas frecuentes cortas y deja la misma
 * interfaz (devuelve fragmentos o "no encontrado") para cambiar solo la implementacion.
 */

const STOPWORDS = new Set([
  "de", "la", "el", "los", "las", "un", "una", "unos", "unas", "que", "en", "y", "a", "o",
  "por", "para", "con", "del", "al", "es", "se", "su", "sus", "como", "cual", "cuales",
  "cuanto", "cuanta", "cuantos", "mi", "me", "tu", "te", "lo", "le", "si", "no", "ya", "hay",
  "tienen", "tiene", "puedo", "pueden", "quiero", "quisiera", "hola", "buenas", "tardes",
  "dias", "noches", "favor", "gracias", "son", "ser", "esta", "este", "esto", "muy", "mas",
]);

function strip(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Raiz aproximada: primeras 5 letras ("seguros" y "seguro" coinciden). */
function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of strip(text).split(/[^a-z0-9]+/)) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    out.add(word.slice(0, 5));
  }
  return out;
}

export interface KnowledgeHit {
  titulo: string;
  fragmento: string;
  relevancia: number;
}

export interface KnowledgeSource {
  title: string;
  text: string;
}

export function searchKnowledge(question: string, sources: KnowledgeSource[], limit = 3): KnowledgeHit[] {
  const query = stems(question);
  if (query.size === 0) return [];
  const needed = Math.min(2, query.size);

  const hits: KnowledgeHit[] = [];
  for (const source of sources) {
    // Una entrada por linea (preguntas frecuentes); lineas muy largas se parten por oraciones.
    const entries = source.text
      .split(/\r?\n+/)
      .map((l) => l.trim())
      .filter((l) => l.length > 20);
    for (const entry of entries) {
      const entryStems = stems(entry);
      let matched = 0;
      for (const s of query) if (entryStems.has(s)) matched++;
      const ratio = matched / query.size;
      if (matched >= needed && ratio >= 0.4) {
        hits.push({ titulo: source.title, fragmento: entry, relevancia: Number(ratio.toFixed(2)) });
      }
    }
  }
  return hits.sort((a, b) => b.relevancia - a.relevancia).slice(0, limit);
}
