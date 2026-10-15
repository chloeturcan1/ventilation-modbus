// POST api/ack : acquittement des alarmes (opérateur). Impulsion remise à
// false par l'automate.
const ihm = global.get("ihm");
const mm = ihm.mm;
try {
    msg.user = ihm.requireRole(msg.req, "operator");
    msg.writes = [{ fc: 5, address: mm.COIL_ACK, quantity: 1, value: true }];
    msg.actions = ["Acquittement demandé"];
    return [msg, null];
} catch (err) {
    return [null, ihm.replyError(msg, err)];
}
