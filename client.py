"""Client de démonstration (IHM provisoire) pour l'automate de ventilation.

1. Force les températures pour parcourir les seuils de la logique été, puis
   ceux de la logique hiver, et vérifie la réponse des ventilateurs (OK / ECART).
2. Revient en mode été, relâche les forçages et affiche l'évolution libre de
   la simulation.
"""

import sys
import time
from datetime import datetime

from pymodbus.client import ModbusTcpClient

from tp_simu_auto import modbus_map as mm

HOST = "127.0.0.1"
SETTLE_S = 0.5  # > 2 cycles automate (0.2 s) pour laisser la logique réagir
PERIOD_S = 0.5
FREE_RUN_S = 5.0

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
    (24.0, 20.0, True, (1, 1, 0, 1), "T_int > T_ext -> V4 (extraction)"),
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


def write_coil(client: ModbusTcpClient, address: int, value: bool) -> None:
    check(client.write_coil(address, value, device_id=mm.DEVICE_ID), "ecriture coil")


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
        errors = run_scenario(client)
        free_run(client)
    finally:
        client.close()
    print(f"Scenario termine : {errors} ecart(s).")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
