# Avisos al equipo y reseñas después de la cita

Dos funciones que el **dueño** enciende en **Ajustes** (pestañas **Avisos** y **Reseñas**). Las dos mandan mensajes de WhatsApp con **plantillas aprobadas por Meta**: al guardar, el sistema las envía a Meta; hasta que se aprueben, esos mensajes no salen.

## Avisos: «alguien pide hablar con una persona»
- **Cuándo se avisa:** cuando el cliente pide hablar con una persona, o el asistente detecta una **urgencia** o una **queja**. (No avisa por fallas técnicas ni por dudas que el asistente no sabe responder: esas se ven en el panel.) Cada escalación se avisa **una sola vez**.
- **A quién:** hasta 3 destinatarios por negocio, cada uno un **WhatsApp** (se normaliza a +52…) o un **correo**, con su interruptor.
- **Horario:** el negocio elige «solo en horario de atención» (usa Ajustes → Horarios; lo pendiente sale cuando abren) o «a cualquier hora».
- **Qué dice:** negocio, cliente, canal, motivo y un enlace a la conversación en el panel.
- **WhatsApp:** sale del número del negocio hacia el del equipo con la plantilla `aviso_atencion_humana` (categoría Utilidad). **Cada aviso cuenta como una plantilla de Meta** (lo cobra Meta al negocio). **Correo:** gratis.
- **Llamadas:** la transferencia en vivo ya existía (Ajustes → Llamadas → número de recepción, solo en horario). Si piden persona y no hay nadie, el recado también dispara el aviso.
- **Reintentos:** si el envío falla, reintenta (máximo 5 intentos); si falta la plantilla aprobada o el correo no está configurado, espera sin gastar intentos (hasta 2 días).

## Reseñas después de la cita
- **Configuración:** interruptor, **horas después de la cita** (1 a 48, por defecto 3), sitio (Google, Facebook u otro) y el **enlace** donde dejar la reseña (se valida que sea https y del sitio elegido). Para Google: Perfil de Negocio de Google → «Pedir reseñas» → copiar enlace.
- **Mensaje:** plantilla fija `solicitud_resena` (agradece la visita y pide una reseña). El negocio solo cambia nombre, negocio y enlace: Meta aprueba cada texto.
- **A quién:** a **todos los clientes con teléfono**, sin importar por qué medio agendaron (WhatsApp, Messenger, Instagram, llamada o panel).
- **Reglas:** una vez por cita; **una vez cada 90 días por cliente**; no a citas canceladas ni «No asistió», ni a quien pidió no recibir mensajes; solo citas que terminen **después** de encender la función.
- **Sin filtrar por satisfacción y sin ofrecer nada a cambio:** Google no lo permite. Se pide a todos por igual.
- **Costo:** cada solicitud es una plantilla de Meta (la cobra Meta al negocio; Meta puede clasificarla como «Marketing», más cara).

## Teléfono para agendar
Para que lleguen los recordatorios y las reseñas hace falta el teléfono del cliente. El asistente **no agenda sin él**: por Messenger o Instagram lo pide (a 10 dígitos) y lo guarda antes de crear la cita; por WhatsApp o llamada ya viene del canal (si la llamada llega con número oculto, también lo pide).

## Variables de entorno
| Variable | Dónde | Para qué |
|---|---|---|
| `BREVO_API_KEY` | web **y** worker | Clave de la API de Brevo (correos) |
| `EMAIL_FROM` | web **y** worker | Remitente verificado en Brevo, p. ej. `avisos@jovia.mx` |
| `EMAIL_FROM_NAME` | worker (opcional) | Nombre del remitente (por defecto «Tamia») |
| `PUBLIC_BASE_URL` | **worker** y web | Dirección del panel para el enlace de los avisos (`https://www.jovia.mx`) |

Para el correo: crear cuenta en Brevo, verificar el dominio `jovia.mx` (registros DNS en Hostinger) y poner la clave. Sin eso, los avisos por correo se omiten y los de WhatsApp siguen funcionando.
