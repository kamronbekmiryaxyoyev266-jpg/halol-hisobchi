/**
 * =============================================================================
 * HALOL HISOBCHI — TELEGRAM BOT & MINI-CRM (v2)
 * =============================================================================
 * Sozlamalar .env faylida saqlanadi (BOT_TOKEN, OWNER_ID ...). Tokenni kod ichiga
 * YOZMANG. Namuna: .env.example
 *
 *  - Faqat OWNER boshqaruv paneliga kira oladi va arizalarni belgilay oladi.
 *  - Sayt arizalari POST /api/lead orqali keladi (tekshiruv + rate-limit bilan).
 *  - Barcha foydalanuvchi matnlari HTML-escape qilinadi (Telegram parse_mode=HTML).
 *  - Baza: leads_database.json (atomik yozish + zaxira nusxa).
 * =============================================================================
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

// -----------------------------------------------------------------------------
// .env yuklash (qo'shimcha paket kerak emas)
// -----------------------------------------------------------------------------
(function loadEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let val = m[2];
    if (/^(".*"|'.*')$/.test(val)) val = val.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
})();

const BOT_TOKEN = (process.env.BOT_TOKEN || "").trim();
const OWNER_ID = Number(process.env.OWNER_ID);
const OWNER_NAME = process.env.OWNER_NAME || "Kamronbek";
const PORT = Number(process.env.PORT) || 3005;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  "https://halolhisobchi.uz,https://www.halolhisobchi.uz,http://localhost:3005,http://localhost:5500,http://127.0.0.1:5500,null")
  .split(",").map((s) => s.trim()).filter(Boolean);

if (!BOT_TOKEN || !Number.isFinite(OWNER_ID) || OWNER_ID <= 0) {
  console.error("\n[XATOLIK] .env faylida BOT_TOKEN va OWNER_ID to'ldirilmagan.");
  console.error("          .env.example faylidan nusxa olib, .env yarating.\n");
  process.exit(2); // 2 = qayta ishga tushirmaslik (start_bot.bat shuni tekshiradi)
}

const DB_FILE = path.join(__dirname, "leads_database.json");
const SUPPORT_PHONE = "+998 95 953 55 45";

// Narxlar sayt kalkulyatori (index.html) bilan BIR XIL bo'lishi shart.
const PRICING = {
  base: { mchj_aylanma: 1200000, mchj_qqs: 1800000, yatt: 750000, itpark: 1400000 },
  baseLabel: {
    mchj_aylanma: "MCHJ (Aylanma)",
    mchj_qqs: "MCHJ (Umumiy rejim, QQS 12%)",
    yatt: "YaTT",
    itpark: "IT Park rezidenti / XK",
  },
  perStaff: 45000,
  perOp: 8000,
};

// -----------------------------------------------------------------------------
// Yordamchi funksiyalar
// -----------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clean = (s, max) =>
  String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtNum = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const fmtDate = (iso) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tashkent", day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(iso));

function normalizePhone(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 9) return "+998" + d;
  if (d.length === 12 && d.startsWith("998")) return "+" + d;
  if (d.length >= 10 && d.length <= 15) return "+" + d;
  return null;
}
function prettyPhone(p) {
  const m = /^\+998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(p);
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : p;
}
const validUsername = (u) => /^[A-Za-z0-9_]{5,32}$/.test(u || "");

// -----------------------------------------------------------------------------
// Baza (JSON) — atomik yozish, buzilgan faylni yo'qotmaslik
// -----------------------------------------------------------------------------
function normalizeLead(l) {
  return { ...l, status: l.status === "boglanildi" ? "boglanildi" : "yangi" };
}

function loadLeads() {
  if (!fs.existsSync(DB_FILE)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    if (!Array.isArray(arr)) throw new Error("Baza massiv emas");
    return arr.map(normalizeLead);
  } catch (e) {
    console.error("[BAZA] O'qishda xatolik:", e.message);
    try { fs.copyFileSync(DB_FILE, `${DB_FILE}.broken-${Date.now()}`); } catch (_) { /* e'tiborsiz */ }
    return [];
  }
}

function writeLeads(leads) {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(leads, null, 2), "utf-8");
  if (fs.existsSync(DB_FILE)) {
    try { fs.copyFileSync(DB_FILE, DB_FILE + ".bak"); } catch (_) { /* e'tiborsiz */ }
  }
  fs.renameSync(tmp, DB_FILE);
}

function saveLead(lead) {
  const leads = loadLeads();
  const saved = {
    ...lead,
    id: leads.reduce((m, l) => Math.max(m, l.id || 0), 0) + 1,
    status: "yangi",
    createdAt: new Date().toISOString(),
  };
  leads.push(saved);
  writeLeads(leads); // xato bo'lsa chaqiruvchiga uzatiladi
  return saved;
}

function updateLeadStatus(id, status) {
  const leads = loadLeads();
  const target = leads.find((l) => l.id === id);
  if (!target) return null;
  target.status = status;
  target.updatedAt = new Date().toISOString();
  writeLeads(leads);
  return target;
}

// -----------------------------------------------------------------------------
// Sessiyalar (30 daqiqadan keyin tozalanadi)
// -----------------------------------------------------------------------------
const SESSION_TTL = 30 * 60 * 1000;
const sessions = new Map();
const getSession = (chatId) => {
  const s = sessions.get(chatId);
  if (s && Date.now() - s.ts < SESSION_TTL) return s;
  sessions.delete(chatId);
  return {};
};
const setSession = (chatId, data) => {
  data.ts = Date.now();
  sessions.set(chatId, data);
  return data;
};
setInterval(() => {
  for (const [k, v] of sessions) if (Date.now() - v.ts >= SESSION_TTL) sessions.delete(k);
}, 10 * 60 * 1000).unref();

