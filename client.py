"""Client de démonstration (IHM provisoire) pour l'automate de ventilation.

1. Force les températures pour parcourir les seuils de la logique été, puis
   ceux de la logique hiver, et vérifie la réponse des ventilateurs (OK / ECART).
2. Teste la conduite et les sécurités : mode manuel, arrêt d'urgence et
   réarmement, défaut de rotation, défauts capteurs, alarme haute ; vérifie
   ventilateurs et mots d'alarmes.
3. Teste les réglages : seuils, hystérésis et alarme haute modifiés, réglage
   incohérent refusé par l'automate, commande « réglages par défaut ».
4. Revient en mode été, relâche les forçages et affiche l'évolution libre de
   la simulation.

Les réglages par défaut sont rétablis au début et à la fin du test.
"""

import sys
import time
from datetime import datetime

from pymodbus.client import ModbusTcpClient

from server import settings_from_registers, settings_to_registers
from tp_simu_auto import modbus_map as mm
from tp_simu_auto.automate import Settings

HOST = "127.0.0.1"
SETTLE_S = 0.5  # > 2 cycles automate (0.2 s) pour laisser la logique réagir
PERIOD_S = 0.5
FREE_RUN_S = 5.0
FAN_FAULT_WAIT_S = 3.0  # > délai de contrôle de rotation de l'automate (2 s)

# (T_int forcée, T_ext forcée, mode été, ventilateurs attendus V1..V4, commentaire)
SCENARIO = [
    (22.0, 30.0, True, (0, 0, 0, 0), "sous 23 C, T_int < T_ext"),
    (23.0, 30.0, True, (1, 0, 0, 0), "23 C -> V1"),
    (24.0, 30.0, True, (1, 1, 0, 0), "24 C -> V1 V2"),
    (25.0, 30.0, True, (1, 1, 1, 0), "25 C -> V1 V2 V3"),
    (24.7, 30.0, True, (1, 1, 1, 0), "24.7 C : V3 maintenu (hysteresis)"),
    (24.3, 30.0, True, (1, 1, 0, 0), "24.3 C < 24.5 : arret V3"),
    (22.4, 30.0, True, (0, 0, 0, 0), "22.4 C < 22.5 : tout arrete"),
    (24.0, 30.0, True, (1, 1, 0, 0), "T_int = 24 < T_ext = 30 : pas de V4"),
    (24.0, 24.0, True, (1, 1, 0, 0), "T_int = T_ext : pas de V4"),
    (24.0, 20.0, True, (1, 1, 0, 1), "T_int > T_ext -> V4 (insufflation)"),
    # --- Mode hiver : seuils 26 / 27 / 28 C, V4 seulement si de plus T_int > 28 C
    (24.0, 20.0, False, (0, 0, 0, 0), "hiver, 24 C : sous 26 C, tout arrete"),
    (26.0, 5.0, False, (1, 0, 0, 0), "hiver 26 C -> V1"),
    (27.0, 5.0, False, (1, 1, 0, 0), "hiver 27 C -> V1 V2"),
    (28.0, 5.0, False, (1, 1, 1, 0), "hiver 28 C -> V3, pas V4 (il faut > 28 C)"),
    (28.5, 5.0, False, (1, 1, 1, 1), "hiver 28.5 C > 28 et > T_ext -> V4"),
    (28.5, 30.0, False, (1, 1, 1, 0), "hiver T_int < T_ext : arret V4"),
    (28.5, 5.0, False, (1, 1, 1, 1), "hiver T_int > T_ext : V4 relance"),
    (27.6, 5.0, False, (1, 1, 1, 1), "hiver 27.6 C : V3 et V4 maintenus (hysteresis)"),
    (27.4, 5.0, False, (1, 1, 0, 0), "hiver 27.4 C < 27.5 : arret V3 et V4"),
    (25.4, 5.0, False, (0, 0, 0, 0), "hiver 25.4 C < 25.5 : tout arrete"),
    (24.0, 20.0, True, (1, 1, 0, 1), "retour mode ete"),
]


def alarms(*bits: int) -> int:
    """Mot d'alarmes attendu, à partir des numéros de bit ALARM_xxx."""
    return sum(1 << bit for bit in bits)


AU, HIGH, SENSOR_INT, SENSOR_EXT = (
    mm.ALARM_EMERGENCY_STOP,
    mm.ALARM_T_INT_HIGH,
    mm.ALARM_SENSOR_T_INT,
    mm.ALARM_SENSOR_T_EXT,
)
FAN_MODE_REGISTERS = (mm.HR_FAN_MODE_1, mm.HR_FAN_MODE_2, mm.HR_FAN_MODE_3, mm.HR_FAN_MODE_4)
FAN_FAULT_COILS = (mm.COIL_FAN_FAULT_1, mm.COIL_FAN_FAULT_2, mm.COIL_FAN_FAULT_3, mm.COIL_FAN_FAULT_4)

