# Restaurante (módulo `restaurante`)

Estado: **fase 7 (última del plan): portada «Para restaurantes» y guion de demo.** El asistente contesta con el menú real y **toma pedidos para recoger en el local o a domicilio** (si el restaurante lo activa) por WhatsApp, Messenger e Instagram; el equipo los atiende en el tablero de **Pedidos**. Por **teléfono** el asistente informa el menú y, si se activa, también toma pedidos. Un restaurante se da de alta eligiendo su giro y arranca con un menú de ejemplo. Además toma **reservaciones de mesa por aforo** (si el restaurante las activa).

El plan de la conversación de diseño quedó completo. Para enseñarlo a un prospecto, ver `docs/DEMO-RESTAURANTES.md`.

## Cómo se enciende para un negocio

Hay tres giros de restaurante: **Taquería**, **Pizzería** y **Restaurante, fonda o cafetería**. Quien se registra en `/registro` elige uno (o el operador se lo asigna con *Cambiar giro*) y el negocio arranca **solo con el módulo de restaurante** (sin Citas): menú, pedidos y el prompt del asistente se componen según el módulo (ver `docs/MODULOS.md`). El pack de cada giro (`packs/taqueria.json`, `pizzeria.json`, `restaurante.json`) da el tono y las reglas de escalamiento (quejas, reembolsos, alergias, pedidos muy grandes).

Para encenderlo a un negocio que ya existe sin cambiarle el giro, o para tener los dos módulos, se sigue pudiendo con una lista de módulos en el perfil:

```sql
UPDATE tenants
SET profile = jsonb_set(coalesce(profile, '{}'::jsonb), '{modules}', '["restaurante"]'::jsonb),
    updated_at = now()
WHERE id = '<id del negocio>';
```

Ojo: esa lista **reemplaza** a la del giro. Con `["restaurante"]` el negocio deja de tener el módulo de citas (se le oculta «Citas» y el agente pierde las herramientas de agenda). Para tener los dos: `["citas","restaurante"]`. Para volver al módulo del giro: quitar la clave `modules` del perfil.

Sin el módulo, la pantalla Menú, la API (`/api/menu/*`) y la herramienta del agente no existen para el negocio.

## Qué hay

**Panel → Menú** (solo negocios con el módulo):

- **Platillos** por categoría, con precio, descripción (los ingredientes que usa el asistente), y un interruptor **Disponible / Agotado** para el día a día.
- **Modificadores:** grupos que se definen una vez y se pegan a varios platillos (tamaño, masa, tortilla, extras…). Cada grupo es obligatorio o no, de una sola opción o de varias (con tope opcional), y cada opción puede sumar un precio extra y marcarse como agotada. Cambiar el precio de «Queso extra» se hace en un solo lugar.
- **Importar CSV** (con una **prueba** que no guarda nada) y **Exportar CSV**.
- Ver el menú lo puede cualquier rol; cambiarlo, el dueño y la recepción.

**Agente → `consultar_menu`:** sin búsqueda da un resumen por categorías; con una palabra (platillo, ingrediente o categoría) da el detalle con precio y modificadores. Busca sin importar mayúsculas ni acentos, y todas las palabras deben coincidir. Lo agotado se marca y no se ofrece. Lo que no existe se dice sin inventar alternativas. Un menú vacío escala a una persona. Con más de 60 platillos, sin búsqueda solo lista categorías. Las alergias y dietas se escalan a una persona.

## Pedidos para recoger (fase 2)

**Agente.** Tres herramientas nuevas (solo con el módulo):

- `crear_pedido`: el modelo solo dice *qué* quiere el cliente (`platillo_id`, cantidad, `opciones_ids`, notas por platillo, forma de pago). **El total lo calcula el código** contra el menú real (`packages/agent/src/orders.ts`): rechaza platillos u opciones agotados o inexistentes, modificadores obligatorios que faltan, demasiadas opciones, más de 20 piezas por platillo, más de 15 platillos distintos o más de $15,000. Primero devuelve el resumen con el total; el cliente debe confirmar **en un mensaje posterior** (misma confirmación que citas) y entonces se crea con su **número de pedido** consecutivo por negocio. Repetir la confirmación no duplica el pedido (huella del carrito, 10 minutos). Pide nombre y teléfono del cliente antes de crear.
- `estado_pedido`: los pedidos del cliente de las últimas 24 h y en qué van.
- `cancelar_pedido`: solo mientras el pedido siga **nuevo**; si ya se prepara, lo pasa con una persona.

