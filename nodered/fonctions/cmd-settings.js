// POST api/settings : tous les réglages en une seule écriture (FC16), car
// l'automate vérifie la cohérence de l'ensemble (administrateur).
const ihm = global.get("ihm");
const mm = ihm.mm;
const toRegister = global.get("toRegister");

// Registre, libellé du journal, et lecture dans l'objet échangé avec la page
// { summer: [v1, v2, v3], winter: [...], winter_intake, hysteresis, t_int_high }.
const SETTINGS = [
    ...[1, 2, 3].map((n) => ({ address: mm[`HR_SUMMER_THRESHOLD_${n}`], label: `Seuil V${n} été`, get: (s) => s.summer[n - 1] })),
    ...[1, 2, 3].map((n) => ({ address: mm[`HR_WINTER_THRESHOLD_${n}`], label: `Seuil V${n} hiver`, get: (s) => s.winter[n - 1] })),
    { address: mm.HR_WINTER_INTAKE_THRESHOLD, label: "Seuil insufflation V4 hiver", get: (s) => s.winter_intake },
    { address: mm.HR_HYSTERESIS, label: "Hystérésis", get: (s) => s.hysteresis },
    { address: mm.HR_T_INT_HIGH_ALARM, label: "Seuil alarme haute", get: (s) => s.t_int_high },
];

// Mêmes règles que Settings.errors() dans automate.py : on les vérifie ici pour
// répondre un message clair, l'automate refusant de toute façon un réglage incohérent.
function checkSettings(body) {
    const isNumber = (v) => typeof v === "number" && Number.isFinite(v);
    const inRange = (v, min, max) => isNumber(v) && v >= min && v <= max;
    const s = {
        summer: body.summer,
        winter: body.winter,
        winter_intake: body.winter_intake,
        hysteresis: body.hysteresis,
        t_int_high: body.t_int_high,
    };
    for (const season of ["summer", "winter"]) {
        const name = season === "summer" ? "été" : "hiver";
        const v = s[season];
        if (!Array.isArray(v) || v.length !== 3 || !v.every((t) => inRange(t, mm.SETPOINT_MIN, mm.SETPOINT_MAX))) {
            throw new Error(`seuils ${name} : 3 valeurs entre ${mm.SETPOINT_MIN} et ${mm.SETPOINT_MAX} °C attendues`);
        }
        if (!(v[0] <= v[1] && v[1] <= v[2])) throw new Error(`seuils ${name} : il faut V1 ≤ V2 ≤ V3`);
    }
    for (const [key, name] of [["winter_intake", "seuil insufflation V4 hiver"], ["t_int_high", "seuil alarme haute"]]) {
        if (!inRange(s[key], mm.SETPOINT_MIN, mm.SETPOINT_MAX)) {
            throw new Error(`${name} : valeur entre ${mm.SETPOINT_MIN} et ${mm.SETPOINT_MAX} °C attendue`);
        }
    }
    if (!inRange(s.hysteresis, mm.HYSTERESIS_MIN, mm.HYSTERESIS_MAX)) {
        throw new Error(`hystérésis : valeur entre ${mm.HYSTERESIS_MIN} et ${mm.HYSTERESIS_MAX} °C attendue`);
    }
    // Arrondi au dixième, la précision des registres.
    const round = (v) => Math.round(v * mm.TEMPERATURE_SCALE) / mm.TEMPERATURE_SCALE;
    return {
        summer: s.summer.map(round),
        winter: s.winter.map(round),
        winter_intake: round(s.winter_intake),
        hysteresis: round(s.hysteresis),
        t_int_high: round(s.t_int_high),
    };
}

try {
    msg.user = ihm.requireRole(msg.req, "admin");
    if (!ihm.state.connected) throw new Error("automate injoignable");
    const settings = checkSettings(msg.payload);
    const before = ihm.state.settings;
    const values = new Array(mm.HR_SETTINGS_COUNT).fill(0);
    for (const s of SETTINGS) values[s.address - mm.HR_SETTINGS_START] = toRegister(s.get(settings));
    msg.writes = [{ fc: 16, address: mm.HR_SETTINGS_START, quantity: mm.HR_SETTINGS_COUNT, value: values }];
    msg.actions = SETTINGS.filter((s) => s.get(settings) !== s.get(before))
        .map((s) => `${s.label} : de ${s.get(before).toFixed(1)} à ${s.get(settings).toFixed(1)} °C`);
    return [msg, null];
} catch (err) {
    return [null, ihm.replyError(msg, err)];
}