# (actions, attente, ventilateurs attendus, mot d'alarmes actives, mot d'alarmes
# mémorisées, commentaire). Actions : ("mode", n° ventilateur, mode),
# ("au", enfoncé), ("panne", n° ventilateur, en panne), ("ack",), ("temp", T_int, T_ext).
SAFETY_SCENARIO = [
    ([("temp", 24.0, 20.0)], SETTLE_S, (1, 1, 0, 1), 0, 0, "ete 24 C, tout en AUTO"),
    ([("mode", 3, mm.FAN_MODE_MANUAL_ON)], SETTLE_S, (1, 1, 1, 1), 0, 0, "V3 MANU marche"),
    ([("mode", 1, mm.FAN_MODE_MANUAL_OFF)], SETTLE_S, (0, 1, 1, 1), 0, 0, "V1 MANU arret"),
    (
        [("mode", 1, mm.FAN_MODE_AUTO), ("mode", 3, mm.FAN_MODE_AUTO)],
        SETTLE_S, (1, 1, 0, 1), 0, 0, "retour AUTO",
    ),
    ([("au", True)], SETTLE_S, (0, 0, 0, 0), alarms(AU), alarms(AU), "AU enfonce : tout arrete"),
    (
        [("mode", 1, mm.FAN_MODE_MANUAL_ON)],
        SETTLE_S, (0, 0, 0, 0), alarms(AU), alarms(AU), "AU prioritaire sur V1 MANU marche",
    ),
    ([("au", False)], SETTLE_S, (0, 0, 0, 0), 0, alarms(AU), "AU relache : pas de redemarrage"),
    (
        [("ack",), ("mode", 1, mm.FAN_MODE_AUTO)],
        SETTLE_S, (1, 1, 0, 1), 0, 0, "acquittement : redemarrage",
    ),
    (
        [("panne", 2, True)],
        FAN_FAULT_WAIT_S, (1, 0, 0, 1), 0, alarms(mm.ALARM_FAN_2), "panne V2 : defaut rotation",
    ),
    (
        [("panne", 2, False)],
        SETTLE_S, (1, 0, 0, 1), 0, alarms(mm.ALARM_FAN_2), "V2 repare : reste verrouille",
    ),
    ([("ack",)], SETTLE_S, (1, 1, 0, 1), 0, 0, "acquittement : V2 redemarre"),
    (
        [("temp", 90.0, 20.0)],
        SETTLE_S, (1, 0, 0, 0), alarms(SENSOR_INT), alarms(SENSOR_INT),
        "T_int hors plage : mode degrade, V1 seul",
    ),
    (
        [("temp", 24.0, -60.0)],
        SETTLE_S, (1, 1, 0, 0), alarms(SENSOR_EXT), alarms(SENSOR_INT, SENSOR_EXT),
        "T_ext hors plage : arret V4",
    ),
    (
        [("temp", 36.0, 20.0)],
        SETTLE_S, (1, 1, 1, 1), alarms(HIGH), alarms(SENSOR_INT, SENSOR_EXT, HIGH),
        "36 C : alarme temperature haute",
    ),
    (
        [("temp", 24.0, 20.0), ("ack",)],
        SETTLE_S, (1, 1, 0, 1), 0, 0, "retour a la normale et acquittement",
    ),
]


DEFAULTS = Settings()
CUSTOM = Settings(summer_fan_thresholds=(21.0, 22.0, 23.0))
INVALID = Settings(summer_fan_thresholds=(25.0, 22.0, 23.0))  # non croissants : refusé
WIDE_HYSTERESIS = Settings(summer_fan_thresholds=(21.0, 22.0, 23.0), hysteresis=2.0)
LOW_ALARM = Settings(summer_fan_thresholds=(21.0, 22.0, 23.0), t_int_high_alarm=30.0)

