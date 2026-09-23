export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      await ensureDatabase(env);
    } catch (err) {
      return json({ error: "Error inicializando la base de datos", detail: err?.message || String(err) }, 500);
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
      try {
        const response = await api(request, env, url);
        return withCors(response);
      } catch (err) {
        console.error(err);
        return withCors(json({ error: err?.message || "Server error" }, 500));
      }
    }
    return env.ASSETS.fetch(request);
  }
};

const SESSION_DAYS = 7;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => { headers.set(k, v); });
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

async function body(request) {
  const text = await request.text();
  if (!text || !text.trim()) throw new Error("La petición llegó sin datos.");
  try { return JSON.parse(text); } catch (error) { throw new Error("JSON inválido."); }
}

function nowIso() { return new Date().toISOString(); }
function futureIso(days) { return new Date(Date.now() + days * 86400000).toISOString(); }

function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const salt = saltHex || randomHex(16);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(salt), iterations: 10000, hash: "SHA-256" }, key, 256);
  const hash = [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
  return { salt, hash };
}

async function verifyPassword(password, salt, expectedHash) {
  const { hash } = await hashPassword(password, salt);
  return hash === expectedHash;
}

async function ensureDatabase(env) {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','mesero','cocina')),
        password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS menu_items (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT DEFAULT 'General', price REAL NOT NULL DEFAULT 0, description TEXT DEFAULT '', active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS "tables" (id TEXT PRIMARY KEY, number INTEGER NOT NULL, name TEXT DEFAULT '', type TEXT DEFAULT 'mesa', status TEXT DEFAULT 'available', capacity INTEGER DEFAULT 4, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, table_id TEXT, customer_name TEXT DEFAULT '', customer_phone TEXT DEFAULT '', notes TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'open', subtotal REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0, payment_status TEXT NOT NULL DEFAULT 'pending', payment_method TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, menu_item_id TEXT, name TEXT NOT NULL, qty REAL NOT NULL DEFAULT 1, unit_price REAL NOT NULL DEFAULT 0, modifiers TEXT DEFAULT '[]', notes TEXT DEFAULT '')`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cash_movements (id TEXT PRIMARY KEY, type TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, concept TEXT DEFAULT '', order_id TEXT, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS order_comments (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, user_name TEXT NOT NULL, role TEXT NOT NULL, comment TEXT NOT NULL, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS loyalty_customers (phone TEXT PRIMARY KEY, name TEXT NOT NULL, gender TEXT DEFAULT 'No especificado', birthday TEXT DEFAULT '', visits INTEGER DEFAULT 0, total_spent REAL DEFAULT 0, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT NOT NULL, stock REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY, inventory_id TEXT NOT NULL, supplier_name TEXT NOT NULL, supplier_rfc TEXT DEFAULT '', qty REAL NOT NULL, total_cost REAL NOT NULL, purchase_date TEXT NOT NULL, created_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS recipes (menu_item_id TEXT NOT NULL, inventory_id TEXT NOT NULL, qty REAL NOT NULL, PRIMARY KEY (menu_item_id, inventory_id))`),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS padel_courts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, hourly_rate REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS padel_reservations (
        id TEXT PRIMARY KEY, court_id TEXT NOT NULL, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL,
        date TEXT NOT NULL, start_time TEXT NOT NULL, hours REAL NOT NULL DEFAULT 1.5, total_price REAL NOT NULL,
        deposit REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'confirmed', order_id TEXT, created_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS cash_cuts (
        id TEXT PRIMARY KEY, cut_date TEXT NOT NULL, total_sales REAL NOT NULL, total_expenses REAL NOT NULL,
        net_profit REAL NOT NULL, closed_by TEXT NOT NULL, created_at TEXT NOT NULL
      )
    `)
  ]);

  try { await env.DB.prepare(`ALTER TABLE orders ADD COLUMN estimated_time INTEGER DEFAULT 0`).run(); } catch(e) {} 
  try { await env.DB.prepare(`ALTER TABLE orders ADD COLUMN print_requested INTEGER DEFAULT 0`).run(); } catch(e) {} 
  try { await env.DB.prepare(`ALTER TABLE orders ADD COLUMN customer_phone TEXT DEFAULT ''`).run(); } catch(e) {} 

  try {
    await env.DB.prepare(`DELETE FROM "tables" WHERE id NOT IN (SELECT MIN(id) FROM "tables" GROUP BY number, type)`).run();
  } catch(e) {}

  const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM users`).first();
  if (Number(count?.count || 0) === 0) {
    const t = nowIso();
    const { salt, hash } = await hashPassword("RushAdmin2026!");
    await env.DB.prepare(`INSERT INTO users (id, username, name, role, password_hash, password_salt, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).bind(crypto.randomUUID(), "admin", "Administrador", "admin", hash, salt, t, t).run();
  }

  const courtCount = await env.DB.prepare(`SELECT COUNT(*) AS count FROM padel_courts`).first();
  if (Number(courtCount?.count || 0) === 0) {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO padel_courts (id, name, hourly_rate, active) VALUES (?, ?, ?, 1)`).bind(crypto.randomUUID(), "Cancha 1 (Panorámica)", 450),
      env.DB.prepare(`INSERT INTO padel_courts (id, name, hourly_rate, active) VALUES (?, ?, ?, 1)`).bind(crypto.randomUUID(), "Cancha 2 (Estándar)", 400)
    ]);
  }
}

