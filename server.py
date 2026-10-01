"""Serveur Modbus TCP simulant l'automate de ventilation.

Toutes les 0.2 s, une tâche asyncio lit les commandes (coils) et les valeurs de
forçage (holding registers), fait avancer le modèle puis réécrit les
températures (input registers) et l'état des ventilateurs (discrete inputs).
Les registres sont donc la seule interface entre l'automate et les clients (IHM).

API pymodbus 3.15 : ModbusDeviceContext / ModbusSequentialDataBlock /
ModbusServerContext sont dépréciés au profit de SimData / SimDevice, et l'objet
ModbusTcpServer expose async_getValues / async_setValues pour accéder à son
datastore. On garde donc une référence directe au serveur plutôt que de passer
par StartTcpServer.
"""

import asyncio
import time

from pymodbus.server import ModbusTcpServer
from pymodbus.simulator import DataType, SimData, SimDevice

from tp_simu_auto import modbus_map as mm
from tp_simu_auto.automate import Automate

CYCLE_S = 0.2


def build_device() -> SimDevice:
    """Construit le datastore : espaces coils / DI / HR / IR séparés.

    En mode « blocs séparés », pymodbus exige des blocs de bits par multiples de
    16 ; toute adresse hors des blocs déclarés renvoie une exception Modbus
    « illegal address ».
    """
    coils = [False] * 16
    coils[mm.COIL_SUMMER_MODE] = True  # démarrage en mode été
    return SimDevice(
        id=mm.DEVICE_ID,
        simdata=(
            [SimData(mm.COILS_START, values=coils, datatype=DataType.BITS)],
            [SimData(mm.DI_FANS_START, values=[False] * 16, datatype=DataType.BITS)],
            [
                SimData(
                    mm.HR_FORCED_START,
                    count=mm.HR_FORCED_COUNT,
                    values=0,
                    datatype=DataType.REGISTERS,
                )
            ],
            [
                SimData(
                    mm.IR_SENSORS_START,
                    count=mm.IR_SENSORS_COUNT,
                    values=0,
                    datatype=DataType.REGISTERS,
                )
            ],
        ),
    )


async def read_commands(server: ModbusTcpServer, automate: Automate) -> None:
    """Applique au modèle le mode et les forçages demandés par l'IHM."""
    coils = await server.async_getValues(
        mm.DEVICE_ID, mm.FC_COILS, mm.COILS_START, mm.COILS_COUNT
    )
    forced = await server.async_getValues(
        mm.DEVICE_ID, mm.FC_HOLDING_REGISTERS, mm.HR_FORCED_START, mm.HR_FORCED_COUNT
    )
    summer = bool(coils[mm.COIL_SUMMER_MODE - mm.COILS_START])
    if summer != automate.summer_mode:
        print(f"Mode : {'ETE' if summer else 'HIVER'}")
    automate.summer_mode = summer

    t_int = mm.from_register(forced[mm.HR_T_INT_FORCED - mm.HR_FORCED_START])
    t_ext = mm.from_register(forced[mm.HR_T_EXT_FORCED - mm.HR_FORCED_START])
    automate.t_int_forced = t_int if coils[mm.COIL_FORCE_T_INT - mm.COILS_START] else None
    automate.t_ext_forced = t_ext if coils[mm.COIL_FORCE_T_EXT - mm.COILS_START] else None


async def write_outputs(server: ModbusTcpServer, automate: Automate) -> None:
    """Recopie températures et états des ventilateurs dans les registres."""
    sensors = [0] * mm.IR_SENSORS_COUNT
    sensors[mm.IR_T_INT - mm.IR_SENSORS_START] = mm.to_register(automate.t_int)
    sensors[mm.IR_T_EXT - mm.IR_SENSORS_START] = mm.to_register(automate.t_ext)
    await server.async_setValues(
        mm.DEVICE_ID, mm.FC_INPUT_REGISTERS, mm.IR_SENSORS_START, sensors
    )

    fans = [False] * mm.DI_FANS_COUNT
    for address, on in zip(
        (mm.DI_FAN_1, mm.DI_FAN_2, mm.DI_FAN_3, mm.DI_FAN_4), automate.fans
    ):
        fans[address - mm.DI_FANS_START] = on
    await server.async_setValues(
        mm.DEVICE_ID, mm.FC_DISCRETE_INPUTS, mm.DI_FANS_START, fans
    )


async def simulation_loop(server: ModbusTcpServer, automate: Automate) -> None:
    """Cycle automate : lecture commandes -> step() -> écriture sorties."""
    last = time.monotonic()
    while True:
        await asyncio.sleep(CYCLE_S)
        now = time.monotonic()
        dt, last = now - last, now

        previous_fans = list(automate.fans)
        await read_commands(server, automate)
        automate.step(dt)
        await write_outputs(server, automate)

        if automate.fans != previous_fans:
            states = " ".join(
                f"V{i}={'ON' if on else 'off'}" for i, on in enumerate(automate.fans, 1)
            )
            print(
                f"T_int={automate.t_int:5.1f} C  T_ext={automate.t_ext:5.1f} C  {states}"
            )


async def main() -> None:
    automate = Automate()
    server = ModbusTcpServer(build_device(), address=("0.0.0.0", mm.PORT))
    # Les registres reflètent l'état initial avant la première connexion client.
    automate.step(0.0)
    await write_outputs(server, automate)
    await server.serve_forever(background=True)
    print(f"Automate ventilation en ecoute sur le port {mm.PORT} (Ctrl+C pour arreter)")
    try:
        await simulation_loop(server, automate)
    finally:
        await server.shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Serveur arrete.")
