// Réunit les quatre lectures Modbus en un seul état, au même format que
// readPlc() dans ihm/server.js (c'est ce que la page attend).
// msg.topic indique la lecture : coils (FC1), fans (FC2), holding (FC3), inputs (FC4).
const ihm = global.get("ihm");
const mm = global.get("mm");
const fromRegister = global.get("fromRegister");

const raw = context.get("raw") || {};
raw[msg.topic] = msg.payload;
context.set("raw", raw);

// On recalcule l'état à chaque lecture des capteurs et alarmes (FC4), une fois
// les trois autres lectures reçues au moins une fois.
const { coils, fans, holding, inputs } = raw;
if (msg.topic !== "inputs" || !coils || !fans || !holding) return null;

const coil = (address) => coils[address - mm.COILS_START];
const ir = (address) => inputs[address - mm.IR_SENSORS_START];
const hr = (address) => holding[address]; // lecture FC3 à partir de l'adresse 0
const setting = (address) => fromRegister(hr(address));

const FAN_MODE_NAMES = { [mm.FAN_MODE_AUTO]: "auto", [mm.FAN_MODE_MANUAL_ON]: "on", [mm.FAN_MODE_MANUAL_OFF]: "off" };
const FAN_MODE_REGISTERS = [mm.HR_FAN_MODE_1, mm.HR_FAN_MODE_2, mm.HR_FAN_MODE_3, mm.HR_FAN_MODE_4];
const FAN_FAULT_COILS = [mm.COIL_FAN_FAULT_1, mm.COIL_FAN_FAULT_2, mm.COIL_FAN_FAULT_3, mm.COIL_FAN_FAULT_4];
const fanAddresses = [mm.DI_FAN_1, mm.DI_FAN_2, mm.DI_FAN_3, mm.DI_FAN_4];
const active = ir(mm.IR_ALARMS_ACTIVE);
const latched = ir(mm.IR_ALARMS_LATCHED);

ihm.state = {
    connected: true,
    t_int: fromRegister(ir(mm.IR_T_INT)),
    t_ext: fromRegister(ir(mm.IR_T_EXT)),
    fans: fanAddresses.map((a) => fans[a - mm.DI_FANS_START]),
    summer: coil(mm.COIL_SUMMER_MODE),
    force_int: coil(mm.COIL_FORCE_T_INT),
    force_ext: coil(mm.COIL_FORCE_T_EXT),
    forced_int: fromRegister(hr(mm.HR_T_INT_FORCED)),
    forced_ext: fromRegister(hr(mm.HR_T_EXT_FORCED)),
    fan_modes: FAN_MODE_REGISTERS.map((a) => FAN_MODE_NAMES[hr(a)] || "auto"),
    emergency_stop: coil(mm.COIL_EMERGENCY_STOP),
    fan_faults: FAN_FAULT_COILS.map((a) => coil(a)),
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
ihm.lastRead = ihm.state.time;
node.status({ fill: "green", shape: "dot", text: `T_int ${ihm.state.t_int.toFixed(1)} °C` });
msg.payload = ihm.state;
return msg;
