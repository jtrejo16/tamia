# Google Calendar

Cada negocio conecta **su** Google Calendar desde **Ajustes → Calendario**. Desde ese momento, las citas **confirmadas** aparecen como eventos en su calendario principal (y en su celular). Si una cita se cambia de hora o se cancela, el evento se mueve o se borra solo.

> Estado: probado con un Google simulado (10 pruebas: conectar, cifrado, crear / mover / borrar, evento borrado a mano, permiso revocado, aislamiento entre negocios). **No se ha probado todavía contra Google real.**

## Cómo funciona
- **Un sentido:** el sistema manda, Google solo muestra. Lo que el doctor escriba a mano en su calendario **no** bloquea horarios (eso sería una segunda etapa).
- **Qué se sincroniza:** citas *confirmadas* (no las pendientes de aprobación). Las ya terminadas hace más de un día no se tocan.
- **Cómo se sincroniza:** el worker revisa cada minuto qué citas cambiaron desde la última vez (cubre todas las vías: asistente de WhatsApp, panel, llamadas). Cada cita guarda el id de su evento (`appointments.calendar_event_id`) y la fecha de sincronización.
- **Permiso pedido a Google:** `calendar.events` (crear y editar eventos) y el correo de la cuenta. No se leen los demás eventos.
- **Seguridad:** el permiso permanente (refresh token) se guarda **cifrado** (AES-256-GCM, ligado al negocio) con `ENCRYPTION_KEY`, igual que los tokens de WhatsApp. Solo el dueño puede conectar o desconectar. El flujo OAuth usa un `state` firmado, ligado a la persona y al negocio.
- **Si Google revoca el permiso:** la conexión pasa a "Requiere reconectar" y se deja de intentar hasta que el dueño la reconecte.
- **Si borran un evento a mano en Google:** la próxima vez que la cita cambie, se vuelve a crear.
- **Desconectar:** revoca el permiso en Google; los eventos ya creados se quedan en el calendario.

## Configuración (una sola vez, la haces tú)
1. En <https://console.cloud.google.com> crea un proyecto y activa la **Google Calendar API**.
2. **Pantalla de consentimiento de OAuth**: tipo *Externo*, nombre de la app (por ejemplo Tamia), correo de soporte, dominio `jovia.mx`. Agrega el permiso `.../auth/calendar.events`.
3. **Credenciales → Crear credenciales → ID de cliente de OAuth → Aplicación web**. En **URI de redireccionamiento autorizados** agrega:
   `https://www.jovia.mx/api/calendar/google/callback`
   (en local: `http://localhost:3000/api/calendar/google/callback`).
4. Copia el **ID de cliente** y el **Secreto** y ponlos en las variables de **`web` y `worker`**:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
5. Redespliega `web` y `worker`. En Ajustes aparece la pestaña **Calendario** con el botón "Conectar con Google".

## Límite importante: verificación de Google
Mientras la app esté en modo **Pruebas**, solo la pueden usar los correos que agregues como *usuarios de prueba* (máximo 100) y los permisos caducan a los 7 días. Para clientes reales hay que **publicar** la app y pasar la **verificación de Google** (el permiso de calendario es "sensible": piden política de privacidad, dominio verificado y un video de demostración). Para empezar con pocos consultorios sirve el modo Pruebas, sabiendo que cada 7 días tendrán que reconectar.

## Pendiente
- Segunda etapa: leer lo que el doctor bloquea en Google para no ofrecer esos horarios.
- Un calendario por doctor (hoy es uno por negocio: el calendario principal de la cuenta conectada).
- Recordatorios y asistentes en el evento (hoy solo se crea el evento).
