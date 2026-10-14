# Registro de Equipos

Primera versión con servidor Node.js y base de datos SQLite para permitir varios usuarios conectados al mismo sistema.

## Requisitos

- Node.js 22.9 o posterior (se recomienda una versión LTS reciente).
- La base de datos se crea automáticamente en `data/registro.db` y no se sube al repositorio.

## Iniciar

En PowerShell:

```powershell
npm start
```

La configuración inicial del administrador se guarda en `.env` (plantilla en `.env.example`), que está excluido de Git. Visita `http://localhost:3000`. El primer arranque crea al administrador; los cambios posteriores de contraseña se conservan en la base de datos. El servidor escucha en la red local; para conectarse desde teléfonos, usa la dirección IP del equipo servidor y el puerto 3000. Para uso por Internet hace falta desplegarlo detrás de HTTPS en un servidor compartido y planificar copias de seguridad de la carpeta `data`.

No compartas los archivos `.env` o de base de datos ni expongas las credenciales en servicios públicos.

El administrador puede crear usuarios con correo y perfil. Las contraseñas se guardan como hashes derivados con scrypt.

## Alcance implementado

- Inicio de sesión con un solo administrador y perfiles de registro sin límite y transferencia (máximo 3). Los encargados de registro solo envían lecturas de equipos asignados; transferencia solo cambia asignaciones.
- Ficha de equipo con código único, marca, modelo, número de serie, intervalo de mantenimiento, horómetro inicial y umbral de alerta configurable.
- Ciclos de mantenimiento independientes por equipo y tipo de servicio; el administrador puede agregar, editar y archivar ciclos, cada uno con su intervalo, umbral y horómetro de último servicio.
- Importación masiva de hasta 5,000 equipos desde CSV usando la plantilla descargable del panel; la columna de usuario asignado es opcional.
- Asignación de cada equipo a un usuario de campo desde la tabla del administrador. El servidor restringe el catálogo y los reportes de ese usuario a los equipos asignados.
- Registro de mantenimiento con horómetro al servicio, tipos completados, mecánico e insumos; solo reinicia los ciclos seleccionados, conserva el evento y genera una ficha imprimible.
- Envío de lecturas por usuarios de campo; las horas se actualizan al recibir la lectura y se conservan los reportes para revisión administrativa.
- Panel con conteos y estados: próximo (dentro del umbral), crítico (exactamente al llegar al vencimiento) y urgente (por encima del vencimiento).
- Confirmación o rechazo del reporte por el administrador.
- Historial administrativo de todas las lecturas, servicios y transferencias, con búsqueda; desde cada servicio se puede volver a descargar su ficha de control.
- Actualización del panel administrativo cada 15 segundos y acceso de cada usuario de campo restringido a sus propios reportes.
- Ventana emergente con alertas codificadas por color; marcar “Mantenimiento realizado” registra las horas del servicio, reinicia el ciclo y quita la alerta.
- Cada lectura requiere dos fotos JPG, PNG o WEBP (máximo 10 MB por foto). El nuevo par reemplaza las imágenes previas de ese equipo para controlar el almacenamiento.
- El administrador puede descargar un ZIP con un libro XLSX de todos los registros y las fotos almacenadas; el libro señala los nombres de las imágenes correspondientes.
- El inicio de sesión permite mostrar/ocultar la contraseña. Las cuentas nuevas y las restablecidas deben cambiar su clave temporal al entrar; los usuarios pueden solicitar restablecimiento usando su usuario y correo.
- El correo provisional del administrador se envía mediante SMTP seguro. Configura `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER`, `SMTP_PASS` y `SMTP_FROM` en `.env`, y reinicia el servidor.
- Se generan respaldos de SQLite y fotos cada 24 horas y se pueden crear manualmente desde el panel. `BACKUP_DIR` cambia el destino y `BACKUP_INTERVAL_HOURS` ajusta la frecuencia.
- HTTPS se activa directamente con `HTTPS_CERT_FILE` y `HTTPS_KEY_FILE`; para un dominio público se recomienda terminar TLS en un proxy inverso y mantener el servidor Node enlazado a `127.0.0.1`.

## Pendiente antes de operación real

- Antes de abrir el servicio a usuarios externos, configurar dominio/hosting, certificado HTTPS y un destino de respaldo fuera del servidor.
- Configurar credenciales SMTP de un proveedor compatible con TLS en puerto 465 y hacer un envío real de recuperación.
- Al final del proyecto, cerrar el diseño visual de la ficha imprimible.

## Preparación para Render

El proyecto está configurado para desplegarse como un servicio web Node en Render con un disco persistente montado en `/var/data`. `render.yaml` define el servicio, la versión de Node, el directorio persistente y solicita las credenciales iniciales del administrador sin guardarlas en el repositorio. `DATA_DIR` permite que SQLite, las fotos y las copias se guarden en ese disco.

Para desplegar:

1. Sube el proyecto a GitHub, sin agregar `.env`, `data/` ni archivos de credenciales.
2. En Render, crea un Blueprint desde el repositorio y revisa el servicio `control-de-equipos` del archivo `render.yaml`.
3. Introduce `ADMIN_USER` y `ADMIN_PASSWORD` en el formulario seguro de Render. No reutilices la contraseña temporal en otros sitios; cámbiala al entrar.
4. Al iniciar vacío, Render creará una base nueva. Para conservar el inventario local, antes del uso real hay que migrar `data/registro.db` y las fotos de `data/uploads` al disco persistente de Render.
5. Ejecuta una sola instancia mientras SQLite esté en uso. El disco local persistente no se comparte entre instancias.
6. Configura y verifica respaldos fuera del servicio; las copias guardadas en `/var/data/backups` comparten el mismo disco y no bastan ante una pérdida del volumen.
7. Añade SMTP desde el panel de Render cuando tengas las credenciales del proveedor. Después valida el envío real de recuperación.

Render termina HTTPS para el servicio. No cargues `HTTPS_CERT_FILE` ni `HTTPS_KEY_FILE`. El Blueprint usa un servicio pagado porque Render requiere un servicio pagado para adjuntar un disco persistente.
