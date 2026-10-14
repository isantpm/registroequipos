# Memoria del proyecto: Registro de Equipo

## Qué es

Aplicación web sencilla, en español, para capturar registros de equipos o maquinaria en campo. La interfaz está implementada como una sola página (`index.html`) con HTML, CSS y JavaScript embebidos.

## Flujo actual

1. El usuario selecciona una foto del equipo; el navegador la sube a ImgBB (máximo declarado: 10 MB) y muestra una vista previa.
2. El usuario registra equipo/maquinaria, localidad o proyecto, operador responsable, horómetro, horas del próximo mantenimiento y comentarios (máximo 150 caracteres).
3. El formulario envía esos campos y la URL de la imagen mediante EmailJS.
4. Al éxito, se muestra una alerta y se limpia el formulario.

## Estado y arquitectura observados

- Repositorio muy pequeño: solo `index.html` en el estado revisado.
- Rama `main`, sincronizada con `origin/main`; últimos commits: `470984a` y `1984a29`.
- No se observa backend, API propia, autenticación, base de datos, historial consultable, roles, panel administrativo ni pruebas automatizadas.
- La información se envía por correo; el HTML no mantiene persistencia ni permite consultar/modificar registros existentes.
- Los identificadores y la clave de ImgBB están incrustados en el JavaScript del cliente. Deben tratarse como expuestos y revisarse/rotarse antes de escalar; mover operaciones privilegiadas a un backend y configurar límites/validaciones.
- La carga de foto no limpia el archivo ni la URL previa al elegir otra imagen, y los errores de subida dependen del estado textual del formulario. Revisar robustez del flujo al preparar mejoras.

## Contexto para planificar escala

El objetivo es permitir el uso simultáneo por varios usuarios en campo y tener un único administrador de escritorio que recibe y procesa la información desde un dashboard y una tabla de mantenimiento.

### Capacidades objetivo expresadas por el usuario

- Alta inicial / ficha maestra de cada equipo: marca, modelo, ficha o identificador, intervalo de horas entre mantenimientos y horómetro actual al registrarlo.
- Registros de campo posteriores deben asociarse a un equipo existente y actualizar automáticamente su horómetro/estado en el sistema.
- Dashboard y tabla para que el administrador revise los equipos y su proximidad al mantenimiento.
- Alertas por estado: cercano al mantenimiento, crítico al alcanzar las horas objetivo y urgente al sobrepasar el tiempo óptimo de mantenimiento.
- Al confirmar un registro debe generarse una ficha de control. La definición y diseño de esa ficha se trabajará al final del proyecto.

### Decisiones que faltan para el plan

- Definir regla exacta de alertas y transición entre cercano, crítico y urgente (umbrales, tolerancias, unidades y si las horas se refieren al horómetro absoluto o a horas desde el último mantenimiento).
- Aclarar qué significa que el administrador “procese”/confirme cada reporte: si hay estados pendiente/aprobado/rechazado, y si el equipo actualiza el horómetro antes o después de aprobación.
- Establecer cómo identificar inequívocamente equipos (por ficha/código; evitar depender solo de marca/modelo), y qué hacer con lecturas duplicadas, atrasadas o menores al horómetro guardado.
- Aclarar si un equipo tiene un solo intervalo repetitivo o un plan con varios tipos de servicio e intervalos diferentes.
- Dimensionar usuarios/equipos, conectividad en campo, adjuntos/fotos, exportaciones y permisos del administrador.

Una posible evolución es conservar una captura móvil simple y añadir backend con autenticación multiusuario, base de datos como fuente de verdad, almacenamiento de fotos, bitácora de lecturas y servicios, reglas de mantenimiento y una interfaz de escritorio para administración. Diseñar la ficha de control al final, según lo indicado por el usuario.

## Construcción iniciada (2026-10-14)

