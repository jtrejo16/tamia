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

## Restaurantes: pedidos y reservaciones

En un negocio con el módulo de restaurante **y sin el de citas**, Clientes habla de pedidos y reservaciones en lugar de citas. Las mismas cifras sirven para citas, restaurantes o ambos: cada fuente que el negocio no usa aporta cero.

- **Visita** = un pedido **entregado** o una reservación **completada** (además de una cita realizada, si el negocio también la usa). Si el equipo no marca los pedidos como entregados ni cierra las reservaciones, las cifras salen bajas: se marcan en *Pedidos* y *Reservaciones* (o desde la ficha del cliente: «Vino» / «No vino»).
- **No llega** = reservación en «no llegó». «No llega seguido» = 2 o más.
- **En curso** = pedidos en proceso (de las últimas 24 horas) y reservaciones próximas; mientras haya algo en curso el cliente nunca es «en riesgo» ni «perdido».
- **Plazos más cortos:** *en riesgo* = más de **30** días sin pedir ni venir; *perdido* = más de **60** (un restaurante se enfría antes que una clínica). Con citas, o con los dos módulos, siguen siendo 60 y 120 (`limitsFor` en `customers.ts`).
- **Lista:** en vez de «Visitas» muestra **Pedidos**, **Reservaciones** y **Gastado** (suma de sus pedidos entregados, dato real, no estimado), y la fecha de su último pedido o visita. La pestaña «Con inasistencias» pasa a «No llegaron» y desaparece «Por cerrar» (las reservaciones por cerrar se ven en *Reservaciones*).
- **Ficha:** resumen con pedidos, gastado, **ticket promedio**, reservaciones, platillo favorito (el que más ha pedido), no llegó, canceló, en curso, primera y última visita y cada cuántos días viene; **Historial de pedidos** (con lo que pidió, si fue a domicilio o para recoger, el total y el estado) e **Historial de reservaciones** (personas, notas y estado, con «Vino» / «No vino» para las pasadas sin cerrar). Se muestran los 50 más recientes de cada uno; las cifras cuentan todos.
- Al **unir dos clientes duplicados** se juntan también sus pedidos y reservaciones.

## Reglas al editar

- Los cambios los hacen el dueño y la recepción; el rol de solo lectura puede ver.
- El teléfono se guarda normalizado (`+52` y 10 dígitos; otros países con su lada). Si es el mismo celular escrito de otra forma (con el «1» antiguo de WhatsApp), se conserva el que ya estaba.
- El teléfono es único por negocio. Si ya es de otro cliente, la pantalla avisa y ofrece **unirlos**; se conserva el cliente que tiene ese número.
- Cuando llega un mensaje de WhatsApp, el cliente se busca con las dos formas del celular mexicano (`+52…` y `+521…`), así que cambiar un teléfono no duplica al cliente.
- Las **notas internas** (`contacts.notes`) las ve solo el equipo. No se incluyen en lo que lee el asistente.
- La bitácora (`customer.created`, `customer.updated`) guarda qué campos cambiaron, no los datos personales.

## Ideas para después

Importar clientes desde Excel/CSV, exportar a Excel, seguimiento de «toca volver» (revisión cada 6 meses), cumpleaños, origen del cliente, y mensajes masivos a un segmento (depende de plantillas de Meta con costo y del consentimiento).
