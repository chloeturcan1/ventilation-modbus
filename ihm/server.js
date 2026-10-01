// Serveur de l'IHM : passerelle entre le navigateur et l'automate Modbus TCP.
//
// - interroge l'automate toutes les POLL_MS et diffuse l'état aux pages ouvertes
//   (Server-Sent Events sur /events) ;
// - reçoit les commandes de la page (mode été/hiver, forçages, modes auto/manu,
//   arrêt d'urgence, acquittement, pannes simulées, réglages des seuils) et les
//   écrit dans les coils / holding registers de l'automate ;
// - gère l'accès opérateur / administrateur : la supervision est visible sans
//   connexion, mais chaque commande demande un niveau d'accès minimal ;
// - tient un journal horodaté des alarmes (apparition, disparition, acquittement)
//   et des actions des utilisateurs, exportable en rapport PDF ;
// - envoie un mail d'alerte aux adresses enregistrées à chaque arrêt d'urgence ;
// - sert la page web (public/index.html).
//
// Toutes les requêtes Modbus passent par une file unique : le client
// modbus-serial ne doit traiter qu'une transaction à la fois.

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ModbusRTU = require("modbus-serial");
const { map: mm, toRegister, fromRegister } = require("./modbus_map");
const { writeReport } = require("./report");
const alerts = require("./alerts");

const PLC_HOST = process.env.PLC_HOST || "127.0.0.1";
const PLC_PORT = Number(process.env.PLC_PORT || mm.PORT);
const HTTP_HOST = process.env.IHM_HOST || "127.0.0.1"; // pas de HTTPS : local uniquement
const HTTP_PORT = Number(process.env.IHM_PORT || 3000);
const POLL_MS = 500;
const RECONNECT_MS = 2000;
const T_MIN = -50;
const T_MAX = 100;
const JOURNAL_SIZE = 500;
const SESSION_MS = 8 * 3600 * 1000; // une session dure le temps d'un poste de travail

// Comptes de l'IHM. Mots de passe par défaut à changer via les variables
// d'environnement IHM_OPERATOR_PASSWORD et IHM_ADMIN_PASSWORD.
const USERS = {
  operateur: { role: "operator", password: process.env.IHM_OPERATOR_PASSWORD || "operateur" },
  admin: { role: "admin", password: process.env.IHM_ADMIN_PASSWORD || "admin" },
};
const ROLE_LEVELS = { operator: 1, admin: 2 };

// Valeurs des registres de mode, et leur nom côté page.
const FAN_MODES = { auto: mm.FAN_MODE_AUTO, on: mm.FAN_MODE_MANUAL_ON, off: mm.FAN_MODE_MANUAL_OFF };
const FAN_MODE_NAMES = Object.fromEntries(Object.entries(FAN_MODES).map(([k, v]) => [v, k]));
const FAN_MODE_REGISTERS = [mm.HR_FAN_MODE_1, mm.HR_FAN_MODE_2, mm.HR_FAN_MODE_3, mm.HR_FAN_MODE_4];
const FAN_FAULT_COILS = [mm.COIL_FAN_FAULT_1, mm.COIL_FAN_FAULT_2, mm.COIL_FAN_FAULT_3, mm.COIL_FAN_FAULT_4];

// Réglages : registre, libellé du journal, et lecture / écriture dans l'objet
// échangé avec la page { summer: [v1, v2, v3], winter: [...], winter_intake, hysteresis, t_int_high }.
const SETTINGS = [
  ...[1, 2, 3].map((n) => ({ address: mm[`HR_SUMMER_THRESHOLD_${n}`], label: `Seuil V${n} été`, get: (s) => s.summer[n - 1] })),
  ...[1, 2, 3].map((n) => ({ address: mm[`HR_WINTER_THRESHOLD_${n}`], label: `Seuil V${n} hiver`, get: (s) => s.winter[n - 1] })),
  { address: mm.HR_WINTER_INTAKE_THRESHOLD, label: "Seuil insufflation V4 hiver", get: (s) => s.winter_intake },
  { address: mm.HR_HYSTERESIS, label: "Hystérésis", get: (s) => s.hysteresis },
  { address: mm.HR_T_INT_HIGH_ALARM, label: "Seuil alarme haute", get: (s) => s.t_int_high },
];

