// Compare les alarmes avec celles du cycle précédent, alimente le journal et
// envoie le mail d'alerte à l'apparition de l'arrêt d'urgence. Puis diffuse
// l'état aux pages ouvertes.
const ihm = global.get("ihm");
const mm = ihm.mm;
const { alarms, time } = msg.payload;

if (ihm.lastAlarms) {
    alarms.forEach((a, i) => {
        const before = ihm.lastAlarms[i];
        const events = [];
        // Une cause brève (ex. défaut de rotation, coupé dès le cycle suivant) peut
        // passer entre deux lectures : sa mémorisation compte aussi comme apparition.
        // À l'inverse, disparition et acquittement peuvent tomber entre deux lectures.
        if ((a.active && !before.active) || (a.latched && !before.latched)) events.push("apparition");
        else {
            if (!a.active && before.active) events.push("disparition");
            if (!a.latched && before.latched) events.push("acquittement");
        }
        for (const event of events) ihm.addJournal({ time, label: a.label, event });
        if (events.includes("apparition") && i === mm.ALARM_EMERGENCY_STOP) sendEmergencyMail(time);
    });
} else {
    // Première lecture : on note les alarmes déjà présentes.
    alarms.forEach((a) => {
        if (a.active || a.latched) ihm.addJournal({ time, label: a.label, event: "présente au démarrage" });
    });
}
ihm.lastAlarms = alarms;
ihm.broadcast();
return null;

// --- Mail d'alerte sur arrêt d'urgence ---------------------------------------
// Déclenché par l'apparition de l'alarme, et non par le bouton de la page : un
// arrêt d'urgence venant d'ailleurs (client Modbus, bouton physique) est aussi signalé.
function emergencyMailText(time) {
    const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "medium" });
    const last = ihm.lastEmergencyPress;
    const press = last && time - last.time < 5000 ? last : null;
    const origin = press
        ? `depuis l'IHM (utilisateur : ${press.user})`
        : "hors de l'IHM (commande Modbus directe ou bouton externe)";
    const s = ihm.state;
    const lines = [
        "ALERTE : l'arrêt d'urgence de la ventilation a été déclenché.",
        "",
        `Date : ${dateTime.format(time)}`,
        `Origine : ${origin}`,
    ];
    if (s.connected) {
        lines.push(
            `Mode : ${s.summer ? "été" : "hiver"}`,
            `Température intérieure : ${s.t_int.toFixed(1)} °C`,
            `Température extérieure : ${s.t_ext.toFixed(1)} °C`
        );
    }
    lines.push(
        "",
        "Tous les ventilateurs sont arrêtés. Ils ne redémarreront qu'après le",
        "relâchement du bouton et un acquittement depuis l'IHM de supervision.",
        "",
        "-- Message automatique de l'IHM Ventilation Modbus"
    );
    return lines.join("\n");
}

function sendEmergencyMail(time) {
    global.get("alerts").sendToAll("[ALERTE] Arrêt d'urgence - Ventilation", emergencyMailText(time))
        .then((n) => ihm.addJournal({ time: Date.now(), label: `Mail d'alerte envoyé à ${n} destinataire(s)`, event: "mail" }))
        .catch((err) => ihm.addJournal({ time: Date.now(), label: `Mail d'alerte non envoyé : ${err.message}`, event: "mail" }))
        .finally(() => ihm.broadcast());
}
