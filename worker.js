export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders() });
      }

      try {
        const response = await api(request, env, url);
        return withCors(response);
      } catch (err) {
        console.error(err);
        return withCors(
          json({ error: err?.message || "Server error" }, 500)
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};


/* =========================================================
   UTILIDADES
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

async function body(request) {
  return await request.json().catch(() => ({}));
}


/* =========================================================
   AUTENTICACIÓN
========================================================= */

async function requireAuth(request, env, roles = []) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";

  if (!token) {
    throw new Error("No autorizado");
  }

  const session = await env.DB.prepare(`
    SELECT
      s.token,
      s.expires_at,
      u.id,
      u.name,
      u.username,
      u.role,
      u.active,
      u.approved
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
      AND s.expires_at > datetime('now')
  `)
    .bind(token)
    .first();

  if (!session) {
    throw new Error("Sesión inválida");
  }

  if (!session.active || !session.approved) {
    throw new Error("Usuario inactivo o pendiente de aprobación");
  }

  if (roles.length && !roles.includes(session.role)) {
    throw new Error("Permisos insuficientes");
  }

  return session;
}


/* =========================================================
   TABLA DE COBROS
   Se crea automáticamente si todavía no existe.
========================================================= */

async function ensurePaymentsTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      payer_name TEXT,
      method TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      cash_amount REAL NOT NULL DEFAULT 0,
      card_amount REAL NOT NULL DEFAULT 0,
      terminal_amount REAL NOT NULL DEFAULT 0,
      terminal_reference TEXT,
      allocations TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
}


/* =========================================================
   TABLA DE MOVIMIENTOS DE CAJA
========================================================= */

async function ensureCashTable(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS cash_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      concept TEXT,
      user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();
}


/* =========================================================
   API
========================================================= */