const client = new ModbusRTU();
let state = { connected: false };
const sseClients = new Set();
const journal = []; // du plus récent au plus ancien
const startedAt = Date.now();
const sessions = new Map(); // jeton -> { name, role, expires }
let lastAlarms = null; // alarmes lues au dernier cycle, pour détecter les changements
let lastEmergencyPress = null; // { user, time } : dernier AU enfoncé depuis l'IHM

// --- File d'attente Modbus ----------------------------------------------------
let queue = Promise.resolve();
function modbus(fn) {
  const job = queue.then(fn);
  queue = job.catch(() => {});
  return job;
}

// --- Connexion / interrogation de l'automate --------------------------------------
async function connect() {
  try {
    await client.connectTCP(PLC_HOST, { port: PLC_PORT });
    client.setID(mm.DEVICE_ID);
    client.setTimeout(1000);
    console.log(`Connecte a l'automate ${PLC_HOST}:${PLC_PORT}`);
    poll();
  } catch (err) {
    setDisconnected(err);
    setTimeout(connect, RECONNECT_MS);
  }
}

function setDisconnected(err) {
  if (state.connected !== false || !state.error) {
    console.log(`Automate injoignable (${err.message}), nouvelle tentative...`);
  }
  state = { connected: false, error: err.message };
  broadcast();
}

async function readPlc() {
  const ir = await client.readInputRegisters(mm.IR_SENSORS_START, mm.IR_SENSORS_COUNT);
  const di = await client.readDiscreteInputs(mm.DI_FANS_START, mm.DI_FANS_COUNT);
  const co = await client.readCoils(mm.COILS_START, mm.COILS_COUNT);
  const hr = await client.readHoldingRegisters(mm.HR_FORCED_START, mm.HR_FORCED_COUNT);
  const modes = await client.readHoldingRegisters(mm.HR_FAN_MODES_START, mm.HR_FAN_MODES_COUNT);
  const al = await client.readInputRegisters(mm.IR_ALARMS_START, mm.IR_ALARMS_COUNT);
  const set = await client.readHoldingRegisters(mm.HR_SETTINGS_START, mm.HR_SETTINGS_COUNT);
  const setting = (address) => fromRegister(set.data[address - mm.HR_SETTINGS_START]);
  const fanAddresses = [mm.DI_FAN_1, mm.DI_FAN_2, mm.DI_FAN_3, mm.DI_FAN_4];
  const active = al.data[mm.IR_ALARMS_ACTIVE - mm.IR_ALARMS_START];
  const latched = al.data[mm.IR_ALARMS_LATCHED - mm.IR_ALARMS_START];
  return {
    connected: true,
    t_int: fromRegister(ir.data[mm.IR_T_INT - mm.IR_SENSORS_START]),
    t_ext: fromRegister(ir.data[mm.IR_T_EXT - mm.IR_SENSORS_START]),
    fans: fanAddresses.map((a) => di.data[a - mm.DI_FANS_START]),
    summer: co.data[mm.COIL_SUMMER_MODE - mm.COILS_START],
    force_int: co.data[mm.COIL_FORCE_T_INT - mm.COILS_START],
    force_ext: co.data[mm.COIL_FORCE_T_EXT - mm.COILS_START],
    forced_int: fromRegister(hr.data[mm.HR_T_INT_FORCED - mm.HR_FORCED_START]),
    forced_ext: fromRegister(hr.data[mm.HR_T_EXT_FORCED - mm.HR_FORCED_START]),
    fan_modes: FAN_MODE_REGISTERS.map((a) => FAN_MODE_NAMES[modes.data[a - mm.HR_FAN_MODES_START]] || "auto"),
    emergency_stop: co.data[mm.COIL_EMERGENCY_STOP - mm.COILS_START],
    fan_faults: FAN_FAULT_COILS.map((a) => co.data[a - mm.COILS_START]),
    // Verrouillages de sécurité, déduits des alarmes mémorisées.
    emergency_lock: Boolean(latched & (1 << mm.ALARM_EMERGENCY_STOP)),
    fan_defects: [mm.ALARM_FAN_1, mm.ALARM_FAN_2, mm.ALARM_FAN_3, mm.ALARM_FAN_4].map((bit) => Boolean(latched & (1 << bit))),
    settings: {
      summer: [mm.HR_SUMMER_THRESHOLD_1, mm.HR_SUMMER_THRESHOLD_2, mm.HR_SUMMER_THRESHOLD_3].map(setting),
      winter: [mm.HR_WINTER_THRESHOLD_1, mm.HR_WINTER_THRESHOLD_2, mm.HR_WINTER_THRESHOLD_3].map(setting),
      winter_intake: setting(mm.HR_WINTER_INTAKE_THRESHOLD),
      hysteresis: setting(mm.HR_HYSTERESIS),
      t_int_high: setting(mm.HR_T_INT_HIGH_ALARM),
    },
    alarms: mm.ALARM_LABELS.map((label, bit) => ({
      label,
      active: Boolean(active & (1 << bit)),
      latched: Boolean(latched & (1 << bit)),
    })),
    time: Date.now(),
  };
}