Reglas que el código impone (no el prompt): pedidos pausados, **horario del negocio** (con turnos que cruzan la medianoche y días de cierre; sin horario cargado no se bloquea), pedido mínimo y formas de pago aceptadas. En modo copiloto/dry las acciones van a Aprobaciones como cualquier otra.

**Panel → Pedidos** (tablero con **Nuevos → Preparando → Listos**, historial de 7 días y ajustes):

- Botones para avanzar el estado (se puede saltar «Preparando») y **Cancelar** con motivo. Al marcar **listo** o **cancelar** se le escribe al cliente por el mismo canal; si pasaron más de 24 h desde su último mensaje de WhatsApp (o fue llamada) el cambio se guarda y el panel avisa que no se pudo notificar.
- Insignia con los pedidos nuevos en el menú, tablero que se actualiza solo cada 5 s y **sonido opcional** al entrar un pedido (se activa con un clic; se recuerda en el navegador).
- **Ajustes** (recepción o dueño): pausar pedidos, minutos de preparación, pedido mínimo, formas de pago (efectivo, tarjeta, transferencia con sus datos). Sin ajustes guardados valen 25 min, sin mínimo, efectivo y tarjeta.
- Ver lo puede cualquier rol; cambiar estados y ajustes, el dueño y la recepción.

**Aviso al equipo.** Cada minuto el worker manda un **correo** por cada pedido nuevo a los destinatarios de correo de *Ajustes → Avisos al equipo* (con cliente, partidas, total y enlace al tablero). Se reclama antes de enviar (sin duplicados con varios workers) y reintenta hasta 5 veces. Si el negocio no tiene destinatario de correo, el tablero igual muestra el pedido.

## Pedidos a domicilio (fase 3)

Se activa en **Pedidos → Ajustes → Entrega a domicilio** (recepción o dueño) y necesita al menos **una zona activa**. Sin eso el asistente no lo ofrece y `crear_pedido` en modo domicilio responde `entrega_no_disponible`.

- **Zonas de entrega:** una por colonia o sector, con su **costo de envío** y un pedido mínimo propio opcional (vale el mayor entre el general y el de la zona). El tiempo de entrega y el **envío gratis desde** un monto son generales. Quitar una zona no altera los pedidos ya hechos (guardan el nombre de su zona, la dirección y el envío).
- **Agente:** `crear_pedido` recibe `modo` (`recoger` por defecto o `domicilio`), `direccion` (calle, número y referencias) y `colonia`. **La zona y el envío los decide el código**: la colonia se compara con las zonas activas sin importar mayúsculas ni acentos ("col. CENTRO, Mérida" → Centro); si cabe en dos zonas o en ninguna, no se adivina: responde `zona_no_cubierta` con las zonas que sí cubre y el asistente ofrece recoger. El resumen que confirma el cliente trae subtotal, envío, total, dirección y tiempo. `consultar_menu` publica las zonas con su costo en `info_de_pedidos.a_domicilio`.
- **Estados:** nuevo → preparando → listo → **en camino** → entregado (en camino es opcional; se puede pasar de listo a entregado). «En camino» no existe en los pedidos para recoger. Al marcar **en camino** se le escribe al cliente («va en camino», con el total a pagar); a un pedido a domicilio no se le manda «listo para recoger». Cancelar sigue avisando con el motivo.
- **Tablero:** las tarjetas muestran «A domicilio» o «Para recoger», la dirección y el envío; aparece la columna **En camino** solo cuando hay pedidos a domicilio.
- **Correo al equipo:** dice «A DOMICILIO», con dirección, zona, envío y total.
- `estado_pedido` dice si es a domicilio, a dónde va y si ya va en camino. El cliente solo cancela mientras el pedido siga nuevo, igual que antes.

No incluye: cálculo de distancia o mapas (las zonas son por nombre de colonia), repartidores ni seguimiento en vivo, ni la ubicación de WhatsApp como dirección (el asistente pide la dirección escrita).

## Voz: menú y pedidos por llamada (fase 4)

El asistente telefónico (ver `docs/VOICE.md`) usa **las mismas herramientas y reglas** que el de texto; no hay lógica de pedidos aparte para voz.