# (réglages écrits, ou None pour la commande « réglages par défaut » de
# l'automate, T_int, T_ext forcées, ventilateurs attendus, réglages attendus
# dans les registres, mot d'alarmes actives attendu, commentaire)
SETTINGS_SCENARIO = [
    (DEFAULTS, 22.0, 30.0, (0, 0, 0, 0), DEFAULTS, 0, "reglages par defaut, 22 C : tout arrete"),
    (CUSTOM, 22.0, 30.0, (1, 1, 0, 0), CUSTOM, 0, "seuils ete 21/22/23 : V1 V2 a 22 C"),
    (INVALID, 22.0, 30.0, (1, 1, 0, 0), CUSTOM, 0, "seuils non croissants : refuses"),
    (WIDE_HYSTERESIS, 20.5, 30.0, (1, 1, 0, 0), WIDE_HYSTERESIS, 0, "hysteresis 2 C : maintenus a 20.5 C"),
    (LOW_ALARM, 31.0, 30.0, (1, 1, 1, 1), LOW_ALARM, 1 << mm.ALARM_T_INT_HIGH, "alarme haute a 30 C"),
    (None, 24.0, 20.0, (1, 1, 0, 1), DEFAULTS, 0, "commande reglages par defaut"),
]


def check(rr, what: str):
    if rr.isError():
        raise RuntimeError(f"Erreur Modbus ({what}) : {rr}")
    return rr


def read_state(client: ModbusTcpClient) -> tuple[float, float, list[bool]]:
    """Lit les deux températures (une requête FC4) et les 4 ventilateurs (une requête FC2)."""
    regs = check(
        client.read_input_registers(
            mm.IR_SENSORS_START, count=mm.IR_SENSORS_COUNT, device_id=mm.DEVICE_ID
        ),
        "lecture temperatures",
    ).registers
    bits = check(
        client.read_discrete_inputs(
            mm.DI_FANS_START, count=mm.DI_FANS_COUNT, device_id=mm.DEVICE_ID
        ),
        "lecture ventilateurs",
    ).bits
    t_int = mm.from_register(regs[mm.IR_T_INT - mm.IR_SENSORS_START])
    t_ext = mm.from_register(regs[mm.IR_T_EXT - mm.IR_SENSORS_START])
    fans = [
        bits[address - mm.DI_FANS_START]
        for address in (mm.DI_FAN_1, mm.DI_FAN_2, mm.DI_FAN_3, mm.DI_FAN_4)
    ]
    return t_int, t_ext, fans


def read_alarms(client: ModbusTcpClient) -> tuple[int, int]:
    """Lit les mots d'alarmes actives et mémorisées (une requête FC4)."""
    regs = check(
        client.read_input_registers(
            mm.IR_ALARMS_START, count=mm.IR_ALARMS_COUNT, device_id=mm.DEVICE_ID
        ),
        "lecture alarmes",
    ).registers
    return (
        regs[mm.IR_ALARMS_ACTIVE - mm.IR_ALARMS_START],
        regs[mm.IR_ALARMS_LATCHED - mm.IR_ALARMS_START],
    )


def write_coil(client: ModbusTcpClient, address: int, value: bool) -> None:
    check(client.write_coil(address, value, device_id=mm.DEVICE_ID), "ecriture coil")


def set_fan_mode(client: ModbusTcpClient, fan: int, mode: int) -> None:
    check(
        client.write_register(FAN_MODE_REGISTERS[fan - 1], mode, device_id=mm.DEVICE_ID),
        "ecriture mode ventilateur",
    )


def write_settings(client: ModbusTcpClient, settings: Settings) -> None:
    """Écrit tous les réglages en une requête (FC16), comme l'exige l'automate."""
    check(
        client.write_registers(
            mm.HR_SETTINGS_START, settings_to_registers(settings), device_id=mm.DEVICE_ID
        ),
        "ecriture reglages",
    )


def read_settings(client: ModbusTcpClient) -> Settings:
    regs = check(
        client.read_holding_registers(
            mm.HR_SETTINGS_START, count=mm.HR_SETTINGS_COUNT, device_id=mm.DEVICE_ID
        ),
        "lecture reglages",
    ).registers
    return settings_from_registers(regs)


def reset_safety(client: ModbusTcpClient) -> None:
    """Remet l'automate en conduite normale : tout en AUTO, AU relâché, pas de panne."""
    for fan in range(1, 5):
        set_fan_mode(client, fan, mm.FAN_MODE_AUTO)
        write_coil(client, FAN_FAULT_COILS[fan - 1], False)
    write_coil(client, mm.COIL_EMERGENCY_STOP, False)
    time.sleep(SETTLE_S)
    write_coil(client, mm.COIL_ACK, True)
    time.sleep(SETTLE_S)


def force_temperatures(client: ModbusTcpClient, t_int: float, t_ext: float) -> None:
    """Écrit les valeurs de forçage puis active les forçages."""
    values = [0] * mm.HR_FORCED_COUNT
    values[mm.HR_T_INT_FORCED - mm.HR_FORCED_START] = mm.to_register(t_int)
    values[mm.HR_T_EXT_FORCED - mm.HR_FORCED_START] = mm.to_register(t_ext)
    check(
        client.write_registers(mm.HR_FORCED_START, values, device_id=mm.DEVICE_ID),
        "ecriture forcages",
    )
    write_coil(client, mm.COIL_FORCE_T_INT, True)
    write_coil(client, mm.COIL_FORCE_T_EXT, True)


