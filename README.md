RUSH POS v26.0 — "The Rush: Club · Café · Cocina"
Fecha: 25 de septiembre de 2026
Plataforma: Cloudflare Workers + D1 (`rush-pos-db`)
Estado de las versiones
Versión	Estado
v24.1 – v25.0	Base funcional completa: comandas por persona, catálogo tipo Starbucks, usuarios, caja, inventario, lealtad, página pública, pedidos externos.
v26.0	Candidata a estable. Rediseño visual del menú público, fotos de producto, repartidores con ubicación en vivo (gratis), envío automático, plantillas de WhatsApp, canje de recompensa, notas por producto. Probada con pruebas automatizadas del servidor y regresión completa de versiones anteriores. Falta confirmarla en producción.
No hay versión marcada como estable todavía.
---
1. Menú público — rediseño completo (`/menu.html`)
El bug que reportaste: al tocar "Estoy en el club" no pasaba nada visible. Corregido: ahora hace scroll automático directo al menú.
El rediseño visual: cambié la estructura completa, no solo colores:
Encabezado tipo "hero" con degradado y tipografía serif para los títulos (Fraunces), inspirado en apps de delivery como Uber Eats/Rappi, pero con la paleta verde+dorado de "The Rush".
Tarjetas de producto grandes, con foto (o un degradado de color con ícono si aún no subes foto — nunca se ve una casilla vacía y gris).
Al tocar un producto se abre una ficha con foto grande, descripción y selector de cantidad, en vez de agregarse de golpe sin avisar.
Buscador, secciones y categorías con la misma jerarquía que ya usas en el admin.
Fotos de producto — cómo se cargan: en Menú → Nuevo producto, hay un campo para subir una foto desde tu celular o computadora. Se comprime automáticamente en el navegador antes de guardarse (para no saturar la base de datos) y se ve de inmediato en el menú público. También puedes subir o cambiar la foto de un producto ya existente, desde la tabla de clasificación.
Nota honesta: las fotos se guardan directo en la base de datos (D1), lo cual es gratis y funciona bien para un menú de tamaño normal. Si algún día suben cientos de fotos en alta resolución, seguirá una migración a almacenamiento de archivos (Cloudflare R2) — te aviso si tu catálogo llega a ese punto, no es algo que debas resolver ahora.
Nombre del producto bien escrito: al escribir el nombre de un producto nuevo (ej. "taco de arrachera"), aparece abajo una sugerencia en mayúsculas/minúsculas correctas ("Taco de Arrachera") que aceptas con un clic. Ya no dependes de escribirlo bien a mano.
2. Repartidores y envío a domicilio (Fase B/C/D, con opciones gratuitas)
Fase B — WhatsApp (versión local, sin API de pago, como pediste)
En Órdenes, cualquier pedido que llegó por la página web tiene un botón 💬 Responder por WhatsApp con 4 plantillas listas para editar y enviar:
📝 Confirmación de pedido
💳 Método de pago (usa los datos de transferencia que guardes en Configuración)
🛵 Va en camino
✅ Entregado
Cada plantilla se arma sola con los datos del pedido (folio, total, dirección) y la puedes editar antes de mandarla — abre WhatsApp con el mensaje listo.
Fase C — Repartidores
Nuevo rol de usuario: Repartidor (se crea igual que los demás, en Usuarios).
En Órdenes, cada pedido a domicilio tiene una barra para asignar repartidor y avanzar su estatus: Recibido → Preparando → Salió → En camino → Entregado.
El repartidor entra con su usuario y ve 🛵 Mis entregas: sus pedidos asignados, con un botón para avanzar al siguiente estatus.
Fase D — Envío automático y mapa en vivo, 100% gratis
Costo de envío automático: al escribir su dirección, el cliente toca "Ubicar mi dirección" y el sistema calcula la distancia real desde el club (usando el buscador gratuito de OpenStreetMap) y aplica tu tarifa base + $/km, configurables en Configuración → Envío a domicilio.
Mapa en vivo, sin apps ni SDKs de pago: el repartidor activa "📍 Compartir mi ubicación" en su pantalla de Mis entregas — usa el GPS que ya trae su celular, sin instalar nada. El cliente entra a su link de seguimiento (`/seguimiento.html`, se genera solo con cada pedido) y ve su pedido avanzando de estatus, y si el repartidor está compartiendo ubicación, lo ve como un punto en un mapa gratuito.
Límite honesto: esto solo funciona mientras el repartidor mantiene esa pantalla abierta (pantalla prendida). No sigue en segundo plano como una app nativa — eso sí requeriría inversión en una app aparte.
Dirección estructurada: el pedido a domicilio ahora pide, como pediste: calle, número, colonia, referencia (por si se pierden), nombre de quien recibe, y confirma el WhatsApp.
3. Notas por producto (ya no solo por comanda completa)
En Venta, cada línea del carrito tiene un botón 📝 para ponerle una nota a ESE producto específico (ej. "sin cebolla" solo en el taco de la Persona 2, no en toda la comanda). Se ve en Cocina, Barra, Órdenes y en el ticket, junto al producto exacto.
4. Canje de recompensa integrado
En Órdenes, junto al botón de tarjeta, ahora hay 🎁 Canjear: si el cliente ya ganó una recompensa de lealtad, se descuenta con un clic (antes solo existía el endpoint, sin botón).
---
Sobre las fotos que compartiste en Google Drive
Vi tu mensaje con la carpeta de imágenes nombradas por platillo. Para poder leerlas necesito que conectes Google Drive (te va a aparecer la opción de conectar en el chat) — en cuanto lo hagas, entro a la carpeta, emparejo cada foto con su producto por nombre, y te dejo una siguiente versión con las fotos ya cargadas de una vez, sin que tengas que subirlas tú una por una.
D1: qué cambia en la base de datos
No tienes que correr SQL. El Worker crea/agrega solo:
Columna `image` en `menu_items`
Columnas `delivery_status`, `driver_id`, `delivery_lat`, `delivery_lng`, `shipping_cost`, `tracking_token`, `delivery_address`, `receiver_name` en `orders`
Tabla `pos_driver_locations`
Configuración nueva: ubicación del negocio, tarifa de envío, datos de pago
Rol `repartidor` disponible en Usuarios
No modifica ni borra nada existente.
Cómo desplegar
Sube todos los archivos (`server.js`, `wrangler.toml`, `public/index.html`, `public/menu.html`, `public/tarjeta.html`, `public/seguimiento.html`) y despliega.
Entra como admin → Configuración: revisa/ajusta la ubicación del negocio (o deja Pachuca centro por default), tarifa de envío, y datos de transferencia.
Menú: sube al menos una foto de prueba y usa la sugerencia de nombre en un producto nuevo.
Usuarios: crea un usuario de prueba con rol Repartidor.
Haz un pedido de prueba a domicilio desde `/menu.html`, asígnale el repartidor de prueba desde Órdenes, y activa "Compartir ubicación" desde el usuario repartidor para ver el flujo completo en `/seguimiento.html`.
Pendiente
Cargar las fotos de tu carpeta de Drive (pendiente de que conectes el acceso).
Costo de envío con ruta real por calle (hoy es línea recta) — requeriría un servicio de rutas, hay opciones gratuitas con límites que podemos evaluar si la línea recta no es suficientemente precisa para ti.
Clon de Uber para Pachuca (proyecto aparte, en pausa, listo para retomar).