// Compare les alarmes avec celles du cycle précédent et alimente le journal.
function updateJournal(alarms, time) {
  if (lastAlarms) {
    alarms.forEach((a, i) => {
      const before = lastAlarms[i];
      const events = [];
      // Une cause brève (ex. défaut de rotation, coupé dès le cycle suivant) peut
      // passer entre deux lectures : sa mémorisation compte aussi comme apparition.
      // À l'inverse, disparition et acquittement peuvent tomber entre deux lectures.
      if ((a.active && !before.active) || (a.latched && !before.latched)) events.push("apparition");
      else {
        if (!a.active && before.active) events.push("disparition");
        if (!a.latched && before.latched) events.push("acquittement");
      }
      for (const event of events) addJournal({ time, label: a.label, event });
      if (events.includes("apparition") && i === mm.ALARM_EMERGENCY_STOP) sendEmergencyMail(time);
    });
  } else {
    // Première lecture : on note les alarmes déjà présentes.
    alarms.forEach((a) => {
      if (a.active || a.latched) addJournal({ time, label: a.label, event: "présente au démarrage" });
    });
  }
  lastAlarms = alarms;
}

function addJournal(entry) {
  journal.unshift(entry);
  journal.length = Math.min(journal.length, JOURNAL_SIZE);
}

// --- Mail d'alerte sur arrêt d'urgence -------------------------------------------
// Déclenché par l'apparition de l'alarme, et non par le bouton de la page : un
// arrêt d'urgence venant d'ailleurs (client Modbus, bouton physique) est aussi signalé.
const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "medium" });

function emergencyMailText(time) {
  const press = lastEmergencyPress && time - lastEmergencyPress.time < 5000 ? lastEmergencyPress : null;
  const origin = press
    ? `depuis l'IHM (utilisateur : ${press.user})`
    : "hors de l'IHM (commande Modbus directe ou bouton externe)";
  const lines = [
    "ALERTE : l'arrêt d'urgence de la ventilation a été déclenché.",
    "",
    `Date : ${dateTime.format(time)}`,
    `Origine : ${origin}`,
  ];
  if (state.connected) {
    lines.push(
      `Mode : ${state.summer ? "été" : "hiver"}`,
      `Température intérieure : ${state.t_int.toFixed(1)} °C`,
      `Température extérieure : ${state.t_ext.toFixed(1)} °C`
    );
  }
  lines.push(
    "",
    "Tous les ventilateurs sont arrêtés. Ils ne redémarreront qu'après le",
    "relâchement du bouton et un acquittement depuis l'IHM de supervision.",
    "",
    "-- Message automatique de l'IHM Ventilation Modbus"
  );
  return lines.join("\n");
}

async function sendEmergencyMail(time) {
  try {
    const n = await alerts.sendToAll("[ALERTE] Arrêt d'urgence - Ventilation", emergencyMailText(time));
    addJournal({ time: Date.now(), label: `Mail d'alerte envoyé à ${n} destinataire(s)`, event: "mail" });
  } catch (err) {
    addJournal({ time: Date.now(), label: `Mail d'alerte non envoyé : ${err.message}`, event: "mail" });
  }
  broadcast();
}

// Trace une action d'un utilisateur dans le journal.
function logAction(user, label) {
  addJournal({ time: Date.now(), label, event: "action", user: user ? user.name : "non connecté" });
  broadcast();
}

async function poll() {
  try {
    state = await modbus(readPlc);
    updateJournal(state.alarms, state.time);
    broadcast();
    setTimeout(poll, POLL_MS);
  } catch (err) {
    client.close(() => {});
    setDisconnected(err);
    setTimeout(connect, RECONNECT_MS);
  }
}

