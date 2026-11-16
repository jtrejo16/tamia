# Asistente telefónico (voz)

El asistente atiende llamadas con **Retell AI** (voz, telefonía) y usa **nuestro sistema como cerebro**: las mismas herramientas que en WhatsApp (servicios, horarios, disponibilidad, citas, escalar a una persona) y las mismas reglas, incluida la confirmación obligatoria antes de agendar.

```
cliente ── llama ──► Retell (voz) ──► funciones ──► /api/voice/tools   (negocio, agenda)
                          └─ avisos ─► /api/voice/webhook              (historial de llamadas)
```

## Qué se ve en el panel
- **Llamadas:** historial con resumen, duración, sentimiento y enlace a la conversación.
- **Bandeja:** cada llamada es una conversación con la etiqueta **Llamada**; la transcripción aparece como mensajes. Una llamada **no se responde por texto**; si el cliente tiene WhatsApp, se le escribe en esa conversación.
- Una escalada por teléfono aparece como cualquier escalada (con urgencia).

## Configurar (Ajustes → Llamadas, solo dueño)
1. Pon `RETELL_API_KEY` en el `.env` y reinicia el panel.
2. Activa el asistente, elige una **voz** de Retell (pega su identificador) y decide si puede **agendar por teléfono**.
3. **Guardar y sincronizar con Retell:** crea (o actualiza) el agente del negocio con su prompt y sus funciones. Vuelve a sincronizar cada vez que cambies servicios, horarios o estos ajustes.
4. **Probar sin número:** en Retell abre ese agente y usa la **llamada web de prueba** (micrófono del navegador).
5. **Recibir llamadas reales:** enlaza un número telefónico al agente en Retell. Puede ser de Retell, de Twilio u otro proveedor (SIP). El panel no necesita saber el número: identifica al negocio por el agente.

`PUBLIC_BASE_URL` debe ser una dirección pública con HTTPS (en pruebas, el túnel): Retell llama a `…/api/voice/tools` y `…/api/voice/webhook`.

## Reglas de seguridad
- Los dos endpoints exigen la **firma de Retell** (con tu clave de API) y rechazan avisos de más de 5 minutos.
- El negocio sale del **id del agente**, nunca de lo que mande la petición; solo negocios aprobados, con voz activada y suscripción vigente.
- Solo se ejecutan funciones de una llamada **en curso**.
- **Confirmación obligatoria impuesta por código:** al proponer una cita no se escribe nada; para ejecutarla el cliente debe haber hablado de nuevo (se cuenta con la transcripción) y los datos deben ser los mismos. Sin transcripción, deben pasar unos segundos.
- Un cliente nuevo debe dar su **nombre completo** antes de agendar.
- Por teléfono el asistente **no agenda por defecto** (toma datos y escala a una persona). Al activar "agendar por teléfono", agenda directo tras la confirmación verbal, **sin pasar por Aprobaciones**.
- El teléfono de quien llama se une al contacto existente aunque esté guardado con o sin el «1» del 52; número oculto = un contacto por llamada.

## Transferir a una persona en vivo
En Ajustes → Llamadas, el dueño puede guardar el **número de recepción** (formato internacional). Entonces el agente recibe dos herramientas: `puede_transferir` (consulta nuestro sistema: ¿hay alguien dentro del **horario de atención humana** del negocio?) y `transferir_a_persona` (transferencia **asistida** de Retell: quien contesta oye un aviso antes de conectar al cliente). El prompt exige consultar `puede_transferir` primero; si dice que no (fuera de horario), el agente **no transfiere**: explica cuándo atienden y deja el recado como escalada.
- Funciona solo en **llamadas telefónicas**, no en la llamada web de prueba: hace falta un número.
- Sin horario configurado, se considera siempre disponible.
- Retell ejecuta la transferencia; no podemos impedirla por código fuera de horario, solo mediante el prompt y la consulta previa.

## Número de teléfono (opciones)
- **Número de Retell** (EE. UU./Canadá): inmediato, sin Twilio. Bueno para probar llamadas y transferencia; quien llame desde México marca a un número extranjero.
- **Número mexicano** con un proveedor (Twilio, Telnyx u otro) conectado a Retell por **SIP**. Cualquier número mexicano exige trámite regulatorio (identificación, comprobante de domicilio; para empresas RFC y Constancia de Situación Fiscal) y puede tardar días.
- **Llamadas dentro de WhatsApp** (API de llamadas de Meta): las llamadas de usuario a negocio son gratuitas y hay disponibilidad en México según fuentes de terceros, y sería el **mismo número de WhatsApp**. Pero conectarlo a Retell **no es directo**: Meta usa el códec Opus, que Retell podría no aceptar por SIP, y haría falta un puente. No está construido.
- Tu número actual puede **desviarse** desde el operador hacia el número nuevo (al final).

## Límites actuales (honestos)
- **No probado con Retell real.** Se verificó con un Retell simulado. Los nombres de campos de la API de Retell (crear modelo y agente, formato de la firma, contenido de las funciones) se escribieron con su documentación pública y **la primera sincronización puede requerir ajustes**.
- Solo **llamadas entrantes**. Salientes (recordatorios, seguimiento) no están construidas; requieren reglas de consentimiento y horario.
- La transferencia en vivo no se ha probado con una llamada real (requiere número); la forma de la herramienta fue aceptada por la API de Retell.
- No se guarda la grabación de audio.
- Costos: Retell y la línea cobran por minuto; revisa sus tarifas.
- La IA de las llamadas la pone Retell (su modelo), no la de OpenRouter.
