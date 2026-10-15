// POST api/emergency-stop { pressed } : enfonce ou relâche l'arrêt d'urgence.
// Accessible sans connexion : un arrêt d'urgence ne doit jamais être bloqué.
// Le relâcher ne relance rien : le réarmement passe par l'acquittement.
const ihm = global.get("ihm");
const mm = ihm.mm;
try {
    const { pressed } = msg.payload;
    if (typeof pressed !== "boolean") throw new Error("'pressed' doit etre true ou false");
    msg.user = ihm.currentUser(msg.req);
    // Noté pour le mail d'alerte, qui indique qui a déclenché l'arrêt.
    if (pressed) ihm.lastEmergencyPress = { user: msg.user ? msg.user.name : "non connecté", time: Date.now() };
    msg.writes = [{ fc: 5, address: mm.COIL_EMERGENCY_STOP, quantity: 1, value: pressed }];
    msg.actions = [pressed ? "Arrêt d'urgence enfoncé" : "Arrêt d'urgence relâché"];
    return [msg, null];
} catch (err) {
    return [null, ihm.replyError(msg, err)];
}
