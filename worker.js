export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // API
    // =========================
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: corsHeaders()
        });
      }

      try {
        const response = await api(request, env, url);
        return withCors(response);
      } catch (err) {
        return withCors(
          json(
            {
              error: err?.message || "Server error"
            },
            500
          )
        );
      }
    }

    // =========================
    // PÁGINA PRINCIPAL
    // =========================
    if (url.pathname === "/" || url.pathname === "") {
      const indexUrl = new URL("/index.html", request.url);

      return env.ASSETS.fetch(
        new Request(indexUrl, request)
      );
    }

    // =========================
    // ARCHIVOS ESTÁTICOS
    // =========================
    return env.ASSETS.fetch(request);
  }
};


// ========================================
// CORS
// ========================================

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
    statusText: response.statusText,
    headers
  });
}


// ========================================
// JSON
// ========================================

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


// ========================================
// REQUEST BODY
// ========================================

async function body(request) {
  return await request
    .json()
    .catch(() => ({}));
}


// ========================================
// API PRINCIPAL
// ========================================

async function api(request, env, url) {

  const p = url.pathname
    .replace(/^\/api\/?/, "");

  const [resource, id] = p.split("/");


  // ========================================
  // HEALTH
  // ========================================

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


  // ========================================
  // MENU
  // ========================================

  if (
    request.method === "GET" &&
    resource === "menu"
  ) {

    const rows = await env.DB
      .prepare(`
        SELECT *
        FROM menu_items
        WHERE active = 1
        ORDER BY category, sort_order, name
      `)
      .all();

    return json(rows.results);
  }


  // ========================================
  // MESAS
  // ========================================

  if (
    request.method === "GET" &&
    resource === "tables"
  ) {

    const rows = await env.DB
      .prepare(`
        SELECT *
        FROM tables
        ORDER BY type, number
      `)
      .all();

    return json(rows.results);
  }


  // ========================================
  // OBTENER ORDENES
  // ========================================

  if (
    request.method === "GET" &&
    resource === "orders" &&
    !id
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


  // ========================================
  // OBTENER UNA ORDEN
  // ========================================

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


  // ========================================
  // CREAR ORDEN
  // ========================================

  if (
    request.method === "POST" &&
    resource === "orders"
  ) {

    const data = await body(request);

    if (
      !data.items ||
      !Array.isArray(data.items) ||
      !data.items.length
    ) {
      return json(
        {
          error:
            "La orden necesita al menos un producto."
        },
        400
      );
    }

    const now =
      new Date().toISOString();

    const orderId =
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


    // ORDEN

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
        (
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
          ?
        )
      `).bind(
        orderId,
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


    // PRODUCTOS DE LA ORDEN

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
          VALUES
          (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?
          )
        `).bind(
          orderId,
          item.menu_item_id || null,
          item.name || "",
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


    return json(
      {
        id: orderId,
        subtotal,
        discount,
        total,
        status: "open"
      },
      201
    );
  }


  // ========================================
  // ACTUALIZAR ORDEN
  // ========================================

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
    const values = [];


    for (const key of allowed) {

      if (data[key] !== undefined) {

        sets.push(`${key} = ?`);
        values.push(data[key]);

      }

    }


    // Cerrar automáticamente
    // cuando se paga

    if (
      data.status === "paid" ||
      data.payment_status === "paid"
    ) {

      sets.push("closed_at = ?");
      values.push(
        new Date().toISOString()
      );

    }


    if (!sets.length) {

      return json(
        {
          error: "Sin cambios."
        },
        400
      );

    }


    sets.push(
      "updated_at = ?"
    );

    values.push(
      new Date().toISOString()
    );

    values.push(id);


    await env.DB
      .prepare(`
        UPDATE orders
        SET ${sets.join(", ")}
        WHERE id = ?
      `)
      .bind(...values)
      .run();


    return json({
      ok: true
    });
  }


  // ========================================
  // CREAR PRODUCTO DEL MENU
  // ========================================

  if (
    request.method === "POST" &&
    resource === "menu"
  ) {

    const data =
      await body(request);

    const id =
      crypto.randomUUID();


    await env.DB
      .prepare(`
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
        VALUES
        (
          ?,
          ?,
          ?,
          ?,
          ?,
          1,
          ?
        )
      `)
      .bind(
        id,
        data.name || "",
        data.category || "General",
        Number(data.price || 0),
        data.description || "",
        Number(data.sort_order || 0)
      )
      .run();


    return json(
      {
        id
      },
      201
    );
  }


  // ========================================
  // MOVIMIENTOS DE CAJA
  // ========================================

  if (
    request.method === "POST" &&
    resource === "cash"
  ) {

    const data =
      await body(request);

    const id =
      crypto.randomUUID();


    await env.DB
      .prepare(`
        INSERT INTO cash_movements
        (
          id,
          type,
          amount,
          concept,
          order_id,
          created_at
        )
        VALUES
        (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        )
      `)
      .bind(
        id,
        data.type || "",
        Number(data.amount || 0),
        data.concept || "",
        data.order_id || null,
        new Date().toISOString()
      )
      .run();


    return json(
      {
        id
      },
      201
    );
  }


  // ========================================
  // DASHBOARD
  // ========================================

  if (
    request.method === "GET" &&
    resource === "dashboard"
  ) {

    const today =
      new Date()
        .toISOString()
        .slice(0, 10);


    const sales =
      await env.DB
        .prepare(`
          SELECT
            COALESCE(
              SUM(total),
              0
            ) total,
            COUNT(*) orders
          FROM orders
          WHERE status = 'paid'
          AND substr(
            created_at,
            1,
            10
          ) = ?
        `)
        .bind(today)
        .first();


    const open =
      await env.DB
        .prepare(`
          SELECT
            COUNT(*) count
          FROM orders
          WHERE status IN
          (
            'open',
            'preparing',
            'ready'
          )
        `)
        .first();


    const kitchen =
      await env.DB
        .prepare(`
          SELECT
            COUNT(*) count
          FROM orders
          WHERE status IN
          (
            'open',
            'preparing'
          )
        `)
        .first();


    return json({
      sales,
      open,
      kitchen
    });
  }


  // ========================================
  // RUTA NO ENCONTRADA
  // ========================================

  return json(
    {
      error: "Ruta no encontrada"
    },
    404
  );
}
