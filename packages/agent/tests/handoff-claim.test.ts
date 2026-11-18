import { describe, expect, it } from "vitest";
import { claimsHandoff } from "../src/handoff-claim";

describe("promesas de pasar con una persona", () => {
  it.each([
    "Le paso tu mensaje a la recepción y te contestan en breve.",
    "Listo, ya pasé tu solicitud al equipo.",
    "Voy a canalizar tu caso con un asesor.",
    "Tu cita la confirmará el equipo; te contactarán hoy.",
    "En breve te contestan por aquí.",
    "Un asesor te atenderá en cuanto pueda.",
    "Ya le avisé a la recepción, le llamarán para confirmar.",
    "Transfiero tu consulta con la doctora.",
  ])("detecta: %s", (text) => {
    expect(claimsHandoff(text)).toBe(true);
  });

  it.each([
    "¡Hola! Soy el asistente virtual de la clínica. ¿Para qué día quieres tu cita?",
    "Tenemos limpieza dental y blanqueamiento. ¿Cuál te interesa?",
    "Quedan estos horarios: martes 10:00, miércoles 12:00 o jueves 16:00.",
    "Atendemos de lunes a viernes de 9 a 18 h.",
    "Gracias por escribirnos, que tengas excelente día.",
    "",
  ])("no se confunde con: %s", (text) => {
    expect(claimsHandoff(text)).toBe(false);
  });
});
