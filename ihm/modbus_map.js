// Table d'échange Modbus, lue depuis src/ventilation_modbus/modbus_map.py.
//
// Le fichier Python reste la seule source de vérité des adresses : au
// démarrage, on demande à Python d'exporter ses constantes en JSON plutôt que
// de les recopier ici (une adresse modifiée côté automate est donc reprise
// automatiquement par l'IHM).

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");

const EXPORT_SCRIPT = `
import json
from ventilation_modbus import modbus_map as m
print(json.dumps({k: v for k, v in vars(m).items() if k.isupper()}))
`;

function loadModbusMap() {
  let out;
  try {
    out = execFileSync("uv", ["run", "--project", PROJECT_ROOT, "python", "-c", EXPORT_SCRIPT], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      "Impossible de lire modbus_map.py via uv (uv est-il installe et 'uv sync' fait ?)\n" +
        (err.stderr || err.message)
    );
  }
  return JSON.parse(out);
}

const map = loadModbusMap();

// Équivalents JS de to_register / from_register (16 bits signé, complément à deux).
function toRegister(value) {
  const raw = Math.max(-0x8000, Math.min(0x7fff, Math.round(value * map.TEMPERATURE_SCALE)));
  return raw & 0xffff;
}

function fromRegister(raw) {
  return (raw >= 0x8000 ? raw - 0x10000 : raw) / map.TEMPERATURE_SCALE;
}

module.exports = { map, toRegister, fromRegister };