- **Siempre** (con el módulo): `consultar_menu` por teléfono. El prompt de voz pide hablar corto (categorías o máximo tres platillos, precios en pesos hablados) y no leer listas largas.
- **Tomar pedidos por teléfono es un ajuste aparte** (*Ajustes → Llamadas → «Permitir que tome pedidos por teléfono»*, solo dueño; apagado por defecto). Apagado: el asistente informa el menú y precios, toma nombre, pedido, si es para recoger o a domicilio (con dirección y colonia) y **escala a una persona** con esos datos. Encendido: gana `crear_pedido`, `estado_pedido` y `cancelar_pedido`. **Hay que volver a sincronizar con Retell** después de cambiarlo.
- **La confirmación sigue impuesta por código:** `crear_pedido` primero devuelve el resumen con el total; el pedido solo se crea si el cliente **habló de nuevo** después (se cuenta con la transcripción; sin ella, deben pasar unos segundos). Mismas validaciones que en WhatsApp: horario, pedidos pausados, mínimo, zona y envío calculados por el sistema.
- **Dirección de entrega por voz:** el prompt manda repetirla completa para confirmarla; la zona sale de la colonia como siempre (si no encaja, ofrece recoger).
- **Teléfono:** se toma el número desde el que llama (si es visible). Con número oculto el asistente lo pide número por número y lo repite antes de crear el pedido.
- El pedido queda con canal **Llamada** en el tablero y llega el mismo correo al equipo.
- **Avisos al cliente:** una llamada no se contesta por texto, así que «listo» / «en camino» / «cancelado» se mandan por **otro canal del mismo cliente** (WhatsApp, etc.) si su ventana de 24 h sigue abierta. Si no hay, el cambio se guarda y el panel avisa que hay que llamarle.
- Un negocio solo de restaurante no recibe en su prompt de voz nada de citas ni de urgencias dentales; con los dos módulos lleva ambos bloques. Un negocio de citas queda igual que antes.

**Sin probar con Retell real:** como el resto de la voz, se verificó con un Retell simulado. Conviene una llamada web de prueba antes de enseñarlo (ver el guion de demo, fase 7).

## Portada «Para restaurantes» y demo (fase 7)

- **`/restaurantes`** (pública, indexable; con sesión redirige al panel): qué hace, cómo se ve el tablero (ilustración), los tres giros, cómo empezar, **lo que Jovia es y lo que todavía no es** (sin pagos en línea, sin punto de venta, sin rastreo, zonas por colonia, aforo sin mesas), precio y preguntas frecuentes. Sus botones llevan a `/registro?giro=taqueria|pizzeria|restaurante`, que **llega con el giro ya elegido** (un giro desconocido se ignora). La portada general enlaza a ella desde el menú y desde la sección de giros.
- **Operador → «Preparar demostración»** (`operatorPrepareDemo`, `packages/inbox/src/demo.ts`, solo operador y solo negocios con el módulo de restaurante): llena **solo lo que falta** y es idempotente. Carga el menú de ejemplo si el menú está vacío, un horario de todos los días de 13:00 a 23:00 si no hay horario general, tres zonas de entrega si no hay ninguna (Centro $30; Norte y Sur $45 con pedido mínimo de $150) y, si el negocio nunca guardó ajustes de pedidos, enciende domicilio (envío gratis desde $300) y reservaciones (aforo 30). Nunca pisa lo que el negocio ya configuró y deja constancia en la bitácora.
- **`docs/DEMO-RESTAURANTES.md`:** preparación del negocio de demo, guion de 10 minutos con los mensajes de ejemplo y qué enseñar en el panel, qué hacer si algo falla, preguntas de prospectos y **lo que no se promete**.

## Clientes de un restaurante

La sección **Clientes** deja de hablar de citas: la lista muestra pedidos, reservaciones y lo gastado, y la ficha trae el **historial de pedidos y de reservaciones**, el ticket promedio y el platillo favorito. Los plazos de «en riesgo» y «perdido» son de 30 y 60 días. Detalle en `docs/CLIENTES.md`.

## Horario que cruza la medianoche

Una taquería que cierra a las 2 de la mañana captura su horario tal cual: **de 18:00 a 02:00** (la hora de cierre menor que la de apertura significa «del día siguiente»; cerrar a las 00:00 es medianoche). Los pedidos y las reservaciones lo entienden (la madrugada cuenta para el turno del día anterior y un día de cierre quita también su madrugada). **Solo se acepta en negocios sin el módulo de citas**: la agenda de citas no entiende turnos que cruzan la medianoche, así que un negocio de citas recibe un aviso claro. En Ajustes → Horarios un restaurante ve «Horario de atención» (no «de citas»). La base exige solo que abrir y cerrar no sean la misma hora (migración `0031`).

## Reservaciones por aforo (fase 6)

