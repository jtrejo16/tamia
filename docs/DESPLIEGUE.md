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
6. **Crea tu usuario operador:** regístrate en `/registro` y márcate como operador:
   ```bash
   docker compose -f docker-compose.prod.yml --env-file .env.production run --rm \
     -e APP_ROLE=migrate --entrypoint sh migrate -c "cd /app/packages/db && ./node_modules/.bin/tsx src/make-operator.ts --email TU_CORREO"
   ```
   (usa `DATABASE_URL`, que solo recibe el servicio `migrate`).

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

## Railway (adaptación, sin probar)
La imagen es única y el rol se elige con `APP_ROLE`, así que en Railway se crean **tres servicios** desde el mismo repositorio, cada uno con la variable `RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile`:
- `web` con `APP_ROLE=web` (con dominio público), `worker` con `APP_ROLE=worker`, y `migrate` con `APP_ROLE=migrate` ejecutado una vez por despliegue.
- Agrega **PostgreSQL con pgvector** y **Redis** como servicios. En Redis configura `maxmemory-policy noeviction` y contraseña.
- Variables: `DATABASE_URL` (solo `migrate`), `DATABASE_APP_URL` (`web` y `worker`, con el rol `empleado_app`), `REDIS_URL`, y las del archivo `deploy/.env.production.example`.
- **Verifica** que el usuario de la base tenga privilegios de superusuario (o `BYPASSRLS`): las funciones de seguridad dependen de eso. En una base de Railway normalmente sí; en bases administradas como Neon, Supabase o AWS RDS puede no ser así.

## Pendientes antes de abrir a clientes
Producción de Meta (verificación del negocio, app publicada), credenciales de producción de Mercado Pago, modelos de IA de pago, aviso de privacidad y contratos, monitoreo con alertas, y pruebas de carga. Ver la lista de lanzamiento.