const lastLeadAt = new Map(); // userId -> vaqt (ketma-ket ariza spamiga qarshi)

// -----------------------------------------------------------------------------
// Telegram API
// -----------------------------------------------------------------------------
async function tg(method, body = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json();
    if (!data.ok && !String(data.description).includes("not modified")) {
      console.error(`[TG] ${method}: ${data.error_code} ${data.description}`);
    }
    return data;
  } catch (e) {
    console.error(`[TG] ${method}: ${e.name === "AbortError" ? "vaqt tugadi" : e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sendMessage = (chatId, text, extra = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

// Xabarni tahrirlaydi; imkonsiz bo'lsa (eski xabar) yangisini yuboradi
async function show(chatId, messageId, text, extra = {}) {
  if (messageId) {
    const r = await tg("editMessageText", {
      chat_id: chatId, message_id: messageId, text, parse_mode: "HTML",
      disable_web_page_preview: true, ...extra,
    });
    if (r && (r.ok || String(r.description).includes("not modified"))) return r;
  }
  return sendMessage(chatId, text, extra);
}

async function setupBotCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "🏠 Asosiy menyuni ochish" },
      { command: "audit", description: "🔍 Bepul soliq diagnostikasi" },
      { command: "kalkulyator", description: "🧮 Xizmat narxini hisoblash" },
      { command: "xizmatlar", description: "📋 Xizmatlar ro'yxati" },
      { command: "aloqa", description: "📞 Bosh buxgalter konsultatsiyasi" },
    ],
  });
  // Owner buyrug'i faqat egasining chatida ko'rinadi
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "🏠 Asosiy menyuni ochish" },
      { command: "owner", description: "👑 Boshqaruv paneli" },
      { command: "audit", description: "🔍 Bepul soliq diagnostikasi" },
      { command: "kalkulyator", description: "🧮 Xizmat narxini hisoblash" },
      { command: "xizmatlar", description: "📋 Xizmatlar ro'yxati" },
      { command: "aloqa", description: "📞 Konsultatsiya" },
    ],
    scope: { type: "chat", chat_id: OWNER_ID },
  });
}

// -----------------------------------------------------------------------------
// Ariza → egasiga bildirishnoma
// -----------------------------------------------------------------------------
const STATUS_TEXT = { yangi: "🟡 Yangi (ko'rilmagan)", boglanildi: "🟢 Bog'lanildi" };

function leadBadge(category) {
  switch (category) {
    case "website": return "🟢 <b>#SAYT_BUYURTMASI (TAYYOR XARIDOR)</b>";
    case "audit": return "🟡 <b>#SOLIQ_DIAGNOSTIKASI (AUDIT TESTI)</b>";
    case "calculator": return "🔵 <b>#KALKULYATOR_HISOBLASH (SMETA)</b>";
    default: return "🟣 <b>#TEZKOR_KONSULTATSIYA</b>";
  }
}

function buildLeadText(l) {
  return [
    leadBadge(l.category),
    `📌 <b>Ariza raqami:</b> #${l.id}`,
    `⚡ <b>Holat:</b> ${STATUS_TEXT[l.status] || STATUS_TEXT.yangi}`,
    "",
    `👤 <b>Mijoz:</b> ${esc(l.name || "Noma'lum")}`,
    `📞 <b>Telefon:</b> <code>${esc(l.phone || "Kiritilmagan")}</code>`,
    `💼 <b>Xizmat:</b> ${esc(l.service || "Umumiy buxgalteriya")}`,
    l.username ? `💬 <b>Telegram:</b> @${esc(l.username)}` : null,
    l.userId ? `🆔 <b>Telegram ID:</b> <code>${esc(l.userId)}</code>` : null,
    "",
    "📝 <b>Tafsilotlar:</b>",
    esc(l.details || "Qo'shimcha izoh qoldirilmagan."),
    "",
    `⏰ <b>Vaqt:</b> ${fmtDate(l.createdAt)} (Toshkent)`,
  ].filter((x) => x !== null).join("\n");
}

function leadKeyboard(l) {
  const row = [];
  if (validUsername(l.username)) row.push({ text: "💬 Telegramda yozish", url: `https://t.me/${l.username}` });
  row.push(
    l.status === "boglanildi"
      ? { text: "↩️ Yangi holatiga qaytarish", callback_data: `lead_undo_${l.id}` }
      : { text: "✅ Bog'lanildi deb belgilash", callback_data: `lead_done_${l.id}` }
  );
  return { reply_markup: { inline_keyboard: [row] } };
}

// Natija: { saved, notified }. Baza xatosi bo'lsa exception tashlaydi.
async function sendLeadToOwner(lead) {
  const saved = saveLead(lead);
  const r = await sendMessage(OWNER_ID, buildLeadText(saved), leadKeyboard(saved));
  const notified = !!(r && r.ok);
  if (!notified) {
    console.error(`[ARIZA] #${saved.id} saqlandi, lekin egasiga yuborilmadi. Bot bilan /start bosganingizni tekshiring.`);
  }
  return { saved, notified };
}

