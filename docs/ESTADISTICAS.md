# Estadísticas

Página **Estadísticas** del panel (`/estadisticas`): cada negocio ve **solo sus propios números**, por periodo de 7, 30 o 90 días (los días se cuentan en la zona horaria del negocio) y con comparación contra el periodo anterior de igual duración. Se actualiza sola cada minuto.

No hay tablas nuevas: todo se calcula con consultas sobre los datos que ya existen (`packages/inbox/src/stats.ts`, API `GET /api/stats?days=`), bajo el aislamiento por negocio de la base de datos.

## Qué se mide

| Sección | Qué muestra |
|---|---|
| Cifras clave | Mensajes de clientes, respuestas del asistente, respuestas de personas, conversaciones activas, citas agendadas, escalaciones (cada una vs. el periodo anterior) |
| Mensajes | Por día (apilado cliente / asistente / persona), por hora y por día de la semana, por canal, entregados / leídos / fallidos, plantillas |
| Velocidad de respuesta | Tiempo típico (mediana) y casos lentos (percentil 90) hasta la primera respuesta; clientes sin respuesta |
| Resolución | % de conversaciones resueltas solo por el asistente, % escaladas, urgentes, pendientes, tiempo típico para resolver una escalación |
| Borradores | Aprobados tal cual / editados / descartados / pendientes (modo copiloto y semi) |
| Citas | Agendadas por el asistente vs. por el equipo, resultado (realizadas, confirmadas, no asistieron, canceladas), tasa de cancelación y de no asistencia, próximos 7 días sin confirmar, anticipación típica, ingreso estimado, servicios top, días y horas con más citas |
| Seguimiento | Recordatorios 24 h / 2 h enviados, % de citas con recordatorio, % que confirmó tras el recordatorio, no asistencia con vs. sin recordatorio, clientes que regresan |
| Clientes | Total, nuevos, aceptan promociones, pidieron no recibir mensajes |
| Llamadas | Total, duración típica, minutos, transferidas, sentimiento |
| Equipo | Escalaciones que tomó cada persona |
| Costo de IA | Solo el dueño: costo, tokens, costo por conversación, desglose |

## Definiciones (para no malinterpretar)
- **Mensajes**: solo chats (WhatsApp, Messenger, Instagram). Las llamadas se miden aparte, por llamada.
- **Resuelta por el asistente**: conversación activa en el periodo, con al menos una respuesta del asistente, **sin** mensajes de personas y **sin** escalación.
- **Primera respuesta**: para cada racha de mensajes del cliente, el tiempo hasta el siguiente mensaje nuestro (se ignoran esperas de más de 24 h). "Sin respuesta" cuenta rachas a las que nadie contestó (pasados 15 minutos).
- **Tasa de seguimiento**: se midió como *cobertura de recordatorios* (citas con al menos un recordatorio), *confirmación tras el recordatorio* y *clientes que regresan* (2 o más citas confirmadas o realizadas). Si se necesita otra definición (por ejemplo, reactivación de clientes que dejaron de escribir), se agrega.
- **Ingreso estimado**: precio de lista de los servicios de las citas confirmadas o realizadas con fecha en el periodo. **No es facturación ni cobro real.**
- **Citas por resultado**: por la fecha de la cita (no por cuándo se agendó).

## Límites actuales
- Las llamadas transferidas se cuentan por el motivo de desconexión que reporta Retell.
- El conteo de lectura depende de que el cliente tenga activados los acuses de lectura en WhatsApp.
- Las cifras de personas por separado (respuestas por usuario del panel) aún no existen: los mensajes de personas no guardan quién los envió; hoy solo se desglosan las escalaciones tomadas.
- Sin exportar a Excel/CSV todavía.
