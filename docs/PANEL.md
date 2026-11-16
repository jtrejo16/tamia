# Panel de atención

Aplicación web (Next.js) para que el dueño y la recepción vean las conversaciones, tomen el control, aprueben lo que propone el asistente y consulten las citas.

## Cómo abrirlo

```bash
pnpm infra:up          # base de datos y Redis (Docker)
pnpm web               # panel en http://localhost:3000 (solo accesible desde tu computadora)
pnpm wa:worker         # envía los mensajes a WhatsApp; sin él, lo que escribas queda en cola
```

Usuario de pruebas: `demo@sonrisa.test`. Su contraseña está en tu `.env` como `DEMO_OWNER_PASSWORD`
(para cambiarla: `pnpm set-password -- --email demo@sonrisa.test`, la pide oculta).

Datos de ejemplo para enseñarlo (3 conversaciones y 2 citas, con clientes ficticios): `pnpm demo-data`.
Es seguro repetirlo: borra y recrea solo sus propios contactos.

## Pantallas

| Pantalla | Para qué sirve |
|---|---|
| **Bandeja** | Lista de conversaciones en vivo (se actualiza sola cada pocos segundos) con filtros y búsqueda. Dentro: mensajes con su estado de entrega, reloj de la ventana de 24 h, **Tomar control / Atender yo**, **Devolver al asistente**, **Cerrar** y la caja para responder como persona. |
| **Aprobaciones** | Borradores del asistente (modo copiloto/semi). Se puede **aprobar**, **editar y enviar** o **descartar**. Al aprobar se ejecuta de verdad lo que el asistente proponía (por ejemplo, crear la cita). Si ya no se puede (el horario se ocupó), no se envía nada y el borrador sigue pendiente. El par borrador → versión editada queda guardado. |
| **Citas** | Próximos 30 días agrupados por día, con acciones Completada / No asistió / Cancelar. Cancelar aquí **no avisa** al cliente por WhatsApp. |
| **Probador** | Chat de prueba con el mismo asistente que WhatsApp (herramientas, memoria, nivel de autonomía), con un cliente ficticio y sin enviar nada afuera. Muestra qué herramientas usó, tokens y costo. |

El menú muestra insignias con lo que pide atención (conversaciones escaladas o con borrador pendiente) y un **aviso amarillo si el worker está detenido**, porque en ese caso los mensajes se quedan en cola.

## Roles

| Rol | Puede |
|---|---|
| Dueño (`owner`) y recepción (`agent`) | Todo lo anterior. |
| Solo lectura (`viewer`) | Ver. Las acciones están desactivadas y el servidor las rechaza. |

## Seguridad (lo que ya está y lo que falta)

Ya está:
- Contraseñas con scrypt (sal propia por usuario); responder "correo desconocido" tarda lo mismo que "contraseña incorrecta".
- Sesión en cookie firmada (HMAC-SHA256), `HttpOnly`, `SameSite=Lax`, `Secure` en producción, vence a las 12 h.
- Máximo 8 intentos de inicio de sesión por correo y 30 por IP cada 15 minutos.
- Las peticiones que modifican datos exigen cabecera `Origin` igual al servidor (anti-CSRF).
- Cada negocio solo ve lo suyo: la base de datos lo impone (RLS), no solo el código del panel.
- Quién actúa (usuario, negocio, rol) sale de la sesión, nunca de lo que mande el navegador.
- Cabeceras `X-Frame-Options`, `nosniff`, `Referrer-Policy` y `Cache-Control: no-store`.
- Acciones sensibles (tomar control, cerrar, aprobar, cambiar citas) quedan en la bitácora.

Falta (pendiente consciente):
- Política de contenido (CSP) y HTTPS: necesarios antes de exponerlo a internet.
- Alta de usuarios, recuperación de contraseña y cambio de negocio desde la interfaz.
- Cierre de sesión en todos los dispositivos (hoy la cookie solo vence por tiempo).
- Actualización por WebSocket (hoy es consulta periódica, que se pausa con la pestaña oculta).
- Plantillas de WhatsApp: fuera de la ventana de 24 h no se puede escribir.

## Estructura

```
apps/web/src/app/api/…      rutas JSON (delgadas: validan sesión y llaman al dominio)
apps/web/src/components/…   pantallas
packages/inbox/             toda la lógica del panel (probada con la base de datos real)
packages/queue/             colas de BullMQ, límite de velocidad y latido del worker (compartidas con el worker)
```