// -----------------------------------------------------------------------------
// Menyular
// -----------------------------------------------------------------------------
function mainKeyboard(userId) {
  const rows = [
    [{ text: "🔍 Soliq xavfini tekshirish (Audit-Test)", callback_data: "audit_start" }],
    [
      { text: "🧮 Xizmat narxini hisoblash", callback_data: "calc_start" },
      { text: "📋 Xizmatlar ro'yxati", callback_data: "services_list" },
    ],
    [
      { text: "📞 Bosh buxgalter konsultatsiyasi", callback_data: "request_call" },
      { text: "🛡 Kafolat & Rekvizitlar", callback_data: "about_company" },
    ],
  ];
  if (Number(userId) === OWNER_ID) {
    rows.unshift([{ text: "👑 Boshqaruv Paneli", callback_data: "owner_panel" }]);
  }
  return { reply_markup: { inline_keyboard: rows } };
}

const contactKeyboard = () => ({
  reply_markup: {
    keyboard: [
      [{ text: "📱 Telefon raqamimni yuborish", request_contact: true }],
      [{ text: "⬅️ Bekor qilish / Bosh menyu" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
});

const navRow = (backData) => [
  { text: "⬅️ Ortga", callback_data: backData },
  { text: "❌ Bekor qilish", callback_data: "menu_home" },
];

async function askPhone(chatId, title, details) {
  await sendMessage(
    chatId,
    `${title}\n\n${details}\n\n👇 Pastdagi <b>"📱 Telefon raqamimni yuborish"</b> tugmasini bosing\n<i>(yoki raqamingizni +998 90 123 45 67 shaklida yozib yuboring)</i>`,
    contactKeyboard()
  );
}

// -----------------------------------------------------------------------------
// Bo'limlar
// -----------------------------------------------------------------------------
async function startAudit(chatId, messageId = null) {
  setSession(chatId, { category: "audit", serviceTitle: "Soliq xavfi diagnostikasi", step: "audit_q1", answers: {} });
  await show(chatId, messageId,
    "🔍 <b>Soliq xavfini diagnostika qilish (1/4)</b>\n\nKorxonangizning tashkiliy-huquqiy shakli qanday?",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏢 MCHJ", callback_data: "audit_a1_mchj" }],
          [{ text: "👤 YaTT (Yakka tartibdagi tadbirkor)", callback_data: "audit_a1_yatt" }],
          [{ text: "🏭 Xususiy korxona (XK) yoki boshqa", callback_data: "audit_a1_xk" }],
          [{ text: "❌ Bekor qilish", callback_data: "menu_home" }],
        ],
      },
    });
}

async function startCalc(chatId, messageId = null) {
  setSession(chatId, { category: "calculator", serviceTitle: "Kalkulyator narx smetasi", step: "calc_b", calc: {} });
  await show(chatId, messageId,
    "🧮 <b>Tezkor xizmat kalkulyatori (1/3)</b>\n\nKorxona shakli va soliq rejimini tanlang:",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🏢 MCHJ (Aylanmadan soliq)", callback_data: "calc_b_mchj_aylanma" }],
          [{ text: "🏭 MCHJ (QQS 12% + Foyda solig'i)", callback_data: "calc_b_mchj_qqs" }],
          [{ text: "👤 YaTT", callback_data: "calc_b_yatt" }],
          [{ text: "💻 IT Park rezidenti / XK", callback_data: "calc_b_itpark" }],
          [{ text: "❌ Bekor qilish", callback_data: "menu_home" }],
        ],
      },
    });
}

