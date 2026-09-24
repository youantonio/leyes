-- RUSH POS v24.1 - Cambios en D1 (base: rush-pos-db)
-- Ejecutar en la CONSOLA SQL del dashboard de Cloudflare, una sentencia a la vez.
-- Solo AGREGAN columnas; no borran nada. Si una ya existe, marcará "duplicate column": ignorar.

ALTER TABLE orders ADD COLUMN items TEXT DEFAULT '[]';
ALTER TABLE orders ADD COLUMN custom_folio TEXT;
ALTER TABLE menu_items ADD COLUMN destination TEXT DEFAULT 'cocina';

-- v24.4: ya NO hace falta SQL para mandar bebidas a barra.
-- Se hace desde el sistema: Menú -> categoría -> "Toda a Barra".

-- v24.3: la tabla de sesiones (pos_sessions) la crea el Worker automáticamente.
-- Si quisieras crearla a mano:
-- CREATE TABLE IF NOT EXISTS pos_sessions (token TEXT PRIMARY KEY, user_id TEXT, username TEXT, name TEXT, role TEXT, expires_at INTEGER);
