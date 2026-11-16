# Alta de negocios y cobro de suscripciones

## Flujo

1. **Registro público** (`/registro`): el negocio se da de alta solo (clínica, zona horaria, dueño, contraseña). Queda en estado **pendiente** con **14 días de prueba gratis**, sin tarjeta, y entra directo al panel para configurarse.
2. **Aprobación**: el operador de la plataforma lo aprueba en `/operador`. Mientras esté pendiente el asistente **no responde** ni manda recordatorios (los mensajes de clientes sí se guardan y se ven en la bandeja).
3. **Elegir plan** (`/facturacion`, solo dueño): Mercado Pago crea la suscripción y el cliente captura su tarjeta en la página de Mercado Pago (nosotros nunca vemos la tarjeta). Si elige durante la prueba, el primer cobro es al terminarla.
4. **Avisos** (`POST /api/billing/webhook`): Mercado Pago avisa de altas, cobros, pausas y cancelaciones. Se acepta solo con firma HMAC válida y **el estado real se consulta a la API de Mercado Pago**, no se confía en el aviso.

## Cuándo responde el asistente

Regla única (`accessFor`, en `packages/shared/src/plans.ts`), usada por el worker y por el panel: el negocio debe estar **aprobado** y con suscripción **vigente** (prueba en curso, activa, cortesía, o un cobro retrasado dentro de **3 días de gracia**). Cancelada, prueba vencida sin tarjeta o pago vencido => se detiene y el panel muestra un aviso con el motivo.

## Seguridad

- La tabla `subscriptions` **solo se lee** desde la app; se modifica únicamente con funciones de base de datos (alta, cobro, operador). Ningún dueño puede darse un plan o una cortesía.
- El permiso de **operador** lo decide la base de datos (`users.is_operator`) con la sesión del usuario, no una variable ni la cookie. Se asigna desde terminal: `pnpm db:operator -- --email correo@tuempresa.com` (`--off` para quitarlo).
- Registrarse con el correo de alguien que ya tiene cuenta se rechaza sin tocar su cuenta. Máximo 5 registros por IP por hora.
- La firma del webhook rechaza avisos alterados, de otro secreto o con más de 10 minutos de antigüedad.

## Configuración (`.env`)

| Variable | Para qué |
|---|---|
| `MERCADOPAGO_ACCESS_TOKEN` | Crear/consultar/cancelar suscripciones. Empieza con el de **prueba**. |
| `MERCADOPAGO_WEBHOOK_SECRET` | Clave secreta del webhook (verifica la firma). |
| `PUBLIC_BASE_URL` | Dirección pública del panel, sin ruta. Mercado Pago regresa al cliente a `/facturacion`. |

Webhook en Mercado Pago: `https://TU-DOMINIO/api/billing/webhook`, eventos *Planes y suscripciones* y *Pagos de suscripciones*.

Planes y precios: `packages/shared/src/plans.ts` (un solo lugar). Los precios actuales son un punto de partida.

## Pendiente

- Los planes se muestran con sus características, pero **no hay topes de uso** (conversaciones al mes) por plan ni se cambia el modelo de IA según el plan.
- Conectar el WhatsApp del negocio sigue siendo por terminal (`pnpm wa:connect`/ `connect-channel`): hace falta una pantalla en el panel o el registro integrado de Meta.
- Sin facturas/CFDI ni correo de bienvenida/aviso de cobro (requiere un servicio de correo).
- No se ha probado un checkout real contra Mercado Pago: solo con Mercado Pago simulado en pruebas automáticas.
