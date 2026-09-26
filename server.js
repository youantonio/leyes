// RUSH POS v24.3 - Cloudflare Worker + D1
const ROLES = ["admin", "mesero", "cocina", "barra", "repartidor", "editor"];

// ===== FOTOS: Google Drive → proxy con caché → Cloudflare R2 =====
// Extrae el ID de cualquier link de Drive (uc?id=, /file/d/ID, open?id=, thumbnail?id=, lh3/d/ID)
function driveId(u) {
  const s = String(u || "");
  if (!/drive\.google\.com|googleusercontent\.com/.test(s)) return null;
  const m = s.match(/[?&]id=([\w-]{20,})/) || s.match(/\/d\/([\w-]{20,})/);
  return m ? m[1] : null;
}
// Lo que ve el navegador: los links de Drive pasan por /img/drive/ID (nuestro Worker)
function imgOut(u) {
  if (!u) return u;
  const id = driveId(u);
  return id ? "/img/drive/" + id : u;
}
const IMG_CACHE = "public, max-age=2592000, immutable";
function isValidImg(v) {
  return v.startsWith("data:image/") || v.startsWith("https://") || v.startsWith("http://") || v.startsWith("/img/");
}
async function fetchDriveImage(id) {
  const urls = [
    `https://drive.google.com/thumbnail?id=${id}&sz=w1200`,
    `https://lh3.googleusercontent.com/d/${id}=w1200`,
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: "follow" });
      const ct = r.headers.get("content-type") || "";
      if (r.ok && ct.startsWith("image/")) return { buf: await r.arrayBuffer(), ct };
    } catch (e) {}
  }
  return null;
}
function dataUrlToBytes(dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, ct: m[1] };
}
const extFor = (ct) => (ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg");
async function serveImage(path, env, ctx) {
  const noImg = () => new Response("Foto no encontrada", { status: 404, headers: { "Cache-Control": "public, max-age=300" } });
  // /img/r2/<clave> → archivo propio en R2
  if (path.startsWith("/img/r2/")) {
    if (!env.PHOTOS) return noImg();
    const key = decodeURIComponent(path.slice(8));
    const obj = await env.PHOTOS.get(key);
    if (!obj) return noImg();
    return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": IMG_CACHE } });
  }
  // /img/drive/<ID> → primero R2 (si ya se copió), luego caché de Cloudflare, luego Drive
  const m = path.match(/^\/img\/drive\/([\w-]{20,})$/);
  if (!m) return noImg();
  const id = m[1];
  if (env.PHOTOS) {
    const obj = await env.PHOTOS.get("drive/" + id);
    if (obj) return new Response(obj.body, { headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": IMG_CACHE } });
  }
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://rush-img-cache/drive/" + id);
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  const got = await fetchDriveImage(id);
  if (!got) return noImg();
  const resp = new Response(got.buf, { headers: { "Content-Type": got.ct, "Cache-Control": IMG_CACHE } });
  if (cache) ctx.waitUntil(cache.put(key, resp.clone()));
  // Se guarda sola en R2 la primera vez que alguien la ve
  if (env.PHOTOS) ctx.waitUntil(env.PHOTOS.put("drive/" + id, got.buf, { httpMetadata: { contentType: got.ct } }));
  return resp;
}
const SESSION_MS = 24 * 60 * 60 * 1000;
let sessionsReady = false;
let menuSchemaReady2 = false;
let menuSchemaReady = false;

// Estructura inicial del menú (tipo Starbucks: 2 secciones y categorías por "cómo lo pide el cliente")
const DEFAULT_SECTIONS = [
  { id: "sec_alimentos", name: "Alimentos", icon: "🍳", destination: "cocina", sort: 1 },
  { id: "sec_bebidas", name: "Bebidas", icon: "☕", destination: "barra", sort: 2 },
];
const DEFAULT_CATEGORIES = [
  ["cat_desayunos", "sec_alimentos", "Desayunos", 1],
  ["cat_tacos", "sec_alimentos", "Tacos y antojitos", 2],
  ["cat_hamburguesas", "sec_alimentos", "Hamburguesas y sándwiches", 3],
  ["cat_ensaladas", "sec_alimentos", "Ensaladas y bowls", 4],
  ["cat_botanas", "sec_alimentos", "Botanas y para compartir", 5],
  ["cat_postres", "sec_alimentos", "Postres y panadería", 6],
  ["cat_cafe_caliente", "sec_bebidas", "Café caliente", 1],
  ["cat_cafe_frio", "sec_bebidas", "Café frío", 2],
  ["cat_te", "sec_bebidas", "Té e infusiones", 3],
  ["cat_frappes", "sec_bebidas", "Frappés y licuados", 4],
  ["cat_jugos", "sec_bebidas", "Jugos y aguas frescas", 5],
  ["cat_refrescos", "sec_bebidas", "Refrescos, agua e hidratación", 6],
  ["cat_cervezas", "sec_bebidas", "Cervezas y micheladas", 7],
  ["cat_cocteles", "sec_bebidas", "Cocteles y licores", 8],
];

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
const safeEq = (a, b) => {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
};
async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations: 100000 }, key, 256
  );
  return "pbkdf2$" + toHex(bits);
}
const newSalt = () => toHex(crypto.getRandomValues(new Uint8Array(16)));

