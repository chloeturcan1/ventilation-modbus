// Serveur de l'IHM : passerelle entre le navigateur et l'automate Modbus TCP.
//
// - interroge l'automate toutes les POLL_MS et diffuse l'état aux pages ouvertes
//   (Server-Sent Events sur /events) ;
// - reçoit les commandes de la page (mode été/hiver, forçages) et les écrit
//   dans les coils / holding registers de l'automate ;
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

const client = new ModbusRTU();
let state = { connected: false };
const sseClients = new Set();

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
  const fanAddresses = [mm.DI_FAN_1, mm.DI_FAN_2, mm.DI_FAN_3, mm.DI_FAN_4];
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
    time: Date.now(),
  };
}

async function poll() {
  try {
    state = await modbus(readPlc);
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

function checkTemperature(value) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < T_MIN || value > T_MAX) {
    throw new Error(`temperature invalide (attendu un nombre entre ${T_MIN} et ${T_MAX}, ou null)`);
  }
  return value;
}

// --- HTTP ---------------------------------------------------------------------
function broadcast() {
  const msg = `data: ${JSON.stringify(state)}\n\n`;
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
      res.write(`data: ${JSON.stringify(state)}\n\n`);
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
