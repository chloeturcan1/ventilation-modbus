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
COIL_SUMMER_MODE = 0  # True = mode été, False = mode hiver (seuils plus hauts, boucle de chauffage)
COIL_FORCE_T_INT = 1  # True = la température intérieure est forcée à HR_T_INT_FORCED
COIL_FORCE_T_EXT = 2  # True = la température extérieure est forcée à HR_T_EXT_FORCED
COIL_EMERGENCY_STOP = 3  # True = bouton d'arrêt d'urgence enfoncé : arrêt de tous les ventilateurs
COIL_ACK = 4  # Impulsion d'acquittement : le client écrit True, l'automate la remet à False
COIL_FAN_FAULT_1 = 5  # Simulation (tests) : panne moteur de V1, il ne tourne plus même commandé
COIL_FAN_FAULT_2 = 6
COIL_FAN_FAULT_3 = 7
COIL_FAN_FAULT_4 = 8
COILS_START = COIL_SUMMER_MODE
COILS_COUNT = 9

# --- Holding registers (lecture/écriture, valeurs de forçage) -----------------
HR_T_INT_FORCED = 0  # °C x TEMPERATURE_SCALE, signé
HR_T_EXT_FORCED = 1  # °C x TEMPERATURE_SCALE, signé
HR_FORCED_START = HR_T_INT_FORCED
HR_FORCED_COUNT = 2

# --- Holding registers (lecture/écriture, mode de conduite des ventilateurs) --
HR_FAN_MODE_1 = 2  # FAN_MODE_AUTO / FAN_MODE_MANUAL_ON / FAN_MODE_MANUAL_OFF
HR_FAN_MODE_2 = 3
HR_FAN_MODE_3 = 4
HR_FAN_MODE_4 = 5
HR_FAN_MODES_START = HR_FAN_MODE_1
HR_FAN_MODES_COUNT = 4

FAN_MODE_AUTO = 0  # piloté par la logique de l'automate
FAN_MODE_MANUAL_ON = 1  # marche forcée par l'opérateur
FAN_MODE_MANUAL_OFF = 2  # arrêt forcé par l'opérateur

# --- Discrete inputs (lecture seule, retour de marche des ventilateurs) -------
# Contigus pour être lus en une seule requête FC2.
DI_FAN_1 = 0  # Soufflage, seuil 23 °C été / 26 °C hiver
DI_FAN_2 = 1  # Soufflage, seuil 24 °C été / 27 °C hiver
DI_FAN_3 = 2  # Soufflage, seuil 25 °C été / 28 °C hiver
DI_FAN_4 = 3  # Monté à l'envers (extraction) : T_int > T_ext (et T_int > 28 °C en hiver)
DI_FANS_START = DI_FAN_1
DI_FANS_COUNT = 4

# --- Input registers (lecture seule, capteurs) --------------------------------
# Contigus pour être lus en une seule requête FC4.
IR_T_INT = 0  # Température intérieure, °C x TEMPERATURE_SCALE, signé
IR_T_EXT = 1  # Température extérieure, °C x TEMPERATURE_SCALE, signé
IR_SENSORS_START = IR_T_INT
IR_SENSORS_COUNT = 2

# --- Input registers (lecture seule, mots d'alarmes) --------------------------
# Bit n du mot = alarme ALARM_xxx de numéro n.
IR_ALARMS_ACTIVE = 2  # bit à 1 = cause de l'alarme présente
IR_ALARMS_LATCHED = 3  # bit à 1 = alarme mémorisée, en attente d'acquittement
IR_ALARMS_START = IR_ALARMS_ACTIVE
IR_ALARMS_COUNT = 2

# --- Numéros de bit des alarmes dans les mots d'alarmes -----------------------
ALARM_EMERGENCY_STOP = 0
ALARM_T_INT_HIGH = 1
ALARM_SENSOR_T_INT = 2
ALARM_SENSOR_T_EXT = 3
ALARM_FAN_1 = 4  # défaut de rotation (commandé mais sans retour de marche)
ALARM_FAN_2 = 5
ALARM_FAN_3 = 6
ALARM_FAN_4 = 7
ALARM_LABELS = [  # libellés affichés par l'IHM, dans l'ordre des bits
    "Arrêt d'urgence",
    "Température intérieure haute",
    "Défaut capteur T_int",
    "Défaut capteur T_ext",
    "Défaut rotation V1",
    "Défaut rotation V2",
    "Défaut rotation V3",
    "Défaut rotation V4",
]

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
