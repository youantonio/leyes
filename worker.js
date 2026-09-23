export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      await ensureDatabase(env);
    } catch (err) {
      return json({
        error: "Error inicializando la base de datos",
        detail: err?.message || String(err)
      }, 500);
    }

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: corsHeaders()
        });
      }

      try {
        const response = await api(request, env, url);
        return withCors(response);
      } catch (err) {
        console.error(err);

        return withCors(
          json({
            error: err?.message || "Server error"
          }, 500)
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};


const SESSION_DAYS = 7;


/* =========================================================
   CORS
========================================================= */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => {
    headers.set(k, v);
  });
  return new Response(response.body, {
    status: response.status,
    headers
  });
}


/* =========================================================
   RESPUESTAS
========================================================= */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  );
}

async function body(request) {
  const text = await request.text();
  if (!text || !text.trim()) {
    throw new Error("La petición llegó sin datos.");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("JSON inválido recibido por el servidor.");
  }
}


/* =========================================================
   FECHAS
========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function futureIso(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}


/* =========================================================
   CRIPTOGRAFÍA
========================================================= */

function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const salt = saltHex || randomHex(16);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(salt),
      iterations: 10000,
      hash: "SHA-256"
    },
    key,
    256
  );
  const hash = [...new Uint8Array(bits)].map(x => x.toString(16).padStart(2, "0")).join("");
  return { salt, hash };
}

async function verifyPassword(password, salt, expectedHash) {
  const { hash } = await hashPassword(password, salt);
  return hash === expectedHash;
}


/* =========================================================
   BASE DE DATOS Y TABLAS
========================================================= */

