# Canales: WhatsApp, Messenger e Instagram

Un negocio puede atender por los tres canales a la vez. Todos comparten la bandeja, el asistente, las aprobaciones y las citas; cada conversación muestra por qué red escribe el cliente.

## Cómo llegan los mensajes

Los tres usan **la misma aplicación de Meta, el mismo webhook y la misma firma** (`/webhooks/whatsapp`, X-Hub-Signature-256). El campo `object` del aviso dice de qué red es (`whatsapp_business_account`, `page`, `instagram`); la página o cuenta que lo recibió identifica al negocio.

En el panel de tu app de Meta, en **Webhooks**, configura la **misma URL y el mismo token de verificación** para los productos *Page* (campos `messages`, `messaging_postbacks`) e *Instagram* (campo `messages`).

## Cómo se conectan los negocios

**WhatsApp:** pegando identificador de número, de cuenta y clave permanente (Ajustes → WhatsApp). Ver `BILLING.md`.

**Messenger e Instagram:** *Ajustes → Messenger e Instagram → Continuar con Facebook* (solo dueño):
1. El dueño inicia sesión con Facebook y acepta los permisos.
2. Elegimos su página y, si la tiene vinculada, su cuenta profesional de Instagram.
3. Se suscribe la página a nuestro webhook y se guarda el **token de la página, cifrado**. Nunca se pide ni se muestra una contraseña ni un token.

Seguridad del flujo: el `state` va firmado y ligado al usuario y negocio (anti-CSRF, caduca en 10 min); el secreto de la app viaja solo en el cuerpo de la petición a Meta; las páginas con sus tokens esperan la elección en una cookie **cifrada** de 10 minutos que el navegador no puede leer; una página no puede estar conectada en dos negocios.

### Variables (.env)
| Variable | Para qué |
|---|---|
| `META_APP_ID` | Identificador de la app (para el inicio de sesión con Facebook). |
| `META_APP_SECRET` | Ya existente: firma del webhook y canje del código. |
| `PUBLIC_BASE_URL` | Dirección pública del panel. |

En la app de Meta agrega, en **Inicio de sesión con Facebook → URI de redireccionamiento OAuth válidos**: `https://TU-DOMINIO/api/channel/facebook/callback`.

## Cómo se comporta el asistente

- **Cliente sin teléfono:** en Messenger e Instagram el cliente se identifica por un id propio de la red. El asistente **pide su número de WhatsApp antes de agendar** (los recordatorios de cita salen por WhatsApp). Si ese número ya es de otro cliente **no se fusionan** historiales: se escala a una persona.
- **Formato:** sin marcas de WhatsApp (`*negrita*`); textos largos se parten (Messenger 2000 caracteres, Instagram 1000).
- **Ventana:** 24 horas desde el último mensaje del cliente, igual que WhatsApp. No hay plantillas fuera de WhatsApp.
- **Ubicación:** se envía como texto con el enlace del mapa.

## Límites actuales (honestos)

- **Revisión de la app de Meta:** con la app en modo desarrollo solo funciona con páginas y cuentas de personas con rol en la app (tú y tus probadores). Para clientes reales hay que pasar la **revisión** de los permisos `pages_messaging`, `pages_manage_metadata` e `instagram_manage_messages` (y verificar el negocio). Es un trámite de Meta que tarda días.
- No se envían ni se leen **estados de entrega/lectura** de Messenger e Instagram: el mensaje queda "enviado".
- El cliente puede mandar imágenes, audios y archivos, pero el asistente **no los procesa** todavía (se guardan con su enlace); los adjuntos no soportados (historias, reels) llegan como aviso de texto.
- No existe la etiqueta de agente humano (extender la ventana a 7 días): requiere permiso adicional de Meta.
- No probado con Meta real: la conexión y el envío se verificaron con un Meta simulado en pruebas automáticas.

## Dónde recibe los mensajes (webhook)

El panel ya recibe los avisos de Meta en **`/api/webhooks/whatsapp`** (WhatsApp, Messenger e Instagram). Una sola dirección pública sirve para todo: en la app de Meta, para los productos **WhatsApp**, **Messenger** (*Page*) e **Instagram**, usa la URL `https://TU-DOMINIO/api/webhooks/whatsapp` y el mismo token de verificación (`WHATSAPP_VERIFY_TOKEN`).

La ruta solo valida la firma, identifica al negocio y **encola**; la IA y el envío los hace el worker (`pnpm wa:worker`), que debe estar corriendo. El servidor de webhook propio del worker (`/webhooks/whatsapp`, puerto 3001) sigue existiendo para pruebas locales, pero ya no hace falta exponerlo.
