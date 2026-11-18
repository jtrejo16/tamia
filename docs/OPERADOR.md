# Consola del operador

Pantalla `/operador` (solo para usuarios marcados como operador de la plataforma). Permiso: lo decide **la base de datos** (`users.is_operator`) en cada petición, no la pantalla ni una cookie. Los demás usuarios regresan a la bandeja.

## Lista de clientes (`/operador`)
- **Estado de la plataforma:** si el servicio de envíos (worker) está vivo, si la IA es de pago o gratuita, y qué claves tiene el servidor (Mercado Pago, Meta, Retell, Google, OpenRouter). Nunca muestra los valores.
- **Cifras:** clientes, por aprobar, pagando, **ingreso mensual** (suma del precio de lista de los que pagan), lo que **renueva en 7 días**, en prueba (y cuántas terminan en ≤3 días), **vencidos**, con problemas, sin canal conectado y escalaciones abiertas.
- **Filtros** (con contador) y búsqueda por nombre o correo: por aprobar, con problemas, vencidos, por vencer, pagando, en prueba, sin canal, cortesía/cancelados.
- Por cliente: estado de cobro con fecha y días, **semáforo de salud**, chips de **WhatsApp / Messenger / Instagram** (verde = conectado, rojo = error, gris = desconectado), mensajes de 7 días y último mensaje.

## Estado de cobro (cómo se decide)
Usa la misma regla que el worker (`accessFor`):

| Estado | Significa |
|---|---|
| Por aprobar | Negocio nuevo esperando tu aprobación |
| En prueba / Prueba por terminar | Prueba gratis vigente / termina en ≤3 días |
| Pagando / Por vencer | Suscripción al corriente / el próximo cobro es en ≤7 días |
| Vencido | Sin pago vigente (prueba terminada sin pagar, o pago atrasado más allá de los 3 días de gracia) |
| Canceló | Canceló la renovación; conserva el acceso hasta el fin de lo pagado |
| Cortesía · Pausado · Sin suscripción | — |

> Mercado Pago no guarda aquí un historial de pagos: "pagando" se deduce del estado de la suscripción y su próximo cobro (confirmado con Mercado Pago por la conciliación periódica y los avisos).

## Salud de un cliente (qué se detecta)
Sin canal conectado · canal en error o desconectado · calidad del número en amarillo/rojo (Meta) · mensajes fallidos en 24 h · sin mensajes en 7 días · último mensaje del cliente sin respuesta (>30 min) · escalaciones pendientes · borradores esperando aprobación · Google Calendar por reconectar · llamadas activas pero sin sincronizar · plantillas rechazadas por Meta.
Esto sale de datos que ya tenemos; para preguntar **en vivo a Meta** usa "Comprobar conexiones ahora" en el detalle del cliente.

## Detalle de un cliente (`/operador/<cliente>`)
Salud, cobro (con **extender la prueba** 3/7/14/30 días), aprobar / pausar / cortesía, y las **conexiones**, donde puedes dar soporte:

- **WhatsApp:** ver número, calidad y estado; **conectar o reconectar** con *Phone number ID*, *WABA ID* y clave de acceso (se verifica con Meta antes de guardar; la clave se guarda **cifrada** y no vuelve a mostrarse); desconectar.
- **Messenger / Instagram:** **Conectar con Facebook** inicia sesión con **tu** cuenta de Facebook y eliges la página del cliente. Funciona solo si tu cuenta administra esa página: pídele al cliente que te agregue en Meta (Business Manager → Páginas → Agregar personas). No hace falta su contraseña. También puedes desconectar.
- **Comprobar conexiones ahora:** pregunta a Meta con la clave guardada si la clave sigue válida y la página sigue suscrita a los mensajes.
- **Llamadas:** estado y **sincronizar con Retell**. **Plantillas:** estado y sincronizar con Meta. **Google Calendar:** estado.
- Además: equipo con acceso, mensajes fallidos recientes con su motivo, **bitácora** (quién hizo qué) y las **estadísticas completas** del cliente.

## Cómo funciona el soporte (y su seguridad)
- Actúas **como dueño de ese negocio con tu propio usuario** (no como su persona): las funciones normales (conectar canal, sincronizar...) se ejecutan con tu id.
- **Todo queda en la bitácora del cliente** con tu usuario (`operator.support.*`). Nunca se guardan claves en la bitácora.
- Un dueño de negocio **no** puede usar estas rutas para entrar a otro negocio (la base lo rechaza). Hay pruebas para eso.
- **Facebook:** el inicio de sesión usa el mismo URI de redireccionamiento OAuth que el flujo normal (`/api/channel/facebook/callback`), con un `state` firmado y ligado a ti y al cliente; las páginas esperan tu elección en una cookie cifrada de 10 minutos.

## Fuera de alcance por ahora
- No hay "entrar como el cliente" ni restablecer contraseñas desde aquí.
- No se registra un historial de pagos individuales ni facturas (CFDI).
- Alertas automáticas (correo/WhatsApp cuando un cliente falla o vence): solo se ven al abrir la pantalla.
- Exportar a Excel.
