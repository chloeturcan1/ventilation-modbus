"""Serveur Modbus TCP simulant l'automate de ventilation.

Toutes les 0.2 s, une tâche asyncio lit les commandes (coils), les valeurs de
forçage, modes des ventilateurs et réglages (holding registers), fait avancer le modèle
puis réécrit les températures et mots d'alarmes (input registers) et l'état des
ventilateurs (discrete inputs).
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
from tp_simu_auto.automate import Alarm, Automate, FanMode, Settings

CYCLE_S = 0.2

FAN_MODES = {
    mm.FAN_MODE_AUTO: FanMode.AUTO,
    mm.FAN_MODE_MANUAL_ON: FanMode.MANUAL_ON,
    mm.FAN_MODE_MANUAL_OFF: FanMode.MANUAL_OFF,
}
FAN_MODE_NAMES = {FanMode.AUTO: "AUTO", FanMode.MANUAL_ON: "MANU marche", FanMode.MANUAL_OFF: "MANU arret"}
ALARM_BITS = {
    Alarm.EMERGENCY_STOP: mm.ALARM_EMERGENCY_STOP,
    Alarm.T_INT_HIGH: mm.ALARM_T_INT_HIGH,
    Alarm.SENSOR_T_INT: mm.ALARM_SENSOR_T_INT,
    Alarm.SENSOR_T_EXT: mm.ALARM_SENSOR_T_EXT,
    Alarm.FAN_1: mm.ALARM_FAN_1,
    Alarm.FAN_2: mm.ALARM_FAN_2,
    Alarm.FAN_3: mm.ALARM_FAN_3,
    Alarm.FAN_4: mm.ALARM_FAN_4,
}


def alarm_word(alarms: set[Alarm]) -> int:
    """Mot d'alarmes : bit ALARM_xxx à 1 pour chaque alarme de l'ensemble."""
    return sum(1 << ALARM_BITS[alarm] for alarm in alarms)


def alarm_label(alarm: Alarm) -> str:
    return mm.ALARM_LABELS[ALARM_BITS[alarm]]


def settings_to_registers(settings: Settings) -> list[int]:
    """Bloc de registres HR_SETTINGS_START.. correspondant aux réglages."""
    values = [0] * mm.HR_SETTINGS_COUNT
    addresses = {
        mm.HR_SUMMER_THRESHOLD_1: settings.summer_fan_thresholds[0],
        mm.HR_SUMMER_THRESHOLD_2: settings.summer_fan_thresholds[1],
        mm.HR_SUMMER_THRESHOLD_3: settings.summer_fan_thresholds[2],
        mm.HR_WINTER_THRESHOLD_1: settings.winter_fan_thresholds[0],
        mm.HR_WINTER_THRESHOLD_2: settings.winter_fan_thresholds[1],
        mm.HR_WINTER_THRESHOLD_3: settings.winter_fan_thresholds[2],
        mm.HR_WINTER_INTAKE_THRESHOLD: settings.winter_intake_threshold,
        mm.HR_HYSTERESIS: settings.hysteresis,
        mm.HR_T_INT_HIGH_ALARM: settings.t_int_high_alarm,
    }
    for address, value in addresses.items():
        values[address - mm.HR_SETTINGS_START] = mm.to_register(value)
    return values


def settings_from_registers(registers: list[int]) -> Settings:
    def value(address: int) -> float:
        return mm.from_register(registers[address - mm.HR_SETTINGS_START])

    return Settings(
        summer_fan_thresholds=(
            value(mm.HR_SUMMER_THRESHOLD_1),
            value(mm.HR_SUMMER_THRESHOLD_2),
            value(mm.HR_SUMMER_THRESHOLD_3),
        ),
        winter_fan_thresholds=(
            value(mm.HR_WINTER_THRESHOLD_1),
            value(mm.HR_WINTER_THRESHOLD_2),
            value(mm.HR_WINTER_THRESHOLD_3),
        ),
        winter_intake_threshold=value(mm.HR_WINTER_INTAKE_THRESHOLD),
        hysteresis=value(mm.HR_HYSTERESIS),
        t_int_high_alarm=value(mm.HR_T_INT_HIGH_ALARM),
    )


def build_device(automate: Automate) -> SimDevice:
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
                    # forçages à 0, modes à 0 (= FAN_MODE_AUTO), puis réglages en vigueur
                    values=[0] * (mm.HR_SETTINGS_START - mm.HR_FORCED_START)
                    + settings_to_registers(automate.settings),
                    datatype=DataType.REGISTERS,
                )
            ],
            [
                SimData(
                    mm.IR_SENSORS_START,
                    count=mm.IR_ALARMS_START + mm.IR_ALARMS_COUNT - mm.IR_SENSORS_START,
                    values=0,
                    datatype=DataType.REGISTERS,
                )
            ],
        ),
    )


async def read_commands(server: ModbusTcpServer, automate: Automate) -> None:
    """Applique au modèle les commandes de l'IHM : mode, forçages, conduite, sécurités."""
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

    modes = await server.async_getValues(
        mm.DEVICE_ID, mm.FC_HOLDING_REGISTERS, mm.HR_FAN_MODES_START, mm.HR_FAN_MODES_COUNT
    )
    for i, address in enumerate(
        (mm.HR_FAN_MODE_1, mm.HR_FAN_MODE_2, mm.HR_FAN_MODE_3, mm.HR_FAN_MODE_4)
    ):
        # Valeur inconnue : repli sur le mode automatique.
        mode = FAN_MODES.get(modes[address - mm.HR_FAN_MODES_START], FanMode.AUTO)
        if mode != automate.fan_modes[i]:
            print(f"V{i + 1} : {FAN_MODE_NAMES[mode]}")
        automate.fan_modes[i] = mode

    automate.emergency_stop = bool(coils[mm.COIL_EMERGENCY_STOP - mm.COILS_START])
    automate.fan_faults = [
        bool(coils[address - mm.COILS_START])
        for address in (
            mm.COIL_FAN_FAULT_1,
            mm.COIL_FAN_FAULT_2,
            mm.COIL_FAN_FAULT_3,
            mm.COIL_FAN_FAULT_4,
        )
    ]

    # Retour aux réglages par défaut : impulsion, remise à False une fois traitée.
    if coils[mm.COIL_RESTORE_DEFAULTS - mm.COILS_START]:
        automate.settings = Settings()
        await server.async_setValues(
            mm.DEVICE_ID,
            mm.FC_HOLDING_REGISTERS,
            mm.HR_SETTINGS_START,
            settings_to_registers(automate.settings),
        )
        await server.async_setValues(mm.DEVICE_ID, mm.FC_COILS, mm.COIL_RESTORE_DEFAULTS, [False])
        print("Reglages par defaut retablis")

    # Réglages : appliqués seulement s'ils sont cohérents ; sinon on réécrit les
    # réglages en vigueur, pour que les registres reflètent toujours ce qui est appliqué.
    registers = await server.async_getValues(
        mm.DEVICE_ID, mm.FC_HOLDING_REGISTERS, mm.HR_SETTINGS_START, mm.HR_SETTINGS_COUNT
    )
    settings = settings_from_registers(registers)
    if settings != automate.settings:
        if errors := settings.errors():
            print(f"Reglages refuses : {', '.join(errors)}")
            await server.async_setValues(
                mm.DEVICE_ID,
                mm.FC_HOLDING_REGISTERS,
                mm.HR_SETTINGS_START,
                settings_to_registers(automate.settings),
            )
        else:
            automate.settings = settings
            print(f"Nouveaux reglages : {settings}")

    # Acquittement : impulsion, remise à False une fois traitée.
    if coils[mm.COIL_ACK - mm.COILS_START]:
        automate.acknowledge()
        await server.async_setValues(mm.DEVICE_ID, mm.FC_COILS, mm.COIL_ACK, [False])
        print("Acquittement des alarmes")