def format_state(t_int: float, t_ext: float, fans: list[bool]) -> str:
    stamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    states = " ".join(f"V{i}={'ON ' if on else 'off'}" for i, on in enumerate(fans, 1))
    return f"{stamp}  T_int={t_int:5.1f} C  T_ext={t_ext:5.1f} C  {states}"


def run_scenario(client: ModbusTcpClient) -> int:
    """Joue le scénario forcé, renvoie le nombre d'écarts constatés."""
    print("=== Scenario force : parcours des seuils ===")
    errors = 0
    for t_int, t_ext, summer, expected, comment in SCENARIO:
        force_temperatures(client, t_int, t_ext)
        write_coil(client, mm.COIL_SUMMER_MODE, summer)
        time.sleep(SETTLE_S)
        state = read_state(client)
        ok = tuple(int(on) for on in state[2]) == expected
        errors += not ok
        print(f"{format_state(*state)}  {'OK   ' if ok else 'ECART'} {comment}")
    return errors


def run_safety_scenario(client: ModbusTcpClient) -> int:
    """Joue le scénario conduite / sécurités, renvoie le nombre d'écarts constatés."""
    print("=== Scenario conduite et securites ===")
    write_coil(client, mm.COIL_SUMMER_MODE, True)
    errors = 0
    for actions, wait, expected, active, latched, comment in SAFETY_SCENARIO:
        for action in actions:
            match action:
                case ("temp", t_int, t_ext):
                    force_temperatures(client, t_int, t_ext)
                case ("mode", fan, mode):
                    set_fan_mode(client, fan, mode)
                case ("au", pressed):
                    write_coil(client, mm.COIL_EMERGENCY_STOP, pressed)
                case ("panne", fan, fault):
                    write_coil(client, FAN_FAULT_COILS[fan - 1], fault)
                case ("ack",):
                    write_coil(client, mm.COIL_ACK, True)
        time.sleep(wait)
        state = read_state(client)
        words = read_alarms(client)
        ok = tuple(int(on) for on in state[2]) == expected and words == (active, latched)
        errors += not ok
        print(
            f"{format_state(*state)}  AL={words[0]:02X}/{words[1]:02X}  "
            f"{'OK   ' if ok else 'ECART'} {comment}"
        )
    return errors


def run_settings_scenario(client: ModbusTcpClient) -> int:
    """Joue le scénario des réglages, renvoie le nombre d'écarts constatés."""
    print("=== Scenario reglages ===")
    write_coil(client, mm.COIL_SUMMER_MODE, True)
    errors = 0
    for settings, t_int, t_ext, expected, in_force, active, comment in SETTINGS_SCENARIO:
        if settings is None:
            write_coil(client, mm.COIL_RESTORE_DEFAULTS, True)
        else:
            write_settings(client, settings)
        force_temperatures(client, t_int, t_ext)
        time.sleep(SETTLE_S)
        state = read_state(client)
        words = read_alarms(client)
        ok = (
            tuple(int(on) for on in state[2]) == expected
            and read_settings(client) == in_force
            and words[0] == active
        )
        errors += not ok
        print(f"{format_state(*state)}  AL={words[0]:02X}  {'OK   ' if ok else 'ECART'} {comment}")
    return errors


def free_run(client: ModbusTcpClient) -> None:
    print("=== Forcages relaches : simulation libre ===")
    write_coil(client, mm.COIL_FORCE_T_INT, False)
    write_coil(client, mm.COIL_FORCE_T_EXT, False)
    end = time.monotonic() + FREE_RUN_S
    while time.monotonic() < end:
        time.sleep(PERIOD_S)
        print(format_state(*read_state(client)))


def main() -> int:
    client = ModbusTcpClient(HOST, port=mm.PORT)
    if not client.connect():
        print(f"Connexion impossible a {HOST}:{mm.PORT} - le serveur est-il lance ?")
        return 1
    try:
        print("=== Etat initial ===")
        print(format_state(*read_state(client)))
        write_settings(client, DEFAULTS)
        reset_safety(client)
        errors = run_scenario(client)
        errors += run_safety_scenario(client)
        errors += run_settings_scenario(client)
        free_run(client)
    finally:
        write_settings(client, DEFAULTS)
        reset_safety(client)
        client.close()
    print(f"Scenario termine : {errors} ecart(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
