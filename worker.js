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
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function body(request) {
  return await request.json().catch(() => ({}));
}

function nowIso() {
  return new Date().toISOString();
}

function futureIso(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

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
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
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

async function ensureDatabase(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','mesero','cocina')),
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'General',
      price REAL NOT NULL DEFAULT 0,
      description TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS "tables" (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL,
      name TEXT DEFAULT '',
      type TEXT DEFAULT 'mesa',
      status TEXT DEFAULT 'available',
      capacity INTEGER DEFAULT 4,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS orders (
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
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      menu_item_id TEXT,
      name TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      modifiers TEXT DEFAULT '[]',
      notes TEXT DEFAULT ''
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cash_movements (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      concept TEXT DEFAULT '',
      order_id TEXT,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS payment_transactions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      payer_name TEXT DEFAULT '',
      method TEXT NOT NULL CHECK(method IN ('cash','card','mixed')),
      amount REAL NOT NULL DEFAULT 0,
      cash_amount REAL NOT NULL DEFAULT 0,
      card_amount REAL NOT NULL DEFAULT 0,
      terminal_amount REAL NOT NULL DEFAULT 0,
      terminal_reference TEXT DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS payment_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id TEXT NOT NULL,
      order_item_id INTEGER NOT NULL,
      qty REAL NOT NULL DEFAULT 0,
      amount REAL NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_payments_order ON payment_transactions(order_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_payment_allocations_payment ON payment_allocations(payment_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_payment_allocations_item ON payment_allocations(order_item_id)`)
  ]);

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
      stmts.push(env.DB.prepare(`INSERT INTO users
        (id,username,name,role,password_hash,password_salt,active,created_at,updated_at)
        VALUES (?,?,?,?,?,?,1,?,?)`
      ).bind(crypto.randomUUID(), username, name, role, hash, salt, t, t));
    }
    await env.DB.batch(stmts);
  }

  const tableCount = await env.DB.prepare(`SELECT COUNT(*) AS count FROM "tables"`).first();
  if (Number(tableCount?.count || 0) === 0) {
    const stmts = [];
    for (let i = 1; i <= 12; i++) {
      stmts.push(env.DB.prepare(`INSERT INTO "tables"
        (id,number,name,type,status,capacity,active)
        VALUES (?,?,?,?,?,?,1)`
      ).bind(crypto.randomUUID(), i, `Mesa ${i}`, "mesa", "available", 4));
    }
    await env.DB.batch(stmts);
  }

  // Menú oficial de The Rush, transcrito de la carta proporcionada.
  // Se instala una sola vez por versión para no sobrescribir cambios posteriores del administrador.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`).run();

  const MENU_VERSION = "2026-09-22-carta-photos-v1";
  const menuVersion = await env.DB.prepare(`SELECT value FROM app_config WHERE key='menu_version'`).first();

  if (menuVersion?.value !== MENU_VERSION) {
    await env.DB.prepare(`DELETE FROM menu_items`).run();

    const menu = [
  [
    "Arrachera",
    "Tacos",
    40,
    "Con perejil frito · 80 g",
    1
  ],
  [
    "Roast Beef",
    "Tacos",
    40,
    "Con perejil frito · 80 g",
    2
  ],
  [
    "Sirloin",
    "Tacos",
    40,
    "Con perejil frito · 80 g",
    3
  ],
  [
    "Chorizo Argentino",
    "Tacos",
    25,
    "Con perejil frito · 80 g",
    4
  ],
  [
    "Chistorra",
    "Tacos",
    25,
    "Con perejil frito · 80 g",
    5
  ],
  [
    "De Arrachera",
    "Gringas",
    80,
    "120 g",
    6
  ],
  [
    "De Roast Beef",
    "Gringas",
    80,
    "120 g",
    7
  ],
  [
    "De Sirloin",
    "Gringas",
    80,
    "120 g",
    8
  ],
  [
    "De Chorizo Argentino",
    "Gringas",
    50,
    "120 g",
    9
  ],
  [
    "De Chistorra",
    "Gringas",
    50,
    "120 g",
    10
  ],
  [
    "Hamburguesa Sencilla",
    "Hamburguesas",
    90,
    "Queso manchego, carne de res, tocino, lechuga, jitomate, cebolla morada y aderezos.",
    11
  ],
  [
    "Hamburguesa Hawaiana",
    "Hamburguesas",
    110,
    "Queso manchego, carne de res, tocino, piña, jamón, lechuga, jitomate, cebolla morada y aderezos.",
    12
  ],
  [
    "Hamburguesa Doble",
    "Hamburguesas",
    130,
    "Doble queso manchego, doble carne de res, tocino, lechuga, jitomate, cebolla morada y aderezos.",
    13
  ],
  [
    "Papas a la Francesa",
    "Snacks",
    40,
    "250 g",
    14
  ],
  [
    "Papas Rush",
    "Snacks",
    60,
    "Con tocino y queso cheddar",
    15
  ],
  [
    "Arrachera",
    "Burritos",
    90,
    "Con queso, arrachera, frijoles, lechuga, pico de gallo. 250 g",
    16
  ],
  [
    "Roast Beef",
    "Burritos",
    90,
    "Con queso, roast beef, frijoles, lechuga, pico de gallo. 250 g",
    17
  ],
  [
    "Sirloin",
    "Burritos",
    90,
    "Con queso, sirloin, frijoles, lechuga, pico de gallo. 250 g",
    18
  ],
  [
    "Chorizo Argentino",
    "Burritos",
    70,
    "Con queso, chorizo argentino, frijoles, lechuga, pico de gallo. 250 g",
    19
  ],
  [
    "Chistorra",
    "Burritos",
    70,
    "Con queso, chistorra, frijoles, lechuga, pico de gallo. 250 g",
    20
  ],
  [
    "De Arrachera",
    "Volcanes",
    60,
    "110 g",
    21
  ],
  [
    "De Roast Beef",
    "Volcanes",
    60,
    "110 g",
    22
  ],
  [
    "De Sirloin",
    "Volcanes",
    60,
    "110 g",
    23
  ],
  [
    "De Chorizo Argentino",
    "Volcanes",
    40,
    "110 g",
    24
  ],
  [
    "De Chistorra",
    "Volcanes",
    40,
    "110 g",
    25
  ],
  [
    "De Queso",
    "Volcanes",
    30,
    "110 g",
    26
  ],
  [
    "Hot Dog",
    "Otros",
    70,
    "Pan brioche, salchicha alemana, cebolla caramelizada y queso cheddar derretido.",
    27
  ],
  [
    "Hot Dog Especial",
    "Otros",
    85,
    "Enrollado en tocino, queso manchego y cebolla caramelizada",
    28
  ],
  [
    "Choripán",
    "Otros",
    70,
    "Pan de baguette, chorizo argentino y chimichurri",
    29
  ],
  [
    "Pepito de Arrachera",
    "Otros",
    90,
    "Arrachera, cebolla caramelizada y aderezo.",
    30
  ],
  [
    "Clásico",
    "Sandwiches",
    70,
    "Jamón, queso, jitomate, lechuga, cebolla, mayonesa chipotle.",
    31
  ],
  [
    "Español",
    "Sandwiches",
    99,
    "Jamón serrano, queso",
    32
  ],
  [
    "Pollo",
    "Sandwiches",
    70,
    "Pollo, queso manchego, jitomate, cebolla morada",
    33
  ],
  [
    "Clásicas",
    "Enchiladas",
    90,
    "Rellenas de pollo cubiertas de salsa verde o roja, crema y queso",
    34
  ],
  [
    "Suizas",
    "Enchiladas",
    110,
    "Rellenas de pollo, salsa de la casa, gratinadas con queso",
    35
  ],
  [
    "Sencillos",
    "Chilaquiles",
    90,
    "Con pollo, salsa de la casa verde o roja, crema y queso",
    36
  ],
  [
    "Huevo",
    "Chilaquiles",
    90,
    "Con huevo, salsa de la casa verde o roja, crema y queso",
    37
  ],
  [
    "Arrachera",
    "Chilaquiles",
    130,
    "Con arrachera, salsa de la casa verde o roja, crema y queso",
    38
  ],
  [
    "Huevos al gusto",
    "Otros desayuno",
    70,
    "2 huevos, preparados al gusto",
    39
  ],
  [
    "Café americano + jugo",
    "Paquete",
    50,
    "",
    40
  ],
  [
    "Milanesa",
    "Molletes",
    80,
    "Frijoles, queso, 60 g de milanesa de pollo",
    41
  ],
  [
    "Pollo",
    "Molletes",
    70,
    "Frijoles, queso y 60 g de pollo deshebrado",
    42
  ],
  [
    "Tocino",
    "Molletes",
    80,
    "Frijoles, queso, 4 rebanadas de tocino",
    43
  ],
  [
    "Chorizo Argentino",
    "Molletes",
    70,
    "Frijoles, queso y 60 g de chorizo argentino",
    44
  ],
  [
    "Hot Cakes",
    "Dulces",
    60,
    "3 piezas",
    45
  ],
  [
    "Pan Francés",
    "Dulces",
    130,
    "Frutos rojos, helado de vainilla y azúcar glass · 2 piezas",
    46
  ],
  [
    "Pink Shake",
    "Protein Shakes",
    120,
    "Fresas, yogurt griego, proteína vainilla, leche, miel",
    47
  ],
  [
    "Reese's",
    "Protein Shakes",
    110,
    "Plátano, crema de maní, proteína de chocolate, leche",
    48
  ],
  [
    "Strawberry Mango",
    "Protein Shakes",
    120,
    "Fresas, mango, yogurt griego, proteína de vainilla, leche",
    49
  ],
  [
    "Strawberry Chocolate",
    "Protein Shakes",
    120,
    "Fresas, plátano, yogurt griego, proteína de chocolate, leche",
    50
  ],
  [
    "Protein Berry",
    "Protein Shakes",
    130,
    "Frutos rojos, yogurt griego, proteína de vainilla, leche",
    51
  ],
  [
    "Blue Rush",
    "Protein Shakes",
    130,
    "Mango, espirulina azul, proteína de vainilla, leche",
    52
  ],
  [
    "Tropical",
    "Protein Shakes",
    120,
    "Mango, piña, yogurt griego, extracto de vainilla, proteína de vainilla, miel, leche",
    53
  ],
  [
    "Jugo Naranja",
    "Jugos",
    50,
    "450 ml",
    54
  ],
  [
    "Glow Boost",
    "Jugos",
    50,
    "Jugo de zanahoria con betabel y naranja · 450 ml",
    55
  ],
  [
    "Green",
    "Jugos",
    50,
    "Jugo de naranja con piña, perejil, espinaca, nopal y apio · 450 ml",
    56
  ],
  [
    "Very Berry",
    "Jugos",
    60,
    "Jugo de naranja y frutos rojos · 450 ml",
    57
  ],
  [
    "Energy",
    "Jugos",
    60,
    "Jugo de naranja, blueberries y piña · 450 ml",
    58
  ],
  [
    "Sunrise",
    "Jugos",
    50,
    "Jugo de naranja con apio, jengibre y piña · 450 ml",
    59
  ],
  [
    "Refrescos",
    "Bebidas",
    40,
    "600 ml",
    60
  ],
  [
    "Rusa",
    "Bebidas",
    55,
    "16 oz",
    61
  ],
  [
    "Agua del Día",
    "Bebidas",
    35,
    "16 oz",
    62
  ],
  [
    "Jarra 1 L Agua del Día",
    "Bebidas",
    70,
    "",
    63
  ],
  [
    "Jarra 2 L Agua del Día",
    "Bebidas",
    110,
    "",
    64
  ],
  [
    "Naranjada",
    "Bebidas",
    60,
    "16 oz",
    65
  ],
  [
    "Limonada",
    "Bebidas",
    60,
    "16 oz",
    66
  ],
  [
    "Limonada de Frutos Rojos",
    "Bebidas",
    65,
    "16 oz",
    67
  ],
  [
    "Agua Natural",
    "Bebidas",
    35,
    "600 ml",
    68
  ],
  [
    "Té Negro Sin Azúcar",
    "Bebidas",
    55,
    "16 oz",
    69
  ],
  [
    "Té Berries Jamaica Sin Azúcar",
    "Bebidas",
    55,
    "16 oz",
    70
  ],
  [
    "Espresso",
    "Café caliente",
    40,
    "7 oz",
    71
  ],
  [
    "Espresso Doble",
    "Café caliente",
    50,
    "12 oz",
    72
  ],
  [
    "Americano",
    "Café caliente",
    45,
    "12 oz",
    73
  ],
  [
    "Americano",
    "Café caliente",
    55,
    "16 oz",
    74
  ],
  [
    "Capuchino",
    "Café caliente",
    50,
    "12 oz",
    75
  ],
  [
    "Capuchino",
    "Café caliente",
    70,
    "16 oz",
    76
  ],
  [
    "Latte",
    "Café caliente",
    70,
    "12 oz",
    77
  ],
  [
    "Latte",
    "Café caliente",
    80,
    "16 oz",
    78
  ],
  [
    "Flat White",
    "Café caliente",
    70,
    "12 oz",
    79
  ],
  [
    "Flat White",
    "Café caliente",
    80,
    "16 oz",
    80
  ],
  [
    "Vainilla Latte",
    "Café caliente",
    75,
    "12 oz",
    81
  ],
  [
    "Vainilla Latte",
    "Café caliente",
    85,
    "16 oz",
    82
  ],
  [
    "Hazelnut Latte",
    "Café caliente",
    75,
    "12 oz",
    83
  ],
  [
    "Hazelnut Latte",
    "Café caliente",
    85,
    "16 oz",
    84
  ],
  [
    "Caramel Macchiato",
    "Café caliente",
    75,
    "12 oz",
    85
  ],
  [
    "Caramel Macchiato",
    "Café caliente",
    85,
    "16 oz",
    86
  ],
  [
    "Mocha Blanco",
    "Café caliente",
    75,
    "12 oz",
    87
  ],
  [
    "Mocha Blanco",
    "Café caliente",
    85,
    "16 oz",
    88
  ],
  [
    "Mocha",
    "Café caliente",
    75,
    "12 oz",
    89
  ],
  [
    "Mocha",
    "Café caliente",
    85,
    "16 oz",
    90
  ],
  [
    "Dirty Chai",
    "Café caliente",
    90,
    "12 oz",
    91
  ],
  [
    "Dirty Chai",
    "Café caliente",
    105,
    "16 oz",
    92
  ],
  [
    "Chocolate",
    "Café caliente",
    70,
    "12 oz",
    93
  ],
  [
    "Chocolate",
    "Café caliente",
    80,
    "16 oz",
    94
  ],
  [
    "Choco. Blanco",
    "Café caliente",
    70,
    "12 oz",
    95
  ],
  [
    "Choco. Blanco",
    "Café caliente",
    80,
    "16 oz",
    96
  ],
  [
    "Taro Latte",
    "Café caliente",
    80,
    "12 oz",
    97
  ],
  [
    "Taro Latte",
    "Café caliente",
    90,
    "16 oz",
    98
  ],
  [
    "Matcha Latte",
    "Café caliente",
    80,
    "12 oz",
    99
  ],
  [
    "Matcha Latte",
    "Café caliente",
    90,
    "16 oz",
    100
  ],
  [
    "Chai Latte",
    "Café caliente",
    80,
    "12 oz",
    101
  ],
  [
    "Chai Latte",
    "Café caliente",
    90,
    "16 oz",
    102
  ],
  [
    "Frappé Mocha/Mocha Blanco/Taro/Chai/Caramel/Chocolate/Chocolate Blanco",
    "Frappés",
    90,
    "16 oz",
    103
  ],
  [
    "Frappé Maracuyá/Mango/Fresa",
    "Frappés",
    75,
    "16 oz",
    104
  ],
  [
    "Vainilla Latte",
    "Calorie Free",
    99,
    "16 oz · frío o caliente",
    105
  ],
  [
    "Hazelnut Latte",
    "Calorie Free",
    99,
    "16 oz · frío o caliente",
    106
  ],
  [
    "Dirty Chai",
    "Calorie Free",
    120,
    "16 oz · frío o caliente",
    107
  ],
  [
    "Taro Latte",
    "Calorie Free",
    99,
    "16 oz · frío o caliente",
    108
  ],
  [
    "Chai Latte",
    "Calorie Free",
    99,
    "16 oz · frío o caliente",
    109
  ],
  [
    "Refresher Fresa",
    "Bebidas Refrescantes",
    60,
    "16 oz",
    110
  ],
  [
    "Refresher Mora Azul",
    "Bebidas Refrescantes",
    60,
    "Sin azúcar · 16 oz",
    111
  ],
  [
    "Té Negro",
    "Bebidas Refrescantes",
    55,
    "Sin azúcar · 16 oz",
    112
  ],
  [
    "Té Berries Jamaica",
    "Bebidas Refrescantes",
    55,
    "Sin azúcar · 16 oz",
    113
  ],
  [
    "Iced Coffee",
    "Bebidas Frías",
    60,
    "16 oz",
    114
  ],
  [
    "Cold Latte",
    "Bebidas Frías",
    80,
    "16 oz",
    115
  ],
  [
    "Cold Brew",
    "Bebidas Frías",
    80,
    "16 oz",
    116
  ],
  [
    "Vainilla Latte",
    "Bebidas Frías",
    89,
    "16 oz",
    117
  ],
  [
    "Hazelnut Latte",
    "Bebidas Frías",
    89,
    "16 oz",
    118
  ],
  [
    "Caramel Latte",
    "Bebidas Frías",
    89,
    "16 oz",
    119
  ],
  [
    "Mocha Blanco",
    "Bebidas Frías",
    89,
    "16 oz",
    120
  ],
  [
    "Mocha",
    "Bebidas Frías",
    89,
    "16 oz",
    121
  ],
  [
    "Dirty Chai",
    "Bebidas Frías",
    110,
    "16 oz",
    122
  ],
  [
    "Taro Latte",
    "Bebidas Frías",
    90,
    "16 oz",
    123
  ],
  [
    "Matcha Latte",
    "Bebidas Frías",
    90,
    "16 oz",
    124
  ],
  [
    "Chai Latte",
    "Bebidas Frías",
    90,
    "16 oz",
    125
  ],
  [
    "Mango Matcha",
    "Matcha Bar",
    99,
    "Matcha ceremonial · 16 oz",
    126
  ],
  [
    "Strawberry Matcha",
    "Matcha Bar",
    99,
    "Matcha ceremonial · 16 oz",
    127
  ],
  [
    "Matcha con Foam Taro",
    "Matcha Bar",
    99,
    "Matcha ceremonial · 16 oz",
    128
  ],
  [
    "Matcha con Foam Chai",
    "Matcha Bar",
    99,
    "Matcha ceremonial · 16 oz",
    129
  ],
  [
    "Matcha con Foam Caramel",
    "Matcha Bar",
    99,
    "Matcha ceremonial · 16 oz",
    130
  ],
  [
    "Matcha con Foam Vainilla",
    "Matcha Bar",
    99,
    "Matcha ceremonial · 16 oz",
    131
  ],
  [
    "Leche de avena / almendra",
    "Extras",
    10,
    "",
    132
  ],
  [
    "Leche de coco",
    "Extras",
    15,
    "",
    133
  ],
  [
    "Limonada",
    "Extras",
    8,
    "",
    134
  ],
  [
    "Foam",
    "Extras",
    15,
    "",
    135
  ]
];

    const stmts = menu.map(([name, category, price, description, sortOrder]) =>
      env.DB.prepare(`INSERT INTO menu_items
        (id,name,category,price,description,active,sort_order)
        VALUES (?,?,?,?,?,1,?)`).bind(
        crypto.randomUUID(), name, category, price, description, sortOrder
      )
    );

    await env.DB.batch(stmts);
    await env.DB.prepare(`INSERT INTO app_config(key,value) VALUES('menu_version',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(MENU_VERSION).run();
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
  return await env.DB.prepare(`
    SELECT u.id,u.username,u.name,u.role,u.active,s.token,s.expires_at
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND u.active=1 AND s.expires_at>?
  `).bind(token, nowIso()).first();
}

function requireRole(user, roles) {
  return user && roles.includes(user.role);
}

async function api(request, env, url) {
  const p = url.pathname.replace(/^\/api\/?/, "");
  const [resource, id, action] = p.split("/");

  if (request.method === "GET" && resource === "health") {
    return json({ ok: true, service: "RUSH POS", time: nowIso() });
  }

  if (request.method === "POST" && resource === "login") {
    const d = await body(request);
    const username = String(d.username || "").trim().toLowerCase();
    const password = String(d.password || "");
    if (!username || !password) return json({ error: "Usuario y contraseña son obligatorios." }, 400);

    const user = await env.DB.prepare(`SELECT * FROM users WHERE username=? AND active=1`).bind(username).first();
    if (!user || !(await verifyPassword(password, user.password_salt, user.password_hash))) {
      return json({ error: "Usuario o contraseña incorrectos." }, 401);
    }

    const token = randomHex(32);
    await env.DB.prepare(`INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES (?,?,?,?)`)
      .bind(token, user.id, futureIso(SESSION_DAYS), nowIso()).run();

    return json({
      token,
      user: { id: user.id, username: user.username, name: user.name, role: user.role }
    });
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

  if (request.method === "GET" && resource === "menu") {
    const rows = await env.DB.prepare(`SELECT * FROM menu_items WHERE active=1 ORDER BY category,sort_order,name`).all();
    return json(rows.results);
  }

  if (request.method === "POST" && resource === "menu") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    const d = await body(request);
    if (!d.name) return json({ error: "El producto necesita nombre." }, 400);
    const newId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO menu_items(id,name,category,price,description,active,sort_order)
      VALUES (?,?,?,?,?,1,?)`).bind(
      newId, d.name, d.category || "General", Number(d.price || 0), d.description || "", Number(d.sort_order || 0)
    ).run();
    return json({ id: newId }, 201);
  }

  if (request.method === "PATCH" && resource === "menu" && id) {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    const d = await body(request);
    const sets = [], vals = [];
    for (const k of ["name","category","price","description","active","sort_order"]) {
      if (d[k] !== undefined) { sets.push(`${k}=?`); vals.push(k === "price" || k === "sort_order" ? Number(d[k]) : d[k]); }
    }
    if (!sets.length) return json({ error: "Sin cambios." }, 400);
    vals.push(id);
    await env.DB.prepare(`UPDATE menu_items SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
    return json({ ok: true });
  }

  if (request.method === "GET" && resource === "tables") {
    const rows = await env.DB.prepare(`SELECT * FROM "tables" WHERE active=1 ORDER BY type,number`).all();
    return json(rows.results);
  }

  if (request.method === "PATCH" && resource === "tables" && id) {
    if (!requireRole(user, ["admin","mesero"])) return json({ error: "Sin permiso." }, 403);
    const d = await body(request);
    if (!["available","occupied","reserved"].includes(String(d.status || ""))) return json({ error: "Estado de mesa inválido." }, 400);
    await env.DB.prepare(`UPDATE "tables" SET status=? WHERE id=?`).bind(d.status, id).run();
    return json({ ok: true });
  }

  if (request.method === "GET" && resource === "orders" && id) {
    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`).bind(id).first();
    if (!order) return json({ error: "Orden no encontrada." }, 404);
    const items = await env.DB.prepare(`SELECT * FROM order_items WHERE order_id=? ORDER BY id`).bind(id).all();
    const payments = await env.DB.prepare(`SELECT * FROM payment_transactions WHERE order_id=? ORDER BY created_at, id`).bind(id).all();
    const allocations = await env.DB.prepare(`SELECT * FROM payment_allocations WHERE payment_id IN (SELECT id FROM payment_transactions WHERE order_id=?) ORDER BY id`).bind(id).all();
    const paid = payments.results.reduce((s,p)=>s+Number(p.amount||0),0);
    return json({ order, items: items.results, payments: payments.results, allocations: allocations.results, paid, remaining: Math.max(0, Number(order.total||0)-paid) });
  }

  if (request.method === "GET" && resource === "orders") {
    const status = url.searchParams.get("status");
    let q = `SELECT o.*, COALESCE((SELECT SUM(pt.amount) FROM payment_transactions pt WHERE pt.order_id=o.id),0) AS paid_amount, COALESCE((SELECT SUM(pt.cash_amount) FROM payment_transactions pt WHERE pt.order_id=o.id),0) AS paid_cash, COALESCE((SELECT SUM(pt.card_amount) FROM payment_transactions pt WHERE pt.order_id=o.id),0) AS paid_card, COALESCE((SELECT SUM(pt.terminal_amount) FROM payment_transactions pt WHERE pt.order_id=o.id),0) AS terminal_amount FROM orders o`;
    const args = [];
    if (status) { q += ` WHERE o.status=?`; args.push(status); }
    q += ` ORDER BY o.created_at DESC LIMIT 200`;
    const rows = await env.DB.prepare(q).bind(...args).all();
    return json(rows.results);
  }

  if (request.method === "POST" && resource === "orders") {
    if (!requireRole(user, ["admin","mesero"])) return json({ error: "Solo mesero o administrador." }, 403);
    const data = await body(request);
    if (!data.items?.length) return json({ error: "La orden necesita al menos un producto." }, 400);

    const orderId = crypto.randomUUID();
    const now = nowIso();
    const subtotal = data.items.reduce((s,x) => s + Number(x.qty || 1) * Number(x.unit_price || 0), 0);
    const discount = Number(data.discount || 0);
    const total = Math.max(0, subtotal - discount);

    const stmts = [
      env.DB.prepare(`INSERT INTO orders
        (id,table_id,customer_name,notes,status,subtotal,discount,total,payment_status,payment_method,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        orderId, data.table_id || null, data.customer_name || "", data.notes || "",
        "open", subtotal, discount, total, "pending", "", now, now
      )
    ];

    for (const item of data.items) {
      stmts.push(env.DB.prepare(`INSERT INTO order_items
        (order_id,menu_item_id,name,qty,unit_price,modifiers,notes)
        VALUES (?,?,?,?,?,?,?)`).bind(
        orderId, item.menu_item_id || null, item.name, Number(item.qty || 1),
        Number(item.unit_price || 0), JSON.stringify(item.modifiers || []), item.notes || ""
      ));
    }

    await env.DB.batch(stmts);
    if (data.table_id) await env.DB.prepare(`UPDATE "tables" SET status='occupied' WHERE id=?`).bind(data.table_id).run();
    return json({ id: orderId, subtotal, discount, total, status: "open" }, 201);
  }

  if (request.method === "POST" && resource === "orders" && id && p.split("/")[2] === "payments") {
    if (!requireRole(user, ["admin","mesero"])) return json({ error: "Solo mesero o administrador puede cobrar." }, 403);
    const orderId = id;
    const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`).bind(orderId).first();
    if (!order) return json({ error: "Orden no encontrada." }, 404);
    if (order.status === "paid" || order.payment_status === "paid") return json({ error: "La orden ya está pagada." }, 400);

    const d = await body(request);
    const method = String(d.method || "").toLowerCase();
    if (!['cash','card','mixed'].includes(method)) return json({ error: "Método de pago inválido." }, 400);
    const payerName = String(d.payer_name || "Cliente").trim() || "Cliente";
    const cashAmount = Number(d.cash_amount || 0);
    const cardAmount = Number(d.card_amount || 0);
    const amount = Number(d.amount || (cashAmount + cardAmount));
    if (amount <= 0) return json({ error: "El monto del pago debe ser mayor a 0." }, 400);
    if (method === 'cash' && (cashAmount <= 0 || Math.abs(cashAmount-amount)>0.01)) return json({ error: "El efectivo debe coincidir con el total de este pago." }, 400);
    if (method === 'card' && (cardAmount <= 0 || Math.abs(cardAmount-amount)>0.01)) return json({ error: "El monto de tarjeta debe coincidir con el total de este pago." }, 400);
    if (method === 'mixed' && (cashAmount < 0 || cardAmount < 0 || Math.abs(cashAmount+cardAmount-amount)>0.01)) return json({ error: "Efectivo + tarjeta deben sumar exactamente el pago." }, 400);
    if (cardAmount > 0 && Number(d.terminal_amount || 0) !== cardAmount) return json({ error: "El monto cargado en la terminal debe coincidir con el monto de tarjeta." }, 400);

    const items = await env.DB.prepare(`SELECT id,qty,unit_price FROM order_items WHERE order_id=?`).bind(orderId).all();
    const paidRows = await env.DB.prepare(`SELECT pa.order_item_id, COALESCE(SUM(pa.qty),0) qty FROM payment_allocations pa JOIN payment_transactions pt ON pt.id=pa.payment_id WHERE pt.order_id=? GROUP BY pa.order_item_id`).bind(orderId).all();
    const already = new Map(paidRows.results.map(r=>[Number(r.order_item_id),Number(r.qty)]));
    const allocations = Array.isArray(d.allocations) ? d.allocations : [];
    const clean = []; let allocationTotal = 0;
    for (const a of allocations) {
      const item = items.results.find(x=>Number(x.id)===Number(a.order_item_id));
      if (!item) return json({ error: "Producto de la cuenta no encontrado." }, 400);
      const qty = Number(a.qty || 0);
      if (qty <= 0) continue;
      const remainingQty = Number(item.qty) - Number(already.get(Number(item.id)) || 0);
      if (qty > remainingQty + 0.0001) return json({ error: `No puedes asignar más cantidad de ${item.id} de la disponible.` }, 400);
      const lineAmount = qty * Number(item.unit_price || 0);
      allocationTotal += lineAmount;
      clean.push({ order_item_id:Number(item.id), qty, amount:lineAmount });
    }
    if (clean.length && Math.abs(allocationTotal-amount)>0.01) return json({ error: `Los productos seleccionados suman $${allocationTotal.toFixed(2)} y el pago es $${amount.toFixed(2)}.` }, 400);
    const paidTotalRow = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) paid FROM payment_transactions WHERE order_id=?`).bind(orderId).first();
    const paidBefore = Number(paidTotalRow?.paid || 0);
    const remainingOrder = Number(order.total || 0) - paidBefore;
    if (amount > remainingOrder + 0.01) return json({ error: `El pago excede el saldo restante de $${remainingOrder.toFixed(2)}.` }, 400);
    const paymentId = crypto.randomUUID(); const now = nowIso();
    const stmts = [env.DB.prepare(`INSERT INTO payment_transactions(id,order_id,payer_name,method,amount,cash_amount,card_amount,terminal_amount,terminal_reference,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(paymentId,orderId,payerName,method,amount,method==='card'?0:cashAmount,method==='cash'?0:cardAmount,cardAmount>0?Number(d.terminal_amount||0):0,String(d.terminal_reference||''),user.id,now)];
    for (const a of clean) stmts.push(env.DB.prepare(`INSERT INTO payment_allocations(payment_id,order_item_id,qty,amount) VALUES (?,?,?,?)`).bind(paymentId,a.order_item_id,a.qty,a.amount));
    await env.DB.batch(stmts);
    const newPaid = paidBefore + amount;
    if (newPaid >= Number(order.total||0)-0.01) {
      await env.DB.prepare(`UPDATE orders SET status='paid',payment_status='paid',payment_method='split',closed_at=?,updated_at=? WHERE id=?`).bind(now,now,orderId).run();
      if (order.table_id) await env.DB.prepare(`UPDATE "tables" SET status='available' WHERE id=?`).bind(order.table_id).run();
    } else {
      await env.DB.prepare(`UPDATE orders SET payment_status='partial',payment_method='split',updated_at=? WHERE id=?`).bind(now,orderId).run();
    }
    if (cashAmount > 0) await env.DB.prepare(`INSERT INTO cash_movements(id,type,amount,concept,order_id,created_at) VALUES (?,?,?,?,?,?)`).bind(crypto.randomUUID(),'ingreso',cashAmount,`Pago de orden ${orderId.slice(0,8)} · ${payerName}`,orderId,now).run();
    return json({ ok:true, payment_id:paymentId, paid:newPaid, remaining:Math.max(0,Number(order.total||0)-newPaid), order_paid:newPaid >= Number(order.total||0)-0.01 },201);
  }

  if (request.method === "PATCH" && resource === "orders" && id) {
    const data = await body(request);
    const canEdit = requireRole(user, ["admin","mesero"]);
    const canKitchen = requireRole(user, ["admin","cocina"]);

    if (data.status && ["preparing","ready"].includes(data.status) && !canKitchen) {
      return json({ error: "Solo cocina o administrador puede cambiar ese estado." }, 403);
    }
    if ((data.status === "paid" || data.payment_status === "paid") && !canEdit) {
      return json({ error: "Solo mesero o administrador puede cobrar." }, 403);
    }
    if (!canEdit && !canKitchen) return json({ error: "Sin permiso." }, 403);

    const allowed = ["status","payment_status","payment_method","notes","discount"];
    const sets = [], vals = [];
    for (const k of allowed) {
      if (data[k] !== undefined) { sets.push(`${k}=?`); vals.push(data[k]); }
    }
    if (data.status === "paid" || data.payment_status === "paid") {
      sets.push("closed_at=?"); vals.push(nowIso());
    }
    if (!sets.length) return json({ error: "Sin cambios." }, 400);
    sets.push("updated_at=?"); vals.push(nowIso(), id);

    await env.DB.prepare(`UPDATE orders SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();

    if (data.status === "paid") {
      const order = await env.DB.prepare(`SELECT * FROM orders WHERE id=?`).bind(id).first();
      if (order?.table_id) await env.DB.prepare(`UPDATE "tables" SET status='available' WHERE id=?`).bind(order.table_id).run();
    }
    return json({ ok: true });
  }

  if (request.method === "GET" && resource === "dashboard") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    const today = new Date().toISOString().slice(0,10);
    const sales = await env.DB.prepare(`SELECT COALESCE(SUM(total),0) total,COUNT(*) orders FROM orders WHERE status='paid' AND substr(created_at,1,10)=?`).bind(today).first();
    const open = await env.DB.prepare(`SELECT COUNT(*) count FROM orders WHERE status IN ('open','preparing','ready')`).first();
    const kitchen = await env.DB.prepare(`SELECT COUNT(*) count FROM orders WHERE status IN ('open','preparing')`).first();
    const payments = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(cash_amount),0) cash, COALESCE(SUM(card_amount),0) card, COALESCE(SUM(terminal_amount),0) terminal, COUNT(*) transactions FROM payment_transactions WHERE substr(created_at,1,10)=?`).bind(today).first();
    return json({ sales, open, kitchen, payments });
  }

  if (request.method === "GET" && resource === "cash") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    const rows = await env.DB.prepare(`SELECT * FROM cash_movements ORDER BY created_at DESC LIMIT 200`).all();
    return json(rows.results);
  }

  if (request.method === "POST" && resource === "cash") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);
    const d = await body(request);
    const newId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO cash_movements(id,type,amount,concept,order_id,created_at)
      VALUES (?,?,?,?,?,?)`).bind(
      newId, d.type, Number(d.amount || 0), d.concept || "", d.order_id || null, nowIso()
    ).run();
    return json({ id: newId }, 201);
  }

  if (resource === "users") {
    if (!requireRole(user, ["admin"])) return json({ error: "Solo administrador." }, 403);

    if (request.method === "GET" && !id) {
      const rows = await env.DB.prepare(`SELECT id,username,name,role,active,created_at,updated_at FROM users ORDER BY name`).all();
      return json(rows.results);
    }

    if (request.method === "POST" && !id) {
      const d = await body(request);
      const username = String(d.username || "").trim().toLowerCase();
      const password = String(d.password || "");
      const role = String(d.role || "");
      if (!username || !d.name || !password || !["admin","mesero","cocina"].includes(role)) {
        return json({ error: "Nombre, usuario, contraseña y rol son obligatorios." }, 400);
      }
      const exists = await env.DB.prepare(`SELECT id FROM users WHERE username=?`).bind(username).first();
      if (exists) return json({ error: "Ese usuario ya existe." }, 409);
      const { salt, hash } = await hashPassword(password);
      const newId = crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO users(id,username,name,role,password_hash,password_salt,active,created_at,updated_at)
        VALUES (?,?,?,?,?,?,1,?,?)`).bind(newId,username,d.name,role,hash,salt,nowIso(),nowIso()).run();
      return json({ id: newId }, 201);
    }

    if (request.method === "PATCH" && id) {
      const d = await body(request);
      const target = await env.DB.prepare(`SELECT * FROM users WHERE id=?`).bind(id).first();
      if (!target) return json({ error: "Usuario no encontrado." }, 404);
      const sets = [], vals = [];
      if (d.name !== undefined) { sets.push("name=?"); vals.push(d.name); }
      if (d.role !== undefined && ["admin","mesero","cocina"].includes(d.role)) { sets.push("role=?"); vals.push(d.role); }
      if (d.active !== undefined) { sets.push("active=?"); vals.push(d.active ? 1 : 0); }
      if (d.password) {
        const { salt, hash } = await hashPassword(String(d.password));
        sets.push("password_hash=?","password_salt=?"); vals.push(hash,salt);
      }
      if (!sets.length) return json({ error: "Sin cambios." }, 400);
      sets.push("updated_at=?"); vals.push(nowIso(),id);
      await env.DB.prepare(`UPDATE users SET ${sets.join(",")} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
  }

  return json({ error: "Ruta no encontrada" }, 404);
}