async function ensureDatabase(env) {

  await env.DB.batch([

    // Usuarios
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','mesero','cocina')),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),

    // Sesiones
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),

    // Menú de productos
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT DEFAULT 'General',
        price REAL NOT NULL DEFAULT 0,
        description TEXT DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    // Mesas y Delivery
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS "tables" (
        id TEXT PRIMARY KEY,
        number INTEGER NOT NULL,
        name TEXT DEFAULT '',
        type TEXT DEFAULT 'mesa',
        status TEXT DEFAULT 'available',
        capacity INTEGER DEFAULT 4,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    // Órdenes
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        table_id TEXT,
        customer_name TEXT DEFAULT '',
        customer_phone TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        subtotal REAL NOT NULL DEFAULT 0,
        discount REAL NOT NULL DEFAULT 0,
        total REAL NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'pending',
        payment_method TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      )
    `),

    // Items de las órdenes
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        menu_item_id TEXT,
        name TEXT NOT NULL,
        qty REAL NOT NULL DEFAULT 1,
        unit_price REAL NOT NULL DEFAULT 0,
        modifiers TEXT DEFAULT '[]',
        notes TEXT DEFAULT ''
      )
    `),

    // Caja y Finanzas
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS cash_movements (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        concept TEXT DEFAULT '',
        order_id TEXT,
        created_at TEXT NOT NULL
      )
    `),
    
    // Chat de Cocina
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS order_comments (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        role TEXT NOT NULL,
        comment TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),

    // Clientes Leales (CRM)
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS loyalty_customers (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        gender TEXT DEFAULT 'No especificado',
        birthday TEXT DEFAULT '',
        visits INTEGER DEFAULT 0,
        total_spent REAL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `),

    // 📦 Inventario de Insumos
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        unit TEXT NOT NULL,
        stock REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `),

    // 📦 Compras a Proveedores
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY,
        inventory_id TEXT NOT NULL,
        supplier_name TEXT NOT NULL,
        supplier_rfc TEXT DEFAULT '',
        qty REAL NOT NULL,
        total_cost REAL NOT NULL,
        purchase_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),

    // 📦 Recetas (BOM - Bill of Materials)
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS recipes (
        menu_item_id TEXT NOT NULL,
        inventory_id TEXT NOT NULL,
        qty REAL NOT NULL,
        PRIMARY KEY (menu_item_id, inventory_id)
      )
    `)

  ]);

  // Migraciones (por si las tablas ya existían antes de añadir columnas)
  try { await env.DB.prepare(`ALTER TABLE orders ADD COLUMN estimated_time INTEGER DEFAULT 0`).run(); } catch(e) {} 
  try { await env.DB.prepare(`ALTER TABLE orders ADD COLUMN print_requested INTEGER DEFAULT 0`).run(); } catch(e) {} 
  try { await env.DB.prepare(`ALTER TABLE orders ADD COLUMN customer_phone TEXT DEFAULT ''`).run(); } catch(e) {} 


  /* =======================================================
     USUARIOS INICIALES (SEMILLA)
  ======================================================= */
  const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM users`).first();

  if (Number(count?.count || 0) === 0) {
    const t = nowIso();
    const seeds = [
      ["admin", "Administrador", "admin", "RushAdmin2026!"],
      ["mesero", "Mesero", "mesero", "RushMesero2026!"],
      ["cocina", "Cocina", "cocina", "RushCocina2026!"]
    ];

    const stmts = [];
    for (const [username, name, role, password] of seeds) {
      const { salt, hash } = await hashPassword(password);
      stmts.push(
        env.DB.prepare(`
          INSERT INTO users (id, username, name, role, password_hash, password_salt, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `)
        .bind(crypto.randomUUID(), username, name, role, hash, salt, t, t)
      );
    }
    await env.DB.batch(stmts);
  }

  /* =======================================================
     MESAS INICIALES Y DELIVERY
  ======================================================= */
  const tableCount = await env.DB.prepare(`SELECT COUNT(*) AS count FROM "tables"`).first();

  if (Number(tableCount?.count || 0) === 0) {
    const stmts = [];
    
    // Mesas físicas (1 a 12)
    for (let i = 1; i <= 12; i++) {
      stmts.push(
        env.DB.prepare(`INSERT INTO "tables" (id, number, name, type, status, capacity, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
        .bind(crypto.randomUUID(), i, `Mesa ${i}`, "mesa", "available", 4)
      );
    }

    // Mesas de Delivery / Plataformas Externas
    stmts.push(
      env.DB.prepare(`INSERT INTO "tables" (id, number, name, type, status, capacity, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .bind("didi-eats", 101, "🛵 Didi Food", "delivery", "available", 0)
    );
    stmts.push(
      env.DB.prepare(`INSERT INTO "tables" (id, number, name, type, status, capacity, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .bind("uber-eats", 102, "🛵 Uber Eats", "delivery", "available", 0)
    );
    stmts.push(
      env.DB.prepare(`INSERT INTO "tables" (id, number, name, type, status, capacity, active) VALUES (?, ?, ?, ?, ?, ?, 1)`)
      .bind("takeaway", 103, "🛍️ Para Llevar", "takeaway", "available", 0)
    );

    await env.DB.batch(stmts);
  }

  /* =======================================================
     MENÚ INICIAL COMPLETO RUSH PÁDEL
  ======================================================= */
  const menuCount = await env.DB.prepare(`SELECT COUNT(*) AS count FROM menu_items`).first();

  if (Number(menuCount?.count || 0) === 0) {
    const menu = [
      // ALIMENTOS
      ["Hamburguesa Clásica", "Alimentos", 149, "Hamburguesa de res con queso, lechuga, jitomate y papas.", 1],
      ["Hamburguesa BBQ", "Alimentos", 169, "Hamburguesa de res, queso, tocino y salsa BBQ con papas.", 2],
      ["Chicken Burger", "Alimentos", 159, "Hamburguesa de pollo empanizado con lechuga y aderezo.", 3],
      ["Club Sandwich", "Alimentos", 159, "Sándwich de pollo, jamón, queso, lechuga y jitomate con papas.", 4],
      ["Quesadillas", "Alimentos", 119, "Quesadillas de queso acompañadas de guacamole.", 5],
      ["Nachos con Queso", "Alimentos", 129, "Totopos con queso, jalapeños y pico de gallo.", 6],
      ["Nachos con Carne", "Alimentos", 169, "Totopos con queso, carne, jalapeños y pico de gallo.", 7],
      ["Boneless", "Alimentos", 179, "Boneless de pollo con aderezo y papas.", 8],
      ["Alitas", "Alimentos", 179, "Alitas de pollo con salsa a elegir y apio.", 9],
      ["Papas a la Francesa", "Alimentos", 89, "Papas a la francesa.", 10],
      ["Papas con Queso y Tocino", "Alimentos", 119, "Papas a la francesa con queso y tocino.", 11],
      ["Ensalada César", "Alimentos", 149, "Lechuga, pollo, parmesano y aderezo César.", 12],
      ["Pizza Individual", "Alimentos", 169, "Pizza individual. Ingredientes según disponibilidad.", 13],
      
      // DESAYUNOS
      ["Chilaquiles", "Desayunos", 139, "Chilaquiles rojos o verdes con crema, queso y huevo.", 20],
      ["Huevos al Gusto", "Desayunos", 119, "Huevos preparados al gusto con frijoles y pan.", 21],
      ["Molletes", "Desayunos", 109, "Molletes con frijoles, queso y pico de gallo.", 22],
      ["Hot Cakes", "Desayunos", 109, "Hot cakes con miel y fruta.", 23],
      ["Avocado Toast", "Desayunos", 129, "Pan tostado con aguacate y huevo.", 24],
      
      // CAFÉ
      ["Espresso", "Café", 45, "Espresso sencillo.", 30],
      ["Americano", "Café", 49, "Café americano.", 31],
      ["Cappuccino", "Café", 65, "Cappuccino.", 32],
      ["Latte", "Café", 69, "Café latte.", 33],
      ["Latte Vainilla", "Café", 75, "Latte con vainilla.", 34],
      ["Chocolate Caliente", "Café", 69, "Chocolate caliente.", 35],
      ["Té", "Café", 49, "Té caliente.", 36],
      
      // BEBIDAS
      ["Agua Natural", "Bebidas", 35, "Agua embotellada.", 40],
      ["Agua Mineral", "Bebidas", 45, "Agua mineral.", 41],
      ["Refresco", "Bebidas", 45, "Refresco en presentación individual.", 42],
      ["Agua de Jamaica", "Bebidas", 49, "Agua fresca de jamaica.", 43],
      ["Agua de Horchata", "Bebidas", 49, "Agua fresca de horchata.", 44],
      ["Limonada", "Bebidas", 59, "Limonada natural.", 45],
      ["Naranjada", "Bebidas", 59, "Naranjada natural.", 46],
      ["Smoothie de Frutos Rojos", "Bebidas", 89, "Smoothie de frutos rojos.", 47],
      ["Smoothie de Mango", "Bebidas", 89, "Smoothie de mango.", 48],
      
      // SNACKS
      ["Barra de Granola", "Snacks", 45, "Barra de granola.", 60],
      ["Fruta de Temporada", "Snacks", 69, "Porción de fruta de temporada.", 61],
      ["Yogurt con Granola", "Snacks", 79, "Yogurt con fruta y granola.", 62]
    ];

    const stmts = menu.map(([name, category, price, description, sortOrder]) =>
      env.DB.prepare(`
        INSERT INTO menu_items (id, name, category, price, description, active, sort_order)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).bind(crypto.randomUUID(), name, category, price, description, sortOrder)
    );

    await env.DB.batch(stmts);
  }
}


/* =========================================================
   SESIONES Y PERMISOS
========================================================= */

function getToken(request) {
  const h = request.headers.get("Authorization") || "";
  if (h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  return null;
}

async function auth(request, env) {
  const token = getToken(request);
  if (!token) return null;

  return await env.DB.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.active, s.token, s.expires_at
    FROM sessions s 
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND u.active = 1 AND s.expires_at > ?
  `).bind(token, nowIso()).first();
}

function requireRole(user, roles) {
  return (user && roles.includes(user.role));
}


/* =========================================================
   CONTROLADOR PRINCIPAL DE LA API
========================================================= */

async function api(request, env, url) {
  const p = url.pathname.replace(/^\/api\/?/, "");
  const [resource, id, action] = p.split("/");

  // 1. HEALTH CHECK
  if (request.method === "GET" && resource === "health") {
    return json({ ok: true, service: "RUSH POS", time: nowIso() });
  }

  // 2. LOGIN
  if (request.method === "POST" && resource === "login") {
    const d = await body(request);
    const username = String(d.username || "").trim().toLowerCase();
    const password = String(d.password || "");

    if (!username || !password) return json({ error: "Usuario y contraseña requeridos." }, 400);

    const user = await env.DB.prepare(`SELECT * FROM users WHERE username = ? AND active = 1`).bind(username).first();
    if (!user) return json({ error: "Usuario incorrecto." }, 401);

    const isValid = await verifyPassword(password, user.password_salt, user.password_hash);
    if (!isValid) return json({ error: "Contraseña incorrecta." }, 401);

    const token = randomHex(32);
    await env.DB.prepare(`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`).bind(token, user.id, futureIso(SESSION_DAYS), nowIso()).run();
    
    return json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  }

  // 3. LOGOUT
  if (request.method === "POST" && resource === "logout") {
    const token = getToken(request);
    if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token=?`).bind(token).run();
    return json({ ok: true });
  }

  // 4. DATOS DEL USUARIO ACTUAL (ME)
  if (request.method === "GET" && resource === "me") {
    const user = await auth(request, env);
    if (!user) return json({ error: "No autenticado." }, 401);
    return json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
  }

  // AUTENTICACIÓN GLOBAL PARA LAS SIGUIENTES RUTAS
  const user = await auth(request, env);
  if (!user) return json({ error: "Sesión no válida o expirada." }, 401);


  /* =======================================================
     INVENTARIO, COMPRAS Y RECETAS (BOM)
  ======================================================= */
  if (resource === "inventory") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    
    if (request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT * FROM inventory ORDER BY name`).all();
      return json(rows.results);
    }
    
    if (request.method === "POST") {
      const d = await body(request);
      const newId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO inventory (id, name, unit, stock, created_at) 
        VALUES (?, ?, ?, 0, ?)
      `).bind(newId, d.name, d.unit, nowIso()).run();
      return json({ ok: true });
    }
  }

  if (resource === "purchases") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    
    if (request.method === "GET") {
      const rows = await env.DB.prepare(`
        SELECT p.*, i.name as item_name, i.unit 
        FROM purchases p 
        JOIN inventory i ON p.inventory_id = i.id 
        ORDER BY p.purchase_date DESC LIMIT 100
      `).all();
      return json(rows.results);
    }
    
    if (request.method === "POST") {
      const d = await body(request);
      const newId = crypto.randomUUID();
      
      // Registrar la compra
      await env.DB.prepare(`
        INSERT INTO purchases (id, inventory_id, supplier_name, supplier_rfc, qty, total_cost, purchase_date, created_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(newId, d.inventory_id, d.supplier_name, d.supplier_rfc || '', Number(d.qty), Number(d.total_cost), d.purchase_date, nowIso()).run();
      
      // Sumar al inventario general
      await env.DB.prepare(`UPDATE inventory SET stock = stock + ? WHERE id=?`).bind(Number(d.qty), d.inventory_id).run();
      
      return json({ ok: true });
    }
  }

  if (resource === "recipes") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    
    if (request.method === "GET" && !id) {
      const rows = await env.DB.prepare(`
        SELECT r.*, i.name as ing_name, i.unit 
        FROM recipes r 
        JOIN inventory i ON r.inventory_id = i.id
      `).all();
      return json(rows.results);
    }
    
    if (request.method === "POST") {
      const d = await body(request);
      await env.DB.prepare(`
        INSERT INTO recipes (menu_item_id, inventory_id, qty) 
        VALUES (?, ?, ?) 
        ON CONFLICT DO UPDATE SET qty=excluded.qty
      `).bind(d.menu_item_id, d.inventory_id, Number(d.qty)).run();
      return json({ ok: true });
    }
    
    if (request.method === "DELETE" && id && action) {
      await env.DB.prepare(`DELETE FROM recipes WHERE menu_item_id=? AND inventory_id=?`).bind(id, action).run();
      return json({ ok: true });
    }
  }


  /* =======================================================
     CLIENTES LEALES (LOYALTY)
  ======================================================= */
  if (resource === "loyalty") {
    if (request.method === "GET" && !id) {
      const rows = await env.DB.prepare(`SELECT * FROM loyalty_customers ORDER BY visits DESC, name ASC`).all();
      return json(rows.results);
    }
    
    // Obtener historial de compras del cliente
    if (request.method === "GET" && id && action === "history") {
      const rows = await env.DB.prepare(`
        SELECT * FROM orders 
        WHERE customer_phone=? AND status='paid' 
        ORDER BY created_at DESC LIMIT 10
      `).bind(id).all();
      return json(rows.results);
    }
    
    // Buscar un cliente específico
    if (request.method === "GET" && id && !action) {
      const customer = await env.DB.prepare(`SELECT * FROM loyalty_customers WHERE phone=?`).bind(id).first();
      return json(customer || { error: "Cliente no encontrado" }, customer ? 200 : 404);
    }
    
    // Crear o actualizar un cliente desde la venta
    if (request.method === "POST" && !id) {
      const d = await body(request);
      const phone = String(d.phone || "").trim();
      const name = String(d.name || "").trim();
      
      if (!phone || !name) return json({ error: "Teléfono y nombre son obligatorios." }, 400);

      await env.DB.prepare(`
        INSERT INTO loyalty_customers (phone, name, gender, birthday, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET name=excluded.name, gender=excluded.gender, birthday=excluded.birthday
      `).bind(phone, name, d.gender || "No especificado", d.birthday || "", nowIso()).run();
      
      return json({ ok: true, phone, name });
    }
  }


  /* =======================================================
     MENÚ
  ======================================================= */
  if (resource === "menu") {
    if (request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT * FROM menu_items WHERE active = 1 ORDER BY category, sort_order, name`).all();
      return json(rows.results);
    }
    
    if (request.method === "POST") {
      if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
      const d = await body(request);
      const newId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO menu_items (id, name, category, price, description, active, sort_order) 
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).bind(newId, d.name, d.category || "General", Number(d.price || 0), d.description || "", Number(d.sort_order || 0)).run();
      return json({ id: newId }, 201);
    }
  }


  /* =======================================================
     MESAS
  ======================================================= */
  if (resource === "tables") {
    if (request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT * FROM "tables" WHERE active=1 ORDER BY type, number`).all();
      return json(rows.results);
    }
    
    if (request.method === "PATCH" && id) {
      if (!requireRole(user, ["admin", "mesero"])) return json({ error: "Sin permiso." }, 403);
      const d = await body(request);
      await env.DB.prepare(`UPDATE "tables" SET status=? WHERE id=?`).bind(d.status, id).run();
      return json({ ok: true });
    }
  }


  /* =======================================================
     ÓRDENES
  ======================================================= */
  if (resource === "orders") {
    
    // Obtener una orden específica con sus items
    if (request.method === "GET" && id && !action) {
      const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`).bind(id).first();
      if (!order) return json({ error: "Orden no encontrada." }, 404);
      const items = await env.DB.prepare(`SELECT * FROM order_items WHERE order_id=? ORDER BY id`).bind(id).all();
      return json({ order, items: items.results });
    }

    // Listar todas las órdenes
    if (request.method === "GET" && !id) {
      const status = url.searchParams.get("status");
      let q = `SELECT * FROM orders`;
      const args = [];
      if (status) { q += ` WHERE status=?`; args.push(status); }
      q += ` ORDER BY created_at DESC LIMIT 200`;
      const rows = await env.DB.prepare(q).bind(...args).all();
      return json(rows.results);
    }

    // CREAR NUEVA ORDEN (Desde la pantalla de ventas)
    if (request.method === "POST" && !id) {
      if (!requireRole(user, ["admin", "mesero"])) return json({ error: "Solo mesero o administrador." }, 403);
      const data = await body(request);
      if (!data.items?.length) return json({ error: "La orden necesita al menos un producto." }, 400);
      
      const orderId = crypto.randomUUID();
      const now = nowIso();
      const subtotal = data.items.reduce((s, x) => s + Number(x.qty || 1) * Number(x.unit_price || 0), 0);
      const discount = Number(data.discount || 0);
      const total = Math.max(0, subtotal - discount);
      
      const phone = String(data.customer_phone || "").trim();
      const custName = String(data.customer_name || "").trim();

      // Registro automático en Loyalty
      if (phone && custName) {
        await env.DB.prepare(`
          INSERT INTO loyalty_customers (phone, name, gender, birthday, created_at)
          VALUES (?, ?, 'No especificado', '', ?)
          ON CONFLICT(phone) DO UPDATE SET name=excluded.name
        `).bind(phone, custName, now).run();
      }

      const stmts = [
        env.DB.prepare(`
          INSERT INTO orders (id, table_id, customer_name, customer_phone, notes, status, subtotal, discount, total, payment_status, payment_method, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(orderId, data.table_id || null, custName, phone, data.notes || "", "open", subtotal, discount, total, "pending", "", now, now)
      ];

      for (const item of data.items) {
        stmts.push(env.DB.prepare(`
          INSERT INTO order_items (order_id, menu_item_id, name, qty, unit_price, modifiers, notes) 
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(orderId, item.menu_item_id || null, item.name, Number(item.qty || 1), Number(item.unit_price || 0), JSON.stringify(item.modifiers || []), item.notes || ""));
      }
      
      await env.DB.batch(stmts);

      // Si es una mesa de restaurante (no delivery), cambiar estado a ocupada
      if (data.table_id && !["didi-eats","uber-eats","takeaway"].includes(data.table_id)) {
        await env.DB.prepare(`UPDATE "tables" SET status='occupied' WHERE id=?`).bind(data.table_id).run();
      }
      
      return json({ id: orderId, subtotal, discount, total, status: "open" }, 201);
    }

    // REGISTRAR PAGOS (Parciales o Totales) + DESCUENTO DE INVENTARIO
    if (request.method === "POST" && id && action === "payments") {
      if (!requireRole(user, ["admin", "mesero"])) return json({ error: "Sin permiso para cobrar." }, 403);
      const d = await body(request);
      const amount = Number(d.amount || 0);

      const movementId = crypto.randomUUID();
      let concept = `Cobro orden ${id.slice(0, 8)} - ${d.payer_name || 'Cliente'} (${d.method})`;
      if (d.terminal_reference) concept += ` [Ref: ${d.terminal_reference}]`;

      // 1. Guardar el movimiento de dinero en caja
      await env.DB.prepare(`
        INSERT INTO cash_movements (id, type, amount, concept, order_id, created_at) 
        VALUES (?, 'pago', ?, ?, ?, ?)
      `).bind(movementId, amount, concept, id, nowIso()).run();

      // 2. Revisar si con este pago ya se cubrió el total de la orden
      const order = await env.DB.prepare(`SELECT total FROM orders WHERE id=?`).bind(id).first();
      const paymentsSum = await env.DB.prepare(`SELECT SUM(amount) AS total FROM cash_movements WHERE order_id=? AND type='pago'`).bind(id).first();
      const totalPaid = Number(paymentsSum?.total || 0);
      const isFullyPaid = totalPaid >= Number(order?.total || 0) - 0.01;

      // 3. Actualizar la orden
      await env.DB.prepare(`
        UPDATE orders 
        SET status=?, payment_status=?, payment_method=?, closed_at=?, updated_at=? 
        WHERE id=?
      `).bind(isFullyPaid ? "paid" : "ready", isFullyPaid ? "paid" : "partial", d.method, isFullyPaid ? nowIso() : null, nowIso(), id).run();

      // 4. Si ya se pagó completa, procesar cierre final
      if (isFullyPaid) {
        const ordInfo = await env.DB.prepare(`SELECT table_id, customer_phone, total FROM orders WHERE id=?`).bind(id).first();
        
        // Liberar mesa si aplica
        if (ordInfo?.table_id && !["didi-eats","uber-eats","takeaway"].includes(ordInfo.table_id)) {
          await env.DB.prepare(`UPDATE "tables" SET status='available' WHERE id=?`).bind(ordInfo.table_id).run();
        }
        
        // Actualizar métricas del cliente leal
        if (ordInfo && ordInfo.customer_phone) {
          await env.DB.prepare(`
            UPDATE loyalty_customers 
            SET visits = visits + 1, total_spent = total_spent + ? 
            WHERE phone = ?
          `).bind(ordInfo.total, ordInfo.customer_phone).run();
        }

        // ==========================================
        // 🔴 DESCUENTO DE INVENTARIO AUTOMÁTICO 🔴
        // ==========================================
        const orderItems = await env.DB.prepare(`SELECT menu_item_id, qty FROM order_items WHERE order_id=?`).bind(id).all();
        
        for (const item of orderItems.results) {
          if (!item.menu_item_id) continue;
          
          // Buscar qué receta tiene ese platillo
          const recipe = await env.DB.prepare(`SELECT inventory_id, qty FROM recipes WHERE menu_item_id=?`).bind(item.menu_item_id).all();
          
          for (const ing of recipe.results) {
            // Restar la cantidad de la receta multiplicada por la cantidad de platillos pedidos
            const amountToDeduct = Number(ing.qty) * Number(item.qty);
            
            await env.DB.prepare(`
              UPDATE inventory 
              SET stock = stock - ? 
              WHERE id=?
            `).bind(amountToDeduct, ing.inventory_id).run();
          }
        }
      }
      return json({ ok: true, totalPaid, isFullyPaid });
    }

    // ACTUALIZAR ORDEN (Estados de Cocina, Impresión, etc)
    if (request.method === "PATCH" && id) {
      const data = await body(request);
      const allowed = ["status", "payment_status", "payment_method", "notes", "discount", "estimated_time", "print_requested"];
      const sets = []; const vals = [];
      for (const k of allowed) {
        if (data[k] !== undefined) { sets.push(`${k}=?`); vals.push(data[k]); }
      }
      if (!sets.length) return json({ error: "Sin cambios." }, 400);
      
      sets.push("updated_at=?"); 
      vals.push(nowIso(), id);
      
      await env.DB.prepare(`UPDATE orders SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }

    // COMENTARIOS (CHAT)
    if (request.method === "GET" && id && action === "comments") {
      const comments = await env.DB.prepare(`SELECT * FROM order_comments WHERE order_id=? ORDER BY created_at ASC`).bind(id).all();
      return json(comments.results);
    }
    if (request.method === "POST" && id && action === "comments") {
      const d = await body(request);
      const newId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO order_comments (id, order_id, user_name, role, comment, created_at) 
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(newId, id, user.name, user.role, d.comment || "", nowIso()).run();
      return json({ ok: true, id: newId });
    }
  }


  /* =======================================================
     DASHBOARD (REPORTE FINANCIERO 3 TIEMPOS)
  ======================================================= */
  if (request.method === "GET" && resource === "dashboard") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    
    const today = new Date().toISOString().slice(0, 10);
    const date7 = new Date(Date.now() - 7*86400000).toISOString().slice(0, 10);
    const date30 = new Date(Date.now() - 30*86400000).toISOString().slice(0, 10);

    const getStats = async (dateFrom) => {
      // Ventas Pagadas
      const s = await env.DB.prepare(`
        SELECT COALESCE(SUM(total),0) as sales, COUNT(*) as orders 
        FROM orders 
        WHERE status='paid' AND substr(created_at,1,10) >= ?
      `).bind(dateFrom).first();
      
      // Gastos en Insumos
      const e = await env.DB.prepare(`
        SELECT COALESCE(SUM(total_cost),0) as expenses 
        FROM purchases 
        WHERE purchase_date >= ?
      `).bind(dateFrom).first();
      
      return { sales: s.sales, orders: s.orders, expenses: e.expenses };
    };

    const dToday = await getStats(today);
    const dWeek = await getStats(date7);
    const dMonth = await getStats(date30);

    const open = await env.DB.prepare(`SELECT COUNT(*) count FROM orders WHERE status IN ('open','preparing','ready')`).first();
    const kitchen = await env.DB.prepare(`SELECT COUNT(*) count FROM orders WHERE status IN ('open','preparing')`).first();

    return json({ today: dToday, week: dWeek, month: dMonth, open, kitchen });
  }


  /* =======================================================
     CAJA (MOVIMIENTOS EXTRAORDINARIOS)
  ======================================================= */
  if (resource === "cash") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    
    if (request.method === "GET") {
      const rows = await env.DB.prepare(`SELECT * FROM cash_movements ORDER BY created_at DESC LIMIT 200`).all();
      return json(rows.results);
    }
    
    if (request.method === "POST") {
      const d = await body(request);
      const newId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO cash_movements (id, type, amount, concept, order_id, created_at) 
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(newId, d.type, Number(d.amount || 0), d.concept || "", d.order_id || null, nowIso()).run();
      return json({ id: newId }, 201);
    }
  }


  /* =======================================================
     USUARIOS
  ======================================================= */
  if (resource === "users") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    
    if (request.method === "GET" && !id) {
      const rows = await env.DB.prepare(`SELECT id, username, name, role, active, created_at, updated_at FROM users ORDER BY name`).all();
      return json(rows.results);
    }
    
    if (request.method === "POST" && !id) {
      const d = await body(request);
      const username = String(d.username || "").trim().toLowerCase();
      const name = String(d.name || "").trim();
      const password = String(d.password || "");
      const role = String(d.role || "").trim().toLowerCase();

      if (!username || !name || !password || !["admin", "mesero", "cocina"].includes(role)) {
        return json({ error: "Todos los campos de usuario son obligatorios." }, 400);
      }

      const { salt, hash } = await hashPassword(password);
      const newId = crypto.randomUUID();
      await env.DB.prepare(`
        INSERT INTO users (id, username, name, role, password_hash, password_salt, active, created_at, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).bind(newId, username, name, role, hash, salt, nowIso(), nowIso()).run();
      return json({ ok: true, id: newId }, 201);
    }
    
    if (request.method === "DELETE" && id) {
      if (id === user.id) return json({ error: "No puedes borrarte a ti mismo." }, 400);
      await env.DB.prepare(`DELETE FROM users WHERE id=?`).bind(id).run();
      await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(id).run();
      return json({ ok: true });
    }
  }

  // 404 CATCH ALL
  return json({ error: "Ruta no encontrada" }, 404);
}
