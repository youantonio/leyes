-- RUSH POS v24.5 - Base de datos (D1: rush-pos-db)
-- NO ES OBLIGATORIO correr nada: el Worker crea todo automáticamente al primer uso.
-- Estas consultas son solo para VERIFICAR (consola SQL del dashboard, una a la vez).

-- 1) Deben aparecer pos_menu_sections, pos_menu_categories (y pos_sessions):
SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pos_%';

-- 2) Debe aparecer la columna category_id:
PRAGMA table_info(menu_items);

-- 3) Estructura del menú:
SELECT s.name AS seccion, s.destination AS estacion, c.name AS categoria
  FROM pos_menu_categories c JOIN pos_menu_sections s ON s.id = c.section_id
 ORDER BY s.sort_order, c.sort_order;

-- 4) Productos sin clasificar:
SELECT name, category FROM menu_items WHERE active=1 AND (category_id IS NULL OR category_id='');

-- ---- Solo si el Worker no pudo crearlas (poco probable): equivalentes manuales ----
-- CREATE TABLE IF NOT EXISTS pos_menu_sections (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '', destination TEXT NOT NULL DEFAULT 'cocina', sort_order INTEGER DEFAULT 0);
-- CREATE TABLE IF NOT EXISTS pos_menu_categories (id TEXT PRIMARY KEY, section_id TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0);
-- ALTER TABLE menu_items ADD COLUMN category_id TEXT;
-- CREATE TABLE IF NOT EXISTS pos_sessions (token TEXT PRIMARY KEY, user_id TEXT, username TEXT, name TEXT, role TEXT, expires_at INTEGER);

-- Históricos (ya ejecutados en versiones anteriores):
-- ALTER TABLE orders ADD COLUMN items TEXT DEFAULT '[]';
-- ALTER TABLE orders ADD COLUMN custom_folio TEXT;
-- ALTER TABLE menu_items ADD COLUMN destination TEXT DEFAULT 'cocina';
