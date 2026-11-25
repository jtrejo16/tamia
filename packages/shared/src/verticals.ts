/**
 * Giros que se pueden elegir al registrarse. Cada id es el nombre de un pack en /packs/<id>.json (reglas, urgencias y
 * datos que pide el asistente). "generico" sirve para cualquier otro negocio con citas o reservas.
 * Vive aqui (sin codigo de servidor) para que lo usen tanto el formulario como el registro.
 */
export const VERTICALS = [
  { id: "dental", label: "Clínica dental" },
  { id: "salud", label: "Consultorio o clínica médica" },
  { id: "belleza", label: "Estética, barbería, spa o uñas" },
  { id: "mascotas", label: "Veterinaria o estética canina" },
  { id: "bienestar", label: "Gimnasio, yoga o entrenamiento" },
  { id: "automotriz", label: "Taller o servicio automotriz" },
  { id: "taqueria", label: "Taquería" },
  { id: "pizzeria", label: "Pizzería" },
  { id: "restaurante", label: "Restaurante, fonda o cafetería" },
  { id: "profesional", label: "Despacho o servicios profesionales" },
  { id: "generico", label: "Otro tipo de negocio" },
] as const;

export type VerticalId = (typeof VERTICALS)[number]["id"];
export const VERTICAL_IDS = VERTICALS.map((v) => v.id) as [VerticalId, ...VerticalId[]];
