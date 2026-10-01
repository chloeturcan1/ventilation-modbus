"""Table d'échange Modbus de l'automate de ventilation.

Seule source de vérité pour les adresses et les facteurs d'échelle : le serveur
(server.py), le client (client.py) et la future IHM importent ce module, aucune
adresse Modbus ne doit être écrite en dur ailleurs.

Les températures sont transmises en dixièmes de degré, codées en entier signé
16 bits (complément à deux) pour supporter les températures négatives
(ex. 23.4 °C -> 234, -5.0 °C -> 65486).
"""

# --- Liaison -----------------------------------------------------------------
PORT = 502
DEVICE_ID = 1  # Unit id / slave id de l'automate

# --- Codes fonction utilisés pour l'accès direct au datastore du serveur ------
FC_COILS = 1  # Read Coils (même espace que Write Coil(s), FC5/FC15)
FC_DISCRETE_INPUTS = 2  # Read Discrete Inputs
FC_HOLDING_REGISTERS = 3  # Read Holding Registers (même espace que FC6/FC16)
FC_INPUT_REGISTERS = 4  # Read Input Registers

# --- Coils (lecture/écriture, commandes de l'IHM) -----------------------------
COIL_SUMMER_MODE = 0  # True = mode été (logique ventilateurs active), False = hiver (tout coupé)
COIL_FORCE_T_INT = 1  # True = la température intérieure est forcée à HR_T_INT_FORCED
COIL_FORCE_T_EXT = 2  # True = la température extérieure est forcée à HR_T_EXT_FORCED
COILS_START = COIL_SUMMER_MODE
COILS_COUNT = 3

# --- Holding registers (lecture/écriture, valeurs de forçage) -----------------
HR_T_INT_FORCED = 0  # °C x TEMPERATURE_SCALE, signé
HR_T_EXT_FORCED = 1  # °C x TEMPERATURE_SCALE, signé
HR_FORCED_START = HR_T_INT_FORCED
HR_FORCED_COUNT = 2

# --- Discrete inputs (lecture seule, état des ventilateurs) -------------------
# Contigus pour être lus en une seule requête FC2.
DI_FAN_1 = 0  # Soufflage, seuil 23 °C
DI_FAN_2 = 1  # Soufflage, seuil 24 °C
DI_FAN_3 = 2  # Soufflage, seuil 25 °C
DI_FAN_4 = 3  # Monté à l'envers (extraction) : T_int > T_ext
DI_FANS_START = DI_FAN_1
DI_FANS_COUNT = 4

# --- Input registers (lecture seule, capteurs) --------------------------------
# Contigus pour être lus en une seule requête FC4.
IR_T_INT = 0  # Température intérieure, °C x TEMPERATURE_SCALE, signé
IR_T_EXT = 1  # Température extérieure, °C x TEMPERATURE_SCALE, signé
IR_SENSORS_START = IR_T_INT
IR_SENSORS_COUNT = 2

TEMPERATURE_SCALE = 10


def to_register(value: float, scale: int = TEMPERATURE_SCALE) -> int:
    """Convertit une grandeur physique en registre 16 bits signé (complément à deux)."""
    raw = max(-0x8000, min(0x7FFF, round(value * scale)))
    return raw & 0xFFFF


def from_register(raw: int, scale: int = TEMPERATURE_SCALE) -> float:
    """Convertit un registre 16 bits signé (complément à deux) en grandeur physique."""
    if raw >= 0x8000:
        raw -= 0x10000
    return raw / scale
