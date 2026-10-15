// POST api/fan-mode { fan, mode } : mode auto / marche / arrêt d'un ventilateur (opérateur).
const ihm = global.get("ihm");
const mm = ihm.mm;
const FAN_MODES = { auto: mm.FAN_MODE_AUTO, on: mm.FAN_MODE_MANUAL_ON, off: mm.FAN_MODE_MANUAL_OFF };
const FAN_MODE_LABELS = { auto: "auto", on: "manuel marche", off: "manuel arrêt" };
const FAN_MODE_REGISTERS = [mm.HR_FAN_MODE_1, mm.HR_FAN_MODE_2, mm.HR_FAN_MODE_3, mm.HR_FAN_MODE_4];
try {
    msg.user = ihm.requireRole(msg.req, "operator");
    const { fan, mode } = msg.payload;
    if (!(mode in FAN_MODES)) throw new Error("'mode' doit valoir auto, on ou off");
    if (![1, 2, 3, 4].includes(fan)) throw new Error("'fan' doit valoir 1, 2, 3 ou 4");
    msg.writes = [{ fc: 6, address: FAN_MODE_REGISTERS[fan - 1], quantity: 1, value: FAN_MODES[mode] }];
    msg.actions = [`V${fan} en mode ${FAN_MODE_LABELS[mode]}`];
    return [msg, null];
} catch (err) {
    return [null, ihm.replyError(msg, err)];
}