function getToken(request) {
  const h = request.headers.get("Authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return null;
}

async function auth(request, env) {
  const token = getToken(request);
  if (!token) return null;
  return await env.DB.prepare(`SELECT u.id, u.username, u.name, u.role, u.active, s.token, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1 AND s.expires_at > ?`).bind(token, nowIso()).first();
}

function requireRole(user, roles) { return (user && roles.includes(user.role)); }

async function api(request, env, url) {
  const p = url.pathname.replace(/^\/api\/?/, "");
  const [resource, id, action] = p.split("/");

  if (request.method === "GET" && resource === "health") return json({ ok: true, service: "RUSH POS", time: nowIso() });

  if (request.method === "POST" && resource === "login") {
    const d = await body(request);
    const username = String(d.username || "").trim().toLowerCase();
    const password = String(d.password || "");
    const user = await env.DB.prepare(`SELECT * FROM users WHERE username = ? AND active = 1`).bind(username).first();
    if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) return json({ error: "Credenciales incorrectas." }, 401);
    const token = randomHex(32);
    await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).bind(token, user.id, futureIso(SESSION_DAYS), nowIso()).run();
    return json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  }

  if (request.method === "POST" && resource === "logout") {
    const token = getToken(request);
    if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token=?`).bind(token).run();
    return json({ ok: true });
  }

  if (request.method === "GET" && resource === "me") {
    const user = await auth(request, env);
    if (!user) return json({ error: "No autenticado." }, 401);
    return json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  }

  const user = await auth(request, env);
  if (!user) return json({ error: "Sesión no válida o expirada." }, 401);

  /* CANCHAS Y RESERVAS */
  if (resource === "courts") {
    if (request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT * FROM padel_courts WHERE active=1`).all();
      return json(rows.results);
    }
  }

  if (resource === "reservations") {
    if (request.method === "GET") {
      const rows = await env.DB.prepare(`
        SELECT r.*, c.name as court_name 
        FROM padel_reservations r 
        JOIN padel_courts c ON r.court_id = c.id 
        ORDER BY r.date DESC, r.start_time ASC
      `).all();
      return json(rows.results);
    }
    if (request.method === "POST") {
      if (!requireRole(user, ["admin", "mesero"])) return json({ error: "Sin permiso." }, 403);
      const d = await body(request);
      const resId = crypto.randomUUID();
      const orderId = crypto.randomUUID();
      
      const subtotal = Number(d.total_price);
      const deposit = Number(d.deposit || 0);

      await env.DB.prepare(`
        INSERT INTO orders (id, customer_name, customer_phone, status, subtotal, discount, total, payment_status, created_at, updated_at)
        VALUES (?, ?, ?, 'open', ?, 0, ?, 'pending', ?, ?)
      `).bind(orderId, d.customer_name, d.customer_phone, subtotal, subtotal, nowIso(), nowIso()).run();

      await env.DB.prepare(`
        INSERT INTO order_items (order_id, name, qty, unit_price) VALUES (?, ?, 1, ?)
      `).bind(orderId, `Renta Cancha (${d.date} ${d.start_time})`, subtotal).run();

      if (deposit > 0) {
        await env.DB.prepare(`
          INSERT INTO cash_movements (id, type, amount, concept, order_id, created_at)
          VALUES (?, 'pago', ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), deposit, `Anticipo Reserva Cancha (${d.customer_name})`, orderId, nowIso()).run();
      }

      await env.DB.prepare(`
        INSERT INTO padel_reservations (id, court_id, customer_name, customer_phone, date, start_time, hours, total_price, deposit, status, order_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
      `).bind(resId, d.court_id, d.customer_name, d.customer_phone, d.date, d.start_time, Number(d.hours), subtotal, deposit, orderId, nowIso()).run();

      return json({ ok: true, orderId });
    }
  }

  /* CORTE DE CAJA */
  if (resource === "cuts") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    if (request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT * FROM cash_cuts ORDER BY created_at DESC LIMIT 30`).all();
      return json(rows.results);
    }
    if (request.method === "POST") {
      const today = new Date().toISOString().slice(0, 10);
      const s = await env.DB.prepare(`SELECT COALESCE(SUM(total),0) as sales FROM orders WHERE status='paid' AND substr(created_at,1,10)=?`).bind(today).first();
      const e = await env.DB.prepare(`SELECT COALESCE(SUM(total_cost),0) as expenses FROM purchases WHERE purchase_date=?`).bind(today).first();
      
      const cutId = crypto.randomUUID();
      const net = s.sales - e.expenses;

      await env.DB.prepare(`
        INSERT INTO cash_cuts (id, cut_date, total_sales, total_expenses, net_profit, closed_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(cutId, today, s.sales, e.expenses, net, user.name, nowIso()).run();

      return json({ ok: true, net });
    }
  }

  /* INVENTARIO, COMPRAS Y RECETAS */
  if (resource === "inventory") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    if (request.method === "GET") return json((await env.DB.prepare(`SELECT * FROM inventory ORDER BY name`).all()).results);
    if (request.method === "POST") {
      const d = await body(request);
      await env.DB.prepare(`INSERT INTO inventory (id, name, unit, stock, created_at) VALUES (?, ?, ?, 0, ?)`).bind(crypto.randomUUID(), d.name, d.unit, nowIso()).run();
      return json({ ok: true });
    }
  }

  if (resource === "purchases") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    if (request.method === "GET") return json((await env.DB.prepare(`SELECT p.*, i.name as item_name, i.unit FROM purchases p JOIN inventory i ON p.inventory_id = i.id ORDER BY p.purchase_date DESC LIMIT 100`).all()).results);
    if (request.method === "POST") {
      const d = await body(request);
      await env.DB.prepare(`INSERT INTO purchases (id, inventory_id, supplier_name, supplier_rfc, qty, total_cost, purchase_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), d.inventory_id, d.supplier_name, d.supplier_rfc || '', Number(d.qty), Number(d.total_cost), d.purchase_date, nowIso()).run();
      await env.DB.prepare(`UPDATE inventory SET stock = stock + ? WHERE id=?`).bind(Number(d.qty), d.inventory_id).run();
      return json({ ok: true });
    }
  }

  if (resource === "recipes") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    if (request.method === "GET" && !id) return json((await env.DB.prepare(`SELECT r.*, i.name as ing_name, i.unit FROM recipes r JOIN inventory i ON r.inventory_id = i.id`).all()).results);
    if (request.method === "POST") {
      const d = await body(request);
      await env.DB.prepare(`INSERT INTO recipes (menu_item_id, inventory_id, qty) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET qty=excluded.qty`).bind(d.menu_item_id, d.inventory_id, Number(d.qty)).run();
      return json({ ok: true });
    }
    if (request.method === "DELETE" && id && action) {
      await env.DB.prepare(`DELETE FROM recipes WHERE menu_item_id=? AND inventory_id=?`).bind(id, action).run();
      return json({ ok: true });
    }
  }

  /* LEALTAD Y CLIENTES */
  if (resource === "loyalty") {
    if (request.method === "GET" && !id) return json((await env.DB.prepare(`SELECT * FROM loyalty_customers ORDER BY visits DESC, name ASC`).all()).results);
    if (request.method === "GET" && id && action === "history") return json((await env.DB.prepare(`SELECT * FROM orders WHERE customer_phone=? AND status='paid' ORDER BY created_at DESC LIMIT 10`).bind(id).all()).results);
    if (request.method === "GET" && id && !action) return json(await env.DB.prepare(`SELECT * FROM loyalty_customers WHERE phone=?`).bind(id).first() || { error: "No encontrado" });
    if (request.method === "POST" && !id) {
      const d = await body(request);
      await env.DB.prepare(`INSERT INTO loyalty_customers (phone, name, gender, birthday, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name, gender=excluded.gender, birthday=excluded.birthday`).bind(d.phone, d.name, d.gender || "No especificado", d.birthday || "", nowIso()).run();
      return json({ ok: true });
    }
  }

  /* MENÚ */
  if (resource === "menu") {
    if (request.method === "GET") return json((await env.DB.prepare(`SELECT * FROM menu_items WHERE active = 1 ORDER BY category, sort_order, name`).all()).results);
    if (request.method === "POST") {
      if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
      const d = await body(request);
      await env.DB.prepare(`INSERT INTO menu_items (id, name, category, price, description, active, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)`).bind(crypto.randomUUID(), d.name, d.category || "General", Number(d.price || 0), d.description || "", Number(d.sort_order || 0)).run();
      return json({ ok: true });
    }
    if (request.method === "PATCH" && id) {
      if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
      await env.DB.prepare(`UPDATE menu_items SET active=0 WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }
  }

  /* MESAS */
  if (resource === "tables") {
    if (request.method === "GET") return json((await env.DB.prepare(`SELECT * FROM "tables" WHERE active=1 ORDER BY type, number`).all()).results);
    if (request.method === "PATCH" && id) {
      if (!requireRole(user, ["admin", "mesero"])) return json({ error: "Sin permiso." }, 403);
      const d = await body(request);
      await env.DB.prepare(`UPDATE "tables" SET status=? WHERE id=?`).bind(d.status, id).run();
      return json({ ok: true });
    }
  }

  /* ÓRDENES Y PAGOS */
  if (resource === "orders") {
    if (request.method === "GET" && id && !action) {
      const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`).bind(id).first();
      const items = await env.DB.prepare(`SELECT * FROM order_items WHERE order_id=? ORDER BY id`).bind(id).all();
      return json({ order, items: items.results });
    }
    if (request.method === "GET" && !id) {
      const status = url.searchParams.get("status");
      let q = `SELECT * FROM orders`; const args = [];
      if (status) { q += ` WHERE status=?`; args.push(status); }
      q += ` ORDER BY created_at DESC LIMIT 200`;
      return json((await env.DB.prepare(q).bind(...args).all()).results);
    }
    if (request.method === "POST" && !id) {
      if (!requireRole(user, ["admin", "mesero"])) return json({ error: "Solo mesero o administrador." }, 403);
      const data = await body(request);
      const orderId = crypto.randomUUID();
      const subtotal = data.items.reduce((s, x) => s + Number(x.qty || 1) * Number(x.unit_price || 0), 0);
      const total = Math.max(0, subtotal - Number(data.discount || 0));
      const phone = String(data.customer_phone || "").trim(); const custName = String(data.customer_name || "").trim();

      if (phone && custName) {
        await env.DB.prepare(`INSERT INTO loyalty_customers (phone, name, created_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name`).bind(phone, custName, nowIso()).run();
      }

      const stmts = [env.DB.prepare(`INSERT INTO orders (id, table_id, customer_name, customer_phone, notes, status, subtotal, discount, total, payment_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, 'pending', ?, ?)`).bind(orderId, data.table_id || null, custName, phone, data.notes || "", subtotal, Number(data.discount||0), total, nowIso(), nowIso())];
      for (const item of data.items) {
        stmts.push(env.DB.prepare(`INSERT INTO order_items (order_id, menu_item_id, name, qty, unit_price, modifiers, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(orderId, item.menu_item_id || null, item.name, Number(item.qty || 1), Number(item.unit_price || 0), JSON.stringify(item.modifiers || []), item.notes || ""));
      }
      await env.DB.batch(stmts);
      if (data.table_id && !["didi-eats","uber-eats","takeaway"].includes(data.table_id)) {
        await env.DB.prepare(`UPDATE "tables" SET status='occupied' WHERE id=?`).bind(data.table_id).run();
      }
      return json({ id: orderId, total }, 201);
    }

    if (request.method === "POST" && id && action === "payments") {
      if (!requireRole(user, ["admin", "mesero"])) return json({ error: "Sin permiso." }, 403);
      const d = await body(request); const amount = Number(d.amount || 0);
      await env.DB.prepare(`INSERT INTO cash_movements (id, type, amount, concept, order_id, created_at) VALUES (?, 'pago', ?, ?, ?, ?)`).bind(crypto.randomUUID(), amount, `Cobro orden ${id.slice(0,8)} - ${d.payer_name||'Cliente'}`, id, nowIso()).run();

      const order = await env.DB.prepare(`SELECT total FROM orders WHERE id=?`).bind(id).first();
      const paymentsSum = await env.DB.prepare(`SELECT SUM(amount) AS total FROM cash_movements WHERE order_id=? AND type='pago'`).bind(id).first();
      const isFullyPaid = Number(paymentsSum?.total || 0) >= Number(order?.total || 0) - 0.01;

      await env.DB.prepare(`UPDATE orders SET status=?, payment_status=?, closed_at=?, updated_at=? WHERE id=?`).bind(isFullyPaid ? "paid" : "ready", isFullyPaid ? "paid" : "partial", isFullyPaid ? nowIso() : null, nowIso(), id).run();

      if (isFullyPaid) {
        const ordInfo = await env.DB.prepare(`SELECT table_id, customer_phone, total FROM orders WHERE id=?`).bind(id).first();
        if (ordInfo?.table_id && !["didi-eats","uber-eats","takeaway"].includes(ordInfo.table_id)) {
          await env.DB.prepare(`UPDATE "tables" SET status='available' WHERE id=?`).bind(ordInfo.table_id).run();
        }
        if (ordInfo?.customer_phone) {
          await env.DB.prepare(`UPDATE loyalty_customers SET visits = visits + 1, total_spent = total_spent + ? WHERE phone = ?`).bind(ordInfo.total, ordInfo.customer_phone).run();
        }
        const orderItems = await env.DB.prepare(`SELECT menu_item_id, qty FROM order_items WHERE order_id=?`).bind(id).all();
        for (const item of orderItems.results) {
          if (!item.menu_item_id) continue;
          const recipe = await env.DB.prepare(`SELECT inventory_id, qty FROM recipes WHERE menu_item_id=?`).bind(item.menu_item_id).all();
          for (const ing of recipe.results) {
            await env.DB.prepare(`UPDATE inventory SET stock = stock - ? WHERE id=?`).bind(Number(ing.qty) * Number(item.qty), ing.inventory_id).run();
          }
        }
      }
      return json({ ok: true, isFullyPaid });
    }

    if (request.method === "DELETE" && id) {
      if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
      const ord = await env.DB.prepare(`SELECT table_id FROM orders WHERE id=?`).bind(id).first();
      if (ord?.table_id) await env.DB.prepare(`UPDATE "tables" SET status='available' WHERE id=?`).bind(ord.table_id).run();
      await env.DB.prepare(`DELETE FROM orders WHERE id=?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM order_items WHERE order_id=?`).bind(id).run();
      return json({ ok: true });
    }

    if (request.method === "PATCH" && id) {
      const data = await body(request);
      const sets = []; const vals = [];
      for (const k of ["status", "payment_status", "notes", "discount", "estimated_time", "print_requested"]) {
        if (data[k] !== undefined) { sets.push(`${k}=?`); vals.push(data[k]); }
      }
      sets.push("updated_at=?"); vals.push(nowIso(), id);
      await env.DB.prepare(`UPDATE orders SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }

    if (request.method === "GET" && id && action === "comments") return json((await env.DB.prepare(`SELECT * FROM order_comments WHERE order_id=? ORDER BY created_at ASC`).bind(id).all()).results);
    if (request.method === "POST" && id && action === "comments") {
      const d = await body(request);
      await env.DB.prepare(`INSERT INTO order_comments (id, order_id, user_name, role, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), id, user.name, user.role, d.comment || "", nowIso()).run();
      return json({ ok: true });
    }
  }

  /* DASHBOARD Y CAJA */
  if (resource === "dashboard") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    const today = new Date().toISOString().slice(0, 10);
    const s = await env.DB.prepare(`SELECT COALESCE(SUM(total),0) as sales, COUNT(*) as orders FROM orders WHERE status='paid' AND substr(created_at,1,10)=?`).bind(today).first();
    const e = await env.DB.prepare(`SELECT COALESCE(SUM(total_cost),0) as expenses FROM purchases WHERE purchase_date=?`).bind(today).first();
    const open = await env.DB.prepare(`SELECT COUNT(*) count FROM orders WHERE status IN ('open','preparing','ready')`).first();
    const kitchen = await env.DB.prepare(`SELECT COUNT(*) count FROM orders WHERE status IN ('open','preparing')`).first();
    return json({ today: { sales: s.sales, orders: s.orders, expenses: e.expenses }, open, kitchen });
  }

  /* USUARIOS */
  if (resource === "users") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    if (request.method === "GET" && !id) return json((await env.DB.prepare(`SELECT id, username, name, role, active, created_at FROM users`).all()).results);
    if (request.method === "POST" && !id) {
      const d = await body(request);
      const { salt, hash } = await hashPassword(d.password);
      await env.DB.prepare(`INSERT INTO users (id, username, name, role, password_hash, password_salt, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).bind(crypto.randomUUID(), d.username.toLowerCase(), d.name, d.role, hash, salt, nowIso(), nowIso()).run();
      return json({ ok: true });
    }
    if (request.method === "PATCH" && id) {
      const d = await body(request);
      if (d.password) {
        const { salt, hash } = await hashPassword(d.password);
        await env.DB.prepare(`UPDATE users SET password_hash=?, password_salt=?, updated_at=? WHERE id=?`).bind(hash, salt, nowIso(), id).run();
      }
      if (d.name) await env.DB.prepare(`UPDATE users SET name=?, updated_at=? WHERE id=?`).bind(d.name, nowIso(), id).run();
      return json({ ok: true });
    }
    if (request.method === "DELETE" && id) {
      if (id === user.id) return json({ error: "No puedes borrarte." }, 400);
      await env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(id).run();
      return json({ ok: true });
    }
  }

  return json({ error: "Ruta no encontrada" }, 404);
}