async function showServices(chatId, messageId = null) {
  await show(chatId, messageId,
`📋 <b>"Halol Hisobchi" xizmatlari:</b>

1. <b>Buxgalteriya xizmati (1C & to'liq yuritish)</b>
Soliq hisobotlari, birlamchi hujjatlar, EHF va bank to'lovlari.

2. <b>Moliyachi xizmati (Cash Flow & P&L)</b>
Pul oqimi nazorati, sof foyda va rentabellik tahlili.

3. <b>Audit xizmati</b>
O'tgan 1-3 yillik operatsiyalarni qayta tekshirib, xatarlarni aniqlash va tuzatish.

4. <b>Soliq maslahatlari va optimizatsiya</b>
Qonuniy imtiyozlarni qo'llash va ortiqcha to'lovlarni kamaytirish.

5. <b>Tashqi iqtisodiy faoliyat (Import / Eksport)</b>
Bojxona deklaratsiyalari va valyuta nazorati.

6. <b>E-tijorat & Uzum Market hisobi</b>
Marketplace aktlari va komissiyalar hisobi.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📞 Maslahat uchun ariza qoldirish", callback_data: "request_call" }],
          [{ text: "🧮 Narxni hisoblash", callback_data: "calc_start" }],
          [{ text: "⬅️ Asosiy menyu", callback_data: "menu_home" }],
        ],
      },
    });
}

async function requestConsultation(chatId, messageId = null) {
  setSession(chatId, { category: "consultation", serviceTitle: "Tezkor buxgalter konsultatsiyasi", step: "waiting_phone" });
  if (messageId) await show(chatId, messageId, "📞 <b>Mutaxassis bilan bog'lanish bo'limi tanlandi.</b>");
  await askPhone(chatId, "📞 <b>Bepul konsultatsiyaga yozilish:</b>",
    "Bosh buxgalterimiz siz bilan bog'lanishi uchun telefon raqamingizni yuboring:");
}

async function showAbout(chatId, messageId = null) {
  await show(chatId, messageId,
`🛡 <b>"Halol Hisobchi" haqida:</b>

• <b>Moddiy javobgarlik:</b> Bizning xatomiz tufayli soliq jarimasi kelsa, shartnoma shartlariga ko'ra qoplab beramiz.
• <b>Konfidensiallik (NDA):</b> Bank va tijorat ma'lumotlaringiz maxfiy saqlanadi.
• <b>10+ yillik amaliy tajriba</b>

📍 <b>Manzil:</b> Toshkent sh., Shayxontohur tumani, Ko'kcha Darvoza ko'chasi, 314/308
📞 <b>Telefon:</b> ${SUPPORT_PHONE}
🕒 <b>Ish tartibi:</b> Dushanba - Shanba, 09:00 - 18:00`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📞 Bog'lanish uchun raqam qoldirish", callback_data: "request_call" }],
          [{ text: "⬅️ Asosiy menyu", callback_data: "menu_home" }],
        ],
      },
    });
}

// -----------------------------------------------------------------------------
// Audit natijasi
// -----------------------------------------------------------------------------
const AUDIT_LABELS = {
  biz: { mchj: "MCHJ", yatt: "YaTT", xk: "Xususiy korxona / boshqa" },
  tax: { aylanma: "Aylanmadan soliq", qqs: "Umumiy tizim (QQS + foyda solig'i)", unknown: "Aniq emas" },
  acc: { staff: "Shtatdagi buxgalter", outsourcing: "Tashqi buxgalter / konsalting", self: "O'zi yuritadi", none: "Tartibli yuritilmayapti" },
  hist: { yes: "O'tkazilgan", no: "Hech qachon o'tkazilmagan", unknown: "Ma'lumot yo'q" },
};

function computeAudit(a) {
  let pct = 35;
  const points = [];
  if (a.taxType === "qqs") {
    pct += 30;
    points.push("QQS bo'yicha kiruvchi va chiquvchi hisobvaraq-fakturalar nomuvofiqligi xavfi yuqori.");
  } else if (a.taxType === "unknown") {
    pct += 10;
    points.push("Soliq rejimi aniq bilinmasa, noto'g'ri stavka qo'llanishi mumkin.");
  }
  if (a.accountant === "self" || a.accountant === "none") {
    pct += 25;
    points.push("Soliq qonunchiligi yangiliklari va kadrlar hisobi (my.mehnat.uz) bo'yicha penya xavfi bor.");
  }
  if (a.auditHistory === "no") {
    pct += 20;
    points.push("O'tgan davrlardagi yashirin xatolar kameral tekshiruvda aniqlanishi mumkin.");
  } else if (a.auditHistory === "unknown") {
    pct += 10;
    points.push("Audit o'tkazilgani noma'lum — hisob holatini tekshirib ko'rish tavsiya etiladi.");
  }
  if (!points.length) points.push("Jiddiy xavf omillari aniqlanmadi. Baribir yiliga bir marta tekshiruv o'tkazish foydali.");
  pct = Math.min(pct, 85);
  const level = pct >= 70 ? "YUQORI ⚠️" : pct >= 45 ? "O'RTA ⚡" : "ME'YORIDA ✅";
  return { pct, level, points };
}

// -----------------------------------------------------------------------------
// Xabarlar
// -----------------------------------------------------------------------------
function parseCommand(text) {
  const m = /^\/([A-Za-z_]+)(?:@\w+)?(?:\s+(.*))?$/.exec(text);
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] || "").trim() } : null;
}

async function handleMessage(msg) {
  if (!msg.chat || msg.chat.type !== "private" || !msg.from) return; // guruhlarni e'tiborsiz
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();
  const isOwner = Number(userId) === OWNER_ID;
  const session = getSession(chatId);

  if (text === "⬅️ Bekor qilish / Bosh menyu") {
    sessions.delete(chatId);
    await sendMessage(chatId, "Bekor qilindi.", { reply_markup: { remove_keyboard: true } });
    await sendMessage(chatId, "Kerakli bo'limni tanlang:", mainKeyboard(userId));
    return;
  }

  const command = parseCommand(text);
  if (command) {
    const { cmd, arg } = command;
    if (cmd === "start") {
      sessions.delete(chatId);
      if (session.step === "waiting_phone") {
        await sendMessage(chatId, "🏠 Bosh menyu", { reply_markup: { remove_keyboard: true } });
      }
      if (arg === "audit" || arg === "audit_from_web") return startAudit(chatId);
      if (arg === "calc" || arg === "calc_from_web") return startCalc(chatId);
      const greeting = isOwner
        ? `👑 <b>Xush kelibsiz, ${esc(OWNER_NAME)}!</b>\n\nBarcha arizalar va statistika faqat sizga ko'rinadi.\n\n👇 <b>Kerakli amalni tanlang:</b>`
        : `Assalomu alaykum, <b>${esc(msg.from.first_name || "hurmatli tadbirkor")}</b>! 🤝\n\n<b>"Halol Hisobchi"</b> konsalting botiga xush kelibsiz.\n\nBuxgalteriya hisobini shaffof va qonuniy yuritish, soliq xatarlarini kamaytirish bo'yicha yordam beramiz.\n\n👇 <b>Bo'limni tanlang:</b>`;
      return sendMessage(chatId, greeting, mainKeyboard(userId));
    }
    if (cmd === "audit") return startAudit(chatId);
    if (cmd === "kalkulyator") return startCalc(chatId);
    if (cmd === "xizmatlar") return showServices(chatId);
    if (cmd === "aloqa") return requestConsultation(chatId);
    if (cmd === "owner" || cmd === "admin") {
      if (isOwner) return showOwnerPanel(chatId);
      await sendMessage(chatId, "⛔ <b>Ruxsat berilmagan.</b>\nBu buyruq faqat tizim egasi uchun.");
      await sendMessage(OWNER_ID,
        `🚨 <b>XAVFSIZLIK SIGNALI</b>\nBegona foydalanuvchi boshqaruv paneliga kirishga urindi:\n👤 ${esc(msg.from.first_name || "Noma'lum")}\n💬 ${msg.from.username ? "@" + esc(msg.from.username) : "username yo'q"}\n🆔 <code>${userId}</code>\n⏰ ${fmtDate(new Date().toISOString())}`);
      return;
    }
  }

  // Kontakt yuborilganda
  if (msg.contact) {
    if (session.step !== "waiting_phone") {
      return sendMessage(chatId, "Avval menyudan kerakli bo'limni tanlang 👇", mainKeyboard(userId));
    }
    if (msg.contact.user_id && msg.contact.user_id !== userId) {
      return sendMessage(chatId, "⚠️ Iltimos, <b>o'zingizning</b> raqamingizni yuboring.", contactKeyboard());
    }
    const phone = normalizePhone(msg.contact.phone_number);
    return finishLead(chatId, msg.from, phone || msg.contact.phone_number, session);
  }

  // Telefon matn ko'rinishida
  if (session.step === "waiting_phone") {
    const phone = normalizePhone(text);
    if (phone) return finishLead(chatId, msg.from, phone, session);
    return sendMessage(chatId,
      "⚠️ <b>Telefon raqami noto'g'ri.</b>\nMasalan: <code>+998 90 123 45 67</code> yoki pastdagi tugmani bosing:",
      contactKeyboard());
  }

  await sendMessage(chatId, "Iltimos, menyudan kerakli bo'limni tanlang 👇", mainKeyboard(userId));
}

