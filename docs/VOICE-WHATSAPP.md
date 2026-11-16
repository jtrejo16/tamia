# Investigación: llamadas por WhatsApp conectadas al asistente de voz

Objetivo: que los clientes llamen con el botón de llamada de WhatsApp al **mismo número** del negocio y los conteste el agente de Retell. (Investigación de documentación pública; **nada de esto se ha probado todavía**. Varias fuentes son de terceros: confirmar contra Meta antes de construir.)

## Qué ofrece Meta
- La **API de llamadas** de WhatsApp Business permite llamadas del cliente al negocio dentro de WhatsApp (internet, no telefonía). Las llamadas **iniciadas por el usuario son gratuitas** para el negocio; las iniciadas por el negocio se cobran y piden permiso previo (y, según fuentes, un límite de mensajería alto).
- Disponible en los países donde existe la Cloud API; fuentes de terceros listan **México**.
- Dos formas de manejar la llamada: **webhooks + Graph API** (WebRTC, tú manejas SDP) o **SIP** (Meta marca a un servidor SIP que tú indicas en los ajustes del número). Con SIP activo **se desactivan** los webhooks y endpoints de llamadas de la Graph API.
- SIP de Meta exige **TLS** y medios **SRTP**; el códec principal es **Opus** (una fuente de terceros menciona también PCMU/PCMA: sin confirmar).

## Qué acepta Retell
- Entrada por **SIP** (`sip.retellai.com`, TCP/UDP/TLS) con números importados.
- Códecs: **PCMU, PCMA y G.722**. **No hay evidencia de Opus** (un hilo de la comunidad de Retell lo plantea sin respuesta oficial).

## El choque
Meta ofrece Opus; Retell no lo acepta. Si Meta ofreciera también PCMU/PCMA, podría conectarse directo. Si no, hace falta algo en medio que transcodifique.

## Caminos
| Camino | Qué es | Riesgo |
|---|---|---|
| A. SIP directo Meta → Retell | Se apunta el SIP de Meta a `sip.retellai.com` y se importa el número en Retell | Funciona solo si coinciden códec y SRTP. **Se puede probar en una tarde** y es reversible |
| B. Proveedor intermedio (Telnyx, Twilio…) | El proveedor recibe la llamada de WhatsApp y la reenvía a Retell por SIP | El número de WhatsApp tendría que gestionarse por ese proveedor (Telnyx tiene opción de "traer tu número"); transcodificación sin confirmar; otra cuenta y costos |
| C. Puente propio | Recibir WebRTC de Meta y conectarlo a Retell (servidor de medios) | Mucho trabajo y operar un servidor de medios en tiempo real |
| D. Servicio de terceros | Pasarelas que ya enrutan llamadas de WhatsApp a agentes de voz | Otro proveedor y costo por minuto |

## Prueba propuesta (camino A)
1. En Retell, importar el número de WhatsApp como número de telefonía propia y asignarle el agente.
2. En Meta, activar las llamadas del número y la señalización SIP apuntando a Retell (con TLS/SRTP).
3. Llamar desde la app de WhatsApp. **Éxito** = contesta el agente. **Fallo típico** = rechazo por códec o SRTP → pasar a B.
Reversible: se desactiva SIP/llamadas en los ajustes del número. Mientras SIP está activo, los clientes verán el botón de llamar y esas llamadas irán a Retell.

## Antes de producción
- Horario de llamadas y días festivos en los ajustes de Meta; los clientes pueden restringir el número con retroalimentación negativa.
- Transferencia a una persona: no se sabe si funciona desde una llamada de WhatsApp.
- Costos de Retell por minuto siguen aplicando.
