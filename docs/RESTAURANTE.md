# Restaurante (módulo `restaurante`)

Estado: **fase 1, el menú.** El asistente ya contesta con el menú real (platillos, precios, ingredientes y modificadores). Todavía **no** toma pedidos ni reservaciones: si el cliente quiere pedir, avisa que lo pasa con una persona del equipo y escala.

Las fases siguientes (pedidos, domicilio, voz, plantillas «Taquería» y «Pizzería», reservaciones) están en el plan de la conversación de diseño; este archivo se va llenando conforme se construyan.

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

Tablas nuevas (migración `0026`), todas con aislamiento por negocio (RLS): `menu_categories`, `menu_items`, `menu_modifier_groups`, `menu_modifier_options` y `menu_item_groups`. Los precios van en centavos de peso mexicano; no hay otra moneda por ahora. Los nombres son únicos sin distinguir mayúsculas (categoría por negocio, platillo por categoría, grupo por negocio, opción por grupo).

El código vive en: `packages/db/src/schema/restaurant.ts` y `menu.ts` (lectura), `packages/inbox/src/menu.ts` y `csv.ts` (edición, importar y exportar), `packages/agent/src/restaurant.ts` (herramienta y prompt), `apps/web/src/components/menu-view.tsx` y `app/api/menu/` (panel).

## Pendiente de esta fase

- Orden manual de categorías y platillos (hoy van en el orden en que se crearon).
- Fotos de platillos.
- Importar directo de `.xlsx` (hoy: guardar como CSV).
- Que el prompt de voz conozca el módulo (ver `docs/MODULOS.md`).