async function finishLead(chatId, from, phone, session) {
  const last = lastLeadAt.get(from.id) || 0;
  if (Date.now() - last < 60 * 1000) {
    await sendMessage(chatId, "✅ Arizangiz allaqachon qabul qilingan. Mutaxassisimiz tez orada bog'lanadi.",
      { reply_markup: { remove_keyboard: true } });
    sessions.delete(chatId);
    return;
  }
  lastLeadAt.set(from.id, Date.now());

  let result;
  try {
    result = await sendLeadToOwner({
      name: clean(`${from.first_name || ""} ${from.last_name || ""}`, 80) || "Mijoz",
      phone: clean(prettyPhone(phone), 30),
      username: from.username || "",
      userId: from.id,
      category: session.category || "consultation",
      service: session.serviceTitle || "Buxgalteriya konsultatsiyasi",
      details: session.auditSummary || session.calcSummary || "To'g'ridan-to'g'ri ariza qoldirildi.",
    });
  } catch (e) {
    console.error("[ARIZA] Saqlashda xatolik:", e.message);
    lastLeadAt.delete(from.id);
    await sendMessage(chatId,
      `⚠️ Arizani saqlashda texnik xatolik yuz berdi. Iltimos, bizga qo'ng'iroq qiling: <b>${SUPPORT_PHONE}</b>`,
      { reply_markup: { remove_keyboard: true } });
    return;
  }

  await sendMessage(chatId,
`✅ <b>Arizangiz qabul qilindi!</b>

Rahmat, <b>${esc(from.first_name || "hurmatli tadbirkor")}</b>. Ma'lumotlaringiz mutaxassisimizga yetkazildi — u siz bilan tez orada bog'lanadi.

📞 Tezkor aloqa: <b>${SUPPORT_PHONE}</b>`,
    { reply_markup: { remove_keyboard: true } });
  await sendMessage(chatId, "Boshqa xizmatlarimiz bilan tanishishingiz mumkin 👇", mainKeyboard(from.id));
  sessions.delete(chatId);
}

