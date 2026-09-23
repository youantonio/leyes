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
    "Access-Control-Allow-Methods":
      "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization"
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
        "Content-Type":
          "application/json; charset=utf-8"
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

    throw new Error(
      "JSON inválido recibido por el servidor."
    );

  }

}

/* =========================================================
   FECHAS
========================================================= */

function nowIso() {
  return new Date().toISOString();
}


function futureIso(days) {
  return new Date(
    Date.now() + days * 86400000
  ).toISOString();
}


/* =========================================================
   CRIPTOGRAFÍA
========================================================= */

function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);

  crypto.getRandomValues(a);

  return [...a]
    .map(x =>
      x.toString(16).padStart(2, "0")
    )
    .join("");
}


async function hashPassword(password, saltHex) {

  const salt =
    saltHex || randomHex(16);

  const enc = new TextEncoder();

  const key =
    await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

  const bits =
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: enc.encode(salt),
        iterations: 10000,
        hash: "SHA-256"
      },
      key,
      256
    );

  const hash =
    [...new Uint8Array(bits)]
      .map(x =>
        x.toString(16).padStart(2, "0")
      )
      .join("");

  return {
    salt,
    hash
  };
}


async function verifyPassword(
  password,
  salt,
  expectedHash
) {
  const { hash } =
    await hashPassword(
      password,
      salt
    );

  return hash === expectedHash;
}


/* =========================================================
   BASE DE DATOS
========================================================= */