El restaurante dice **cuántos comensales caben a la vez** (aforo) y cada reservación ocupa los lugares de su grupo durante la estancia estimada. **No hay mesas**: se reserva mientras el grupo quepa en el aforo durante TODO el rato que ocuparía. Se enciende en *Reservaciones → Ajustes* (apagado por defecto); el código del cálculo está en `packages/agent/src/reservations.ts`.

- **Ajustes** (recepción o dueño): aforo (por defecto 40), duración de la mesa (90 min), horas cada 15/30/60 min, grupo máximo (10; más grande lo atiende una persona), aviso mínimo (60 min), hasta cuántos días adelante (30) y minutos antes del cierre para la última reservación (60). Sin horario general cargado (Ajustes → Horarios) no se puede ofrecer nada: el asistente escala y el panel lo avisa.
- **Las horas ofrecidas las calcula el código:** parten del horario del negocio (con turnos que cruzan la medianoche y días de cierre), cada «slot», hasta el cierre menos la última hora; descartan lo ya pasado, lo muy cercano (aviso mínimo), lo muy lejano y lo que no cabe. El cupo es el **pico real de comensales sentados a la vez** durante la estancia (dos reservaciones consecutivas no se suman). El asistente **nunca dice cuántos lugares quedan**.
- **Agente** (texto y voz): `buscar_mesa` (día, personas y hora preferida → hasta cuatro horas libres, o por qué no hay y los próximos días con lugar), `crear_reservacion` (resumen primero; la confirmación debe llegar en un mensaje posterior, igual que citas y pedidos; pide nombre y teléfono), `mis_reservaciones` y `cancelar_reservacion` (solo antes de su hora). Se vuelve a revisar el cupo dentro de un candado por negocio al crear, así que dos clientes no se quedan con el mismo lugar. Repetir la misma reservación no la duplica. En modo copiloto van a Aprobaciones.
- **Voz:** reservar por teléfono es un ajuste aparte (*Ajustes → Llamadas → «Permitir que reserve mesa por teléfono»*, solo dueño, apagado por defecto; hay que volver a sincronizar con Retell). Apagado, el asistente toma día, hora y personas y escala a una persona.
- **Panel → Reservaciones:** agenda por día (con flechas, «Hoy» y selector de fecha) con reservaciones, comensales y **pico contra el aforo** (barra que se pone ámbar y roja), estados **confirmada → sentada → completada**, «no llegó» (solo después de su hora) y **cancelar con motivo**, que le avisa al cliente por su conversación (si ya pasaron 24 h o fue por llamada sin otro canal abierto, el panel dice que no se pudo notificar). Insignia en el menú con las confirmadas de hoy que aún no llegan.
- **Nueva reservación a mano** (recepción o dueño): nombre, teléfono, día, hora, personas y nota. Da de alta al cliente si no existe (o usa al que ya tiene ese teléfono) y respeta el aforo; si el aforo no alcanza, ofrece «reservar de todos modos» y la reservación queda marcada como sobrecupo en la bitácora.
- **Primeros pasos:** paso opcional «Reservaciones de mesa» (no cuenta en el porcentaje).

No incluye: mesas ni plano del salón, recordatorios automáticos antes de la reservación, depósito o garantía con tarjeta, lista de espera ni cambiar una reservación (se cancela y se crea otra).

## Menú de ejemplo y primeros pasos (fase 5)

**Menú de ejemplo.** Al registrarse con uno de los tres giros, el negocio nace con un menú de ejemplo realista (con modificadores): tacos con tortilla y extras y bebidas con tamaño en la taquería; pizzas con tamaño obligatorio, orilla y extras en la pizzería; entradas, platos fuertes, bebidas y postres en el restaurante. Los datos viven en `packages/shared/src/starter-menus.ts` y se cargan con `applyStarterMenu` (`packages/inbox/src/starter.ts`). Reglas:

- **Solo se carga una vez y nunca pisa un menú que ya existe.** Si el registro no puede cargarlo, el alta sigue (el menú se puede cargar a mano o por CSV).
- Cuando el **operador cambia el giro** de un negocio con el menú vacío a uno de restaurante, también se carga (la consola avisa «Se cargó un menú de ejemplo»). Para demos: crear un negocio de prueba, cambiarle el giro y ya tiene menú.
- Los precios son **de referencia**: el negocio queda marcado como «menú sin revisar» (`profile.starterMenu`) hasta que el dueño cambia algo del menú (editar, agregar, borrar o importar; una importación de prueba no cuenta). Mientras tanto, *Primeros pasos* muestra un aviso.
- El horario del negocio y los ajustes de pedidos **no** se precargan: son del dueño (y sin horario cargado el asistente no bloquea pedidos).

