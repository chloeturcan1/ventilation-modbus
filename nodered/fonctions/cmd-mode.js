// POST api/mode { summer } : passage en mode été / hiver (opérateur).
// Sortie 1 : écritures Modbus à faire. Sortie 2 : réponse d'erreur à la page.
const ihm = global.get("ihm");
const mm = ihm.mm;
try {
    msg.user = ihm.requireRole(msg.req, "operator");
    const { summer } = msg.payload;
    if (typeof summer !== "boolean") throw new Error("'summer' doit etre true ou false");
    msg.writes = [{ fc: 5, address: mm.COIL_SUMMER_MODE, quantity: 1, value: summer }];
    msg.actions = [summer ? "Passage en mode été" : "Passage en mode hiver"];
    return [msg, null];
} catch (err) {
    return [null, ihm.replyError(msg, err)];
}
