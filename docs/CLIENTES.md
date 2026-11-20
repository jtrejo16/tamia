# Gestión de clientes

Sección **Clientes** del panel (`/clientes`): ver a todos los clientes, editar sus datos, darlos de alta a mano y saber cuándo vinieron y si han vuelto.

## Qué incluye

- **Lista** con buscador (nombre, teléfono con o sin formato, correo), filtros por etapa y una cabecera con números: clientes, nuevos (30 días), recurrentes, porcentaje que ha vuelto, porcentaje que no asiste y cuántos están en riesgo.
- **Ficha** (`/clientes/:id`): datos editables (nombre, teléfono, correo, etiquetas, notas internas, «no contactar»), canales por los que ha hablado, historial de citas y estadísticas.
- **Alta manual**: nombre y al menos un teléfono o correo.
- **Citas por cerrar**: citas que ya pasaron y siguen pendientes o confirmadas, con los botones «Vino» y «No vino».
- **Posibles duplicados** y unión de clientes (la unión ya existía en la bandeja).

## Cómo se calculan las cifras

Todo se calcula al consultar, sin tablas aparte (`packages/inbox/src/customers.ts`).

- **Vino** = cita en estado *completada*. Si el equipo no cierra las citas, las estadísticas salen bajas; por eso existe la cola «Por cerrar».
- **Etapas** (se evalúan en este orden):
  - *Prospecto*: nunca ha agendado.
  - *Nuevo*: una sola visita, o una cita próxima o por cerrar.
  - *Recurrente*: 2 o más visitas.
  - *En riesgo*: más de 60 días sin venir y sin cita próxima.
  - *Perdido*: más de 120 días sin venir y sin cita próxima.
  - *Falla seguido* no es una etapa, es una marca: 2 o más inasistencias.
- **Ha vuelto** = 2 o más visitas. **Viene cada** = promedio de días entre visitas realizadas.
- **Gasto estimado** = suma de los precios ACTUALES de sus citas completadas. Es una aproximación; Jovia no registra cobros por cita.
- Los días de «en riesgo» y «perdido» son fijos (`RISK_DAYS`, `LOST_DAYS`). Si más adelante se quieren configurables por negocio, se guardan en el perfil del negocio.
- La lista carga hasta 200 clientes por consulta y calcula las cifras de la cabecera sobre todos los que cumplen la búsqueda.

## Reglas al editar

- Los cambios los hacen el dueño y la recepción; el rol de solo lectura puede ver.
- El teléfono se guarda normalizado (`+52` y 10 dígitos; otros países con su lada). Si es el mismo celular escrito de otra forma (con el «1» antiguo de WhatsApp), se conserva el que ya estaba.
- El teléfono es único por negocio. Si ya es de otro cliente, la pantalla avisa y ofrece **unirlos**; se conserva el cliente que tiene ese número.
- Cuando llega un mensaje de WhatsApp, el cliente se busca con las dos formas del celular mexicano (`+52…` y `+521…`), así que cambiar un teléfono no duplica al cliente.
- Las **notas internas** (`contacts.notes`) las ve solo el equipo. No se incluyen en lo que lee el asistente.
- La bitácora (`customer.created`, `customer.updated`) guarda qué campos cambiaron, no los datos personales.

## Ideas para después

Importar clientes desde Excel/CSV, exportar a Excel, seguimiento de «toca volver» (revisión cada 6 meses), cumpleaños, origen del cliente, y mensajes masivos a un segmento (depende de plantillas de Meta con costo y del consentimiento).
