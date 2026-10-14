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
- Importación masiva de hasta 5,000 equipos desde CSV usando la plantilla descargable del panel; la columna de usuario asignado es opcional.
- Asignación de cada equipo a un usuario de campo desde la tabla del administrador. El servidor restringe el catálogo y los reportes de ese usuario a los equipos asignados.
- Registro de mantenimiento con horómetro al servicio, mecánico e insumos; reinicia el ciclo desde el horómetro indicado y genera una ficha HTML imprimible.
- Envío de lecturas por usuarios de campo; las horas se actualizan al recibir la lectura y se conservan los reportes para revisión administrativa.
- Panel con conteos y estados: próximo (dentro del umbral), crítico (exactamente al llegar al vencimiento) y urgente (por encima del vencimiento).
- Confirmación o rechazo del reporte por el administrador.
- Actualización del panel administrativo cada 15 segundos y acceso de cada usuario de campo restringido a sus propios reportes.
- Ventana emergente con alertas codificadas por color; marcar “Mantenimiento realizado” registra las horas del servicio, reinicia el ciclo y quita la alerta.
- Cada lectura requiere dos fotos JPG, PNG o WEBP (máximo 10 MB por foto). El nuevo par reemplaza las imágenes previas de ese equipo para controlar el almacenamiento.
- El administrador puede descargar un ZIP con un libro XLSX de todos los registros y las fotos almacenadas; el libro señala los nombres de las imágenes correspondientes.
- El inicio de sesión permite mostrar/ocultar la contraseña. Las cuentas nuevas y las restablecidas deben cambiar su clave temporal al entrar; los usuarios pueden solicitar restablecimiento usando su usuario y correo.
- El correo provisional del administrador se envía mediante SMTP seguro. Configura `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_USER`, `SMTP_PASS` y `SMTP_FROM` en `.env`, y reinicia el servidor.

## Pendiente antes de operación real

- Definir si toda lectura recibida debe actualizar el horómetro inmediatamente o solo al aprobarla.
- Definir reglas de múltiples ciclos/tipos de mantenimiento, y qué acción registra que el mantenimiento se completó y reinicia el ciclo.
- Terminar el historial detallado y la ficha de control que se diseñará al final.
- Configurar HTTPS, copias de seguridad y las credenciales SMTP antes de activar el correo de recuperación.