// -----------------------------------------------------------------------------
// Inline tugmalar
// -----------------------------------------------------------------------------
async function handleCallback(cq) {
  if (!cq.message) return;
  const chatId = cq.message.chat.id;
  const messageId = cq.message.message_id;
  const userId = cq.from.id;
  const data = cq.data || "";
  const isOwner = Number(userId) === OWNER_ID;
  let answered = false;
  const answer = async (text, alert = false) => {
    if (answered) return;
    answered = true;
    await tg("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text, show_alert: alert } : {}) });
  };

  try {
    if (data === "none") return;

    if (data === "menu_home") {
      sessions.delete(chatId);
      return void (await show(chatId, messageId, "Asosiy menyu. Kerakli bo'limni tanlang 👇", mainKeyboard(userId)));
    }

    // ---- Owner bo'limlari (hammasi egasi uchun tekshiriladi) ----
    if (data === "owner_panel" || data === "owner_new_leads" || data === "owner_recent_leads" || /^lead_(done|undo)_/.test(data)) {
      if (!isOwner) {
        await answer("⛔ Ruxsat yo'q", true);
        return;
      }
      if (data === "owner_panel") return void (await showOwnerPanel(chatId, messageId));
      if (data === "owner_new_leads") return void (await showLeads(chatId, messageId, "new"));
      if (data === "owner_recent_leads") return void (await showLeads(chatId, messageId, "all"));

      const m = /^lead_(done|undo)_(\d+)(?:_(l))?$/.exec(data);
      if (!m) return;
      const id = Number(m[2]);
      const updated = updateLeadStatus(id, m[1] === "done" ? "boglanildi" : "yangi");
      if (!updated) {
        await answer("Ariza topilmadi", true);
        return;
      }
      await answer(m[1] === "done" ? `✅ Ariza #${id} — bog'lanildi` : `↩️ Ariza #${id} — yangi holatiga qaytarildi`);
      if (m[3]) return void (await showLeads(chatId, messageId, "new"));
      return void (await show(chatId, messageId, buildLeadText(updated), leadKeyboard(updated)));
    }

    // ---- Audit ----
    if (data === "audit_start") return void (await startAudit(chatId, messageId));

    let s = getSession(chatId);

    if (data.startsWith("audit_a1_")) {
      s = setSession(chatId, { category: "audit", serviceTitle: "Soliq xavfi diagnostikasi", answers: {}, ...s, step: "audit_q2" });
      s.answers = { ...(s.answers || {}), bizType: data.slice(9) };
      return void (await show(chatId, messageId,
        "🔍 <b>Soliq xavfini diagnostika qilish (2/4)</b>\n\nQaysi soliq to'lash tizimidasiz?",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "📊 Aylanmadan olinadigan soliq", callback_data: "audit_a2_aylanma" }],
              [{ text: "📈 Umumiy tizim (QQS + foyda solig'i)", callback_data: "audit_a2_qqs" }],
              [{ text: "❓ Aniq bilmayman", callback_data: "audit_a2_unknown" }],
              navRow("audit_start"),
            ],
          },
        }));
    }

    if (data.startsWith("audit_a2_")) {
      s = setSession(chatId, { category: "audit", serviceTitle: "Soliq xavfi diagnostikasi", answers: {}, ...s, step: "audit_q3" });
      s.answers.taxType = data.slice(9);
      return void (await show(chatId, messageId,
        "🔍 <b>Soliq xavfini diagnostika qilish (3/4)</b>\n\nHisob-kitob va hisobotlarni hozir kim yuritmoqda?",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "💼 Shtatdagi buxgalter", callback_data: "audit_a3_staff" }],
              [{ text: "👨‍💻 Tashqi buxgalter / konsalting", callback_data: "audit_a3_outsourcing" }],
              [{ text: "✍️ O'zim yuritaman", callback_data: "audit_a3_self" }],
              [{ text: "❌ Hali tartibli yuritilmayapti", callback_data: "audit_a3_none" }],
              navRow(`audit_a1_${s.answers.bizType || "mchj"}`),
            ],
          },
        }));
    }

    if (data.startsWith("audit_a3_")) {
      s = setSession(chatId, { category: "audit", serviceTitle: "Soliq xavfi diagnostikasi", answers: {}, ...s, step: "audit_q4" });
      s.answers.accountant = data.slice(9);
      return void (await show(chatId, messageId,
        "🔍 <b>Soliq xavfini diagnostika qilish (4/4)</b>\n\nOxirgi 1 yil ichida mustaqil audit tekshiruvi o'tkazilganmi?",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Ha, o'tkazilgan", callback_data: "audit_a4_yes" }],
              [{ text: "⚠️ Yo'q, hech qachon", callback_data: "audit_a4_no" }],
              [{ text: "❓ Ma'lumotim yo'q", callback_data: "audit_a4_unknown" }],
              navRow(`audit_a2_${s.answers.taxType || "aylanma"}`),
            ],
          },
        }));
    }

    if (data.startsWith("audit_a4_")) {
      s = setSession(chatId, { category: "audit", serviceTitle: "Soliq xavfi diagnostikasi", answers: {}, ...s });
      s.answers.auditHistory = data.slice(9);
      const a = s.answers;
      const { pct, level, points } = computeAudit(a);

      s.auditSummary =
        `• Korxona: ${AUDIT_LABELS.biz[a.bizType] || "—"}\n` +
        `• Soliq rejimi: ${AUDIT_LABELS.tax[a.taxType] || "—"}\n` +
        `• Buxgalteriya: ${AUDIT_LABELS.acc[a.accountant] || "—"}\n` +
        `• Audit tarixi: ${AUDIT_LABELS.hist[a.auditHistory] || "—"}\n` +
        `• Taxminiy xavf: ${level} (${pct}%)`;
      s.step = "waiting_phone";
      setSession(chatId, s);

      await show(chatId, messageId,
`📊 <b>DIAGNOSTIKA NATIJASI:</b>

Soliq xatarlari ehtimoli: <b>${level} (${pct}%)</b>

<b>Asosiy omillar:</b>
${points.map((p, i) => `${i + 1}. ${esc(p)}`).join("\n")}

<i>Bu 4 ta savolga asoslangan taxminiy baho, rasmiy audit xulosasi emas.</i>

🎁 Bosh buxgalterimiz hisobotlaringizni bepul ko'rib chiqib, aniq tavsiyalar beradi.`);
      await askPhone(chatId, "📞 <b>Bepul ko'rib chiqish uchun:</b>",
        "Mutaxassisimiz siz bilan bog'lanib, xatarlarni kamaytirish rejasini taqdim etadi.");
      return;
    }

    // ---- Kalkulyator ----
    if (data === "calc_start") return void (await startCalc(chatId, messageId));

    if (data.startsWith("calc_b_")) {
      const type = data.slice(7);
      if (!PRICING.base[type]) return;
      s = setSession(chatId, { category: "calculator", serviceTitle: "Kalkulyator narx smetasi", ...s, step: "calc_s" });
      s.calc = { type };
      return void (await show(chatId, messageId,
        "🧮 <b>Tezkor xizmat kalkulyatori (2/3)</b>\n\nKorxonangizda nechta rasmiy xodim ishlaydi?",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "1 - 5 nafar", callback_data: "calc_s_5" }],
              [{ text: "6 - 15 nafar", callback_data: "calc_s_15" }],
              [{ text: "16 - 30 nafar", callback_data: "calc_s_30" }],
              [{ text: "30 nafardan ko'p", callback_data: "calc_s_50" }],
              navRow("calc_start"),
            ],
          },
        }));
    }

    if (data.startsWith("calc_s_")) {
      s = setSession(chatId, { category: "calculator", serviceTitle: "Kalkulyator narx smetasi", calc: { type: "mchj_aylanma" }, ...s, step: "calc_o" });
      s.calc.staff = Number(data.slice(7)) || 5;
      return void (await show(chatId, messageId,
        "🧮 <b>Tezkor xizmat kalkulyatori (3/3)</b>\n\nOyiga o'rtacha nechta elektron hisobvaraq-faktura (EHF) / hujjat aylanadi?",
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "30 tagacha", callback_data: "calc_o_30" }],
              [{ text: "100 tagacha", callback_data: "calc_o_100" }],
              [{ text: "250 tagacha", callback_data: "calc_o_250" }],
              [{ text: "500 va undan ko'p", callback_data: "calc_o_500" }],
              navRow(`calc_b_${s.calc.type}`),
            ],
          },
        }));
    }

    if (data.startsWith("calc_o_")) {
      s = setSession(chatId, { category: "calculator", serviceTitle: "Kalkulyator narx smetasi", calc: { type: "mchj_aylanma", staff: 5 }, ...s });
      const { type, staff } = s.calc;
      const ops = Number(data.slice(7)) || 30;
      const base = PRICING.base[type] || PRICING.base.mchj_aylanma;
      const staffCost = staff * PRICING.perStaff;
      const opsCost = ops * PRICING.perOp;
      const total = base + staffCost + opsCost;
      const typeName = PRICING.baseLabel[type] || type;

      s.calcSummary =
        `• Korxona turi: ${typeName}\n` +
        `• Xodimlar: ${staff} nafargacha\n` +
        `• Oylik EHF/hujjatlar: ${ops} tagacha\n` +
        `• Hisoblangan narx: ${fmtNum(total)} so'm / oy`;
      s.step = "waiting_phone";
      setSession(chatId, s);

      await show(chatId, messageId,
`📊 <b>HISOB-KITOB NATIJASI:</b>

💰 <b>Taxminan: ${fmtNum(total)} so'm / oy</b>

• Baza va 1C 8.3: ${fmtNum(base)} so'm
• Xodimlar xizmati: ${fmtNum(staffCost)} so'm
• EHF / hujjatlar: ${fmtNum(opsCost)} so'm

<b>Paketga kiradi:</b>
✅ Oylik va choraklik soliq hisobotlari
✅ 1C 8.3 da hisob yuritish
✅ EHF (Didox, Faktura) va bank-klient to'lovlari
✅ Kadrlar hisobi (my.mehnat.uz)

<i>* Narx taxminiy. Qo'shimcha modullar (audit, moliyachi, tashqi iqtisodiy faoliyat) kiritilmagan; yakuniy qiymat shartnomada kelishiladi.</i>`);
      await askPhone(chatId, "📞 <b>Ushbu hisob bo'yicha buyurtma berish uchun:</b>",
        "Telefon raqamingizni qoldiring, mutaxassisimiz siz bilan bog'lanadi.");
      return;
    }

    if (data === "services_list") return void (await showServices(chatId, messageId));
    if (data === "request_call") return void (await requestConsultation(chatId, messageId));
    if (data === "about_company") return void (await showAbout(chatId, messageId));
  } finally {
    await answer(); // har doim callback'ga javob beriladi (tugma "aylanib" qolmasligi uchun)
  }
}

