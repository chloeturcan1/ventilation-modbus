// POST api/settings/defaults : retour aux réglages par défaut (administrateur).
// L'automate connaît seul les valeurs par défaut : on lui envoie la commande,
// une impulsion qu'il remet à false.
const ihm = global.get("ihm");
const mm = ihm.mm;
try {
    msg.user = ihm.requireRole(msg.req, "admin");
    if (!ihm.state.connected) throw new Error("automate injoignable");
    msg.writes = [{ fc: 5, address: mm.COIL_RESTORE_DEFAULTS, quantity: 1, value: true }];
    msg.actions = ["Retour aux réglages par défaut"];
    return [msg, null];
} catch (err) {
    return [null, ihm.replyError(msg, err)];
}