- Se agregó un primer servidor con Node.js (`server.mjs`), API HTTP autenticada por sesión y SQLite en `data/registro.db`.
- Se agregó UI responsive en `public/index.html`, con vista de campo y panel administrativo.
- El administrador inicial se provisiona usando `ADMIN_USER` y `ADMIN_PASSWORD` en el primer arranque; puede crear usuarios de campo.
- Hay alta de equipos con umbral próximo editable (predeterminado en la interfaz: 50 horas), envío de lecturas y cola para confirmar/rechazar.
- Usuarios de campo solo consultan su historial propio; el panel de administración refresca cada 15 segundos.
- Suposición de esta versión: el horómetro se actualiza al recibir el reporte. Rechazar restaura el último valor no rechazado; confirmar cambia el estado del reporte. Esta regla debe validarse con el usuario.
- Regla implementada: “próximo” cuando faltan más de 0 y hasta el umbral; “crítico” exactamente al llegar a las horas objetivo; “urgente” cuando se excede. Un salto de lectura que pase el objetivo aterriza directamente en urgente.
- Las nuevas lecturas ahora exigen dos fotos JPG/PNG/WEBP de máximo 10 MB por imagen. Al recibir una pareja nueva de un equipo, se quitan las referencias y se borran las dos imágenes anteriores de ese mismo equipo; el reporte antiguo permanece sin esas imágenes.
- Alertas de equipos no al día se muestran en un diálogo emergente y con chips por color. La casilla de mantenimiento realizado guarda un evento y reinicia el ciclo en el horómetro actual.
- Reparación 2026-10-14: SQLite interpretaba `""` como identificadores de columna en la consulta para localizar fotos previas; se cambiaron a literales SQL `''`. Se validaron con datos temporales el acceso a lecturas, subida de dos fotos, borrado/referencia del par anterior, confirmación y reinicio de alertas. Los datos de prueba se eliminaron después.
- El inventario ahora se puede cargar en lote con una plantilla CSV descargable (hasta 5,000 filas), con validación transaccional, ficha única, datos de mantenimiento y asignación opcional por nombre de usuario.
- Cada equipo admite un usuario de campo asignado. La interfaz de campo y el servidor muestran/aceptan lecturas solo para sus equipos asignados; administración puede asignar o retirar esa asignación desde la tabla.
- Pruebas de API 2026-10-14: importación de dos equipos, rechazo transaccional de duplicado, filtrado de equipos para usuario asignado, bloqueo de reporte a equipo libre y asignar/retirar usuario. Los usuarios/equipos de prueba se limpiaron.
- Al marcar mantenimiento realizado, el administrador debe ingresar el horómetro de la labor, insumos y mecánico. Se registra en `maintenance_events`, reinicia el ciclo desde esas horas y descarga una ficha HTML de control imprimible/guardable como PDF. Prueba de API confirmó persistencia y reinicio; el registro de prueba se limpió.
- Corrección 2026-10-14: el refresco automático del panel administrativo cada 15 segundos se pausa mientras hay un diálogo abierto, para evitar que el formulario de mantenimiento se cierre o se reconstruya durante su uso. Se validó la sintaxis del JavaScript del cliente.
- Aún faltan intervalos por tipo de servicio y la ficha de control; esta última permanece reservada para la etapa final.
- Ampliación 2026-10-14: cuentas de campo con `user_type` registro o transferencia; registro no tiene límite y transferencia queda limitada a tres. Solo transferencia y administración pueden reasignar equipos; las lecturas continúan limitadas a equipos asignados.
- Se añadieron correos en cuentas, solicitudes de restablecimiento, contraseñas provisionales con cambio obligatorio, mostrar/ocultar contraseña al iniciar sesión, y restablecimiento propio del admin por correo. El SMTP seguro se configura mediante variables `SMTP_*`; no hay credenciales SMTP del usuario/proveedor en el proyecto todavía.
- Se añadió exportación de un ZIP con un libro XLSX de todas las lecturas y los archivos de fotos vigentes. Las filas incluyen los nombres de archivo de las dos fotos asociadas; fotos antiguas borradas al reemplazar el par no pueden incluirse.
- Instrucciones de inicio y limitaciones en `README.md`; la base de datos local está excluida de Git por `.gitignore`.

## Fuente y fecha de revisión

Resumen basado en la revisión de `index.html` y el historial visible del repositorio el 2026-10-14. Actualizar esta memoria si cambia el alcance o la arquitectura.