// -----------------------------------------------------------------------------
// Owner paneli
// -----------------------------------------------------------------------------
async function showOwnerPanel(chatId, messageId = null) {
  const leads = loadLeads();
  const cnt = (f) => leads.filter(f).length;
  const newLeads = cnt((l) => l.status === "yangi");
  const text =
`👑 <b>HALOL HISOBCHI — BOSHQARUV PANELI</b>

🔒 <i>${esc(OWNER_NAME)}, bu ma'lumotlar faqat sizga ko'rinadi.</i>

📊 <b>Holat:</b>
• 🟡 Yangi arizalar: <b>${newLeads}</b>
• 🟢 Bog'lanilgan: <b>${cnt((l) => l.status === "boglanildi")}</b>
• 📁 Jami: <b>${leads.length}</b>

🌐 <b>Manbalar:</b>
• Sayt formasi: <b>${cnt((l) => l.category === "website")}</b>
• Soliq testi: <b>${cnt((l) => l.category === "audit")}</b>
• Kalkulyator: <b>${cnt((l) => l.category === "calculator")}</b>
• Konsultatsiya: <b>${cnt((l) => l.category === "consultation")}</b>`;

  await show(chatId, messageId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: `🟡 Yangi arizalar (${newLeads})`, callback_data: "owner_new_leads" },
          { text: "🗂 Barcha arizalar", callback_data: "owner_recent_leads" },
        ],
        [
          { text: "🔄 Yangilash", callback_data: "owner_panel" },
          { text: "⬅️ Asosiy menyu", callback_data: "menu_home" },
        ],
      ],
    },
  });
}

