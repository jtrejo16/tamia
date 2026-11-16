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
| Dueño (`owner`) | Todo: atender, aprobar, citas, **configuración** (Ajustes) y **usuarios**. |
| Recepción (`agent`) | Atender conversaciones, aprobar borradores, manejar citas y usar el probador. Consulta la configuración pero no la cambia. |
| Solo lectura (`viewer`) | Ver. Las acciones están desactivadas y el servidor las rechaza. |

El rol **no viaja en la cookie**: se lee de la base de datos en cada petición. Cambiar el rol o dar de baja a alguien surte efecto en su siguiente clic.

## Usuarios (Ajustes → Usuarios, solo dueño)

- **Agregar** a alguien: se le crea la cuenta con una **contraseña temporal** (12 caracteres al azar) que se muestra **una sola vez** y que debe cambiar al entrar; hasta entonces el panel y la API le están bloqueados. Si el correo ya tiene cuenta en otro negocio, solo se le da acceso a este (su contraseña no se toca).
- **Cambiar rol**, **dar de baja** (pierde el acceso al instante) y **restablecer contraseña** (queda una temporal y se cierran sus sesiones).
- Siempre debe quedar **al menos un dueño**.
- Un dueño **no puede restablecer la contraseña de alguien que también pertenece a otro negocio** (sería tomar el control de su acceso al otro); esa persona la cambia ella misma.
- Todo queda en la bitácora; las contraseñas nunca.

**Mi cuenta** (para todos): cambiar la propia contraseña (pide la actual, mínimo 10 caracteres; cierra las demás sesiones y conserva la de este dispositivo), **cerrar sesión en todos los dispositivos** y **cambiar de negocio** si perteneces a varios.

**Recuperar una contraseña olvidada:** todavía no hay recuperación por correo (requiere un servicio de envío de correos). Si un usuario la olvida, el dueño la restablece desde Usuarios; si la olvida el único dueño, se restablece desde la terminal: `pnpm set-password -- --email correo@negocio.com`.

## Seguridad (lo que ya está y lo que falta)

Ya está:
- Contraseñas con scrypt (sal propia por usuario); responder "correo desconocido" tarda lo mismo que "contraseña incorrecta".
- Sesión en cookie firmada (HMAC-SHA256), `HttpOnly`, `SameSite=Lax`, `Secure` en producción, vence a las 12 h. La cookie solo dice quién es y trae una **versión de sesión**: subirla (cambio de contraseña, restablecimiento, «cerrar en todos los dispositivos») invalida todas las cookies anteriores. Cada petición se verifica contra la base de datos (no revocada, sigue en el negocio, negocio activo, rol vigente).
- Máximo 8 intentos de inicio de sesión por correo y 30 por IP cada 15 minutos.
- Las peticiones que modifican datos exigen cabecera `Origin` igual al servidor (anti-CSRF).
- Cada negocio solo ve lo suyo: la base de datos lo impone (RLS), no solo el código del panel.
- Quién actúa (usuario, negocio, rol) sale de la sesión, nunca de lo que mande el navegador.
- Cabeceras `X-Frame-Options`, `nosniff`, `Referrer-Policy` y `Cache-Control: no-store`.
- **Política de contenido (CSP) con nonce por petición** (`apps/web/src/middleware.ts`): solo corren los scripts propios de cada respuesta (`strict-dynamic`); un script inyectado no se ejecuta. Sin `unsafe-eval` en producción; además `frame-ancestors 'none'`, `object-src 'none'`, `form-action 'self'`.
- **HTTPS en producción**: `Strict-Transport-Security` (1 año) y `upgrade-insecure-requests` solo cuando `NODE_ENV=production`; la cookie de sesión es `Secure` en producción. En local (http) no se activan para no romper el desarrollo.
- `AUTH_SECRET` debe tener al menos 32 caracteres (si no, el panel se niega a iniciar sesión).
- Acciones sensibles (tomar control, cerrar, aprobar, cambiar citas) quedan en la bitácora.

Falta (pendiente consciente):
- Poner el panel detrás de un dominio con certificado HTTPS (la CSP y HSTS ya están listos; el certificado lo da el hosting).
- Recuperación de contraseña por correo (hoy la restablece el dueño).
- Actualización por WebSocket (hoy es consulta periódica, que se pausa con la pestaña oculta).
- Plantillas de WhatsApp: fuera de la ventana de 24 h no se puede escribir.

## Estructura

```
apps/web/src/app/api/…      rutas JSON (delgadas: validan sesión y llaman al dominio)
apps/web/src/components/…   pantallas
packages/inbox/             toda la lógica del panel (probada con la base de datos real)
packages/queue/             colas de BullMQ, límite de velocidad y latido del worker (compartidas con el worker)
```
