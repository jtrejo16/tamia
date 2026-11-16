# WhatsApp: cómo funciona y cómo conectarlo

## Cómo viaja un mensaje

```
Cliente ──► Meta ──► POST /webhooks/whatsapp ──► (valida firma, responde 200) ──► cola "wa-inbound"
                                                                                       │
                       cola "wa-outbound" ◄── agente (IA + herramientas) ◄── worker ◄──┘
                              │
                              └─► worker envía por la Graph API ──► Meta ──► Cliente
Meta ──► avisos de entrega (sent/delivered/read) ──► cola "wa-status" ──► se actualiza el mensaje
```

Tres procesos, cada uno en su terminal:

| Comando | Qué hace |
|---|---|
| `pnpm wa:webhook` | Recibe los webhooks de Meta. Solo valida la firma y encola (responde en milisegundos). |
| `pnpm wa:worker` | Procesa las colas: corre el agente y envía las respuestas. |
| `pnpm wa:fake-graph` | **Solo desarrollo.** Un "WhatsApp falso" que imprime lo que se enviaría. |

Garantías ya probadas (`pnpm test`):
- Firma `X-Hub-Signature-256` obligatoria; sin firma válida no se toca nada (401).
- Un mismo mensaje entregado dos veces por Meta genera **una sola** respuesta.
- Varios mensajes seguidos de un cliente se atienden **en orden**.
- Máximo 30 mensajes por cliente por hora (protege el costo de IA).
- Fuera de la ventana de 24 h no se envía texto libre.
- Si un envío falla de forma transitoria se reintenta; si es permanente queda `failed` con el motivo.
- Si el proceso se cae entre guardar y encolar, un barrido cada 30 s recupera los envíos.

## Probar sin WhatsApp real (modo desarrollo)

Con `GRAPH_BASE_URL=http://localhost:4010` en `.env`:

```bash
pnpm wa:fake-graph        # terminal 1
pnpm wa:webhook           # terminal 2
pnpm wa:worker            # terminal 3
pnpm wa:simulate --text "Hola, ¿cuánto cuesta una limpieza?"   # terminal 4
```

El mensaje aparece en la terminal 1 como lo vería el cliente.
Antes, una sola vez: `pnpm wa:connect-channel --slug sonrisa --dev-token`.

## Conectar el número REAL

Lo que no se puede automatizar porque son secretos o decisiones tuyas:

1. **App Secret de Meta** → developers.facebook.com → tu app → Configuración → Básica → *Clave secreta de la app*.
   Ponla en `.env` como `META_APP_SECRET=` (reemplaza el valor de desarrollo).
2. **Quitar el Graph falso:** en `.env` deja `GRAPH_BASE_URL=` **vacío**. (Al arrancar, el worker imprime a qué Graph API apunta.)
3. **Token del usuario del sistema** (permanente): Business Settings → Usuarios del sistema → asigna tu app y la cuenta de WhatsApp con control total → *Generar token* con los permisos `whatsapp_business_messaging`, `whatsapp_business_management` y `business_management`.
   Guárdalo cifrado (se pide oculto, no queda en ningún archivo):
   ```bash
   pnpm wa:connect-channel --slug sonrisa --phone-number-id 1385124751359472 --display-phone "+52 1 984 479 0350"
   ```
   > Ojo: ese número se muestra como **"Renova Capital"**. Conectarlo a la clínica demo es solo para pruebas con tu propio teléfono.
4. **URL pública** para que Meta llegue a tu PC. Con un túnel temporal (sin cuenta):
   ```bash
   winget install Cloudflare.cloudflared
   cloudflared tunnel --url http://localhost:3001
   ```
   Te da una dirección `https://algo.trycloudflare.com`. **Mientras el túnel esté abierto, tu servidor del webhook es accesible desde internet**; la firma impide mensajes falsos, pero ciérralo cuando no lo uses.
5. **Registrar el webhook en Meta:** callback `https://algo.trycloudflare.com/webhooks/whatsapp` y como *verify token* el valor de `WHATSAPP_VERIFY_TOKEN` de tu `.env`. Se puede hacer desde el panel de Meta o con el conector de WhatsApp Business (`whatsapp_biz_configure_webhooks`); la URL debe estar activa antes.
6. **Probar:** manda un mensaje al número desde otro teléfono. Los eventos aparecen en la terminal del webhook (`webhook.accepted`).

Si no llegan eventos: la app puede estar en *modo desarrollo* (publícala) o la suscripción de la cuenta puede faltar. Si los envíos fallan con error de pago, falta el método de pago en la cuenta de WhatsApp.

## Cuidados
- La IA gratuita (`LLM_MODE=free`) es **lenta** (hasta ~1 min por respuesta) y puede registrar los mensajes: úsala solo con datos de prueba. Para contestar a clientes reales usa `LLM_MODE=paid`.
- La versión de la Graph API se configura con `GRAPH_API_VERSION` (por defecto `v23.0`); si Meta la retira, súbela.