**Primeros pasos** (`/inicio`, `packages/inbox/src/onboarding.ts`): lista con **porcentaje de avance** calculada con lo que ya hay (no guarda nada). Pasos del núcleo: describir el negocio (descripción y dirección), horario, conectar WhatsApp y avisos al equipo. Con el módulo de citas se suman servicios y equipo; con el de restaurante, cargar el menú, **revisar el menú de ejemplo** (si arrancó con uno), revisar los ajustes de pedidos (se marca al guardarlos una vez) y, **opcional y sin contar en el porcentaje**, la entrega a domicilio. Cada paso lleva directo a su pantalla (`/configuracion?tab=…`). La entrada «Primeros pasos» aparece **primera en el menú con su porcentaje** mientras falte algo y desaparece al llegar a 100 %. Los negocios de restaurante tampoco ven las pestañas de Servicios y Equipo en Ajustes.

## Formato del CSV

Encabezado obligatorio: `categoria`, `nombre`, `precio`. Opcionales: `descripcion`, `disponible`, `modificadores`.

```csv
categoria,nombre,descripcion,precio,disponible,modificadores
Tacos,Taco al pastor,Con piña y cebolla,18,si,Tortilla
Pizzas,Hawaiana,"Jamón, piña y queso",129.50,si,Tamaño | Extras
Bebidas,Refresco,,25,no,
```

- Acepta coma, punto y coma o tabulador, comillas, BOM y acentos (lo que guarda Excel en español).
- Precios: `85`, `$85.50`, `85,50`, `$1,250.00`, `85 pesos`. Máximo 100,000 pesos.
- `disponible`: vacío = disponible; `no`, `0`, `false`, `agotado` = agotado.
- `modificadores`: nombres de grupos que **ya existen**, separados con `|`. Uno que no existe se avisa y el platillo se importa sin él. Si la columna no viene (o la celda está vacía), los enlaces que ya tenía el platillo no se tocan.
- **Es idempotente:** volver a importar actualiza los platillos que ya existen (por categoría y nombre, sin importar mayúsculas) y no los duplica. Los repetidos dentro del archivo se saltan (manda el primero).
- Límites: 500 platillos y 300 KB por archivo.
- Los nombres que Excel tomaría por fórmula (`=`, `+`, `-`, `@`) se protegen al exportar con un apóstrofo y se recuperan al importar.

## Datos y seguridad

Tablas del menú (migración `0026`; el menú de ejemplo se guarda en las mismas, sin tablas nuevas), todas con aislamiento por negocio (RLS): `menu_categories`, `menu_items`, `menu_modifier_groups`, `menu_modifier_options` y `menu_item_groups`. Los precios van en centavos de peso mexicano; no hay otra moneda por ahora. Los nombres son únicos sin distinguir mayúsculas (categoría por negocio, platillo por categoría, grupo por negocio, opción por grupo).

Reservaciones (migración `0030`, con RLS): tabla `reservations` y los ajustes de aforo dentro de `restaurant_settings`. Tablas de pedidos (migración `0027`, también con RLS; la `0028` suma `delivery_zones`, el estado «en camino» y los campos de domicilio en `orders` y `restaurant_settings`): `restaurant_settings`, `orders`, `order_items` y `order_item_modifiers`, más la función `orders_to_notify` (SECURITY DEFINER, solo devuelve ids). El pedido guarda el nombre y el precio de cada platillo **al momento de pedir**, así que cambiar o borrar un platillo del menú no altera pedidos ya hechos. Unir dos contactos duplicados también mueve sus pedidos.

El código del menú vive en: `packages/db/src/schema/restaurant.ts` y `menu.ts` (lectura), `packages/inbox/src/menu.ts` y `csv.ts` (edición, importar y exportar), `packages/agent/src/restaurant.ts` (herramienta y prompt), `apps/web/src/components/menu-view.tsx` y `app/api/menu/` (panel). Pedidos: `packages/agent/src/orders.ts` y `restaurant.ts`, `packages/inbox/src/orders.ts`, `apps/worker/src/processors/orders.ts`, `apps/web/src/components/orders-view.tsx` y `app/api/orders/`.

## Pendiente

- Cobro en línea y ticket de cocina impreso: fuera de alcance por ahora.
- Orden manual de categorías y platillos (hoy van en el orden en que se crearon).
- Fotos de platillos.
- Importar directo de `.xlsx` (hoy: guardar como CSV).
- Que el prompt de voz conozca el módulo (ver `docs/MODULOS.md`).