// --- Commandes venant de la page ----------------------------------------------
async function setMode(summer) {
  await modbus(() => client.writeCoil(mm.COIL_SUMMER_MODE, summer));
}

// value = nombre -> forçage actif à cette valeur ; value = null -> forçage relâché
async function setForce(coil, register, value) {
  await modbus(async () => {
    if (value !== null) await client.writeRegister(register, toRegister(value));
    await client.writeCoil(coil, value !== null);
  });
}

async function setFanMode(fan, mode) {
  await modbus(() => client.writeRegister(FAN_MODE_REGISTERS[fan - 1], FAN_MODES[mode]));
}

async function setCoil(coil, value) {
  await modbus(() => client.writeCoil(coil, value));
}

// Tous les réglages en une seule écriture (FC16) : l'automate vérifie l'ensemble.
async function setSettings(settings) {
  const values = new Array(mm.HR_SETTINGS_COUNT).fill(0);
  for (const s of SETTINGS) values[s.address - mm.HR_SETTINGS_START] = toRegister(s.get(settings));
  await modbus(() => client.writeRegisters(mm.HR_SETTINGS_START, values));
}

function checkFan(fan) {
  if (![1, 2, 3, 4].includes(fan)) throw new Error("'fan' doit valoir 1, 2, 3 ou 4");
  return fan;
}

function checkBoolean(value, name) {
  if (typeof value !== "boolean") throw new Error(`'${name}' doit etre true ou false`);
  return value;
}

function checkTemperature(value) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < T_MIN || value > T_MAX) {
    throw new Error(`temperature invalide (attendu un nombre entre ${T_MIN} et ${T_MAX}, ou null)`);
  }
  return value;
}

// Mêmes règles que Settings.errors() dans automate.py : on les vérifie ici pour
// répondre un message clair, l'automate refusant de toute façon un réglage incohérent.
function checkSettings(body) {
  const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
  const inRange = (v, min, max) => isNumber(v) && v >= min && v <= max;
  const s = {
    summer: body.summer,
    winter: body.winter,
    winter_intake: body.winter_intake,
    hysteresis: body.hysteresis,
    t_int_high: body.t_int_high,
  };
  for (const season of ["summer", "winter"]) {
    const name = season === "summer" ? "été" : "hiver";
    const v = s[season];
    if (!Array.isArray(v) || v.length !== 3 || !v.every((t) => inRange(t, mm.SETPOINT_MIN, mm.SETPOINT_MAX))) {
      throw new Error(`seuils ${name} : 3 valeurs entre ${mm.SETPOINT_MIN} et ${mm.SETPOINT_MAX} °C attendues`);
    }
    if (!(v[0] <= v[1] && v[1] <= v[2])) throw new Error(`seuils ${name} : il faut V1 ≤ V2 ≤ V3`);
  }
  for (const [key, name] of [["winter_intake", "seuil insufflation V4 hiver"], ["t_int_high", "seuil alarme haute"]]) {
    if (!inRange(s[key], mm.SETPOINT_MIN, mm.SETPOINT_MAX)) {
      throw new Error(`${name} : valeur entre ${mm.SETPOINT_MIN} et ${mm.SETPOINT_MAX} °C attendue`);
    }
  }
  if (!inRange(s.hysteresis, mm.HYSTERESIS_MIN, mm.HYSTERESIS_MAX)) {
    throw new Error(`hystérésis : valeur entre ${mm.HYSTERESIS_MIN} et ${mm.HYSTERESIS_MAX} °C attendue`);
  }
  // Arrondi au dixième, la précision des registres.
  const round = (v) => Math.round(v * mm.TEMPERATURE_SCALE) / mm.TEMPERATURE_SCALE;
  return {
    summer: s.summer.map(round),
    winter: s.winter.map(round),
    winter_intake: round(s.winter_intake),
    hysteresis: round(s.hysteresis),
    t_int_high: round(s.t_int_high),
  };
}