async function ensureDatabase(env) {

  await env.DB.batch([

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL
          CHECK(role IN ('admin','mesero','cocina')),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),

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

  ]);


  /* =======================================================
     USUARIOS INICIALES
  ======================================================= */

  const count =
    await env.DB
      .prepare(
        `SELECT COUNT(*) AS count FROM users`
      )
      .first();


  if (Number(count?.count || 0) === 0) {

    const t = nowIso();

    const seeds = [

      [
        "admin",
        "Administrador",
        "admin",
        "RushAdmin2026!"
      ],

      [
        "mesero",
        "Mesero",
        "mesero",
        "RushMesero2026!"
      ],

      [
        "cocina",
        "Cocina",
        "cocina",
        "RushCocina2026!"
      ]

    ];


    const stmts = [];


    for (
      const [username, name, role, password]
      of seeds
    ) {

      const {
        salt,
        hash
      } =
        await hashPassword(password);


      stmts.push(
        env.DB.prepare(`
          INSERT INTO users
          (
            id,
            username,
            name,
            role,
            password_hash,
            password_salt,
            active,
            created_at,
            updated_at
          )
          VALUES
          (?, ?, ?, ?, ?, ?, 1, ?, ?)
        `)
        .bind(
          crypto.randomUUID(),
          username,
          name,
          role,
          hash,
          salt,
          t,
          t
        )
      );
    }


    await env.DB.batch(stmts);
  }


  /* =======================================================
     MESAS INICIALES
  ======================================================= */

  const tableCount =
    await env.DB
      .prepare(
        `SELECT COUNT(*) AS count FROM "tables"`
      )
      .first();


  if (Number(tableCount?.count || 0) === 0) {

    const stmts = [];


    for (let i = 1; i <= 12; i++) {

      stmts.push(
        env.DB.prepare(`
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
          VALUES
          (?, ?, ?, ?, ?, ?, 1)
        `)
        .bind(
          crypto.randomUUID(),
          i,
          `Mesa ${i}`,
          "mesa",
          "available",
          4
        )
      );

    }


    await env.DB.batch(stmts);
  }


  /* =======================================================
     MENÚ INICIAL RUSH CLUB PÁDEL
  ======================================================= */

  const menuCount =
    await env.DB
      .prepare(
        `SELECT COUNT(*) AS count FROM menu_items`
      )
      .first();


  if (Number(menuCount?.count || 0) === 0) {

    const menu = [

      /* =========================
         ALIMENTOS
      ========================= */

      [
        "Hamburguesa Clásica",
        "Alimentos",
        149,
        "Hamburguesa de res con queso, lechuga, jitomate y papas.",
        1
      ],

      [
        "Hamburguesa BBQ",
        "Alimentos",
        169,
        "Hamburguesa de res, queso, tocino y salsa BBQ con papas.",
        2
      ],

      [
        "Chicken Burger",
        "Alimentos",
        159,
        "Hamburguesa de pollo empanizado con lechuga y aderezo.",
        3
      ],

      [
        "Club Sandwich",
        "Alimentos",
        159,
        "Sándwich de pollo, jamón, queso, lechuga y jitomate con papas.",
        4
      ],

      [
        "Quesadillas",
        "Alimentos",
        119,
        "Quesadillas de queso acompañadas de guacamole.",
        5
      ],

      [
        "Nachos con Queso",
        "Alimentos",
        129,
        "Totopos con queso, jalapeños y pico de gallo.",
        6
      ],

      [
        "Nachos con Carne",
        "Alimentos",
        169,
        "Totopos con queso, carne, jalapeños y pico de gallo.",
        7
      ],

      [
        "Boneless",
        "Alimentos",
        179,
        "Boneless de pollo con aderezo y papas.",
        8
      ],

      [
        "Alitas",
        "Alimentos",
        179,
        "Alitas de pollo con salsa a elegir y apio.",
        9
      ],

      [
        "Papas a la Francesa",
        "Alimentos",
        89,
        "Papas a la francesa.",
        10
      ],

      [
        "Papas con Queso y Tocino",
        "Alimentos",
        119,
        "Papas a la francesa con queso y tocino.",
        11
      ],

      [
        "Ensalada César",
        "Alimentos",
        149,
        "Lechuga, pollo, parmesano y aderezo César.",
        12
      ],

      [
        "Pizza Individual",
        "Alimentos",
        169,
        "Pizza individual. Ingredientes según disponibilidad.",
        13
      ],


      /* =========================
         DESAYUNOS
      ========================= */

      [
        "Chilaquiles",
        "Desayunos",
        139,
        "Chilaquiles rojos o verdes con crema, queso y huevo.",
        20
      ],

      [
        "Huevos al Gusto",
        "Desayunos",
        119,
        "Huevos preparados al gusto con frijoles y pan.",
        21
      ],

      [
        "Molletes",
        "Desayunos",
        109,
        "Molletes con frijoles, queso y pico de gallo.",
        22
      ],

      [
        "Hot Cakes",
        "Desayunos",
        109,
        "Hot cakes con miel y fruta.",
        23
      ],

      [
        "Avocado Toast",
        "Desayunos",
        129,
        "Pan tostado con aguacate y huevo.",
        24
      ],


      /* =========================
         CAFÉ
      ========================= */

      [
        "Espresso",
        "Café",
        45,
        "Espresso sencillo.",
        30
      ],

      [
        "Americano",
        "Café",
        49,
        "Café americano.",
        31
      ],

      [
        "Cappuccino",
        "Café",
        65,
        "Cappuccino.",
        32
      ],

      [
        "Latte",
        "Café",
        69,
        "Café latte.",
        33
      ],

      [
        "Latte Vainilla",
        "Café",
        75,
        "Latte con vainilla.",
        34
      ],

      [
        "Chocolate Caliente",
        "Café",
        69,
        "Chocolate caliente.",
        35
      ],

      [
        "Té",
        "Café",
        49,
        "Té caliente.",
        36
      ],


      /* =========================
         BEBIDAS
      ========================= */

      [
        "Agua Natural",
        "Bebidas",
        35,
        "Agua embotellada.",
        40
      ],

      [
        "Agua Mineral",
        "Bebidas",
        45,
        "Agua mineral.",
        41
      ],

      [
        "Refresco",
        "Bebidas",
        45,
        "Refresco en presentación individual.",
        42
      ],

      [
        "Agua de Jamaica",
        "Bebidas",
        49,
        "Agua fresca de jamaica.",
        43
      ],

      [
        "Agua de Horchata",
        "Bebidas",
        49,
        "Agua fresca de horchata.",
        44
      ],

      [
        "Limonada",
        "Bebidas",
        59,
        "Limonada natural.",
        45
      ],

      [
        "Naranjada",
        "Bebidas",
        59,
        "Naranjada natural.",
        46
      ],

      [
        "Smoothie de Frutos Rojos",
        "Bebidas",
        89,
        "Smoothie de frutos rojos.",
        47
      ],

      [
        "Smoothie de Mango",
        "Bebidas",
        89,
        "Smoothie de mango.",
        48
      ],


      /* =========================
         SNACKS
      ========================= */

      [
        "Barra de Granola",
        "Snacks",
        45,
        "Barra de granola.",
        60
      ],

      [
        "Fruta de Temporada",
        "Snacks",
        69,
        "Porción de fruta de temporada.",
        61
      ],

      [
        "Yogurt con Granola",
        "Snacks",
        79,
        "Yogurt con fruta y granola.",
        62
      ]

    ];


    const stmts =
      menu.map(
        ([
          name,
          category,
          price,
          description,
          sortOrder
        ]) =>

          env.DB.prepare(`
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
            (?, ?, ?, ?, ?, 1, ?)
          `)
          .bind(
            crypto.randomUUID(),
            name,
            category,
            price,
            description,
            sortOrder
          )
      );


    await env.DB.batch(stmts);
  }
}


