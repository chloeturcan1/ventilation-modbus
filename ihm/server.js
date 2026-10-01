// Serveur de l'IHM : passerelle entre le navigateur et l'automate Modbus TCP.
//
// - interroge l'automate toutes les POLL_MS et diffuse l'état aux pages ouvertes
//   (Server-Sent Events sur /events) ;
// - reçoit les commandes de la page (mode été/hiver, forçages, modes auto/manu,
//   arrêt d'urgence, acquittement, pannes simulées) et les écrit dans les
//   coils / holding registers de l'automate ;
// - tient un journal horodaté des alarmes (apparition, disparition, acquittement) ;
// - sert la page web (public/index.html).
//
// Toutes les requêtes Modbus passent par une file unique : le client
// modbus-serial ne doit traiter qu'une transaction à la fois.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const ModbusRTU = require("modbus-serial");
const { map: mm, toRegister, fromRegister } = require("./modbus_map");

const PLC_HOST = process.env.PLC_HOST || "127.0.0.1";
const HTTP_HOST = process.env.IHM_HOST || "127.0.0.1"; // pas d'authentification : local uniquement
const HTTP_PORT = Number(process.env.IHM_PORT || 3000);
const POLL_MS = 500;
const RECONNECT_MS = 2000;
const T_MIN = -50;
const T_MAX = 100;
const JOURNAL_SIZE = 50;

// Valeurs des registres de mode, et leur nom côté page.
const FAN_MODES = { auto: mm.FAN_MODE_AUTO, on: mm.FAN_MODE_MANUAL_ON, off: mm.FAN_MODE_MANUAL_OFF };
const FAN_MODE_NAMES = Object.fromEntries(Object.entries(FAN_MODES).map(([k, v]) => [v, k]));
const FAN_MODE_REGISTERS = [mm.HR_FAN_MODE_1, mm.HR_FAN_MODE_2, mm.HR_FAN_MODE_3, mm.HR_FAN_MODE_4];
const FAN_FAULT_COILS = [mm.COIL_FAN_FAULT_1, mm.COIL_FAN_FAULT_2, mm.COIL_FAN_FAULT_3, mm.COIL_FAN_FAULT_4];

const client = new ModbusRTU();
let state = { connected: false };
const sseClients = new Set();
const journal = []; // du plus récent au plus ancien
let lastAlarms = null; // alarmes lues au dernier cycle, pour détecter les changements

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
    await client.connectTCP(PLC_HOST, { port: mm.PORT });
    client.setID(mm.DEVICE_ID);
    client.setTimeout(1000);
    console.log(`Connecte a l'automate ${PLC_HOST}:${mm.PORT}`);
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
      let event = null;
      // Une cause brève (ex. défaut de rotation, coupé dès le cycle suivant) peut
      // passer entre deux lectures : sa mémorisation compte aussi comme apparition.
      if ((a.active && !before.active) || (a.latched && !before.latched)) event = "apparition";
      else if (!a.active && before.active) event = "disparition";
      else if (!a.latched && before.latched) event = "acquittement";
      if (event) journal.unshift({ time, label: a.label, event });
    });
    journal.length = Math.min(journal.length, JOURNAL_SIZE);
  } else {
    // Première lecture : on note les alarmes déjà présentes.
    alarms.forEach((a) => {
      if (a.active || a.latched) journal.unshift({ time, label: a.label, event: "présente au démarrage" });
    });
  }
  lastAlarms = alarms;
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
    } else if (req.method === "POST" && req.url === "/api/mode") {
      const { summer } = await readJson(req);
      if (typeof summer !== "boolean") throw new Error("'summer' doit etre true ou false");
      await setMode(summer);
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/force") {
      const body = await readJson(req);
      if ("t_int" in body) {
        await setForce(mm.COIL_FORCE_T_INT, mm.HR_T_INT_FORCED, checkTemperature(body.t_int));
      }
      if ("t_ext" in body) {
        await setForce(mm.COIL_FORCE_T_EXT, mm.HR_T_EXT_FORCED, checkTemperature(body.t_ext));
      }
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/fan-mode") {
      const { fan, mode } = await readJson(req);
      if (!(mode in FAN_MODES)) throw new Error("'mode' doit valoir auto, on ou off");
      await setFanMode(checkFan(fan), mode);
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/emergency-stop") {
      const { pressed } = await readJson(req);
      await setCoil(mm.COIL_EMERGENCY_STOP, checkBoolean(pressed, "pressed"));
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/ack") {
      await setCoil(mm.COIL_ACK, true); // impulsion remise à false par l'automate
      sendJson(res, 200, { ok: true });
    } else if (req.method === "POST" && req.url === "/api/fan-fault") {
      const { fan, fault } = await readJson(req);
      await setCoil(FAN_FAULT_COILS[checkFan(fan) - 1], checkBoolean(fault, "fault"));
      sendJson(res, 200, { ok: true });
    } else {
      sendJson(res, 404, { ok: false, error: "introuvable" });
    }
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
  }
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`IHM disponible sur http://localhost:${HTTP_PORT} (Ctrl+C pour arreter)`);
  connect();
});
