# Módulos por giro

Jovia tiene un **núcleo** que todos los negocios usan y **módulos** que se encienden según el giro.

- **Núcleo (siempre está):** conversaciones, clientes, canales (WhatsApp, Messenger, Instagram, voz), avisos al equipo, estadísticas, base de conocimiento, y las herramientas del agente para horario, datos del cliente, ubicación y escalar a una persona.
- **Módulo `citas`:** servicios, especialistas, agenda, recordatorios y las herramientas `consultar_servicios`, `buscar_disponibilidad`, `crear_cita`, `buscar_citas_del_contacto`, `reprogramar_cita` y `cancelar_cita`. Lo tienen todos los giros actuales.
- **Módulo `restaurante`:** menú (la herramienta `consultar_menu`, la pantalla Menú y sus tablas). Pedidos y reservaciones por aforo vienen después. Ver `docs/RESTAURANTE.md`.

## Qué módulos tiene un negocio

`modulesFor(vertical, profile.modules)` en `packages/shared/src/modules.ts`:

1. Si `tenants.profile.modules` es una lista, esa lista manda (sirve para encender un módulo a un negocio concreto).
2. Si no, los de su giro en `VERTICAL_MODULES`.
3. Si el giro no aparece ahí (o es desconocido), `DEFAULT_MODULES = ["citas"]`. **Por eso los negocios que ya existen no cambiaron.**

Los nombres desconocidos se ignoran.

## Qué aporta un módulo

| Pieza | Dónde se registra | Efecto |
|---|---|---|
| Herramientas del agente | `registerModuleTools(modulo, [defineModuleTool({...})])` en `packages/agent/src/modules.ts` | El modelo solo las ve, y solo se pueden ejecutar, en negocios con ese módulo. |
| Secciones del prompt | `registerModulePrompt(modulo, { tasks, truthRules, flow, escalation, context })` | Se insertan en el prompt maestro. Las reglas de verdad se numeran a continuación de las del núcleo. Las secciones pueden usar las `{{variables}}` del prompt. |
| Pantallas del panel | `MODULE_NAV` en `apps/web/src/components/panel-shell.tsx` | Se agregan al menú después de «Aprobaciones». |
| Tablas | Migración aditiva con RLS | Propias del módulo. |

Las herramientas que cambian datos (`mutating: true`) pasan por la misma política de aprobación y por la **confirmación obligatoria** que ya usan las citas (el agente propone y el cliente confirma en el siguiente mensaje).

## Reglas para agregar un módulo

1. Agrega el id a `MODULE_IDS` (y, cuando un giro lo use, a `VERTICAL_MODULES`).
2. Registra herramientas y prompt en un archivo del módulo, importado una sola vez al arrancar.
3. Una herramienta que no es de ningún módulo es del núcleo: no la marques con módulo.
4. Todo nuevo debe dejar intacto el prompt y las herramientas de los negocios de citas: el prompt completo de un negocio de citas está protegido por una fotografía (`packages/agent/tests/golden/`, prueba `prompt-golden`). Si cambias ese prompt A PROPÓSITO, borra los archivos de esa carpeta y vuelve a correr la prueba para regenerarlos.

## Pendiente

- La voz (`voice-prompt.ts`) todavía tiene el flujo de agendar escrito dentro y una lista fija de herramientas (`voiceToolNames`). Se abre cuando el módulo de restaurante llegue a la voz.
- `pack.ts` conserva campos de citas (`requiredAppointmentData`, `roleLabel`, `reminder`); un giro sin citas los ignora.
