-- RUSH POS v25.0 - Base de datos (D1: rush-pos-db)
-- NO ES OBLIGATORIO correr nada: el Worker crea todo automáticamente al primer uso.
-- Solo para VERIFICAR (consola SQL del dashboard, una consulta a la vez).

SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pos_%';
-- Deben aparecer: pos_sessions, pos_menu_sections, pos_menu_categories,
-- pos_settings, pos_loyalty, pos_cash_movements, pos_cuts, pos_inventory, pos_inventory_moves

PRAGMA table_info(orders);   -- deben aparecer channel y loyalty_consent
PRAGMA table_info(menu_items); -- debe aparecer sold_out

SELECT * FROM pos_settings;
SELECT phone, name, stamps, rewards_earned, rewards_redeemed FROM pos_loyalty ORDER BY updated_at DESC LIMIT 20;
SELECT folio, period_start, period_end, created_by FROM pos_cuts ORDER BY folio DESC LIMIT 10;
