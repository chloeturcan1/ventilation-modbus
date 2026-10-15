// Envoie une à une les écritures préparées par la commande (msg.writes) au bloc
// « Écrire dans l'automate », qui renvoie ici après chaque écriture réussie.
// Quand tout est écrit : trace les actions au journal et répond à la page.
// Sortie 1 : écriture Modbus suivante. Sortie 2 : réponse à la page.
const ihm = global.get("ihm");

if (msg.error) {
    // Échec d'une écriture, remonté par le bloc « catch ».
    return [null, ihm.reply(msg, 400, { ok: false, error: msg.error.message || "écriture refusée par l'automate" })];
}
if (msg.writes.length) {
    if (!ihm.state.connected) return [null, ihm.reply(msg, 400, { ok: false, error: "automate injoignable" })];
    msg.payload = { ...msg.writes.shift(), unitid: ihm.mm.DEVICE_ID };
    return [msg, null];
}
for (const label of msg.actions) ihm.logAction(msg.user, label);
return [null, ihm.reply(msg, 200, { ok: true })];
