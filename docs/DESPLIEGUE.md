# Despliegue en un servidor

Esta guía pone todo el sistema en línea en **un servidor con Docker** (panel, worker, base de datos, Redis, HTTPS y respaldos). Sirve igual en un VPS barato (Hetzner, DigitalOcean, etc.) que en tu propia máquina. Una sección al final explica cómo adaptarlo a **Railway**.

> Estado: el empaquetado se **probó en local** (construcción de la imagen, migraciones y arranque de todos los servicios). **No se ha probado todavía en un servidor real ni en Railway.**

## Qué se instala

| Servicio | Qué hace |
|---|---|
| `postgres` | Base de datos (PostgreSQL 17 con pgvector). Solo accesible desde la red interna. |
| `redis` | Colas y avisos en tiempo real, con contraseña y política `noeviction` (BullMQ la exige). |
| `migrate` | Corre una vez en cada despliegue: extensiones, migraciones y contraseña del rol de la app. |
| `web` | El panel y los webhooks (WhatsApp/Messenger/Instagram, Mercado Pago, Retell). |
| `worker` | Atiende los mensajes, manda recordatorios y concilia cobros. |
| `caddy` | HTTPS automático (Let's Encrypt) para tu dominio. |
| `backup` | Respaldo diario de la base de datos (14 días) en `./backups`. |

El panel y el worker usan el rol **limitado** `empleado_app` (el aislamiento entre clínicas lo impone la base de datos); solo `migrate` recibe la conexión del dueño.

## Requisitos
- Un servidor Linux con **2 GB de RAM o más** (4 GB recomendado) y Docker con el plugin Compose.
- Un **dominio** (≈ $10–15 al año) con un registro **A** hacia la IP del servidor. Puertos **80 y 443** abiertos.
- Los datos de Meta, Mercado Pago, Retell y OpenRouter (de producción).

## Pasos
1. **Copia el proyecto** al servidor (git clone o rsync).
2. **Genera secretos nuevos** (no reutilices los de desarrollo):
   ```bash
   pnpm deploy:secrets      # o: node deploy/gen-secrets.mjs
   ```
3. **Crea `.env.production`** en la raíz: `cp deploy/.env.production.example .env.production`. Pega los secretos y llena `DOMAIN`, `PUBLIC_BASE_URL` y las claves de cada servicio. **Guarda `ENCRYPTION_KEY` en un gestor de contraseñas**: si se pierde, las claves de WhatsApp guardadas ya no se pueden abrir.
4. **Levanta todo:**
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
   docker compose -f docker-compose.prod.yml ps
   ```
   La primera vez tarda varios minutos (construye la imagen). `migrate` debe terminar en estado *exited (0)*.
5. **Entra a `https://TU-DOMINIO/login`.** Caddy obtiene el certificado solo (puede tardar un minuto).
6. **Crea tu usuario operador:** regístrate en `/registro`, agrega `OPERATOR_EMAIL=tu@correo.com` a `.env.production` y vuelve a correr el paso 4: el trabajo de migraciones te marca como operador (es seguro repetirlo).

## Apuntar los servicios a la nueva dirección
Cuando el dominio funcione, cambia en cada servicio la dirección del túnel por la definitiva:

| Servicio | Dónde | Valor |
|---|---|---|
| Meta (WhatsApp, Page, Instagram) | Webhooks | `https://TU-DOMINIO/api/webhooks/whatsapp` + el `WHATSAPP_VERIFY_TOKEN` |
| Meta (inicio de sesión con Facebook) | URI de redireccionamiento OAuth | `https://TU-DOMINIO/api/channel/facebook/callback` |
| Mercado Pago | Webhooks (pestaña **Producción**) | `https://TU-DOMINIO/api/billing/webhook` + eventos de suscripciones |
| Retell | (automático) | se actualiza al **sincronizar** el agente desde Ajustes → Llamadas |

## Operación
- **Ver registros:** `docker compose -f docker-compose.prod.yml logs -f web worker`
- **Actualizar a una versión nueva:** `git pull` y luego el mismo `up -d --build` del paso 4 (corre las migraciones solo).
- **Reiniciar:** `docker compose -f docker-compose.prod.yml restart web worker`
- **Estado de salud:** `https://TU-DOMINIO/api/health` responde `{"ok":true}` si el panel y la base de datos funcionan. El panel también avisa si el worker se detiene.
- **Conciliación manual de cobros:** `docker compose -f docker-compose.prod.yml --env-file .env.production run --rm -e APP_ROLE=worker --entrypoint sh worker -c "cd /app/apps/worker && ./node_modules/.bin/tsx src/dev/reconcile.ts"`

## Respaldos (importante)
El servicio `backup` guarda un `.sql.gz` diario en `./backups` (14 días). **Eso está en el mismo servidor**: si el servidor se pierde, se pierden también los respaldos. Copia `./backups` **fuera** del servidor (snapshots del proveedor, `rclone` a un almacenamiento externo, o `scp` a otra máquina), y **prueba restaurar** al menos una vez. La restauración se **probó** (sin errores: recuperó clínicas, usuarios, las 17 migraciones y las 29 políticas de seguridad) con este procedimiento:
```bash
# 1) en una base NUEVA (aqui "restauracion"); en un servidor nuevo: levanta solo postgres y haz esto antes del resto
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres psql -U empleado -d postgres -c "create database restauracion"
gunzip -c backups/empleado_FECHA.sql.gz | docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres psql -U empleado -d restauracion -q
# 2) revisa los datos; para usarla como la base real, restaurala sobre una base vacia con el nombre de POSTGRES_DB
```
En un servidor nuevo, restaura **antes** de levantar el resto: las migraciones ya vienen registradas en el respaldo y `migrate` solo fija la contraseña del rol de la aplicación.

## Seguridad básica del servidor
- Solo los puertos **22 (SSH), 80 y 443** deben estar abiertos (firewall del proveedor o `ufw`). Postgres y Redis **no publican puertos**.
- Acceso por **llave SSH**, sin contraseña; actualizaciones del sistema automáticas.
- `.env.production` con permisos `600` y fuera de git (ya está en `.gitignore`).
- Este es un entorno **nuevo**: base de datos vacía y llaves nuevas. Cada clínica debe **reconectar** su WhatsApp, y los datos del entorno de pruebas no se copian.

## Railway (paso a paso)

> No probado todavía en Railway. Los nombres de los botones pueden cambiar; la lógica no. Railway **ya no admite archivos de configuración nuevos** (`railway.json` está en desuso), así que todo se configura en su panel. Fuentes: [variables entre servicios](https://docs.railway.com/variables/reference), [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [guía con pgvector](https://docs.railway.com/guides/rag-pipeline-pgvector).

**0. El código debe estar en GitHub (privado).** Crea un repositorio privado vacío en GitHub y, desde la carpeta del proyecto:
```bash
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git branch -M main
git push -u origin main
```

**1. Proyecto.** En https://railway.com crea cuenta (con GitHub) y el plan Hobby. *New Project → Deploy from GitHub repo* → elige el repositorio. Ese primer servicio será el **panel**: renómbralo **`web`**.

**2. Base de datos con pgvector.** La base estándar de Railway **no trae pgvector**: usa una plantilla (*New → Template* y busca "pgvector"). Antes de aceptar, revisa que (a) incluya la extensión **vector**, (b) dé un usuario **superusuario** (el de `POSTGRES_USER`) y (c) muestre la conexión de administrador (en algunas se llama `DATABASE_ADMIN_URL`). Renombra el servicio a **`Postgres`**.

**3. Redis.** *New → Database → Redis*; renómbralo **`Redis`**. Comprueba que la política de memoria sea `noeviction` (`CONFIG GET maxmemory-policy`); BullMQ la exige.

**4. Dos servicios más del mismo repositorio:** *New → GitHub Repo* (el mismo) dos veces, llamados **`worker`** y **`migrate`**.

**5. Variables** (pestaña *Variables* de cada servicio):

| Variable | web | worker | migrate |
|---|---|---|---|
| `RAILWAY_DOCKERFILE_PATH` = `deploy/Dockerfile` | ✔ | ✔ | ✔ |
| `APP_ROLE` | `web` | `worker` | `migrate` |
| `DATABASE_APP_URL` | ✔ | ✔ | |
| `DATABASE_URL` (superusuario) | | | ✔ |
| `APP_DB_PASSWORD` | | | ✔ |
| `REDIS_URL` | ✔ | ✔ | |
| Resto de `deploy/.env.production.example` (AUTH_SECRET, ENCRYPTION_KEY, META_*, OPENROUTER_API_KEY, MERCADOPAGO_*, RETELL_*, QUEUE_PREFIX…) | ✔ | ✔ | |

- `DATABASE_APP_URL` = `postgres://empleado_app:LA_CONTRASEÑA@${{Postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/NOMBRE_DE_LA_BASE` (la contraseña es la misma `APP_DB_PASSWORD` de `migrate`; el nombre de la base lo ves en las variables del servicio Postgres).
- `DATABASE_URL` de `migrate` = la conexión **de superusuario** de tu plantilla, por referencia (por ejemplo `${{Postgres.DATABASE_ADMIN_URL}}` o `${{Postgres.DATABASE_URL}}`). **No se la des a `web` ni a `worker`.**
- `REDIS_URL` = `${{Redis.REDIS_URL}}`.
- Usa **Shared Variables** del proyecto para no repetir los secretos en `web` y `worker`.
- Genera los secretos nuevos con `pnpm deploy:secrets` (guarda `ENCRYPTION_KEY` en un gestor de contraseñas).

**6. Ajustes por servicio** (*Settings*):
- `web`: *Networking → Generate Domain* (HTTPS gratis en `*.up.railway.app`; después puedes conectar tu dominio) y *Healthcheck Path* = `/api/health`. Pon `PUBLIC_BASE_URL` = `https://ESE-DOMINIO`.
- `migrate`: política de reinicio **Never** (corre una vez por despliegue y termina). Si Railway lo marca como "crashed" al terminar con éxito, es normal.
- `worker`: sin dominio público.

**7. Despliega y verifica.** En los registros de `migrate` debe salir *"Migraciones aplicadas y rol empleado_app listo."*. Si `web` o `worker` arrancaron antes y fallaron, se reintentan solos o pulsa *Redeploy*. Luego abre `https://TU-DOMINIO/api/health`: debe responder `{"ok":true}`.

**8. Operador y webhooks.** Regístrate en `/registro`, define `OPERATOR_EMAIL` en `migrate` y redespliega ese servicio. Después cambia las direcciones de Meta, Facebook y Mercado Pago (tabla de la sección anterior).

**Cosas a saber de Railway**
- **Respaldos:** el servicio `backup` de este compose **no existe en Railway**. Activa los respaldos de volumen de Railway si tu plan los incluye (verifícalo) y/o programa un volcado externo; hasta entonces **no hay respaldo**. Pendiente.
- **Orden de migraciones:** Railway no obliga a que `migrate` termine antes que `web`; en actualizaciones con cambios de base de datos, redespliega `migrate` primero.
- **Costo:** es por uso (4 servicios siempre encendidos: panel, worker, Postgres, Redis). Revisa el consumo la primera semana.
- **Verifica** que el usuario de la base sea superusuario (o tenga `BYPASSRLS`): las funciones de seguridad dependen de eso. Con una plantilla de Postgres propia suele serlo; en bases administradas como Neon, Supabase o AWS RDS puede no serlo.

## Pendientes antes de abrir a clientes
Producción de Meta (verificación del negocio, app publicada), credenciales de producción de Mercado Pago, modelos de IA de pago, aviso de privacidad y contratos, monitoreo con alertas, y pruebas de carga. Ver la lista de lanzamiento.
