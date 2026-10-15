// POST api/fan-fault { fan, fault } : panne moteur simulée (administrateur).
const ihm = global.get("ihm");
const mm = ihm.mm;
const FAN_FAULT_COILS = [mm.COIL_FAN_FAULT_1, mm.COIL_FAN_FAULT_2, mm.COIL_FAN_FAULT_3, mm.COIL_FAN_FAULT_4];
try {
    msg.user = ihm.requireRole(msg.req, "admin");
    const { fan, fault } = msg.payload;
    if (![1, 2, 3, 4].includes(fan)) throw new Error("'fan' doit valoir 1, 2, 3 ou 4");
    if (typeof fault !== "boolean") throw new Error("'fault' doit etre true ou false");
    msg.writes = [{ fc: 5, address: FAN_FAULT_COILS[fan - 1], quantity: 1, value: fault }];
    msg.actions = [`Panne simulée V${fan} ${fault ? "activée" : "retirée"}`];
    return [msg, null];
} catch (err) {
    return [null, ihm.replyError(msg, err)];
}
