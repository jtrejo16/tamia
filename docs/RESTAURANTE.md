# Restaurante (módulo `restaurante`)

Estado: **fase 2, pedidos para recoger.** El asistente contesta con el menú real y **toma pedidos para recoger en el local** por WhatsApp, Messenger e Instagram; el equipo los atiende en el tablero de **Pedidos**. Todavía **no** hay domicilio ni reservaciones: si el cliente pide a domicilio, el asistente lo dice y escala a una persona.

Las fases siguientes (domicilio, voz, plantillas «Taquería» y «Pizzería», reservaciones) están en el plan de la conversación de diseño; este archivo se va llenando conforme se construyan.

## Cómo se enciende para un negocio

El módulo se activa por negocio. Todavía no hay un giro «restaurante» en el registro (llega con las plantillas, fase 5), así que por ahora se enciende con una lista de módulos en el perfil del negocio:

```sql
UPDATE tenants
SET profile = jsonb_set(coalesce(profile, '{}'::jsonb), '{modules}', '["restaurante"]'::jsonb),
    updated_at = now()
WHERE id = '<id del negocio>';
```

Ojo: esa lista **reemplaza** a la del giro. Con `["restaurante"]` el negocio deja de tener el módulo de citas (se le oculta «Citas» y el agente pierde las herramientas de agenda). Para tener los dos: `["citas","restaurante"]`. Para apagarlo: quitar la clave `modules` del perfil.

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

Tablas del menú (migración `0026`), todas con aislamiento por negocio (RLS): `menu_categories`, `menu_items`, `menu_modifier_groups`, `menu_modifier_options` y `menu_item_groups`. Los precios van en centavos de peso mexicano; no hay otra moneda por ahora. Los nombres son únicos sin distinguir mayúsculas (categoría por negocio, platillo por categoría, grupo por negocio, opción por grupo).

Tablas de pedidos (migración `0027`, también con RLS): `restaurant_settings`, `orders`, `order_items` y `order_item_modifiers`, más la función `orders_to_notify` (SECURITY DEFINER, solo devuelve ids). El pedido guarda el nombre y el precio de cada platillo **al momento de pedir**, así que cambiar o borrar un platillo del menú no altera pedidos ya hechos. Unir dos contactos duplicados también mueve sus pedidos.

El código del menú vive en: `packages/db/src/schema/restaurant.ts` y `menu.ts` (lectura), `packages/inbox/src/menu.ts` y `csv.ts` (edición, importar y exportar), `packages/agent/src/restaurant.ts` (herramienta y prompt), `apps/web/src/components/menu-view.tsx` y `app/api/menu/` (panel). Pedidos: `packages/agent/src/orders.ts` y `restaurant.ts`, `packages/inbox/src/orders.ts`, `apps/worker/src/processors/orders.ts`, `apps/web/src/components/orders-view.tsx` y `app/api/orders/`.

## Pendiente

- Pedidos a domicilio (dirección, zonas, costo de envío): fase 3.
- Pedidos por llamada (voz): fase 4.
- Cobro en línea y ticket de cocina impreso: fuera de alcance por ahora.
- Orden manual de categorías y platillos (hoy van en el orden en que se crearon).
- Fotos de platillos.
- Importar directo de `.xlsx` (hoy: guardar como CSV).
- Que el prompt de voz conozca el módulo (ver `docs/MODULOS.md`).