/* =========================================================
   AUTENTICACIÓN
========================================================= */

function getToken(request) {

  const h =
    request.headers.get(
      "Authorization"
    ) || "";

  if (
    h.toLowerCase()
      .startsWith("bearer ")
  ) {
    return h.slice(7).trim();
  }

  return null;
}


async function auth(request, env) {

  const token =
    getToken(request);

  if (!token) {
    return null;
  }


  return await env.DB
    .prepare(`
      SELECT
        u.id,
        u.username,
        u.name,
        u.role,
        u.active,
        s.token,
        s.expires_at
      FROM sessions s
      JOIN users u
        ON u.id = s.user_id
      WHERE
        s.token = ?
        AND u.active = 1
        AND s.expires_at > ?
    `)
    .bind(
      token,
      nowIso()
    )
    .first();
}


function requireRole(user, roles) {
  return (
    user &&
    roles.includes(user.role)
  );
}


/* =========================================================
   API
========================================================= */

async function api(
  request,
  env,
  url
) {

  const p =
    url.pathname
      .replace(/^\/api\/?/, "");


  const [
    resource,
    id,
    action
  ] =
    p.split("/");


  /* =======================================================
     HEALTH
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "health"
  ) {

    return json({
      ok: true,
      service: "RUSH POS",
      time: nowIso()
    });

  }


  /* =======================================================
     LOGIN
  ======================================================= */

  if (
    request.method === "POST" &&
    resource === "login"
  ) {

    const d =
      await body(request);

    const username =
      String(
        d.username || ""
      )
      .trim()
      .toLowerCase();


    const password =
      String(
        d.password || ""
      );


    if (
      !username ||
      !password
    ) {

      return json({
        error:
          "Usuario y contraseña son obligatorios."
      }, 400);

    }


    const user =
      await env.DB
        .prepare(`
          SELECT *
          FROM users
          WHERE username = ?
            AND active = 1
        `)
        .bind(username)
        .first();


    if (
      !user ||
      !(
        await verifyPassword(
          password,
          user.password_salt,
          user.password_hash
        )
      )
    ) {

      return json({
        error:
          "Usuario o contraseña incorrectos."
      }, 401);

    }


    const token =
      randomHex(32);


    await env.DB
      .prepare(`
        INSERT INTO sessions
        (
          token,
          user_id,
          expires_at,
          created_at
        )
        VALUES
        (?, ?, ?, ?)
      `)
      .bind(
        token,
        user.id,
        futureIso(SESSION_DAYS),
        nowIso()
      )
      .run();


    return json({

      token,

      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role
      }

    });

  }


  /* =======================================================
     LOGOUT
  ======================================================= */

  if (
    request.method === "POST" &&
    resource === "logout"
  ) {

    const token =
      getToken(request);


    if (token) {

      await env.DB
        .prepare(
          `DELETE FROM sessions WHERE token=?`
        )
        .bind(token)
        .run();

    }


    return json({
      ok: true
    });

  }


  /* =======================================================
     ME
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "me"
  ) {

    const user =
      await auth(
        request,
        env
      );


    if (!user) {

      return json({
        error:
          "No autenticado."
      }, 401);

    }


    return json({

      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role
      }

    });

  }


  /* =======================================================
     AUTENTICACIÓN PARA EL RESTO
  ======================================================= */

  const user =
    await auth(
      request,
      env
    );


  if (!user) {

    return json({
      error:
        "Sesión no válida o expirada."
    }, 401);

  }


  /* =======================================================
     MENÚ - CONSULTAR
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "menu"
  ) {

    const rows =
      await env.DB
        .prepare(`
          SELECT *
          FROM menu_items
          WHERE active = 1
          ORDER BY
            category,
            sort_order,
            name
        `)
        .all();


    return json(
      rows.results
    );

  }


  /* =======================================================
     MENÚ - CREAR
  ======================================================= */

  if (
    request.method === "POST" &&
    resource === "menu"
  ) {

    if (
      !requireRole(
        user,
        ["admin"]
      )
    ) {

      return json({
        error:
          "Solo administrador."
      }, 403);

    }


    const d =
      await body(request);


    if (!d.name) {

      return json({
        error:
          "El producto necesita nombre."
      }, 400);

    }


    const newId =
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
        (?, ?, ?, ?, ?, 1, ?)
      `)
      .bind(
        newId,
        d.name,
        d.category || "General",
        Number(d.price || 0),
        d.description || "",
        Number(d.sort_order || 0)
      )
      .run();


    return json({
      id: newId
    }, 201);

  }


  /* =======================================================
     MENÚ - EDITAR
  ======================================================= */

  if (
    request.method === "PATCH" &&
    resource === "menu" &&
    id
  ) {

    if (
      !requireRole(
        user,
        ["admin"]
      )
    ) {

      return json({
        error:
          "Solo administrador."
      }, 403);

    }


    const d =
      await body(request);


    const sets = [];
    const vals = [];


    for (
      const k of [
        "name",
        "category",
        "price",
        "description",
        "active",
        "sort_order"
      ]
    ) {

      if (
        d[k] !== undefined
      ) {

        sets.push(
          `${k}=?`
        );


        vals.push(
          k === "price" ||
          k === "sort_order"
            ? Number(d[k])
            : d[k]
        );

      }
    }


    if (!sets.length) {

      return json({
        error:
          "Sin cambios."
      }, 400);

    }


    vals.push(id);


    await env.DB
      .prepare(`
        UPDATE menu_items
        SET ${sets.join(",")}
        WHERE id=?
      `)
      .bind(...vals)
      .run();


    return json({
      ok: true
    });

  }


  /* =======================================================
     MESAS - CONSULTAR
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "tables"
  ) {

    const rows =
      await env.DB
        .prepare(`
          SELECT *
          FROM "tables"
          WHERE active=1
          ORDER BY
            type,
            number
        `)
        .all();


    return json(
      rows.results
    );

  }


  /* =======================================================
     MESAS - CAMBIAR ESTADO
  ======================================================= */

  if (
    request.method === "PATCH" &&
    resource === "tables" &&
    id
  ) {

    if (
      !requireRole(
        user,
        ["admin", "mesero"]
      )
    ) {

      return json({
        error:
          "Sin permiso."
      }, 403);

    }


    const d =
      await body(request);


    if (
      ![
        "available",
        "occupied",
        "reserved"
      ].includes(
        String(
          d.status || ""
        )
      )
    ) {

      return json({
        error:
          "Estado de mesa inválido."
      }, 400);

    }


    await env.DB
      .prepare(`
        UPDATE "tables"
        SET status=?
        WHERE id=?
      `)
      .bind(
        d.status,
        id
      )
      .run();


    return json({
      ok: true
    });

  }


  /* =======================================================
     ORDEN - CONSULTAR UNA
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "orders" &&
    id
  ) {

    const order =
      await env.DB
        .prepare(`
          SELECT *
          FROM orders
          WHERE id=?
        `)
        .bind(id)
        .first();


    if (!order) {

      return json({
        error:
          "Orden no encontrada."
      }, 404);

    }


    const items =
      await env.DB
        .prepare(`
          SELECT *
          FROM order_items
          WHERE order_id=?
          ORDER BY id
        `)
        .bind(id)
        .all();


    return json({
      order,
      items:
        items.results
    });

  }


  /* =======================================================
     ÓRDENES - LISTAR
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "orders"
  ) {

    const status =
      url.searchParams.get(
        "status"
      );


    let q =
      `SELECT * FROM orders`;


    const args = [];


    if (status) {

      q +=
        ` WHERE status=?`;

      args.push(status);

    }


    q +=
      ` ORDER BY created_at DESC LIMIT 200`;


    const rows =
      await env.DB
        .prepare(q)
        .bind(...args)
        .all();


    return json(
      rows.results
    );

  }


  /* =======================================================
     ÓRDENES - CREAR
  ======================================================= */

  if (
    request.method === "POST" &&
    resource === "orders"
  ) {

    if (
      !requireRole(
        user,
        ["admin", "mesero"]
      )
    ) {

      return json({
        error:
          "Solo mesero o administrador."
      }, 403);

    }


    const data =
      await body(request);


    if (
      !data.items?.length
    ) {

      return json({
        error:
          "La orden necesita al menos un producto."
      }, 400);

    }


    const orderId =
      crypto.randomUUID();


    const now =
      nowIso();


    const subtotal =
      data.items.reduce(
        (s, x) =>
          s +
          Number(x.qty || 1) *
          Number(
            x.unit_price || 0
          ),
        0
      );


    const discount =
      Number(
        data.discount || 0
      );


    const total =
      Math.max(
        0,
        subtotal - discount
      );


    const stmts = [

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
          payment_method,
          created_at,
          updated_at
        )
        VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        orderId,
        data.table_id || null,
        data.customer_name || "",
        data.notes || "",
        "open",
        subtotal,
        discount,
        total,
        "pending",
        "",
        now,
        now
      )

    ];


    for (
      const item
      of data.items
    ) {

      stmts.push(

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
          (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          orderId,
          item.menu_item_id || null,
          item.name,
          Number(
            item.qty || 1
          ),
          Number(
            item.unit_price || 0
          ),
          JSON.stringify(
            item.modifiers || []
          ),
          item.notes || ""
        )

      );

    }


    await env.DB.batch(
      stmts
    );


    if (
      data.table_id
    ) {

      await env.DB
        .prepare(`
          UPDATE "tables"
          SET status='occupied'
          WHERE id=?
        `)
        .bind(
          data.table_id
        )
        .run();

    }


    return json({
      id: orderId,
      subtotal,
      discount,
      total,
      status: "open"
    }, 201);

  }


  /* =======================================================
     ORDEN - ACTUALIZAR
  ======================================================= */

  if (
    request.method === "PATCH" &&
    resource === "orders" &&
    id
  ) {

    const data =
      await body(request);


    const canEdit =
      requireRole(
        user,
        ["admin", "mesero"]
      );


    const canKitchen =
      requireRole(
        user,
        ["admin", "cocina"]
      );


    if (
      data.status &&
      [
        "preparing",
        "ready"
      ].includes(
        data.status
      ) &&
      !canKitchen
    ) {

      return json({
        error:
          "Solo cocina o administrador puede cambiar ese estado."
      }, 403);

    }


    if (
      (
        data.status === "paid" ||
        data.payment_status === "paid"
      ) &&
      !canEdit
    ) {

      return json({
        error:
          "Solo mesero o administrador puede cobrar."
      }, 403);

    }


    if (
      !canEdit &&
      !canKitchen
    ) {

      return json({
        error:
          "Sin permiso."
      }, 403);

    }


    const allowed = [
      "status",
      "payment_status",
      "payment_method",
      "notes",
      "discount"
    ];


    const sets = [];
    const vals = [];


    for (
      const k of allowed
    ) {

      if (
        data[k] !== undefined
      ) {

        sets.push(
          `${k}=?`
        );

        vals.push(
          data[k]
        );

      }
    }


    if (
      data.status === "paid" ||
      data.payment_status === "paid"
    ) {

      sets.push(
        "closed_at=?"
      );

      vals.push(
        nowIso()
      );

    }


    if (!sets.length) {

      return json({
        error:
          "Sin cambios."
      }, 400);

    }


    sets.push(
      "updated_at=?"
    );


    vals.push(
      nowIso(),
      id
    );


    await env.DB
      .prepare(`
        UPDATE orders
        SET ${sets.join(",")}
        WHERE id=?
      `)
      .bind(...vals)
      .run();


    if (
      data.status === "paid"
    ) {

      const order =
        await env.DB
          .prepare(`
            SELECT *
            FROM orders
            WHERE id=?
          `)
          .bind(id)
          .first();


      if (
        order?.table_id
      ) {

        await env.DB
          .prepare(`
            UPDATE "tables"
            SET status='available'
            WHERE id=?
          `)
          .bind(
            order.table_id
          )
          .run();

      }

    }


    return json({
      ok: true
    });

  }


  /* =======================================================
     DASHBOARD
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "dashboard"
  ) {

    if (
      !requireRole(
        user,
        ["admin"]
      )
    ) {

      return json({
        error:
          "Solo administrador."
      }, 403);

    }


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
          WHERE status='paid'
            AND substr(
              created_at,
              1,
              10
            )=?
        `)
        .bind(today)
        .first();


    const open =
      await env.DB
        .prepare(`
          SELECT COUNT(*) count
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
          SELECT COUNT(*) count
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


  /* =======================================================
     CAJA - CONSULTAR
  ======================================================= */

  if (
    request.method === "GET" &&
    resource === "cash"
  ) {

    if (
      !requireRole(
        user,
        ["admin"]
      )
    ) {

      return json({
        error:
          "Solo administrador."
      }, 403);

    }


    const rows =
      await env.DB
        .prepare(`
          SELECT *
          FROM cash_movements
          ORDER BY created_at DESC
          LIMIT 200
        `)
        .all();


    return json(
      rows.results
    );

  }


  /* =======================================================
     CAJA - CREAR MOVIMIENTO
  ======================================================= */

  if (
    request.method === "POST" &&
    resource === "cash"
  ) {

    if (
      !requireRole(
        user,
        ["admin"]
      )
    ) {

      return json({
        error:
          "Solo administrador."
      }, 403);

    }


    const d =
      await body(request);


    const newId =
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
        (?, ?, ?, ?, ?, ?)
      `)
      .bind(
        newId,
        d.type,
        Number(
          d.amount || 0
        ),
        d.concept || "",
        d.order_id || null,
        nowIso()
      )
      .run();


    return json({
      id: newId
    }, 201);

  }


  /* =======================================================
     USUARIOS
  ======================================================= */

  if (
    resource === "users"
  ) {

    if (
      !requireRole(
        user,
        ["admin"]
      )
    ) {

      return json({
        error:
          "Solo administrador."
      }, 403);

    }


    /* =====================================================
       LISTAR USUARIOS
    ===================================================== */

    if (
      request.method === "GET" &&
      !id
    ) {

      const rows =
        await env.DB
          .prepare(`
            SELECT
              id,
              username,
              name,
              role,
              active,
              created_at,
              updated_at
            FROM users
            ORDER BY name
          `)
          .all();


      return json(
        rows.results
      );

    }


    /* =====================================================
       CREAR USUARIO
    ===================================================== */

    if (
      request.method === "POST" &&
      !id
    ) {

      const d =
        await body(request);


      const username =
        String(
          d.username || ""
        )
        .trim()
        .toLowerCase();


      const name =
        String(
          d.name || ""
        )
        .trim();


      const password =
        String(
          d.password || ""
        );


      const role =
        String(
          d.role || ""
        )
        .trim()
        .toLowerCase();


    /* VALIDACIÓN */

      if (
        !username ||
        !name ||
        !password ||
        ![
          "admin",
          "mesero",
          "cocina"
        ].includes(role)
      ) {

        return json({
          error:
            `Debug - Recibido: nombre='${name}', usuario='${username}', pass='${password ? "OK" : "FALTA"}', rol='${role}'`
        }, 400);

      }
      /* COMPROBAR USUARIO EXISTENTE */

      const exists =
        await env.DB
          .prepare(`
            SELECT id
            FROM users
            WHERE username=?
          `)
          .bind(username)
          .first();


      if (exists) {

        return json({
          error:
            "Ese usuario ya existe."
        }, 409);

      }


      /* CREAR CONTRASEÑA */

      const {
        salt,
        hash
      } =
        await hashPassword(
          password
        );


      /* ID */

      const newId =
        crypto.randomUUID();


      /* INSERTAR USUARIO */

      await env.DB
        .prepare(`
          INSERT INTO users
          (
            id,
            username,
            name,
            role,
            password_hash,
            password_salt,
            active,
            created_at,
            updated_at
          )
          VALUES
          (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            1,
            ?,
            ?
          )
        `)
        .bind(
          newId,
          username,
          name,
          role,
          hash,
          salt,
          nowIso(),
          nowIso()
        )
        .run();


      /* RESPUESTA */

      return json({
        ok: true,
        id: newId,
        message:
          "Usuario creado correctamente.",
        username,
        name,
        role
      }, 201);

    }


    /* =====================================================
       EDITAR USUARIO
    ===================================================== */

    if (
      request.method === "PATCH" &&
      id
    ) {

      const d =
        await body(request);


      const target =
        await env.DB
          .prepare(`
            SELECT *
            FROM users
            WHERE id=?
          `)
          .bind(id)
          .first();


      if (!target) {

        return json({
          error:
            "Usuario no encontrado."
        }, 404);

      }


      const sets = [];
      const vals = [];


      if (
        d.name !== undefined
      ) {

        sets.push(
          "name=?"
        );

        vals.push(
          d.name
        );

      }


      if (
        d.role !== undefined &&
        [
          "admin",
          "mesero",
          "cocina"
        ].includes(
          d.role
        )
      ) {

        sets.push(
          "role=?"
        );

        vals.push(
          d.role
        );

      }


      if (
        d.active !== undefined
      ) {

        sets.push(
          "active=?"
        );

        vals.push(
          d.active ? 1 : 0
        );

      }


      if (
        d.password
      ) {

        const {
          salt,
          hash
        } =
          await hashPassword(
            String(
              d.password
            )
          );


        sets.push(
          "password_hash=?",
          "password_salt=?"
        );


        vals.push(
          hash,
          salt
        );

      }


      if (!sets.length) {

        return json({
          error:
            "Sin cambios."
        }, 400);

      }


      sets.push(
        "updated_at=?"
      );


      vals.push(
        nowIso(),
        id
      );


      await env.DB
        .prepare(`
          UPDATE users
          SET ${sets.join(",")}
          WHERE id=?
        `)
        .bind(...vals)
        .run();


      return json({
        ok: true,
        message:
          "Usuario actualizado correctamente."
      });

    }

  }


  /* =======================================================
     RUTA NO ENCONTRADA
  ======================================================= */

  return json({
    error:
      "Ruta no encontrada"
  }, 404);
}