async function showLeads(chatId, messageId, filter) {
  let leads = loadLeads();
  if (filter === "new") leads = leads.filter((l) => l.status === "yangi");
  const list = leads.slice(-5).reverse();
  const back = [{ text: "⬅️ Boshqaruv paneli", callback_data: "owner_panel" }];

  if (!list.length) {
    return void (await show(chatId, messageId,
      filter === "new" ? "🎉 Yangi ko'rilmagan arizalar yo'q." : "📭 Bazada hozircha arizalar yo'q.",
      { reply_markup: { inline_keyboard: [back] } }));
  }

  let text = `🗂 <b>${filter === "new" ? "YANGI ARIZALAR" : "OXIRGI ARIZALAR"} (oxirgi ${list.length} ta):</b>\n\n`;
  const doneButtons = [];
  for (const l of list) {
    text += `<b>#${l.id} | ${l.status === "boglanildi" ? "🟢" : "🟡"} ${esc(l.name)}</b>\n`;
    text += `📞 <code>${esc(l.phone)}</code>\n💼 ${esc(l.service)}\n⏰ ${fmtDate(l.createdAt)}\n\n`;
    if (l.status === "yangi") doneButtons.push({ text: `✅ #${l.id}`, callback_data: `lead_done_${l.id}_l` });
  }
  const rows = [];
  for (let i = 0; i < doneButtons.length; i += 3) rows.push(doneButtons.slice(i, i + 3));
  rows.push(back);
  await show(chatId, messageId, text, { reply_markup: { inline_keyboard: rows } });
}

// -----------------------------------------------------------------------------
// Sayt uchun HTTP API
// -----------------------------------------------------------------------------
const ipHits = new Map(); // ip -> [vaqtlar]
function rateLimited(ip, max = 5, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  ipHits.set(ip, hits);
  return hits.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) if (!hits.some((t) => now - t < 10 * 60 * 1000)) ipHits.delete(ip);
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || "unknown";
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  const originOk = !origin || ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin);
  const cors = originOk && origin
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
    : {};

  if (req.method === "OPTIONS") {
    res.writeHead(originOk ? 204 : 403, cors);
    return res.end();
  }

  if (req.method === "GET") {
    if (req.url === "/health") {
      return sendJson(res, 200, { ok: true, service: "halol-hisobchi-bot" });
    }
    if (req.url === "/" || req.url === "/index.html") {
      const htmlPath = path.join(__dirname, "index.html");
      if (fs.existsSync(htmlPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(htmlPath));
      }
    }
    if (req.url === "/vizitka" || req.url === "/vizitka.html") {
      const vizitkaPath = path.join(__dirname, "vizitka.html");
      if (fs.existsSync(vizitkaPath)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(vizitkaPath));
      }
    }
  }

  if (req.method === "POST" && req.url === "/api/lead") {
    if (!originOk) return sendJson(res, 403, { ok: false, error: "Ruxsat yo'q" });
    if (rateLimited(clientIp(req))) {
      return sendJson(res, 429, { ok: false, error: "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring." }, cors);
    }

    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("error", () => { /* mijoz uzildi */ });
    req.on("end", async () => {
      if (tooBig) return;
      let data;
      try { data = JSON.parse(body); } catch (_) {
        return sendJson(res, 400, { ok: false, error: "Noto'g'ri so'rov" }, cors);
      }
      if (data && data.website) return sendJson(res, 200, { ok: true }, cors); // honeypot: botlarga indamay "ok"

      const name = clean(data.name, 80);
      const phone = normalizePhone(data.phone);
      if (name.length < 2) return sendJson(res, 422, { ok: false, error: "Ismingizni kiriting" }, cors);
      if (!phone) return sendJson(res, 422, { ok: false, error: "Telefon raqamini to'g'ri kiriting" }, cors);

      try {
        const { saved, notified } = await sendLeadToOwner({
          category: "website",
          name,
          phone: prettyPhone(phone),
          service: clean(data.service, 100) || "Buxgalteriya xizmati",
          details: clean(data.comment, 1000) || "Saytdagi aloqa formasidan ariza",
        });
        sendJson(res, 200, { ok: true, id: saved.id, notified }, cors);
      } catch (e) {
        console.error("[API] /api/lead:", e.message);
        sendJson(res, 500, { ok: false, error: "Serverda xatolik" }, cors);
      }
    });
    return;
  }

  res.writeHead(404, cors);
  res.end();
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[XATOLIK] ${PORT}-port band. Boshqa bot nusxasi ishlayotgan bo'lishi mumkin.`);
    process.exit(2);
  }
  throw e;
});

// -----------------------------------------------------------------------------
// Long polling
// -----------------------------------------------------------------------------
let running = true;

async function poll() {
  const me = await tg("getMe");
  if (!me || !me.ok) {
    console.error("[XATOLIK] Telegram bilan ulanib bo'lmadi yoki BOT_TOKEN noto'g'ri.");
    if (me && me.error_code === 401) process.exit(2);
  } else {
    console.log(`🤖 Bot: @${me.result.username}`);
  }
  await tg("deleteWebhook"); // webhook o'rnatilgan bo'lsa getUpdates ishlamaydi
  await setupBotCommands();

  let offset = 0;
  while (running) {
    const res = await tg("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 40000);
    if (!res || !res.ok) {
      if (res && res.error_code === 409) console.error("[XATOLIK] Bot boshqa joyda ham ishlayapti (409). Bittasini to'xtating.");
      await sleep(3000);
      continue;
    }
    for (const update of res.result) {
      offset = update.update_id + 1;
      try {
        if (update.message) await handleMessage(update.message);
        else if (update.callback_query) await handleCallback(update.callback_query);
      } catch (e) {
        console.error(`[UPDATE ${update.update_id}]`, e);
      }
    }
  }
}

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log("\nBot to'xtatilmoqda...");
    running = false;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("==================================================");
  console.log("🛡  HALOL HISOBCHI — LEAD & CRM BOT ISHGA TUSHDI");
  console.log(`🌐 API: http://localhost:${PORT}/api/lead`);
  console.log(`📁 Baza: ${path.basename(DB_FILE)}`);
  console.log("==================================================");
  poll();
});