async function api(request, env, url) {

  const p = url.pathname.replace(/^\/api\/?/, "");
  const parts = p.split("/");

  const resource = parts[0];
  const id = parts[1];
  const subresource = parts[2];


  /* =======================================================
     HEALTH
  ======================================================= */

  if (request.method === "GET" && resource === "health") {
    return json({
      ok: true,
      service: "RUSH POS",
      time: new Date().toISOString()
    });
  }


  /* =======================================================
     LOGIN
  ======================================================= */

  if (request.method === "POST" && resource === "login") {

    const d = await body(request);

    const username = String(d.username || "")
      .trim()
      .toLowerCase();

    const password = String(d.password || "");

    if (!username || !password) {
      return json({
        error: "Usuario y contraseña son obligatorios."
      }, 400);
    }

    const user = await env.DB.prepare(`
      SELECT
        id,
        name,
        username,
        role,
        active,
        approved,
        password_hash
      FROM users
      WHERE lower(username) = ?
    `)
      .bind(username)
      .first();

    if (!user || !user.active || !user.approved) {
      return json({
        error:
          "Usuario no encontrado, inactivo o pendiente de aprobación."
      }, 401);
    }

    const hash = await sha256(password);

    if (hash !== user.password_hash) {
      return json({
        error: "Contraseña incorrecta."
      }, 401);
    }

    const token =
      crypto.randomUUID() +
      crypto.randomUUID().replaceAll("-", "");

    const expires = new Date(
      Date.now() + 12 * 60 * 60 * 1000
    )
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);

    await env.DB.prepare(`
      INSERT INTO sessions(
        token,
        user_id,
        expires_at,
        created_at
      )
      VALUES (?, ?, ?, datetime('now'))
    `)
      .bind(token, user.id, expires)
      .run();

    return json({
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role
      }
    });
  }


  /* =======================================================
     LOGOUT
  ======================================================= */

  if (request.method === "POST" && resource === "logout") {

    const auth =
      request.headers.get("Authorization") || "";

    const token =
      auth.startsWith("Bearer ")
        ? auth.slice(7)
        : "";

    if (token) {
      await env.DB.prepare(
        "DELETE FROM sessions WHERE token = ?"
      )
        .bind(token)
        .run();
    }

    return json({ ok: true });
  }


  /* =======================================================
     USUARIO ACTUAL
  ======================================================= */

  if (request.method === "GET" && resource === "me") {

    const me = await requireAuth(request, env);

    return json({
      user: {
        id: me.id,
        name: me.name,
        username: me.username,
        role: me.role
      }
    });
  }


  /* =======================================================
     USUARIOS
  ======================================================= */

  if (request.method === "GET" && resource === "users") {

    await requireAuth(request, env, ["admin"]);

    const rows = await env.DB.prepare(`
      SELECT
        id,
        name,
        username,
        role,
        active,
        approved,
        created_at
      FROM users
      ORDER BY name
    `).all();

    return json(rows.results);
  }


  if (request.method === "POST" && resource === "users") {

    await requireAuth(request, env, ["admin"]);

    const d = await body(request);

    const name = String(d.name || "").trim();

    const username = String(d.username || "")
      .trim()
      .toLowerCase();

    const password = String(d.password || "");

    const role =
      ["admin", "waiter", "cashier", "kitchen"].includes(d.role)
        ? d.role
        : "waiter";

    if (!name || !username || !password) {
      return json({
        error:
          "Nombre, usuario y contraseña son obligatorios."
      }, 400);
    }

    if (password.length < 6) {
      return json({
        error:
          "La contraseña debe tener al menos 6 caracteres."
      }, 400);
    }

    const exists = await env.DB.prepare(
      "SELECT id FROM users WHERE lower(username)=?"
    )
      .bind(username)
      .first();

    if (exists) {
      return json({
        error: "Ese usuario ya existe."
      }, 409);
    }

    const id = crypto.randomUUID();

    const hash = await sha256(password);

    await env.DB.prepare(`
      INSERT INTO users(
        id,
        name,
        username,
        password_hash,
        role,
        active,
        approved,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, 1, 1, datetime('now'))
    `)
      .bind(
        id,
        name,
        username,
        hash,
        role
      )
      .run();

    return json({
      ok: true,
      id
    }, 201);
  }


  if (
    request.method === "PATCH" &&
    resource === "users" &&
    id
  ) {

    await requireAuth(request, env, ["admin"]);

    const d = await body(request);

    const sets = [];
    const vals = [];

    if (d.name !== undefined) {
      sets.push("name=?");
      vals.push(String(d.name).trim());
    }

    if (
      d.role !== undefined &&
      ["admin", "waiter", "cashier", "kitchen"].includes(d.role)
    ) {
      sets.push("role=?");
      vals.push(d.role);
    }

    if (d.active !== undefined) {
      sets.push("active=?");
      vals.push(d.active ? 1 : 0);
    }

    if (d.approved !== undefined) {
      sets.push("approved=?");
      vals.push(d.approved ? 1 : 0);
    }

    if (d.password) {
      sets.push("password_hash=?");
      vals.push(await sha256(String(d.password)));
    }

    if (!sets.length) {
      return json({
        error: "Sin cambios."
      }, 400);
    }

    vals.push(id);

    await env.DB.prepare(`
      UPDATE users
      SET ${sets.join(", ")}
      WHERE id=?
    `)
      .bind(...vals)
      .run();

    return json({
      ok: true
    });
  }


  /* =======================================================
     PRODUCTOS / MENÚ
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "menu"
  ) {

    const rows = await env.DB.prepare(`
      SELECT *
      FROM menu_items
      WHERE active=1
      ORDER BY category, sort_order, name
    `).all();

    return json(rows.results);
  }


  if (
    request.method === "POST" &&
    resource === "menu"
  ) {

    await requireAuth(request, env, ["admin"]);

    const d = await body(request);

    const item = {
      id: crypto.randomUUID(),
      name: String(d.name || "").trim(),
      category: String(d.category || "General").trim(),
      price: Number(d.price || 0),
      description: String(d.description || ""),
      active: 1,
      sort_order: Number(d.sort_order || 0)
    };

    if (!item.name) {
      return json({
        error: "El producto necesita nombre."
      }, 400);
    }

    await env.DB.prepare(`
      INSERT INTO menu_items(
        id,
        name,
        category,
        price,
        description,
        active,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        item.id,
        item.name,
        item.category,
        item.price,
        item.description,
        item.active,
        item.sort_order
      )
      .run();

    return json({
      id: item.id
    }, 201);
  }


  /* =======================================================
     MESAS
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "tables" &&
    !id
  ) {

    await requireAuth(
      request,
      env,
      ["admin", "waiter", "cashier", "kitchen"]
    );

    const rows = await env.DB.prepare(`
      SELECT *
      FROM tables
      ORDER BY type, number
    `).all();

    return json(rows.results);
  }


  /* PATCH DE MESA */
  if (
    request.method === "PATCH" &&
    resource === "tables" &&
    id
  ) {

    const me = await requireAuth(
      request,
      env,
      ["admin", "waiter", "cashier"]
    );

    const d = await body(request);

    if (!["available", "reserved", "occupied"].includes(d.status)) {
      return json({
        error: "Estado de mesa inválido."
      }, 400);
    }

    await env.DB.prepare(`
      UPDATE tables
      SET status=?
      WHERE id=?
    `)
      .bind(d.status, id)
      .run();

    return json({
      ok: true,
      updated_by: me.name
    });
  }


  /* =======================================================
     ORDENES - DETALLE
     IMPORTANTE: va ANTES del GET general.
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "orders" &&
    id &&
    !subresource
  ) {

    await requireAuth(
      request,
      env,
      ["admin", "waiter", "cashier", "kitchen"]
    );

    await ensurePaymentsTable(env);

    const order = await env.DB.prepare(`
      SELECT
        o.*,
        u.name AS waiter_name
      FROM orders o
      LEFT JOIN users u
        ON u.id=o.waiter_id
      WHERE o.id=?
    `)
      .bind(id)
      .first();

    if (!order) {
      return json({
        error: "Orden no encontrada."
      }, 404);
    }

    const items = await env.DB.prepare(`
      SELECT *
      FROM order_items
      WHERE order_id=?
      ORDER BY id
    `)
      .bind(id)
      .all();

    const payments = await env.DB.prepare(`
      SELECT *
      FROM payments
      WHERE order_id=?
      ORDER BY id
    `)
      .bind(id)
      .all();

    const paid = payments.results.reduce(
      (s, p) => s + Number(p.amount || 0),
      0
    );

    const paidCash = payments.results.reduce(
      (s, p) => s + Number(p.cash_amount || 0),
      0
    );

    const paidCard = payments.results.reduce(
      (s, p) => s + Number(p.card_amount || 0),
      0
    );

    const terminalAmount = payments.results.reduce(
      (s, p) => s + Number(p.terminal_amount || 0),
      0
    );

    return json({
      order: {
        ...order,
        paid: paid,
        paid_amount: paid,
        paid_cash: paidCash,
        paid_card: paidCard,
        terminal_amount: terminalAmount
      },
      items: items.results,
      payments: payments.results
    });
  }


  /* =======================================================
     ORDENES - LISTADO
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "orders" &&
    !id
  ) {

    await requireAuth(
      request,
      env,
      ["admin", "waiter", "cashier", "kitchen"]
    );

    await ensurePaymentsTable(env);

    const status =
      url.searchParams.get("status");

    let q = `
      SELECT
        o.*,
        u.name AS waiter_name
      FROM orders o
      LEFT JOIN users u
        ON u.id=o.waiter_id
    `;

    const args = [];

    if (status) {
      q += " WHERE o.status=?";
      args.push(status);
    }

    q += `
      ORDER BY o.created_at DESC
      LIMIT 200
    `;

    const rows = await env.DB
      .prepare(q)
      .bind(...args)
      .all();

    const result = [];

    for (const order of rows.results) {

      const payments = await env.DB.prepare(`
        SELECT
          COALESCE(SUM(amount),0) AS paid_amount,
          COALESCE(SUM(cash_amount),0) AS paid_cash,
          COALESCE(SUM(card_amount),0) AS paid_card,
          COALESCE(SUM(terminal_amount),0) AS terminal_amount
        FROM payments
        WHERE order_id=?
      `)
        .bind(order.id)
        .first();

      result.push({
        ...order,
        paid_amount: Number(payments?.paid_amount || 0),
        paid_cash: Number(payments?.paid_cash || 0),
        paid_card: Number(payments?.paid_card || 0),
        terminal_amount: Number(
          payments?.terminal_amount || 0
        )
      });
    }

    return json(result);
  }


  /* =======================================================
     CREAR ORDEN
  ======================================================= */

  if (
    request.method === "POST" &&
    resource === "orders" &&
    !id
  ) {

    const me = await requireAuth(
      request,
      env,
      ["admin", "waiter", "cashier"]
    );

    const data = await body(request);

    if (!data.items?.length) {
      return json({
        error:
          "La orden necesita al menos un producto."
      }, 400);
    }

    const now = new Date().toISOString();

    const orderId = crypto.randomUUID();

    const subtotal = data.items.reduce(
      (s, x) =>
        s +
        Number(x.qty || 1) *
        Number(x.unit_price || 0),
      0
    );

    const discount = Number(
      data.discount || 0
    );

    const total = Math.max(
      0,
      subtotal - discount
    );

    const stmts = [];

    stmts.push(
      env.DB.prepare(`
        INSERT INTO orders(
          id,
          table_id,
          customer_name,
          notes,
          status,
          subtotal,
          discount,
          total,
          payment_status,
          waiter_id,
          created_at,
          updated_at
        )
        VALUES(
          ?,
          ?,
          ?,
          ?,
          'open',
          ?,
          ?,
          ?,
          'pending',
          ?,
          ?,
          ?
        )
      `)
        .bind(
          orderId,
          data.table_id || null,
          data.customer_name || "",
          data.notes || "",
          subtotal,
          discount,
          total,
          me.id,
          now,
          now
        )
    );

    for (const item of data.items) {

      stmts.push(
        env.DB.prepare(`
          INSERT INTO order_items(
            order_id,
            menu_item_id,
            name,
            qty,
            unit_price,
            modifiers,
            notes
          )
          VALUES(
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
          )
        `)
          .bind(
            orderId,
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

    await env.DB.batch(stmts);

    return json({
      id: orderId,
      subtotal,
      discount,
      total,
      status: "open",
      waiter_id: me.id,
      waiter_name: me.name
    }, 201);
  }


  /* =======================================================
     ACTUALIZAR ORDEN
  ======================================================= */

  if (
    request.method === "PATCH" &&
    resource === "orders" &&
    id &&
    !subresource
  ) {

    const me = await requireAuth(
      request,
      env,
      [
        "admin",
        "waiter",
        "cashier",
        "kitchen"
      ]
    );

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

    for (const k of allowed) {

      if (data[k] !== undefined) {

        sets.push(`${k}=?`);
        vals.push(data[k]);
      }
    }

    if (!sets.length) {
      return json({
        error: "Sin cambios."
      }, 400);
    }

    if (
      data.status === "paid" ||
      data.payment_status === "paid"
    ) {
      sets.push("closed_at=?");
      vals.push(
        new Date().toISOString()
      );
    }

    sets.push("updated_at=?");
    vals.push(
      new Date().toISOString()
    );

    vals.push(id);

    await env.DB.prepare(`
      UPDATE orders
      SET ${sets.join(", ")}
      WHERE id=?
    `)
      .bind(...vals)
      .run();

    return json({
      ok: true,
      updated_by: me.name
    });
  }


  /* =======================================================
     COBRO DE UNA ORDEN
     POST /orders/:id/payments
  ======================================================= */

  if (
    request.method === "POST" &&
    resource === "orders" &&
    id &&
    subresource === "payments"
  ) {

    const me = await requireAuth(
      request,
      env,
      ["admin", "waiter", "cashier"]
    );

    await ensurePaymentsTable(env);

    const data = await body(request);

    const order = await env.DB.prepare(`
      SELECT *
      FROM orders
      WHERE id=?
    `)
      .bind(id)
      .first();

    if (!order) {
      return json({
        error: "Orden no encontrada."
      }, 404);
    }

    const amount = Number(
      data.amount || 0
    );

    if (amount <= 0) {
      return json({
        error: "El monto del cobro debe ser mayor a cero."
      }, 400);
    }

    const previous = await env.DB.prepare(`
      SELECT
        COALESCE(SUM(amount),0) AS paid
      FROM payments
      WHERE order_id=?
    `)
      .bind(id)
      .first();

    const alreadyPaid = Number(
      previous?.paid || 0
    );

    const remaining =
      Number(order.total || 0) -
      alreadyPaid;

    if (amount > remaining + 0.01) {
      return json({
        error:
          `El cobro supera el saldo pendiente de $${remaining.toFixed(2)}.`
      }, 400);
    }

    const method =
      ["cash", "card", "mixed"].includes(data.method)
        ? data.method
        : "cash";

    const cashAmount = Number(
      data.cash_amount || 0
    );

    const cardAmount = Number(
      data.card_amount || 0
    );

    const terminalAmount = Number(
      data.terminal_amount || 0
    );

    const paymentId =
      await env.DB.prepare(`
        INSERT INTO payments(
          order_id,
          payer_name,
          method,
          amount,
          cash_amount,
          card_amount,
          terminal_amount,
          terminal_reference,
          allocations,
          created_by,
          created_at
        )
        VALUES(
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          datetime('now')
        )
      `)
        .bind(
          id,
          String(data.payer_name || "Cliente"),
          method,
          amount,
          cashAmount,
          cardAmount,
          terminalAmount,
          String(data.terminal_reference || ""),
          JSON.stringify(
            data.allocations || []
          ),
          me.id
        )
        .run();

    const newPaid =
      alreadyPaid + amount;

    const fullyPaid =
      newPaid >= Number(order.total || 0) - 0.01;

    if (fullyPaid) {

      await env.DB.prepare(`
        UPDATE orders
        SET
          status='paid',
          payment_status='paid',
          payment_method=?,
          closed_at=?,
          updated_at=?
        WHERE id=?
      `)
        .bind(
          method,
          new Date().toISOString(),
          new Date().toISOString(),
          id
        )
        .run();

    } else {

      await env.DB.prepare(`
        UPDATE orders
        SET
          payment_status='partial',
          payment_method=?,
          updated_at=?
        WHERE id=?
      `)
        .bind(
          method,
          new Date().toISOString(),
          id
        )
        .run();
    }

    return json({
      ok: true,
      payment_id:
        paymentId?.meta?.last_row_id || null,
      amount,
      paid: newPaid,
      remaining: Math.max(
        0,
        Number(order.total || 0) - newPaid
      ),
      status: fullyPaid
        ? "paid"
        : "partial"
    }, 201);
  }


  /* =======================================================
     DASHBOARD / CAJA
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "dashboard"
  ) {

    await requireAuth(
      request,
      env,
      ["admin", "cashier"]
    );

    await ensurePaymentsTable(env);

    const today =
      new Date()
        .toISOString()
        .slice(0, 10);


    const sales = await env.DB.prepare(`
      SELECT
        COALESCE(SUM(total),0) AS total,
        COUNT(*) AS orders
      FROM orders
      WHERE status='paid'
        AND substr(created_at,1,10)=?
    `)
      .bind(today)
      .first();


    const open = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM orders
      WHERE status IN(
        'open',
        'preparing',
        'ready'
      )
    `)
      .first();


    const kitchen = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM orders
      WHERE status IN(
        'open',
        'preparing'
      )
    `)
      .first();


    const payments = await env.DB.prepare(`
      SELECT
        COALESCE(SUM(amount),0) AS total,
        COUNT(*) AS transactions,
        COALESCE(SUM(cash_amount),0) AS cash,
        COALESCE(SUM(card_amount),0) AS card,
        COALESCE(SUM(terminal_amount),0) AS terminal
      FROM payments
      WHERE substr(created_at,1,10)=?
    `)
      .bind(today)
      .first();


    return json({
      sales: {
        total: Number(
          sales?.total || 0
        ),
        orders: Number(
          sales?.orders || 0
        )
      },

      open: {
        count: Number(
          open?.count || 0
        )
      },

      kitchen: {
        count: Number(
          kitchen?.count || 0
        )
      },

      payments: {
        total: Number(
          payments?.total || 0
        ),
        transactions: Number(
          payments?.transactions || 0
        ),
        cash: Number(
          payments?.cash || 0
        ),
        card: Number(
          payments?.card || 0
        ),
        terminal: Number(
          payments?.terminal || 0
        )
      }
    });
  }


  /* =======================================================
     CAJA - MOVIMIENTO
  ======================================================= */

  if (
    request.method === "POST" &&
    resource === "cash"
  ) {

    const me = await requireAuth(
      request,
      env,
      ["admin"]
    );

    await ensureCashTable(env);

    const data = await body(request);

    const type =
      ["ingreso", "egreso"].includes(data.type)
        ? data.type
        : null;

    const amount = Number(
      data.amount || 0
    );

    const concept =
      String(data.concept || "").trim();

    if (!type) {
      return json({
        error:
          "Tipo de movimiento inválido."
      }, 400);
    }

    if (amount <= 0) {
      return json({
        error:
          "El monto debe ser mayor a cero."
      }, 400);
    }

    const result =
      await env.DB.prepare(`
        INSERT INTO cash_movements(
          type,
          amount,
          concept,
          user_id,
          created_at
        )
        VALUES(
          ?,
          ?,
          ?,
          ?,
          datetime('now')
        )
      `)
        .bind(
          type,
          amount,
          concept,
          me.id
        )
        .run();

    return json({
      ok: true,
      id:
        result?.meta?.last_row_id || null
    }, 201);
  }


  /* =======================================================
     LISTADO DE MOVIMIENTOS DE CAJA
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "cash"
  ) {

    await requireAuth(
      request,
      env,
      ["admin"]
    );

    await ensureCashTable(env);

    const rows = await env.DB.prepare(`
      SELECT
        c.*,
        u.name AS user_name
      FROM cash_movements c
      LEFT JOIN users u
        ON u.id=c.user_id
      ORDER BY c.id DESC
      LIMIT 200
    `).all();

    return json(rows.results);
  }


  /* =======================================================
     RUTA NO ENCONTRADA
  ======================================================= */

  return json({
    error: "Ruta no encontrada"
  }, 404);
}


/* =========================================================
   SHA-256
========================================================= */

async function sha256(value) {

  const data =
    new TextEncoder().encode(value);

  const hash =
    await crypto.subtle.digest(
      "SHA-256",
      data
    );

  return [
    ...new Uint8Array(hash)
  ]
    .map(
      b =>
        b.toString(16).padStart(2, "0")
    )
    .join("");
}