async def write_outputs(server: ModbusTcpServer, automate: Automate) -> None:
    """Recopie températures, mots d'alarmes et états des ventilateurs dans les registres."""
    sensors = [0] * mm.IR_SENSORS_COUNT
    sensors[mm.IR_T_INT - mm.IR_SENSORS_START] = mm.to_register(automate.t_int)
    sensors[mm.IR_T_EXT - mm.IR_SENSORS_START] = mm.to_register(automate.t_ext)
    await server.async_setValues(
        mm.DEVICE_ID, mm.FC_INPUT_REGISTERS, mm.IR_SENSORS_START, sensors
    )

    alarms = [0] * mm.IR_ALARMS_COUNT
    alarms[mm.IR_ALARMS_ACTIVE - mm.IR_ALARMS_START] = alarm_word(automate.alarms_active)
    alarms[mm.IR_ALARMS_LATCHED - mm.IR_ALARMS_START] = alarm_word(automate.alarms_latched)
    await server.async_setValues(
        mm.DEVICE_ID, mm.FC_INPUT_REGISTERS, mm.IR_ALARMS_START, alarms
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
        previous_alarms = set(automate.alarms_active)
        await read_commands(server, automate)
        automate.step(dt)
        await write_outputs(server, automate)

        for alarm in automate.alarms_active - previous_alarms:
            print(f"ALARME : {alarm_label(alarm)}")
        for alarm in previous_alarms - automate.alarms_active:
            print(f"Fin d'alarme : {alarm_label(alarm)}")

        if automate.fans != previous_fans:
            states = " ".join(
                f"V{i}={'ON' if on else 'off'}" for i, on in enumerate(automate.fans, 1)
            )
            print(
                f"T_int={automate.t_int:5.1f} C  T_ext={automate.t_ext:5.1f} C  {states}"
            )


async def main() -> None:
    automate = Automate()
    server = ModbusTcpServer(build_device(automate), address=("0.0.0.0", mm.PORT))
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
