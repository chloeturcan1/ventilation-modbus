// POST api/force { t_int?, t_ext? } : forçage d'une température, ou relâchement
// avec null (administrateur).
const ihm = global.get("ihm");
const mm = ihm.mm;
const toRegister = global.get("toRegister");
const T_MIN = -50;
const T_MAX = 100;

function checkTemperature(value) {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < T_MIN || value > T_MAX) {
        throw new Error(`temperature invalide (attendu un nombre entre ${T_MIN} et ${T_MAX}, ou null)`);
    }
    return value;
}

// Valeur -> registre de forçage puis coil à true ; null -> coil à false.
function force(name, coil, register, value) {
    if (value !== null) msg.writes.push({ fc: 6, address: register, quantity: 1, value: toRegister(value) });
    msg.writes.push({ fc: 5, address: coil, quantity: 1, value: value !== null });
    msg.actions.push(value === null ? `Forçage ${name} relâché` : `Forçage ${name} à ${value.toFixed(1)} °C`);
}

try {
    msg.user = ihm.requireRole(msg.req, "admin");
    const body = msg.payload;
    msg.writes = [];
    msg.actions = [];
    if ("t_int" in body) force("T_int", mm.COIL_FORCE_T_INT, mm.HR_T_INT_FORCED, checkTemperature(body.t_int));
    if ("t_ext" in body) force("T_ext", mm.COIL_FORCE_T_EXT, mm.HR_T_EXT_FORCED, checkTemperature(body.t_ext));
    return [msg, null];
} catch (err) {
    return [null, ihm.replyError(msg, err)];
}