// --- Accès opérateur / administrateur -----------------------------------------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Comparaison en temps constant, pour ne rien révéler du mot de passe.
function samePassword(a, b) {
  const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function readCookie(req, name) {
  const cookies = (req.headers.cookie || "").split(";").map((c) => c.trim().split("="));
  const found = cookies.find(([k]) => k === name);
  return found ? decodeURIComponent(found[1] || "") : null;
}

function currentUser(req) {
  const token = readCookie(req, "ihm_session");
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

// Renvoie l'utilisateur connecté s'il a au moins le niveau demandé.
function requireRole(req, role) {
  const user = currentUser(req);
  if (!user) throw new HttpError(401, "connexion requise");
  if (ROLE_LEVELS[user.role] < ROLE_LEVELS[role]) {
    throw new HttpError(403, role === "admin" ? "commande réservée à l'administrateur" : "accès insuffisant");
  }
  return user;
}

function login(res, username, password) {
  const account = Object.hasOwn(USERS, username) ? USERS[username] : null;
  // On compare même si le compte n'existe pas, pour ne pas révéler les identifiants valides.
  const ok = samePassword(password, account ? account.password : crypto.randomUUID()) && account;
  if (!ok) throw new HttpError(401, "identifiant ou mot de passe incorrect");
  const token = crypto.randomBytes(32).toString("hex");
  const user = { name: username, role: account.role, expires: Date.now() + SESSION_MS };
  sessions.set(token, user);
  res.setHeader("Set-Cookie", `ihm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
  return user;
}

function logout(req, res) {
  const token = readCookie(req, "ihm_session");
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "ihm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

const sessionInfo = (user) => (user ? { name: user.name, role: user.role } : null);

const FAN_MODE_LABELS = { auto: "auto", on: "manuel marche", off: "manuel arrêt" };
const describeForce = (name, value) => (value === null ? `Forçage ${name} relâché` : `Forçage ${name} à ${value.toFixed(1)} °C`);

// --- HTTP ---------------------------------------------------------------------
function snapshot() {
  return JSON.stringify({ ...state, journal });
}

function broadcast() {
  const msg = `data: ${snapshot()}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) reject(new Error("requete trop grande"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("JSON invalide"));
      }
    });
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

const INDEX_HTML = path.join(__dirname, "public", "index.html");

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(INDEX_HTML).pipe(res);
    } else if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${snapshot()}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
    } else if (req.method === "GET" && req.url === "/api/session") {
      sendJson(res, 200, { ok: true, user: sessionInfo(currentUser(req)) });
    } else if (req.method === "POST" && req.url === "/api/login") {
      const { username, password } = await readJson(req);
      const user = login(res, String(username || ""), String(password || ""));
      logAction(user, "Connexion");
      sendJson(res, 200, { ok: true, user: sessionInfo(user) });
    } else if (req.method === "POST" && req.url === "/api/logout") {
      const user = currentUser(req);
      logout(req, res);
      if (user) logAction(user, "Déconnexion");
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/mode") {
      const user = requireRole(req, "operator");
      const { summer } = await readJson(req);
      if (typeof summer !== "boolean") throw new Error("'summer' doit etre true ou false");
      await setMode(summer);
      logAction(user, summer ? "Passage en mode été" : "Passage en mode hiver");
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/force") {
      const user = requireRole(req, "admin");
      const body = await readJson(req);
      if ("t_int" in body) {
        const value = checkTemperature(body.t_int);
        await setForce(mm.COIL_FORCE_T_INT, mm.HR_T_INT_FORCED, value);
        logAction(user, describeForce("T_int", value));
      }
      if ("t_ext" in body) {
        const value = checkTemperature(body.t_ext);
        await setForce(mm.COIL_FORCE_T_EXT, mm.HR_T_EXT_FORCED, value);
        logAction(user, describeForce("T_ext", value));
      }
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/fan-mode") {
      const user = requireRole(req, "operator");
      const { fan, mode } = await readJson(req);
      if (!(mode in FAN_MODES)) throw new Error("'mode' doit valoir auto, on ou off");
      await setFanMode(checkFan(fan), mode);
      logAction(user, `V${fan} en mode ${FAN_MODE_LABELS[mode]}`);
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/emergency-stop") {
      // Accessible sans connexion : un arrêt d'urgence ne doit jamais être bloqué.
      // Le relâcher ne relance rien : le réarmement passe par l'acquittement.
      const { pressed } = await readJson(req);
      await setCoil(mm.COIL_EMERGENCY_STOP, checkBoolean(pressed, "pressed"));
      const user = currentUser(req);
      if (pressed) lastEmergencyPress = { user: user ? user.name : "non connecté", time: Date.now() };
      logAction(user, pressed ? "Arrêt d'urgence enfoncé" : "Arrêt d'urgence relâché");
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/ack") {
      const user = requireRole(req, "operator");
      await setCoil(mm.COIL_ACK, true); // impulsion remise à false par l'automate
      logAction(user, "Acquittement demandé");
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/fan-fault") {
      const user = requireRole(req, "admin");
      const { fan, fault } = await readJson(req);
      await setCoil(FAN_FAULT_COILS[checkFan(fan) - 1], checkBoolean(fault, "fault"));
      logAction(user, `Panne simulée V${fan} ${fault ? "activée" : "retirée"}`);
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/settings") {
      const user = requireRole(req, "admin");
      if (!state.connected) throw new Error("automate injoignable");
      const settings = checkSettings(await readJson(req));
      const before = state.settings;
      await setSettings(settings);
      for (const s of SETTINGS) {
        if (s.get(settings) !== s.get(before)) {
          logAction(user, `${s.label} : de ${s.get(before).toFixed(1)} à ${s.get(settings).toFixed(1)} °C`);
        }
      }
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/settings/defaults") {
      const user = requireRole(req, "admin");
      if (!state.connected) throw new Error("automate injoignable");
      // L'automate connaît seul les valeurs par défaut : on lui envoie la commande.
      await setCoil(mm.COIL_RESTORE_DEFAULTS, true); // impulsion remise à false par l'automate
      logAction(user, "Retour aux réglages par défaut");
      sendJson(res, 200, { ok: true });
    } else if (req.method === "GET" && req.url === "/api/alert-emails") {
      requireRole(req, "admin"); // adresses personnelles : visibles par l'admin seulement
      sendJson(res, 200, { ok: true, emails: alerts.getEmails(), account: alerts.accountStatus() });
    } else if (req.method === "POST" && req.url === "/api/alert-emails") {
      const user = requireRole(req, "admin");
      const email = alerts.addEmail((await readJson(req)).email);
      logAction(user, `Destinataire d'alerte ajouté : ${email}`);
      sendJson(res, 200, { ok: true, emails: alerts.getEmails() });
    } else if (req.method === "POST" && req.url === "/api/alert-emails/delete") {
      const user = requireRole(req, "admin");
      const email = alerts.removeEmail((await readJson(req)).email);
      logAction(user, `Destinataire d'alerte retiré : ${email}`);
      sendJson(res, 200, { ok: true, emails: alerts.getEmails() });
    } else if (req.method === "POST" && req.url === "/api/mail-account") {
      const user = requireRole(req, "admin");
      const result = await alerts.setAccount(await readJson(req));
      logAction(user, `Compte d'envoi des alertes : ${result.user}`);
      sendJson(res, 200, { ok: true, account: alerts.accountStatus() });
    } else if (req.method === "POST" && req.url === "/api/mail-account/delete") {
      const user = requireRole(req, "admin");
      alerts.clearAccount();
      logAction(user, "Compte d'envoi des alertes supprimé");
      sendJson(res, 200, { ok: true, account: alerts.accountStatus() });
    } else if (req.method === "POST" && req.url === "/api/alert-emails/test") {
      const user = requireRole(req, "admin");
      const n = await alerts.sendToAll(
        "[TEST] Alerte Ventilation",
        `Mail de test envoyé depuis l'IHM par ${user.name}.\n\n` +
          "Ces adresses recevront un mail d'alerte à chaque arrêt d'urgence.\n\n" +
          "-- Message automatique de l'IHM Ventilation Modbus"
      );
      logAction(user, `Mail de test envoyé à ${n} destinataire(s)`);
      sendJson(res, 200, { ok: true, sent: n });
    } else if (req.method === "GET" && req.url === "/api/report.pdf") {
      const user = requireRole(req, "operator");
      const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "h");
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="rapport-alarmes_${stamp}.pdf"`,
      });
      writeReport(res, { state, journal, startedAt, user, journalSize: JOURNAL_SIZE });
    } else {
      sendJson(res, 404, { ok: false, error: "introuvable" });
    }
  } catch (err) {
    sendJson(res, err.status || 400, { ok: false, error: err.message });
  }
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`IHM disponible sur http://localhost:${HTTP_PORT} (Ctrl+C pour arreter)`);
  connect();
});
