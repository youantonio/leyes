RUSH POS v25.0 — "The Rush: Club · Café · Cocina"
Fecha: 25 de septiembre de 2026
Plataforma: Cloudflare Workers + D1 (`rush-pos-db`)
Estado de las versiones
Versión	Estado
v24.1 – v24.5	Base funcional: login, comandas por persona, Cocina/Barra separadas, catálogo tipo Starbucks, usuarios, lealtad básica (lista de clientes).
v25.0	Candidata a estable. Caja con cortes y métodos de pago, inventario, productos agotados, tarjeta de lealtad digital automática, página pública de menú y pedidos, pedidos externos (Rappi/Uber). Probada con pruebas automatizadas (servidor + lógica; algunas también con el frontend real). Falta confirmarla en producción.
No hay versión marcada como estable todavía.
---
1. Caja — ✅ funcionando
Dashboard con ventas de hoy, ventas desde el último corte, desglose por método de pago (efectivo/tarjeta/transferencia), egresos pendientes.
Top de productos del periodo (para saber qué se vende más).
Ingresos y egresos manuales, con historial y opción de borrar (solo si aún no entraron a un corte).
Corte de caja: cierra el periodo desde el último corte hasta ahora, calcula el efectivo esperado (efectivo cobrado + ingresos − egresos), permite anotar el efectivo contado físicamente y muestra la diferencia. Con folio consecutivo e historial.
Cobro con método de pago real: al cobrar una cuenta, se pregunta cómo pagó el cliente (efectivo/tarjeta/transferencia) y ya no se puede cobrar dos veces la misma cuenta.
2. Inventario — ✅ funcionando
Crear insumos (nombre, unidad, existencia inicial, mínimo de alerta).
Registrar movimientos (entradas y salidas, con motivo) — ya no solo "sumar".
No deja que el stock quede negativo.
Marca en rojo los insumos por debajo del mínimo.
Historial de movimientos.
3. Productos agotados — ✅ funcionando
Cada producto se puede marcar 🚫 Agotado, desde el Menú.
Desaparece (atenuado) de Venta y no se puede agregar al carrito.
La página pública tampoco lo deja pedir.
Se puede marcar ✅ Disponible en cualquier momento.
4. Orden de categorías — ✅ funcionando
Botones ⬆️⬇️ para subir/bajar categorías dentro de su sección.
---
5. Tarjeta de lealtad digital — ✅ funcionando (versión web, sin Apple/Google Wallet)
Cómo la diseñé: tomé el patrón de tus referencias (Hola Lealtad, Fiweex): tarjeta con sellos, QR/link único, vive en el celular del cliente, se actualiza sola. La diferencia importante:
> Una tarjeta **real** de Apple Wallet / Google Wallet requiere que tú tengas cuenta de desarrollador de Apple (paga, ~$99 USD/año) y un proyecto dado de alta en Google Wallet API. Yo no puedo generar esas credenciales por ti — son cuentas tuyas, con tu identidad legal. Lo que construí es el **equivalente funcional sin esas cuentas**: una página web con la tarjeta, que el cliente guarda como acceso directo en su pantalla de inicio (funciona igual de bien, solo no vive literalmente dentro de la app Wallet). El día que decidas dar de alta esas cuentas, es un paso adicional, no un rediseño.
Cómo funciona:
Al tomar una orden (mesero o página pública), se pregunta el WhatsApp del cliente y una casilla "Inscribir a tarjeta de lealtad", marcada por defecto, pero el cliente puede decir que no — no pasa nada si no deja sus datos.
Al cobrar una cuenta con consentimiento, el sistema suma 1 sello automáticamente. A los 10 sellos (configurable) se reinicia y se marca una recompensa ganada.
Desde Órdenes, el botón ⭐ Tarjeta abre WhatsApp con el link de la tarjeta del cliente, listo para enviar.
El cliente abre el link (`/tarjeta.html?token=...`) y ve su tarjeta: sellos, progreso, y si ya ganó su recompensa.
Configuras cuántos sellos se necesitan y cuál es la recompensa desde Configuración.
Seguridad: el link usa un token aleatorio, no el número de teléfono, para que nadie pueda adivinar la tarjeta de otro cliente.
6. Página pública del menú y pedidos — ✅ funcionando (`/menu.html`)
Diseñada con paletas y tipografía consistentes con "The Rush: Club · Café · Cocina" (ver sección de marca abajo).
El cliente entra, ve el menú por secciones y categorías (igual que en el admin), y elige:
🍽️ Estoy en el club → arma su pedido y lo manda por WhatsApp al número que configures (se abre WhatsApp con el pedido ya escrito).
🛵 A domicilio → elige entre:
📱 Directo (WhatsApp): arma su carrito aquí mismo y lo envía por WhatsApp, con nombre, teléfono y dirección.
🛵 Rappi / 🚗 Uber Eats: lo manda directo al link que configures de cada plataforma (tu menú ahí es independiente; aquí solo es la puerta de entrada).
Igual pide WhatsApp y nombre, con la misma casilla de lealtad.
No cobra en línea — todo pedido directo se resuelve por WhatsApp (cuenta, transferencia, o pago al llegar), como pediste.
7. Pedidos externos (Rappi / Uber) — ✅ funcionando
En Órdenes → 🛵 Capturar pedido externo: el admin o mesero arma el pedido que llegó por Rappi/Uber/WhatsApp y lo manda directo a Cocina/Barra, con folio y etiqueta de canal (🛵 Rappi, 🚗 Uber Eats, 📱 Domicilio directo) visible en Cocina, Barra, Órdenes y el ticket.
8. Configuración — ✅ nueva pantalla
Nombre del negocio, WhatsApp para pedidos, links de Rappi y Uber, meta y recompensa de lealtad, y el link para compartir la página pública del menú.
---
Lo que pediste y NO construí — con la razón exacta
Bot de WhatsApp con IA que responde solo. Automatizarlo dejando WhatsApp Web abierto en una compu no es estable (se cae, se desconecta) y viola los Términos de Servicio de WhatsApp, lo que arriesga que bloqueen tu número — un riesgo real para un negocio que depende de ese número. La forma correcta y sostenible es la API oficial de WhatsApp Business de Meta: es de pago, tú la das de alta como dueño del negocio (verificación de empresa incluida), y desde ahí sí puedo conectar un flujo de preguntas frecuentes y guion de ventas. Es un proyecto de la siguiente fase, no algo que dependa de código.
Rastreo en tiempo real del repartidor (tipo Uber/Waze), con mapa y "cuánto falta". Eso requiere una app con acceso al GPS del celular del repartidor, actualizando su posición en vivo — no es algo que una página web haga de forma confiable ni con buena batería. Lo que sí puedo construir ahora, si quieres, es una versión honesta: el repartidor entra desde su celular, ve la dirección, y va actualizando su estatus a mano (Salió / En camino / Entregado) con botones grandes; el cliente ve ese estatus (no un mapa moviéndose). El mapa en vivo real es un proyecto de app nativa aparte.
Perfil de repartidor con QR/link temporal, asignación, costo de envío automático (tipo Uber/DiDi). No lo incluí en esta versión por el tamaño del corte — es la siguiente pieza lógica una vez que decidamos cómo va lo de WhatsApp (porque ahí es donde definimos si el pedido "entra" al sistema automático o el admin lo sigue capturando a mano como en el punto 7).
Marca unificada: "The Rush · Club, Café & Cocina"
Usé principios de psicología del color y de marketing de restaurantes:
Verde oscuro (#0f2f26) como color ancla: transmite el club deportivo (pádel, aire libre) sin caer en el naranja genérico de delivery.
Dorado (#f2a71b) como acento: es el color que en cafeterías/restaurantes se asocia con "premium" y "recompensa" — lo uso en los sellos de lealtad y precios.
Naranja (cocina) y verde-azulado (barra) como códigos de color internos, ya existentes en tu sistema, ahora también visibles en la página pública (para que el cliente entienda, sin que se lo tengas que explicar, qué es comida y qué es bebida).
El nombre "The Rush · Club, Café & Cocina" aparece en el encabezado de la página pública y de la tarjeta, dejando claro desde el primer segundo que es club + café + comida — resolviendo la confusión que mencionaste.
Esto es un punto de partida sólido, no un diseño cerrado: cuando tengas tu logo final o paleta de marca ya definida, la aplico directamente.
D1: qué cambia en la base de datos
No tienes que correr SQL. El Worker crea automáticamente, en el primer uso:
Tablas `pos_settings`, `pos_loyalty`, `pos_cash_movements`, `pos_cuts`, `pos_inventory`, `pos_inventory_moves`
Columnas nuevas en `orders`: `channel`, `loyalty_consent`
Columna nueva en `menu_items`: `sold_out`
Configuración inicial (nombre del negocio, meta de lealtad, etc.)
No modifica ni borra nada existente. `sql/migracion_d1.sql` trae consultas de verificación, por si quieres confirmarlo tú mismo.
Cómo desplegar
Sube `server.js`, `wrangler.toml`, `public/index.html`, `public/menu.html` y `public/tarjeta.html`, y despliega.
Entra como administrador a la app principal.
Ve a ⚙️ Configuración y llena: nombre del negocio, tu WhatsApp de pedidos, links de Rappi/Uber, meta y recompensa de lealtad.
Copia el link de "Página pública del menú" y pruébalo en tu celular.
Haz una venta de prueba con WhatsApp real, cóbrala, y toca ⭐ Tarjeta para ver el flujo completo.
Pendiente (roadmap sugerido)
Fase B — WhatsApp Business API oficial (requiere que tú des de alta cuenta de Meta Business): preguntas frecuentes automáticas, guion de ventas, y que los pedidos de la página pública lleguen ya estructurados a un panel en vez de solo abrir WhatsApp.
Fase C — Repartidores: perfil de repartidor, asignación desde admin, estatus manual (salió/en camino/entregado) visible para el cliente.
Fase D — Costo de envío automático y mapa en tiempo real (requiere definir presupuesto para app nativa o SDK de mapas).
Notas por producto/persona (hoy son por comanda completa).
Canje de recompensa integrado al cobro (hoy es un endpoint listo, `/api/loyalty-redeem`, pero falta el botón en la pantalla de Órdenes).