// Notas: JSON {type,cocina,barra}. También lee el formato viejo de texto.
function parseNotes(s) {
  try {
    const o = JSON.parse(s);
    if (o && typeof o === "object") return { type: o.type || "", cocina: o.cocina || "", barra: o.barra || "" };
  } catch (e) {}
  const str = String(s || "");
  const g = (re) => { const m = str.match(re); const v = m ? m[1].trim() : ""; return v === "N/A" ? "" : v; };
  return { type: (str.match(/^\[([^\]]+)\]/) || [])[1] || "", cocina: g(/Cocina:\s*([^|]*)/), barra: g(/Barra:\s*([^|]*)/) };
}
function mergeNotes(curRaw, add) {
  const c = parseNotes(curRaw);
  const j = (a, b) => (b ? (a ? a + " / " + b : b) : a);
  return JSON.stringify({
    type: c.type || add.type || "",
    cocina: j(c.cocina, String(add.cocina || "").trim()),
    barra: j(c.barra, String(add.barra || "").trim()),
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // Fotos de producto (R2 / proxy de Drive)
    if (path.startsWith("/img/") && request.method === "GET") return serveImage(path, env, ctx);
    // Archivos estáticos
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      const db = env.DB;
      if (!db) return json({ error: "Base de datos no disponible" }, 500);

      if (!menuSchemaReady2) {
        await db.prepare(`CREATE TABLE IF NOT EXISTS pos_settings (key TEXT PRIMARY KEY, value TEXT)`).run();
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_loyalty (
             phone TEXT PRIMARY KEY, name TEXT, card_token TEXT UNIQUE, stamps INTEGER DEFAULT 0,
             rewards_earned INTEGER DEFAULT 0, rewards_redeemed INTEGER DEFAULT 0,
             consent INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`
        ).run();
        try { await db.prepare("ALTER TABLE orders ADD COLUMN channel TEXT DEFAULT 'restaurante'").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE orders ADD COLUMN loyalty_consent INTEGER DEFAULT 0").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE users ADD COLUMN whatsapp TEXT").run(); } catch (e) {}
        const defSettings = [
          ["business_name", "The Rush - Club, Cafe & Cocina"],
          ["whatsapp_order_number", ""], ["whatsapp_on_duty", ""], ["rappi_link", ""], ["uber_link", ""],
          ["loyalty_goal", "10"], ["loyalty_reward", "Un cafe o postre de cortesia"],
          ["business_lat", "20.1010"], ["business_lng", "-98.7591"],
          ["delivery_base_fee", "20"], ["delivery_rate_km", "8"],
          ["payment_info", ""],
          ["menu_tagline", "Tu ritual empieza aquí, entre espuma y aroma"],
          ["business_hours", "Abierto de 8:00 a.m. a 11:00 p.m."],
        ];
        for (const [k, v] of defSettings) await db.prepare("INSERT OR IGNORE INTO pos_settings (key,value) VALUES (?,?)").bind(k, v).run();
        menuSchemaReady2 = true;
      }

      if (!sessionsReady) {
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_sessions (
             token TEXT PRIMARY KEY, user_id TEXT, username TEXT, name TEXT, role TEXT, expires_at INTEGER)`
        ).run();
        sessionsReady = true;
      }

      if (!menuSchemaReady) {
        // Tablas propias (prefijo pos_) para no chocar con tablas del sistema anterior
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_menu_sections (
             id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT DEFAULT '', destination TEXT NOT NULL DEFAULT 'cocina', sort_order INTEGER DEFAULT 0)`
        ).run();
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_menu_categories (
             id TEXT PRIMARY KEY, section_id TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER DEFAULT 0)`
        ).run();
        try { await db.prepare("ALTER TABLE menu_items ADD COLUMN category_id TEXT").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE menu_items ADD COLUMN sold_out INTEGER DEFAULT 0").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE menu_items ADD COLUMN image TEXT").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE orders ADD COLUMN delivery_status TEXT").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE orders ADD COLUMN driver_id TEXT").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE orders ADD COLUMN delivery_lat REAL").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE orders ADD COLUMN delivery_lng REAL").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE orders ADD COLUMN shipping_cost REAL DEFAULT 0").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE orders ADD COLUMN tracking_token TEXT").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE orders ADD COLUMN delivery_address TEXT").run(); } catch (e) {}
        try { await db.prepare("ALTER TABLE orders ADD COLUMN receiver_name TEXT").run(); } catch (e) {}
        await db.prepare(`CREATE TABLE IF NOT EXISTS pos_driver_locations (driver_id TEXT PRIMARY KEY, lat REAL, lng REAL, updated_at TEXT)`).run();
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_cash_movements (
             id TEXT PRIMARY KEY, type TEXT NOT NULL, concept TEXT NOT NULL, amount REAL NOT NULL,
             created_by TEXT, created_at TEXT DEFAULT (datetime('now')))`
        ).run();
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_cuts (
             id TEXT PRIMARY KEY, folio INTEGER, period_start TEXT, period_end TEXT, data TEXT,
             created_by TEXT, created_at TEXT DEFAULT (datetime('now')))`
        ).run();
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_inventory (
             id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT DEFAULT 'pza', stock REAL DEFAULT 0,
             min_stock REAL DEFAULT 0, active INTEGER DEFAULT 1)`
        ).run();
        await db.prepare(
          `CREATE TABLE IF NOT EXISTS pos_inventory_moves (
             id TEXT PRIMARY KEY, item_id TEXT, qty REAL, reason TEXT, created_by TEXT,
             created_at TEXT DEFAULT (datetime('now')))`
        ).run();
        for (const sec of DEFAULT_SECTIONS)
          await db.prepare("INSERT OR IGNORE INTO pos_menu_sections (id,name,icon,destination,sort_order) VALUES (?,?,?,?,?)")
            .bind(sec.id, sec.name, sec.icon, sec.destination, sec.sort).run();
        const have = await db.prepare("SELECT COUNT(*) AS c FROM pos_menu_categories").first();
        if (!have || !have.c)
          for (const [id, sid, name, sort] of DEFAULT_CATEGORIES)
            await db.prepare("INSERT OR IGNORE INTO pos_menu_categories (id,section_id,name,sort_order) VALUES (?,?,?,?)")
              .bind(id, sid, name, sort).run();
        menuSchemaReady = true;
      }

      const calcTotal = (items) =>
        items.reduce((s, i) => s + (Number(i.qty) || 1) * (Number(i.unit_price) || 0), 0);
      const parseOrder = (r) => ({ ...r, items: JSON.parse(r.items || "[]"), np: parseNotes(r.notes) });

      const soldOutNames = async (items) => {
        const ids = [...new Set((items || []).map((i) => i.menu_item_id).filter(Boolean).map(String))].slice(0, 80);
        if (!ids.length) return [];
        const q = ids.map(() => "?").join(",");
        const { results } = await db.prepare(`SELECT name FROM menu_items WHERE sold_out=1 AND id IN (${q})`).bind(...ids).all();
        return (results || []).map((r) => r.name);
      };
      const getSettings = async () => {
        const { results } = await db.prepare("SELECT key, value FROM pos_settings").all();
        const o = {}; for (const r of results || []) o[r.key] = r.value; return o;
      };
      // WhatsApp que recibe los pedidos: el del admin en turno; si no hay, el número general de respaldo
      const resolveOrderWa = async (st) => {
        const clean = (v) => String(v || "").replace(/\D/g, "").slice(-10);
        if (st.whatsapp_on_duty) {
          const u = await db.prepare("SELECT name, whatsapp FROM users WHERE id=? AND active=1 AND role='admin'")
            .bind(st.whatsapp_on_duty).first().catch(() => null);
          if (u && clean(u.whatsapp).length === 10) return { number: clean(u.whatsapp), name: u.name, source: "turno" };
        }
        const g = clean(st.whatsapp_order_number);
        return g.length === 10 ? { number: g, name: null, source: "general" } : { number: "", name: null, source: "ninguno" };
      };
      const haversineKm = (lat1, lng1, lat2, lng2) => {
        const R = 6371, toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      };
      // Costo de envío automático: tarifa base + $/km en línea recta desde el negocio
      if (path === "/api/shipping-quote" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const lat = Number(b.lat), lng = Number(b.lng);
        if (!isFinite(lat) || !isFinite(lng)) return json({ error: "Ubicación no válida" }, 400);
        const st = await getSettings();
        const bLat = Number(st.business_lat) || 20.101, bLng = Number(st.business_lng) || -98.7591;
        const km = haversineKm(bLat, bLng, lat, lng);
        const cost = Math.round((Number(st.delivery_base_fee) || 0) + km * (Number(st.delivery_rate_km) || 0));
        return json({ km: Math.round(km * 10) / 10, cost });
      }
      // Seguimiento público (sin sesión): estatus del pedido + ubicación del repartidor si está compartiendo
      if (path === "/api/track" && request.method === "GET") {
        const token = url.searchParams.get("token") || "";
        const o = token ? await db.prepare("SELECT * FROM orders WHERE tracking_token=?").bind(token).first() : null;
        if (!o) return json({ error: "Pedido no encontrado" }, 404);
        let driverLoc = null, driverName = null;
        if (o.driver_id) {
          const loc = await db.prepare("SELECT * FROM pos_driver_locations WHERE driver_id=?").bind(o.driver_id).first();
          if (loc && Date.now() - new Date(loc.updated_at + "Z").getTime() < 5 * 60 * 1000) driverLoc = { lat: loc.lat, lng: loc.lng };
          const u = await db.prepare("SELECT name FROM users WHERE id=?").bind(o.driver_id).first();
          driverName = u?.name || null;
        }
        return json({
          folio: o.custom_folio || o.id.slice(0, 6), status: o.status, delivery_status: o.delivery_status || null,
          channel: o.channel, driver_name: driverName, driver_location: driverLoc,
          business_location: { lat: Number((await getSettings()).business_lat) || 20.101, lng: Number((await getSettings()).business_lng) || -98.7591 },
          delivery_location: (o.delivery_lat && o.delivery_lng) ? { lat: o.delivery_lat, lng: o.delivery_lng } : null,
        });
      }
      const genToken = () => crypto.randomUUID().replace(/-/g, "");
      const addStamp = async (phone, name) => {
        const goal = Number((await getSettings()).loyalty_goal) || 10;
        let row = await db.prepare("SELECT * FROM pos_loyalty WHERE phone=?").bind(phone).first();
        if (!row) {
          const token = genToken();
          await db.prepare("INSERT INTO pos_loyalty (phone,name,card_token,stamps,consent) VALUES (?,?,?,0,1)").bind(phone, name, token).run();
          row = { phone, name, card_token: token, stamps: 0, rewards_earned: 0 };
        }
        let stamps = row.stamps + 1, earned = row.rewards_earned, justEarned = false;
        if (stamps >= goal) { stamps = 0; earned += 1; justEarned = true; }
        await db.prepare("UPDATE pos_loyalty SET stamps=?, rewards_earned=?, name=?, updated_at=datetime('now') WHERE phone=?")
          .bind(stamps, earned, name || row.name, phone).run();
        return { token: row.card_token, stamps, goal, justEarned };
      };

      // ===== PUBLICO (sin sesion): pagina de pedidos y tarjeta de lealtad =====
      if (path === "/api/public-settings" && request.method === "GET") {
        const st = await getSettings();
        const wa = await resolveOrderWa(st);
        return json({
          business_name: st.business_name, whatsapp_order_number: wa.number,
          rappi_link: st.rappi_link, uber_link: st.uber_link,
          loyalty_goal: Number(st.loyalty_goal) || 10, loyalty_reward: st.loyalty_reward,
          menu_tagline: st.menu_tagline || "", business_hours: st.business_hours || "",
        });
      }
      if (path === "/api/public-menu" && request.method === "GET") {
        const its = ((await db.prepare("SELECT id,name,category,category_id,price,description,destination,image FROM menu_items WHERE active=1 AND sold_out=0 ORDER BY sort_order, name").all()).results) || [];
        const secs = ((await db.prepare("SELECT * FROM pos_menu_sections ORDER BY sort_order, name").all()).results) || [];
        const cats = ((await db.prepare("SELECT * FROM pos_menu_categories ORDER BY sort_order, name").all()).results) || [];
        return json({ items: its.map((i) => ({ ...i, image: imgOut(i.image) })), structure: secs.map((sc) => ({ ...sc, categories: cats.filter((c) => c.section_id === sc.id) })) });
      }
      if (path === "/api/public-order" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const items0 = b.items || [];
        if (!items0.length) return json({ error: "El carrito esta vacio" }, 400);
        const soldOut = await soldOutNames(items0);
        if (soldOut.length) return json({ error: "Agotado: " + soldOut.join(", ") }, 409);
        let phone = String(b.customer_phone || "").replace(/\D/g, ""); if (phone.length > 10) phone = phone.slice(-10);
        if (phone.length !== 10) return json({ error: "WhatsApp a 10 digitos" }, 400);
        const name = String(b.customer_name || "Cliente").trim() || "Cliente";
        const channel = ["restaurante", "domicilio_directo"].includes(b.channel) ? b.channel : "restaurante";
        // Precios SIEMPRE desde la base de datos (nunca confiar en el precio que manda el navegador)
        const reqIds = [...new Set(items0.map((i) => String(i.menu_item_id || "")).filter(Boolean))].slice(0, 80);
        if (!reqIds.length) return json({ error: "Productos no válidos" }, 400);
        const dbItems = ((await db.prepare(`SELECT id, name, price, destination FROM menu_items WHERE active=1 AND id IN (${reqIds.map(() => "?").join(",")})`)
          .bind(...reqIds).all()).results) || [];
        const byId = Object.fromEntries(dbItems.map((r) => [String(r.id), r]));
        const missing = items0.filter((i) => !byId[String(i.menu_item_id)]);
        if (missing.length) return json({ error: "Ya no está disponible: " + missing.map((i) => i.name || "producto").join(", ") + ". Recarga el menú." }, 409);
        const itemsSafe = items0.slice(0, 80).map((i) => {
          const r = byId[String(i.menu_item_id)];
          return { menu_item_id: String(r.id), name: r.name, qty: Math.min(99, Math.max(1, Math.floor(Number(i.qty) || 1))),
                   unit_price: Number(r.price) || 0, destination: r.destination || "cocina", ...(i.note ? { note: String(i.note).slice(0, 140) } : {}) };
        });
        const tableTxt = String(b.table || "").trim().slice(0, 40);
        let shipping = 0, dLat = null, dLng = null, addrText = "";
        if (channel === "domicilio_directo") {
          const a = b.address || {};
          addrText = [a.street, a.number, a.neighborhood, a.reference].filter(Boolean).join(", ");
          if (!a.street || !a.number || !a.neighborhood) return json({ error: "Falta calle, número o colonia" }, 400);
          if (!String(b.receiver_name || "").trim()) return json({ error: "Falta el nombre de quien recibe" }, 400);
          if (isFinite(Number(a.lat)) && isFinite(Number(a.lng))) {
            dLat = Number(a.lat); dLng = Number(a.lng);
            const st = await getSettings();
            const km = haversineKm(Number(st.business_lat) || 20.101, Number(st.business_lng) || -98.7591, dLat, dLng);
            shipping = Math.round((Number(st.delivery_base_fee) || 0) + km * (Number(st.delivery_rate_km) || 0));
          }
        }
        const notes = JSON.stringify({
          type: channel === "domicilio_directo" ? "Domicilio (directo)" : ("Restaurante" + (tableTxt ? " · " + tableTxt : "")),
          cocina: String(b.notes || "").trim().slice(0, 300), barra: String(b.notes_barra || "").trim().slice(0, 300),
        });
        const total = calcTotal(itemsSafe) + shipping;
        const id = crypto.randomUUID(), trackToken = crypto.randomUUID().replace(/-/g, "");
        // Hora de México (UTC-6, sin horario de verano) + 2 letras al azar para que no se repita el folio en el mismo minuto
        const dd = new Date(Date.now() - 6 * 3600 * 1000), p2b = (n) => String(n).padStart(2, "0");
        const folio = "WEB-" + p2b(dd.getUTCDate()) + p2b(dd.getUTCMonth() + 1) + "-" + p2b(dd.getUTCHours()) + p2b(dd.getUTCMinutes())
          + "-" + trackToken.slice(0, 2).toUpperCase();
        await db.prepare(
          `INSERT INTO orders (id, custom_folio, customer_name, customer_phone, notes, items, subtotal, total, channel,
             loyalty_consent, delivery_status, delivery_lat, delivery_lng, shipping_cost, tracking_token, delivery_address, receiver_name, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
        ).bind(id, folio, name, phone, notes, JSON.stringify(itemsSafe), calcTotal(itemsSafe), total, channel, b.loyalty_consent ? 1 : 0,
               channel === "domicilio_directo" ? "recibido" : null, dLat, dLng, shipping, trackToken, addrText, String(b.receiver_name || "").trim()).run();
        const waTo = await resolveOrderWa(await getSettings());
        // Tarjeta de lealtad: se crea (sin sello) para que el cliente tenga su link desde ya; el sello se suma al cobrar
        let cardToken = null;
        if (b.loyalty_consent) {
          const row = await db.prepare("SELECT card_token FROM pos_loyalty WHERE phone=?").bind(phone).first();
          if (row) cardToken = row.card_token;
          else {
            cardToken = genToken();
            await db.prepare("INSERT INTO pos_loyalty (phone,name,card_token,stamps,consent) VALUES (?,?,?,0,1)").bind(phone, name, cardToken).run();
          }
        }
        return json({ id, folio, shipping, total, track_token: trackToken, whatsapp_to: waTo.number, card_token: cardToken }, 201);
      }
      if (path === "/api/loyalty-card" && request.method === "GET") {
        const token = url.searchParams.get("token") || "";
        const row = token ? await db.prepare("SELECT * FROM pos_loyalty WHERE card_token=?").bind(token).first() : null;
        if (!row) return json({ error: "Tarjeta no encontrada" }, 404);
        const st = await getSettings();
        return json({
          name: row.name, stamps: row.stamps, goal: Number(st.loyalty_goal) || 10, reward: st.loyalty_reward,
          rewards_earned: row.rewards_earned, rewards_redeemed: row.rewards_redeemed, business_name: st.business_name,
        });
      }


      // ===== LOGIN (único endpoint sin sesión) =====
      if (path === "/api/login" && request.method === "POST") {
        const b = await request.json().catch(() => ({}));
        const username = String(b.username || "").trim();
        const password = String(b.password || "");

        let user = null, legacy = false;
        if (username) {
          let u = null;
          try {
            u = await db.prepare("SELECT * FROM users WHERE lower(username)=lower(?) AND active=1").bind(username).first();
          } catch (e) {}
          if (u) {
            if (String(u.password_hash || "").startsWith("pbkdf2$")) {
              const h = await hashPw(password, u.password_salt);
              if (safeEq(h, u.password_hash)) user = u;
            } else legacy = true;
          }
        }
        // Respaldo temporal: se apaga solo cuando exista un administrador con contraseña nueva
        if (!user && username === "admin" && password === "admin") {
          let allowed = true;
          try {
            const r = await db.prepare(
              "SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1 AND password_hash LIKE 'pbkdf2$%'"
            ).first();
            allowed = (r?.c || 0) === 0;
          } catch (e) {}
          if (allowed) user = { id: "fallback", name: "Administrador", username: "admin", role: "admin" };
        }
        if (!user) {
          return json({
            error: legacy
              ? "Este usuario es anterior al sistema nuevo. Pide al administrador que le restablezca la contraseña."
              : "Usuario o contraseña incorrectos",
          }, 401);
        }

        await db.prepare("DELETE FROM pos_sessions WHERE expires_at < ?").bind(Date.now()).run();
        const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
        await db.prepare("INSERT INTO pos_sessions (token,user_id,username,name,role,expires_at) VALUES (?,?,?,?,?,?)")
          .bind(token, String(user.id), user.username, user.name, user.role, Date.now() + SESSION_MS).run();
        return json({ token, user: { id: user.id, name: user.name, username: user.username, role: user.role } });
      }

      // ===== Sesión obligatoria para todo lo demás =====
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const sess = token
        ? await db.prepare("SELECT * FROM pos_sessions WHERE token=? AND expires_at>?").bind(token, Date.now()).first()
        : null;
      if (!sess) return json({ error: "Sesión expirada. Inicia sesión de nuevo." }, 401);
      const isAdmin = sess.role === "admin";

      if (path === "/api/logout" && request.method === "POST") {
        await db.prepare("DELETE FROM pos_sessions WHERE token=?").bind(token).run();
        return json({ ok: true });
      }

      // ===== USUARIOS (solo admin) =====
      const um = path.match(/^\/api\/users(?:\/([^\/]+))?$/);
      if (um) {
        if (!isAdmin) return json({ error: "Solo el administrador puede gestionar usuarios" }, 403);
        const uid = um[1] ? decodeURIComponent(um[1]) : null;
        const otherAdmins = async (excludeId) => {
          const r = await db.prepare(
            "SELECT COUNT(*) AS c FROM users WHERE role='admin' AND active=1 AND id != ?"
          ).bind(excludeId).first();
          return r?.c || 0;
        };

        if (!uid && request.method === "GET") {
          const { results } = await db.prepare(
            "SELECT id, username, name, role, active, created_at, password_hash, whatsapp FROM users ORDER BY name"
          ).all();
          return json((results || []).map(({ password_hash, ...u }) => ({
            ...u, legacy: !String(password_hash || "").startsWith("pbkdf2$"),
          })));
        }

        if (!uid && request.method === "POST") {
          const b = await request.json().catch(() => ({}));
          const name = String(b.name || "").trim();
          const username = String(b.username || "").trim();
          const password = String(b.password || "");
          const role = String(b.role || "mesero");
          if (!name || !username) return json({ error: "Nombre y usuario son obligatorios" }, 400);
          if (password.length < 4) return json({ error: "La contraseña debe tener al menos 4 caracteres" }, 400);
          if (!ROLES.includes(role)) return json({ error: "Rol no válido" }, 400);
          const wa = String(b.whatsapp || "").replace(/\D/g, "").slice(-10);
          if (wa && wa.length !== 10) return json({ error: "El WhatsApp debe tener 10 dígitos" }, 400);
          const dup = await db.prepare("SELECT id FROM users WHERE lower(username)=lower(?)").bind(username).first();
          if (dup) return json({ error: "Ese usuario ya existe" }, 409);
          const salt = newSalt();
          const hash = await hashPw(password, salt);
          const id = crypto.randomUUID();
          await db.prepare(
            `INSERT INTO users (id, username, name, role, password_hash, password_salt, active, created_at, updated_at, approved)
             VALUES (?,?,?,?,?,?,1,datetime('now'),datetime('now'),1)`
          ).bind(id, username, name, role, hash, salt).run();
          if (wa) await db.prepare("UPDATE users SET whatsapp=? WHERE id=?").bind(wa, id).run();
          return json({ id }, 201);
        }

        if (uid && request.method === "PATCH") {
          const target = await db.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
          if (!target) return json({ error: "Usuario no encontrado" }, 404);
          const b = await request.json().catch(() => ({}));
          const sets = [], vals = [];
          if (typeof b.name === "string" && b.name.trim()) { sets.push("name=?"); vals.push(b.name.trim()); }
          if (b.role !== undefined) {
            if (!ROLES.includes(b.role)) return json({ error: "Rol no válido" }, 400);
            if (target.role === "admin" && b.role !== "admin" && (await otherAdmins(uid)) === 0)
              return json({ error: "No puedes quitar el rol al único administrador" }, 400);
            sets.push("role=?"); vals.push(b.role);
          }
          if (b.active !== undefined) {
            const a = b.active ? 1 : 0;
            if (!a && target.role === "admin" && (await otherAdmins(uid)) === 0)
              return json({ error: "No puedes desactivar al único administrador" }, 400);
            sets.push("active=?"); vals.push(a);
          }
          if (b.whatsapp !== undefined) {
            const wa = String(b.whatsapp || "").replace(/\D/g, "").slice(-10);
            if (wa && wa.length !== 10) return json({ error: "El WhatsApp debe tener 10 dígitos" }, 400);
            sets.push("whatsapp=?"); vals.push(wa);
          }
          let passChanged = false;
          if (b.password !== undefined) {
            if (String(b.password).length < 4) return json({ error: "La contraseña debe tener al menos 4 caracteres" }, 400);
            const salt = newSalt();
            sets.push("password_hash=?", "password_salt=?");
            vals.push(await hashPw(String(b.password), salt), salt);
            passChanged = true;
          }
          if (!sets.length) return json({ error: "Nada que actualizar" }, 400);
          await db.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at=datetime('now') WHERE id=?`)
            .bind(...vals, uid).run();
          if (passChanged || b.active === false || b.active === 0)
            await db.prepare("DELETE FROM pos_sessions WHERE user_id=? AND token != ?").bind(uid, token).run();
          return json({ ok: true });
        }

        if (uid && request.method === "DELETE") {
          if (uid === sess.user_id) return json({ error: "No puedes eliminar tu propio usuario" }, 400);
          const target = await db.prepare("SELECT * FROM users WHERE id=?").bind(uid).first();
          if (!target) return json({ error: "Usuario no encontrado" }, 404);
          if (target.role === "admin" && target.active && (await otherAdmins(uid)) === 0)
            return json({ error: "No puedes eliminar al único administrador" }, 400);
          await db.prepare("DELETE FROM users WHERE id=?").bind(uid).run();
          await db.prepare("DELETE FROM pos_sessions WHERE user_id=?").bind(uid).run();
          return json({ ok: true });
        }
      }

      // Da (o crea) el token de la tarjeta de un cliente, para compartir su link
      if (path === "/api/loyalty-token" && request.method === "POST") {
        if (!isAdmin && sess.role !== "mesero") return json({ error: "No autorizado" }, 403);
        const b = await request.json().catch(() => ({}));
        let phone = String(b.phone || "").replace(/\D/g, ""); if (phone.length > 10) phone = phone.slice(-10);
        if (phone.length !== 10) return json({ error: "WhatsApp no valido" }, 400);
        let row = await db.prepare("SELECT * FROM pos_loyalty WHERE phone=?").bind(phone).first();
        if (!row) {
          const token = genToken();
          await db.prepare("INSERT INTO pos_loyalty (phone,name,card_token,stamps,consent) VALUES (?,?,?,0,1)").bind(phone, String(b.name || "Cliente"), token).run();
          row = { card_token: token };
        }
        return json({ token: row.card_token });
      }
      if (path === "/api/loyalty-redeem" && request.method === "POST") {
        if (!isAdmin && sess.role !== "mesero") return json({ error: "No autorizado" }, 403);
        const b = await request.json().catch(() => ({}));
        let phone = String(b.phone || "").replace(/\D/g, ""); if (phone.length > 10) phone = phone.slice(-10);
        const row = await db.prepare("SELECT * FROM pos_loyalty WHERE phone=?").bind(phone).first();
        if (!row) return json({ error: "Cliente no encontrado" }, 404);
        if (row.rewards_earned <= row.rewards_redeemed) return json({ error: "No tiene recompensas disponibles" }, 400);
        await db.prepare("UPDATE pos_loyalty SET rewards_redeemed=rewards_redeemed+1, updated_at=datetime('now') WHERE phone=?").bind(phone).run();
        return json({ ok: true });
      }
      // ===== ADMIN EN TURNO: quién recibe los pedidos por WhatsApp =====
      if (path === "/api/on-duty" && request.method === "GET") {
        const st = await getSettings();
        const wa = await resolveOrderWa(st);
        return json({ user_id: st.whatsapp_on_duty || "", name: wa.name, number: wa.number, source: wa.source });
      }
      if (path === "/api/on-duty" && request.method === "POST") {
        if (!isAdmin) return json({ error: "Solo un administrador puede tomar el turno" }, 403);
        const b = await request.json().catch(() => ({}));
        const uid = b.user_id === "" ? "" : String(b.user_id || sess.user_id);
        if (uid) {
          const u = await db.prepare("SELECT id, name, role, active, whatsapp FROM users WHERE id=?").bind(uid).first();
          if (!u || !u.active || u.role !== "admin") return json({ error: "Ese usuario no es un administrador activo" }, 400);
          if (String(u.whatsapp || "").replace(/\D/g, "").length !== 10)
            return json({ error: `${u.name} no tiene WhatsApp registrado. Agrégalo en Usuarios.` }, 400);
        }
        await db.prepare("INSERT INTO pos_settings (key,value) VALUES ('whatsapp_on_duty',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(uid).run();
        return json({ ok: true });
      }
      if (path === "/api/settings" && request.method === "GET") return json(await getSettings());
      if (path === "/api/settings" && request.method === "PATCH") {
        if (!isAdmin) return json({ error: "Solo el administrador puede editar la configuracion" }, 403);
        const b = await request.json().catch(() => ({}));
        for (const [k, v] of Object.entries(b)) await db.prepare("INSERT INTO pos_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k, String(v ?? "")).run();
        return json({ ok: true });
      }

      // ===== REPARTIDORES =====
      const DELIVERY_STEPS = ["recibido", "preparando", "salio", "en_camino", "entregado"];
      if (path === "/api/drivers" && request.method === "GET") {
        if (!isAdmin && sess.role !== "mesero") return json({ error: "No autorizado" }, 403);
        const { results } = await db.prepare("SELECT id, name, username FROM users WHERE role='repartidor' AND active=1 ORDER BY name").all();
        return json(results || []);
      }
      const dm = path.match(/^\/api\/orders\/([^\/]+)\/delivery$/);
      if (dm && request.method === "PATCH") {
        const oid = decodeURIComponent(dm[1]);
        const o = await db.prepare("SELECT * FROM orders WHERE id=?").bind(oid).first();
        if (!o) return json({ error: "Pedido no encontrado" }, 404);
        const b = await request.json().catch(() => ({}));
        if (b.driver_id !== undefined) {
          if (!isAdmin && sess.role !== "mesero") return json({ error: "No autorizado" }, 403);
          await db.prepare("UPDATE orders SET driver_id=?, delivery_status=COALESCE(delivery_status,'recibido'), updated_at=datetime('now') WHERE id=?")
            .bind(b.driver_id || null, oid).run();
        }
        if (b.delivery_status !== undefined) {
          if (!DELIVERY_STEPS.includes(b.delivery_status)) return json({ error: "Estatus no válido" }, 400);
          if (!isAdmin && sess.role !== "mesero" && sess.user_id !== o.driver_id) return json({ error: "No autorizado" }, 403);
          await db.prepare("UPDATE orders SET delivery_status=?, updated_at=datetime('now') WHERE id=?").bind(b.delivery_status, oid).run();
        }
        return json({ ok: true });
      }
      if (path === "/api/my-deliveries" && request.method === "GET") {
        if (sess.role !== "repartidor" && !isAdmin) return json({ error: "No autorizado" }, 403);
        const { results } = await db.prepare(
          "SELECT * FROM orders WHERE driver_id=? AND delivery_status != 'entregado' ORDER BY created_at"
        ).bind(sess.user_id).all();
        return json((results || []).map(parseOrder));
      }
      if (path === "/api/my-location" && request.method === "POST") {
        if (sess.role !== "repartidor") return json({ error: "No autorizado" }, 403);
        const b = await request.json().catch(() => ({}));
        const lat = Number(b.lat), lng = Number(b.lng);
        if (!isFinite(lat) || !isFinite(lng)) return json({ error: "Ubicación no válida" }, 400);
        await db.prepare(
          "INSERT INTO pos_driver_locations (driver_id,lat,lng,updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(driver_id) DO UPDATE SET lat=excluded.lat,lng=excluded.lng,updated_at=excluded.updated_at"
        ).bind(sess.user_id, lat, lng).run();
        return json({ ok: true });
      }

      // ===== CLIENTES (se arman con los datos de las órdenes) =====
      if (path === "/api/customers" && request.method === "GET") {
        const { results } = await db.prepare(
          `SELECT o.customer_phone AS phone,
                  (SELECT o2.customer_name FROM orders o2
                    WHERE o2.customer_phone = o.customer_phone ORDER BY o2.created_at DESC LIMIT 1) AS name,
                  COUNT(*) AS visits,
                  COALESCE(SUM(CASE WHEN o.status='paid' THEN o.total ELSE 0 END),0) AS spent,
                  MAX(o.created_at) AS last_visit
             FROM orders o
            WHERE o.customer_phone IS NOT NULL AND TRIM(o.customer_phone) != ''
            GROUP BY o.customer_phone
            ORDER BY last_visit DESC`
        ).all();
        return json((results || []).map((c) => ({
          ...c, name: String(c.name || "").replace(/\s*\(\d{10}\)\s*$/, "").trim() || "Cliente",
        })));
      }

      // ===== MENÚ =====
      const DESTS = ["cocina", "barra"];
      const needAdmin = () => (isAdmin ? null : json({ error: "Solo el administrador puede editar el menú" }, 403));
      const newId = (p) => p + "_" + crypto.randomUUID().slice(0, 8);

      // Mueve items de comandas abiertas cuando cambia la estación de un producto
      const moveOpenOrderItems = async (ids, dest) => {
        if (!ids.length) return;
        const idSet = new Set(ids.map(String));
        const { results } = await db.prepare("SELECT id, items FROM orders WHERE status != 'paid'").all();
        for (const o of results || []) {
          let items;
          try { items = JSON.parse(o.items || "[]"); } catch (e) { continue; }
          let changed = false;
          items = items.map((i) => {
            if (idSet.has(String(i.menu_item_id)) && (i.destination || "cocina") !== dest) {
              changed = true;
              return { ...i, destination: dest, done: false };
            }
            return i;
          });
          if (!changed) continue;
          const status = items.every((i) => i.done) ? "ready" : items.some((i) => i.done) ? "preparing" : "open";
          await db.prepare("UPDATE orders SET items=?, status=?, updated_at=datetime('now') WHERE id=?")
            .bind(JSON.stringify(items), status, o.id).run();
        }
      };
      // Pone categoría (y por ende estación) a un conjunto de productos
      const assignCategory = async (productIds, catId) => {
        const cat = await db.prepare(
          `SELECT c.id, c.name, s.destination FROM pos_menu_categories c JOIN pos_menu_sections s ON s.id=c.section_id WHERE c.id=?`
        ).bind(catId).first();
        if (!cat) return false;
        for (const pid of productIds)
          await db.prepare("UPDATE menu_items SET category_id=?, category=?, destination=? WHERE id=?")
            .bind(cat.id, cat.name, cat.destination, pid).run();
        await moveOpenOrderItems(productIds, cat.destination);
        return true;
      };
      // Sube/baja un elemento y renumera su grupo
      const reorder = async (table, whereCol, whereVal, id, dir) => {
        const rows = whereCol
          ? (await db.prepare(`SELECT id FROM ${table} WHERE ${whereCol}=? ORDER BY sort_order, name`).bind(whereVal).all()).results
          : (await db.prepare(`SELECT id FROM ${table} ORDER BY sort_order, name`).all()).results;
        const ids = (rows || []).map((r) => r.id);
        const i = ids.indexOf(id), j = dir === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        for (let k = 0; k < ids.length; k++)
          await db.prepare(`UPDATE ${table} SET sort_order=? WHERE id=?`).bind(k + 1, ids[k]).run();
      };
      const idsInCategories = async (catIds) => {
        if (!catIds.length) return [];
        const q = catIds.map(() => "?").join(",");
        const { results } = await db.prepare(`SELECT id FROM menu_items WHERE category_id IN (${q})`).bind(...catIds).all();
        return (results || []).map((r) => r.id);
      };

      // ===== FOTOS (R2) =====
      if (path === "/api/photo-upload" && request.method === "POST") {
        if (!isAdmin && sess.role !== "editor") return json({ error: "No autorizado" }, 403);
        const b = await request.json().catch(() => ({}));
        const d = dataUrlToBytes(b.data);
        if (!d) return json({ error: "Imagen no válida" }, 400);
        if (d.bytes.length > 3 * 1024 * 1024) return json({ error: "La foto pesa más de 3 MB" }, 400);
        if (!env.PHOTOS) return json({ url: String(b.data), storage: "d1" }); // sin R2: se guarda como antes
        const key = `up/${crypto.randomUUID()}.${extFor(d.ct)}`;
        await env.PHOTOS.put(key, d.bytes, { httpMetadata: { contentType: d.ct } });
        return json({ url: "/img/r2/" + key, storage: "r2" });
      }
      if (path === "/api/photos/status" && request.method === "GET") {
        const deny = needAdmin(); if (deny) return deny;
        const rows = (await db.prepare("SELECT image FROM menu_items WHERE active=1").all()).results || [];
        const c = { total: rows.length, sin_foto: 0, drive: 0, d1: 0, r2: 0, otras: 0 };
        for (const r of rows) {
          const v = String(r.image || "");
          if (!v) c.sin_foto++; else if (v.startsWith("/img/r2/")) c.r2++; else if (driveId(v)) c.drive++;
          else if (v.startsWith("data:image/")) c.d1++; else c.otras++;
        }
        return json({ r2_conectado: !!env.PHOTOS, ...c });
      }
      if (path === "/api/photos/migrate" && request.method === "POST") {
        const deny = needAdmin(); if (deny) return deny;
        if (!env.PHOTOS) return json({ error: "R2 no está conectado. Revisa el paso 1 del README (bucket rush-fotos)." }, 400);
        const LOTE = 8; // pocas por vuelta para no pasar el límite de Cloudflare
        const rows = (await db.prepare(
          "SELECT id, name, image FROM menu_items WHERE active=1 AND image IS NOT NULL AND image != '' AND image NOT LIKE '/img/r2/%'"
        ).all()).results || [];
        const pend = rows.filter((r) => driveId(r.image) || String(r.image).startsWith("data:image/") || String(r.image).startsWith("/img/drive/"));
        const fallos = [];
        let hechas = 0;
        for (const r of pend.slice(0, LOTE)) {
          const v = String(r.image);
          let key = null;
          const did = driveId(v) || (v.match(/^\/img\/drive\/([\w-]{20,})$/) || [])[1];
          if (did) {
            key = "drive/" + did;
            if (!(await env.PHOTOS.head(key))) {
              const got = await fetchDriveImage(did);
              if (!got) { fallos.push(r.name); continue; }
              await env.PHOTOS.put(key, got.buf, { httpMetadata: { contentType: got.ct } });
            }
          } else {
            const d = dataUrlToBytes(v);
            if (!d) { fallos.push(r.name); continue; }
            key = `up/${r.id}.${extFor(d.ct)}`;
            await env.PHOTOS.put(key, d.bytes, { httpMetadata: { contentType: d.ct } });
          }
          await db.prepare("UPDATE menu_items SET image=? WHERE id=?").bind("/img/r2/" + key, r.id).run();
          hechas++;
        }
        return json({ hechas, fallos, pendientes: Math.max(0, pend.length - hechas - fallos.length) });
      }

      if (path === "/api/menu" && request.method === "GET") {
        let items = [];
        try {
          const { results } = await db.prepare("SELECT * FROM menu_items WHERE active = 1 ORDER BY sort_order, name").all();
          items = (results || []).map((i) => ({ ...i, image: imgOut(i.image) }));
        } catch (e) {}
        return json(items);
      }

      if (path === "/api/menu-structure" && request.method === "GET") {
        const secs = (await db.prepare("SELECT * FROM pos_menu_sections ORDER BY sort_order, name").all()).results || [];
        const cats = (await db.prepare("SELECT * FROM pos_menu_categories ORDER BY sort_order, name").all()).results || [];
        return json({ sections: secs.map((sc) => ({ ...sc, categories: cats.filter((c) => c.section_id === sc.id) })) });
      }

      // Lo más pedido en los últimos 30 días (como "Destacados" de Starbucks)
      if (path === "/api/menu-popular" && request.method === "GET") {
        const { results } = await db.prepare("SELECT items FROM orders WHERE created_at >= datetime('now','-30 day')").all();
        const tally = {};
        for (const o of results || []) {
          let its; try { its = JSON.parse(o.items || "[]"); } catch (e) { continue; }
          for (const i of its) if (i.menu_item_id) tally[i.menu_item_id] = (tally[i.menu_item_id] || 0) + (Number(i.qty) || 1);
        }
        return json(Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, qty]) => ({ id, qty })));
      }

      if (path === "/api/menu" && request.method === "POST") {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json().catch(() => ({}));
        const name = String(b.name || "").trim();
        const price = Number(b.price);
        if (!name) return json({ error: "El nombre es obligatorio" }, 400);
        if (!(price >= 0)) return json({ error: "El precio no es válido" }, 400);
        const dup = await db.prepare("SELECT id FROM menu_items WHERE active=1 AND lower(trim(name))=lower(?)").bind(name).first();
        if (dup) return json({ error: "Ya existe un producto con ese nombre" }, 409);
        let dest = DESTS.includes(b.destination) ? b.destination : "cocina";
        let catText = String(b.category || "").trim() || "General";
        let catId = null;
        if (b.category_id) {
          const cat = await db.prepare(
            "SELECT c.id, c.name, s.destination FROM pos_menu_categories c JOIN pos_menu_sections s ON s.id=c.section_id WHERE c.id=?"
          ).bind(b.category_id).first();
          if (!cat) return json({ error: "Categoría no encontrada" }, 404);
          catId = cat.id; catText = cat.name; dest = cat.destination;
        }
        const rawImg = String(b.image || "");
        const okImg = isValidImg(rawImg);
        const image = okImg ? rawImg.slice(0, 400000) : null;
        const id = crypto.randomUUID();
        await db.prepare(
          "INSERT INTO menu_items (id, name, category, category_id, price, description, destination, active, sort_order, image) VALUES (?,?,?,?,?,?,?,1,0,?)"
        ).bind(id, name, catText, catId, price, String(b.description || ""), dest, image).run();
        return json({ id }, 201);
      }

      // Clasificar muchos productos a la vez: {assignments:[{id, category_id}]}
      if (path === "/api/menu-classify" && request.method === "POST") {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json().catch(() => ({}));
        const byCat = {};
        for (const a of b.assignments || []) if (a.id && a.category_id) (byCat[a.category_id] ||= []).push(a.id);
        let n = 0;
        for (const [catId, ids] of Object.entries(byCat)) if (await assignCategory(ids, catId)) n += ids.length;
        return json({ ok: true, updated: n });
      }

      const mm = path.match(/^\/api\/menu\/([^\/]+)$/);
      if (mm && request.method === "PATCH") {
        const pid = decodeURIComponent(mm[1]);
        const cur = await db.prepare("SELECT * FROM menu_items WHERE id=?").bind(pid).first();
        if (!cur) return json({ error: "Producto no encontrado" }, 404);
        const b = await request.json().catch(() => ({}));
        const onlySoldOut = Object.keys(b).length === 1 && b.sold_out !== undefined;
        const onlyCarta = Object.keys(b).length > 0 && Object.keys(b).every((k) => ["name", "description", "image"].includes(k));
        if (sess.role === "editor" && !onlyCarta) return json({ error: "El editor de carta solo puede cambiar foto, nombre y descripción" }, 403);
        if (!(onlySoldOut && ["admin", "cocina", "barra"].includes(sess.role)) && !(onlyCarta && sess.role === "editor")) {
          const deny = needAdmin(); if (deny) return deny;
        }
        const sets = [], vals = [];
        if (b.sold_out !== undefined) { sets.push("sold_out=?"); vals.push(b.sold_out ? 1 : 0); }
        if (typeof b.name === "string" && b.name.trim()) { sets.push("name=?"); vals.push(b.name.trim()); }
        if (typeof b.description === "string") { sets.push("description=?"); vals.push(b.description); }
        if (b.price !== undefined && Number(b.price) >= 0) { sets.push("price=?"); vals.push(Number(b.price)); }
        if (b.active !== undefined) { sets.push("active=?"); vals.push(b.active ? 1 : 0); }
        if (b.destination !== undefined) {
          if (!DESTS.includes(b.destination)) return json({ error: "Estación no válida" }, 400);
          sets.push("destination=?"); vals.push(b.destination);
        }
        if (b.image !== undefined) {
          const val = String(b.image || "");
          const okImg = isValidImg(val);
          const image = okImg ? val.slice(0, 400000) : null;
          sets.push("image=?"); vals.push(image);
        }
        if (sets.length) await db.prepare(`UPDATE menu_items SET ${sets.join(", ")} WHERE id=?`).bind(...vals, pid).run();
        if (b.destination !== undefined) await moveOpenOrderItems([pid], b.destination);
        if (b.category_id) { if (!(await assignCategory([pid], b.category_id))) return json({ error: "Categoría no encontrada" }, 404); }
        if (!sets.length && !b.category_id) return json({ error: "Nada que actualizar" }, 400);
        return json({ ok: true });
      }

      // ----- Secciones -----
      if (path === "/api/menu-sections" && request.method === "POST") {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json().catch(() => ({}));
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "El nombre es obligatorio" }, 400);
        const dest = DESTS.includes(b.destination) ? b.destination : "cocina";
        const mx = await db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM pos_menu_sections").first();
        const id = newId("sec");
        await db.prepare("INSERT INTO pos_menu_sections (id,name,icon,destination,sort_order) VALUES (?,?,?,?,?)")
          .bind(id, name, String(b.icon || "🍽️"), dest, (mx?.m || 0) + 1).run();
        return json({ id }, 201);
      }
      const sm = path.match(/^\/api\/menu-sections\/([^\/]+)$/);
      if (sm && request.method === "PATCH") {
        const deny = needAdmin(); if (deny) return deny;
        const sid = decodeURIComponent(sm[1]);
        const cur = await db.prepare("SELECT * FROM pos_menu_sections WHERE id=?").bind(sid).first();
        if (!cur) return json({ error: "Sección no encontrada" }, 404);
        const b = await request.json().catch(() => ({}));
        if (b.move === "up" || b.move === "down") {
          await reorder("pos_menu_sections", null, null, sid, b.move);
          return json({ ok: true });
        }
        const sets = [], vals = [];
        if (typeof b.name === "string" && b.name.trim()) { sets.push("name=?"); vals.push(b.name.trim()); }
        if (typeof b.icon === "string" && b.icon.trim()) { sets.push("icon=?"); vals.push(b.icon.trim()); }
        if (b.destination !== undefined) {
          if (!DESTS.includes(b.destination)) return json({ error: "Estación no válida" }, 400);
          sets.push("destination=?"); vals.push(b.destination);
        }
        if (!sets.length) return json({ error: "Nada que actualizar" }, 400);
        await db.prepare(`UPDATE pos_menu_sections SET ${sets.join(", ")} WHERE id=?`).bind(...vals, sid).run();
        if (b.destination !== undefined && b.destination !== cur.destination) {
          // toda la sección cambia de estación (ej. Bebidas -> barra)
          const cats = ((await db.prepare("SELECT id FROM pos_menu_categories WHERE section_id=?").bind(sid).all()).results || []).map((c) => c.id);
          const ids = await idsInCategories(cats);
          if (cats.length) {
            // por categoría (no por lista de productos) para no pasar del límite de 100 variables de D1
            const cq = cats.map(() => "?").join(",");
            await db.prepare(`UPDATE menu_items SET destination=? WHERE category_id IN (${cq})`).bind(b.destination, ...cats).run();
          }
          await moveOpenOrderItems(ids, b.destination);
        }
        return json({ ok: true });
      }
      if (sm && request.method === "DELETE") {
        const deny = needAdmin(); if (deny) return deny;
        const sid = decodeURIComponent(sm[1]);
        const n = await db.prepare("SELECT COUNT(*) AS c FROM pos_menu_categories WHERE section_id=?").bind(sid).first();
        if (n?.c) return json({ error: "Primero elimina o mueve las categorías de esta sección" }, 400);
        await db.prepare("DELETE FROM pos_menu_sections WHERE id=?").bind(sid).run();
        return json({ ok: true });
      }

      // ----- Categorías -----
      if (path === "/api/menu-categories" && request.method === "POST") {
        const deny = needAdmin(); if (deny) return deny;
        const b = await request.json().catch(() => ({}));
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "El nombre es obligatorio" }, 400);
        const sec = await db.prepare("SELECT id FROM pos_menu_sections WHERE id=?").bind(b.section_id).first();
        if (!sec) return json({ error: "Sección no encontrada" }, 404);
        const dup = await db.prepare("SELECT id FROM pos_menu_categories WHERE section_id=? AND lower(trim(name))=lower(?)").bind(sec.id, name).first();
        if (dup) return json({ error: "Esa categoría ya existe en la sección" }, 409);
        const mx = await db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM pos_menu_categories WHERE section_id=?").bind(sec.id).first();
        const id = newId("cat");
        await db.prepare("INSERT INTO pos_menu_categories (id,section_id,name,sort_order) VALUES (?,?,?,?)")
          .bind(id, sec.id, name, (mx?.m || 0) + 1).run();
        return json({ id }, 201);
      }
      const cm = path.match(/^\/api\/menu-categories\/([^\/]+)$/);
      if (cm && request.method === "PATCH") {
        const deny = needAdmin(); if (deny) return deny;
        const cid = decodeURIComponent(cm[1]);
        const cur = await db.prepare("SELECT * FROM pos_menu_categories WHERE id=?").bind(cid).first();
        if (!cur) return json({ error: "Categoría no encontrada" }, 404);
        const b = await request.json().catch(() => ({}));
        if (b.move === "up" || b.move === "down") {
          await reorder("pos_menu_categories", "section_id", cur.section_id, cid, b.move);
          return json({ ok: true });
        }
        if (typeof b.name === "string" && b.name.trim()) {
          await db.prepare("UPDATE pos_menu_categories SET name=? WHERE id=?").bind(b.name.trim(), cid).run();
          await db.prepare("UPDATE menu_items SET category=? WHERE category_id=?").bind(b.name.trim(), cid).run();
        }
        if (b.section_id && b.section_id !== cur.section_id) {
          const sec = await db.prepare("SELECT * FROM pos_menu_sections WHERE id=?").bind(b.section_id).first();
          if (!sec) return json({ error: "Sección no encontrada" }, 404);
          await db.prepare("UPDATE pos_menu_categories SET section_id=? WHERE id=?").bind(sec.id, cid).run();
          const ids = await idsInCategories([cid]);
          if (ids.length) {
            await db.prepare("UPDATE menu_items SET destination=? WHERE category_id=?").bind(sec.destination, cid).run();
            await moveOpenOrderItems(ids, sec.destination);
          }
        }
        return json({ ok: true });
      }
      if (cm && request.method === "DELETE") {
        const deny = needAdmin(); if (deny) return deny;
        const cid = decodeURIComponent(cm[1]);
        // los productos quedan "sin clasificar" (no se borran)
        await db.prepare("UPDATE menu_items SET category_id=NULL WHERE category_id=?").bind(cid).run();
        await db.prepare("DELETE FROM pos_menu_categories WHERE id=?").bind(cid).run();
        return json({ ok: true });
      }

      // ===== MESAS =====
      if (path === "/api/tables" && request.method === "GET") {
        let tables = [];
        try {
          const { results } = await db.prepare("SELECT * FROM tables WHERE active = 1").all();
          tables = results || [];
        } catch (e) {}
        if (tables.length === 0) tables = [{ id: "t1", name: "Mesa 1", capacity: 4, type: "mesa", status: "open" }];
        return json(tables);
      }

      // ===== ÓRDENES =====
      const m = path.match(/^\/api\/orders(?:\/([^\/]+))?(?:\/(payments))?$/);
      if (m) {
        const id = m[1], sub = m[2];

        if (!id && request.method === "GET") {
          const { results } = await db.prepare("SELECT * FROM orders WHERE status != 'paid' ORDER BY created_at DESC").all();
          return json(results.map(parseOrder));
        }

        if (!id && request.method === "POST") {
          const b = await request.json();
          const items = (b.items || []).map(({ done, ...i }) => i);
          const soldOut = await soldOutNames(items);
          if (soldOut.length) return json({ error: "Agotado: " + soldOut.join(", ") }, 409);
          const total = calcTotal(items);
          const newId = crypto.randomUUID();
          const notes = b.notes && typeof b.notes === "object" ? JSON.stringify(b.notes) : String(b.notes || "");
          await db.prepare(
            `INSERT INTO orders (id, custom_folio, table_id, customer_name, customer_phone, notes, items, subtotal, total, channel, loyalty_consent, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
          ).bind(newId, b.custom_folio || null, b.table_id || null, b.customer_name || "Mostrador",
                 b.customer_phone || "", notes, JSON.stringify(items), total, total, b.channel || "restaurante", b.loyalty_consent ? 1 : 0).run();
          return json({ id: newId }, 201);
        }

        if (id && sub === "payments" && request.method === "POST") {
          const o = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
          if (!o) return json({ error: "Orden no encontrada" }, 404);
          if (o.status === "paid") return json({ error: "Esta cuenta ya fue cobrada" }, 409);
          let method = "efectivo";
          try { const b = await request.json(); if (b.method) method = b.method; } catch (e) {}
          if (!["efectivo", "tarjeta", "transferencia"].includes(method)) return json({ error: "Método de pago no válido" }, 400);
          let loyalty = null;
          if (o.loyalty_consent && o.customer_phone && String(o.customer_phone).replace(/\D/g, "").length >= 10)
            loyalty = await addStamp(String(o.customer_phone).replace(/\D/g, "").slice(-10), (o.customer_name || "Cliente").replace(/\s*\(\d{10}\)\s*$/, ""));
          await db.batch([
            db.prepare(
              `INSERT INTO payments (order_id, method, amount, cash_amount, card_amount, terminal_amount, created_by)
               VALUES (?,?,?,?,?,0,?)`
            ).bind(id, method, o.total, method === "efectivo" ? o.total : 0, method === "tarjeta" ? o.total : 0, sess.username),
            db.prepare(
              `UPDATE orders SET status='paid', payment_status='paid', payment_method=?,
               closed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`
            ).bind(method, id),
          ]);
          return json({ ok: true, paid: o.total, loyalty });
        }

        if (id && !sub && request.method === "GET") {
          const o = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
          return o ? json(parseOrder(o)) : json({ error: "No encontrada" }, 404);
        }

        // Actualizar: status, items, notes, add_items/add_notes (agregar a la misma comanda), ready (cocina|barra)
        if (id && !sub && request.method === "PATCH") {
          const b = await request.json();
          const cur = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
          if (!cur) return json({ error: "No encontrada" }, 404);
          let items = JSON.parse(cur.items || "[]");
          let notes = cur.notes;
          let itemsChanged = false;
          if (Array.isArray(b.items)) { items = b.items; itemsChanged = true; }
          if (Array.isArray(b.add_items) && b.add_items.length) {
            const soldOut = await soldOutNames(b.add_items);
            if (soldOut.length) return json({ error: "Agotado: " + soldOut.join(", ") }, 409);
            items = items.concat(b.add_items.map(({ done, ...i }) => i));
            itemsChanged = true;
          }
          if (b.add_notes && (String(b.add_notes.cocina || "").trim() || String(b.add_notes.barra || "").trim()))
            notes = mergeNotes(cur.notes, b.add_notes);
          if (typeof b.notes === "string") notes = b.notes;
          if (b.ready === "cocina" || b.ready === "barra") {
            items = items.map((i) => ((i.destination || "cocina") === b.ready ? { ...i, done: true } : i));
            itemsChanged = true;
          }
          let status = b.status || cur.status;
          if (itemsChanged && !b.status) {
            const allDone = items.length > 0 && items.every((i) => i.done);
            status = allDone ? "ready" : items.some((i) => i.done) ? "preparing" : "open";
          }
          const total = calcTotal(items);
          await db.prepare("UPDATE orders SET status=?, items=?, subtotal=?, total=?, notes=?, updated_at=datetime('now') WHERE id=?")
            .bind(status, JSON.stringify(items), total, total, notes, id).run();
          return json({ ok: true, status });
        }

        if (id && !sub && request.method === "DELETE") {
          if (!isAdmin) return json({ error: "Solo el administrador puede borrar órdenes" }, 403);
          await db.prepare("DELETE FROM orders WHERE id=?").bind(id).run();
          return json({ ok: true });
        }
      }

      if (path === "/api/external-order" && request.method === "POST") {
        if (!isAdmin && sess.role !== "mesero") return json({ error: "No autorizado" }, 403);
        const b = await request.json().catch(() => ({}));
        const items = b.items || [];
        const soldOut = await soldOutNames(items);
        if (soldOut.length) return json({ error: "Agotado: " + soldOut.join(", ") }, 409);
        if (!items.length) return json({ error: "Agrega productos" }, 400);
        const channel = ["rappi", "uber", "domicilio_directo"].includes(b.channel) ? b.channel : "rappi";
        const total = calcTotal(items);
        const notes = JSON.stringify({ type: (channel === "rappi" ? "🛵 Rappi" : channel === "uber" ? "🚗 Uber Eats" : "📱 Domicilio directo") + (b.address ? " · " + b.address : ""), cocina: String(b.notes || "").trim(), barra: "" });
        const id = crypto.randomUUID();
        const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
        const folio = channel.slice(0, 3).toUpperCase() + "-" + p2(d.getUTCHours()) + p2(d.getUTCMinutes());
        await db.prepare(
          `INSERT INTO orders (id, custom_folio, customer_name, customer_phone, notes, items, subtotal, total, channel, loyalty_consent, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`
        ).bind(id, folio, String(b.customer_name || channel).trim(), String(b.customer_phone || ""), notes, JSON.stringify(items), total, total, channel, b.loyalty_consent ? 1 : 0).run();
        return json({ id, folio }, 201);
      }

      // ===== CAJA =====
      // Hora de México: UTC-6 (sin horario de verano). "Hoy" = día local, no día UTC.
      const clock = async () => await db.prepare(
        "SELECT datetime(date('now','-6 hours'),'+6 hours','-1 second') AS day_start, datetime('now') AS now"
      ).first();
      const lastCutRow = async () => await db.prepare("SELECT * FROM pos_cuts ORDER BY folio DESC LIMIT 1").first();

      // Resumen de ventas y movimientos de caja en (start, end]
      const summarize = async (start, end) => {
        const pays = (await db.prepare(
          "SELECT order_id, method, amount FROM payments WHERE created_at > ? AND created_at <= ?"
        ).bind(start, end).all()).results || [];
        const by = { efectivo: 0, tarjeta: 0, transferencia: 0 };
        let sales = 0;
        for (const p of pays) {
          const m = String(p.method || "").toLowerCase(), a = Number(p.amount) || 0;
          sales += a;
          if (m === "efectivo" || m === "cash") by.efectivo += a;
          else if (m === "tarjeta" || m === "card" || m === "terminal") by.tarjeta += a;
          else by.transferencia += a;
        }
        const orders = new Set(pays.map((p) => p.order_id)).size;
        const ords = (await db.prepare(
          "SELECT id, items FROM orders WHERE id IN (SELECT order_id FROM payments WHERE created_at > ? AND created_at <= ?)"
        ).bind(start, end).all()).results || [];
        const byDest = { cocina: 0, barra: 0 }, tally = {};
        for (const o of ords) {
          let its; try { its = JSON.parse(o.items || "[]"); } catch (e) { continue; }
          for (const i of its) {
            const amt = (Number(i.qty) || 1) * (Number(i.unit_price) || 0);
            byDest[(i.destination || "cocina") === "barra" ? "barra" : "cocina"] += amt;
            const t = (tally[i.name] ||= { name: i.name, qty: 0, amount: 0 });
            t.qty += Number(i.qty) || 1; t.amount += amt;
          }
        }
        const movements = (await db.prepare(
          "SELECT id, type, concept, amount, created_by, created_at FROM pos_cash_movements WHERE created_at > ? AND created_at <= ? ORDER BY created_at"
        ).bind(start, end).all()).results || [];
        const income = movements.filter((m) => m.type === "ingreso").reduce((x, m) => x + m.amount, 0);
        const expenses = movements.filter((m) => m.type === "egreso").reduce((x, m) => x + m.amount, 0);
        return {
          period_start: start, period_end: end, orders, sales,
          avg_ticket: orders ? sales / orders : 0,
          by_method: by, by_dest: byDest,
          top: Object.values(tally).sort((x, y) => y.qty - x.qty).slice(0, 5),
          income, expenses, movements,
          expected_cash: by.efectivo + income - expenses,
        };
      };
      const cutOut = (r) => ({ id: r.id, folio: r.folio, created_by: r.created_by, created_at: r.created_at, ...JSON.parse(r.data || "{}") });

      if (path === "/api/dashboard" && request.method === "GET") {
        const c = await clock();
        const lc = await lastCutRow();
        const since = lc ? lc.period_end : c.day_start;
        const [today, pending] = await Promise.all([summarize(c.day_start, c.now), summarize(since, c.now)]);
        return json({
          today: { sales: today.sales, orders: today.orders, avg_ticket: today.avg_ticket, by_method: today.by_method, expenses: today.expenses, income: today.income },
          pending, last_cut: lc ? cutOut(lc) : null,
        });
      }

      if (path === "/api/manual-transactions" && request.method === "POST") {
        if (!isAdmin) return json({ error: "Solo el administrador puede registrar movimientos de caja" }, 403);
        const b = await request.json().catch(() => ({}));
        const type = b.type === "egreso" ? "egreso" : b.type === "ingreso" ? "ingreso" : null;
        const concept = String(b.concept || "").trim(), amount = Number(b.amount);
        if (!type) return json({ error: "Tipo no válido" }, 400);
        if (!concept) return json({ error: "Escribe el concepto" }, 400);
        if (!(amount > 0)) return json({ error: "El monto debe ser mayor a 0" }, 400);
        const id = crypto.randomUUID();
        await db.prepare("INSERT INTO pos_cash_movements (id,type,concept,amount,created_by) VALUES (?,?,?,?,?)")
          .bind(id, type, concept, amount, sess.username).run();
        return json({ id }, 201);
      }
      const tm = path.match(/^\/api\/manual-transactions\/([^\/]+)$/);
      if (tm && request.method === "DELETE") {
        if (!isAdmin) return json({ error: "Solo el administrador puede borrar movimientos" }, 403);
        const lc = await lastCutRow();
        const mv = await db.prepare("SELECT * FROM pos_cash_movements WHERE id=?").bind(decodeURIComponent(tm[1])).first();
        if (!mv) return json({ error: "Movimiento no encontrado" }, 404);
        if (lc && mv.created_at <= lc.period_end) return json({ error: "Ese movimiento ya entró en un corte y no se puede borrar" }, 400);
        await db.prepare("DELETE FROM pos_cash_movements WHERE id=?").bind(mv.id).run();
        return json({ ok: true });
      }

      if (path === "/api/cuts" && request.method === "GET") {
        if (!isAdmin) return json({ error: "Solo el administrador puede ver los cortes" }, 403);
        const { results } = await db.prepare("SELECT * FROM pos_cuts ORDER BY folio DESC LIMIT 60").all();
        return json((results || []).map(cutOut));
      }
      if (path === "/api/cuts" && request.method === "POST") {
        if (!isAdmin) return json({ error: "Solo el administrador puede hacer el corte" }, 403);
        const b = await request.json().catch(() => ({}));
        const c = await clock();
        const lc = await lastCutRow();
        const data = await summarize(lc ? lc.period_end : c.day_start, c.now);
        const counted = b.counted_cash === null || b.counted_cash === undefined || b.counted_cash === "" ? null : Number(b.counted_cash);
        if (counted !== null && !(counted >= 0)) return json({ error: "El efectivo contado no es válido" }, 400);
        data.counted_cash = counted;
        data.difference = counted === null ? null : counted - data.expected_cash;
        const folio = ((lc && lc.folio) || 0) + 1;
        const id = crypto.randomUUID();
        await db.prepare("INSERT INTO pos_cuts (id, folio, period_start, period_end, data, created_by) VALUES (?,?,?,?,?,?)")
          .bind(id, folio, data.period_start, data.period_end, JSON.stringify(data), sess.username).run();
        return json(cutOut(await db.prepare("SELECT * FROM pos_cuts WHERE id=?").bind(id).first()), 201);
      }

      // ===== INVENTARIO (control manual de insumos) =====
      const INV_ROLES = ["admin", "cocina", "barra"];
      if (path === "/api/inventory" && request.method === "GET") {
        const { results } = await db.prepare("SELECT * FROM pos_inventory WHERE active=1 ORDER BY name").all();
        return json((results || []).map((i) => ({ ...i, low: i.min_stock > 0 && i.stock <= i.min_stock })));
      }
      if (path === "/api/inventory" && request.method === "POST") {
        if (!isAdmin) return json({ error: "Solo el administrador puede crear insumos" }, 403);
        const b = await request.json().catch(() => ({}));
        const name = String(b.name || "").trim();
        if (!name) return json({ error: "El nombre es obligatorio" }, 400);
        const dup = await db.prepare("SELECT id FROM pos_inventory WHERE active=1 AND lower(trim(name))=lower(?)").bind(name).first();
        if (dup) return json({ error: "Ya existe un insumo con ese nombre" }, 409);
        const stock = Number(b.stock) || 0, min = Number(b.min_stock) || 0;
        if (stock < 0 || min < 0) return json({ error: "Las cantidades no pueden ser negativas" }, 400);
        const id = crypto.randomUUID();
        await db.prepare("INSERT INTO pos_inventory (id,name,unit,stock,min_stock,active) VALUES (?,?,?,?,?,1)")
          .bind(id, name, String(b.unit || "pza"), stock, min).run();
        if (stock > 0)
          await db.prepare("INSERT INTO pos_inventory_moves (id,item_id,qty,reason,created_by) VALUES (?,?,?,?,?)")
            .bind(crypto.randomUUID(), id, stock, "Existencia inicial", sess.username).run();
        return json({ id }, 201);
      }
      if (path === "/api/inventory-moves" && request.method === "GET") {
        const { results } = await db.prepare(
          `SELECT m.id, m.qty, m.reason, m.created_by, m.created_at, i.name, i.unit
             FROM pos_inventory_moves m LEFT JOIN pos_inventory i ON i.id = m.item_id
            ORDER BY m.created_at DESC, m.rowid DESC LIMIT 30`
        ).all();
        return json(results || []);
      }
      const im = path.match(/^\/api\/inventory\/([^\/]+)$/);
      if (im && request.method === "PATCH") {
        const iid = decodeURIComponent(im[1]);
        const cur = await db.prepare("SELECT * FROM pos_inventory WHERE id=?").bind(iid).first();
        if (!cur) return json({ error: "Insumo no encontrado" }, 404);
        const b = await request.json().catch(() => ({}));
        if (b.delta !== undefined) {
          if (!INV_ROLES.includes(sess.role)) return json({ error: "No tienes permiso para mover el inventario" }, 403);
          const delta = Number(b.delta);
          if (!delta || !isFinite(delta)) return json({ error: "Escribe una cantidad válida" }, 400);
          const next = Math.round((cur.stock + delta) * 1000) / 1000;
          if (next < 0) return json({ error: `Stock insuficiente: hay ${cur.stock} ${cur.unit}` }, 400);
          await db.batch([
            db.prepare("UPDATE pos_inventory SET stock=? WHERE id=?").bind(next, iid),
            db.prepare("INSERT INTO pos_inventory_moves (id,item_id,qty,reason,created_by) VALUES (?,?,?,?,?)")
              .bind(crypto.randomUUID(), iid, delta, String(b.reason || (delta > 0 ? "Entrada" : "Salida")), sess.username),
          ]);
          return json({ ok: true, stock: next });
        }
        if (!isAdmin) return json({ error: "Solo el administrador puede editar insumos" }, 403);
        const sets = [], vals = [];
        if (typeof b.name === "string" && b.name.trim()) { sets.push("name=?"); vals.push(b.name.trim()); }
        if (typeof b.unit === "string" && b.unit.trim()) { sets.push("unit=?"); vals.push(b.unit.trim()); }
        if (b.min_stock !== undefined && Number(b.min_stock) >= 0) { sets.push("min_stock=?"); vals.push(Number(b.min_stock)); }
        if (b.active !== undefined) { sets.push("active=?"); vals.push(b.active ? 1 : 0); }
        if (!sets.length) return json({ error: "Nada que actualizar" }, 400);
        await db.prepare(`UPDATE pos_inventory SET ${sets.join(", ")} WHERE id=?`).bind(...vals, iid).run();
        return json({ ok: true });
      }

      // ===== Aún no implementados =====
      if (request.method === "GET") return json([]);
      return json({ ok: true });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
