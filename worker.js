export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Inicializar estructura de D1
    try {
      await ensureDatabase(env);
    } catch (err) {
      return json({
        error: "Error inicializando la base de datos",
        detail: err?.message || String(err)
      }, 500);
    }

    // API
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

    // Frontend
    return env.ASSETS.fetch(request);
  }
};


/* =========================================================
   DATABASE
========================================================= */

async function ensureDatabase(env) {

  const statements = [

    // MENÚ
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

    // MESAS
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

    // ORDENES
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        table_id TEXT,
        customer_name TEXT DEFAULT '',
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

    // PRODUCTOS DE CADA ORDEN
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

    // CAJA
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS cash_movements (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        concept TEXT DEFAULT '',
        order_id TEXT,
        created_at TEXT NOT NULL
      )
    `)
  ];

  await env.DB.batch(statements);


  // Crear mesas iniciales si no existen
  const tableCount = await env.DB
    .prepare(`SELECT COUNT(*) AS count FROM "tables"`)
    .first();

  if (Number(tableCount?.count || 0) === 0) {

    const tables = [];

    for (let i = 1; i <= 12; i++) {
      tables.push(
        env.DB.prepare(`
          INSERT INTO "tables"
          (id, number, name, type, status, capacity, active)
          VALUES (?, ?, ?, 'mesa', 'available', 4, 1)
        `).bind(
          crypto.randomUUID(),
          i,
          `Mesa ${i}`
        )
      );
    }

    await env.DB.batch(tables);
  }
}


/* =========================================================
   CORS
========================================================= */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type"
  };
}


function withCors(response) {
  const headers = new Headers(response.headers);

  Object.entries(corsHeaders()).forEach(([key, value]) => {
    headers.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    headers
  });
}


/* =========================================================
   JSON
========================================================= */

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  );
}


/* =========================================================
   REQUEST BODY
========================================================= */

async function body(request) {
  return await request.json().catch(() => ({}));
}


/* =========================================================
   API
========================================================= */

async function api(request, env, url) {

  const p = url.pathname.replace(/^\/api\/?/, "");
  const parts = p.split("/");

  const resource = parts[0];
  const id = parts[1];


  /* =====================================================
     HEALTH
  ===================================================== */

  if (
    request.method === "GET" &&
    resource === "health"
  ) {

    return json({
      ok: true,
      service: "RUSH POS",
      time: new Date().toISOString()
    });
  }


  /* =====================================================
     MENU
  ===================================================== */

  if (
    request.method === "GET" &&
    resource === "menu"
  ) {

    const rows = await env.DB.prepare(`
      SELECT *
      FROM menu_items
      WHERE active = 1
      ORDER BY category, sort_order, name
    `).all();

    return json(rows.results);
  }


  /* =====================================================
     CREAR PRODUCTO
  ===================================================== */

  if (
    request.method === "POST" &&
    resource === "menu"
  ) {

    const d = await body(request);

    if (!d.name) {
      return json({
        error: "El producto necesita nombre."
      }, 400);
    }

    const id = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO menu_items
      (
        id,
        name,
        category,
        price,
        description,
        active,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `)
      .bind(
        id,
        d.name,
        d.category || "General",
        Number(d.price || 0),
        d.description || "",
        Number(d.sort_order || 0)
      )
      .run();

    return json({
      id,
    }, 201);
  }


  /* =====================================================
     MESAS
  ===================================================== */

  if (
    request.method === "GET" &&
    resource === "tables"
  ) {

    const rows = await env.DB.prepare(`
      SELECT *
      FROM "tables"
      WHERE active = 1
      ORDER BY type, number
    `).all();

    return json(rows.results);
  }


  /* =====================================================
     CREAR MESA
  ===================================================== */

  if (
    request.method === "POST" &&
    resource === "tables"
  ) {

    const d = await body(request);

    const id = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO "tables"
      (
        id,
        number,
        name,
        type,
        status,
        capacity,
        active
      )
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `)
      .bind(
        id,
        Number(d.number || 1),
        d.name || `Mesa ${d.number || ""}`,
        d.type || "mesa",
        d.status || "available",
        Number(d.capacity || 4)
      )
      .run();

    return json({
      id
    }, 201);
  }


  /* =====================================================
     ORDEN INDIVIDUAL
     
     IMPORTANTE:
     Esta ruta está ANTES de GET /orders
     ===================================================== */

  if (
    request.method === "GET" &&
    resource === "orders" &&
    id
  ) {

    const order = await env.DB
      .prepare(`
        SELECT *
        FROM orders
        WHERE id = ?
      `)
      .bind(id)
      .first();

    if (!order) {
      return json({
        error: "Orden no encontrada."
      }, 404);
    }

    const items = await env.DB
      .prepare(`
        SELECT *
        FROM order_items
        WHERE order_id = ?
        ORDER BY id
      `)
      .bind(id)
      .all();

    return json({
      order,
      items: items.results
    });
  }


  /* =====================================================
     TODAS LAS ORDENES
  ===================================================== */

  if (
    request.method === "GET" &&
    resource === "orders"
  ) {

    const status =
      url.searchParams.get("status");

    let q = `
      SELECT *
      FROM orders
    `;

    const args = [];

    if (status) {
      q += ` WHERE status = ?`;
      args.push(status);
    }

    q += `
      ORDER BY created_at DESC
      LIMIT 200
    `;

    const rows = await env.DB
      .prepare(q)
      .bind(...args)
      .all();

    return json(rows.results);
  }


  /* =====================================================
     CREAR ORDEN
  ===================================================== */

  if (
    request.method === "POST" &&
    resource === "orders"
  ) {

    const data = await body(request);

    if (!data.items?.length) {
      return json({
        error:
          "La orden necesita al menos un producto."
      }, 400);
    }

    const now =
      new Date().toISOString();

    const id =
      crypto.randomUUID();

    const subtotal =
      data.items.reduce(
        (sum, item) =>
          sum +
          Number(item.qty || 1) *
          Number(item.unit_price || 0),
        0
      );

    const discount =
      Number(data.discount || 0);

    const total =
      Math.max(
        0,
        subtotal - discount
      );


    const statements = [];


    statements.push(
      env.DB.prepare(`
        INSERT INTO orders
        (
          id,
          table_id,
          customer_name,
          notes,
          status,
          subtotal,
          discount,
          total,
          payment_status,
          created_at,
          updated_at
        )
        VALUES
        (?, ?, ?, ?, 'open', ?, ?, ?, 'pending', ?, ?)
      `)
        .bind(
          id,
          data.table_id || null,
          data.customer_name || "",
          data.notes || "",
          subtotal,
          discount,
          total,
          now,
          now
        )
    );


    for (const item of data.items) {

      statements.push(
        env.DB.prepare(`
          INSERT INTO order_items
          (
            order_id,
            menu_item_id,
            name,
            qty,
            unit_price,
            modifiers,
            notes
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
          .bind(
            id,
            item.menu_item_id || null,
            item.name,
            Number(item.qty || 1),
            Number(item.unit_price || 0),
            JSON.stringify(
              item.modifiers || []
            ),
            item.notes || ""
          )
      );
    }


    await env.DB.batch(statements);


    return json({
      id,
      subtotal,
      discount,
      total,
      status: "open"
    }, 201);
  }


  /* =====================================================
     ACTUALIZAR ORDEN
  ===================================================== */

  if (
    request.method === "PATCH" &&
    resource === "orders" &&
    id
  ) {

    const data = await body(request);

    const allowed = [
      "status",
      "payment_status",
      "payment_method",
      "notes",
      "discount"
    ];

    const sets = [];
    const vals = [];


    for (const key of allowed) {

      if (data[key] !== undefined) {

        sets.push(`${key} = ?`);

        vals.push(data[key]);
      }
    }


    if (
      data.status === "paid" ||
      data.payment_status === "paid"
    ) {

      sets.push("closed_at = ?");

      vals.push(
        new Date().toISOString()
      );
    }


    if (!sets.length) {

      return json({
        error: "Sin cambios."
      }, 400);
    }


    sets.push(
      "updated_at = ?"
    );

    vals.push(
      new Date().toISOString()
    );


    vals.push(id);


    await env.DB
      .prepare(`
        UPDATE orders
        SET ${sets.join(", ")}
        WHERE id = ?
      `)
      .bind(...vals)
      .run();


    return json({
      ok: true
    });
  }


  /* =====================================================
     CAJA
  ===================================================== */

  if (
    request.method === "POST" &&
    resource === "cash"
  ) {

    const d = await body(request);

    if (!d.type) {

      return json({
        error:
          "El movimiento necesita tipo."
      }, 400);
    }


    const id =
      crypto.randomUUID();

    const now =
      new Date().toISOString();


    await env.DB.prepare(`
      INSERT INTO cash_movements
      (
        id,
        type,
        amount,
        concept,
        order_id,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .bind(
        id,
        d.type,
        Number(d.amount || 0),
        d.concept || "",
        d.order_id || null,
        now
      )
      .run();


    return json({
      id
    }, 201);
  }


  /* =====================================================
     DASHBOARD
  ===================================================== */

  if (
    request.method === "GET" &&
    resource === "dashboard"
  ) {

    const today =
      new Date()
        .toISOString()
        .slice(0, 10);


    const sales =
      await env.DB.prepare(`
        SELECT
          COALESCE(SUM(total), 0) AS total,
          COUNT(*) AS orders
        FROM orders
        WHERE status = 'paid'
        AND substr(created_at, 1, 10) = ?
      `)
        .bind(today)
        .first();


    const open =
      await env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM orders
        WHERE status IN
        ('open', 'preparing', 'ready')
      `)
        .first();


    const kitchen =
      await env.DB.prepare(`
        SELECT COUNT(*) AS count
        FROM orders
        WHERE status IN
        ('open', 'preparing')
      `)
        .first();


    return json({
      sales,
      open,
      kitchen
    });
  }


  /* =====================================================
     404
  ===================================================== */

  return json({
    error: "Ruta no encontrada",
    path: url.pathname
  }, 404);
}
