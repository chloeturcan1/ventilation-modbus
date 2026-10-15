// Alertes par mail (administrateur) : destinataires et compte d'envoi, gérés
// par alerts.js (enregistrés dans nodered/data).
// msg.req.route.path indique la demande.
const ihm = global.get("ihm");
const alerts = global.get("alerts");
const route = msg.req.route.path;
const body = msg.payload || {};

async function handle() {
    const user = ihm.requireRole(msg.req, "admin"); // adresses personnelles : visibles par l'admin seulement
    switch (`${msg.req.method} ${route}`) {
        case "GET /api/alert-emails":
            return { ok: true, emails: alerts.getEmails(), account: alerts.accountStatus() };
        case "POST /api/alert-emails": {
            const email = alerts.addEmail(body.email);
            ihm.logAction(user, `Destinataire d'alerte ajouté : ${email}`);
            return { ok: true, emails: alerts.getEmails() };
        }
        case "POST /api/alert-emails/delete": {
            const email = alerts.removeEmail(body.email);
            ihm.logAction(user, `Destinataire d'alerte retiré : ${email}`);
            return { ok: true, emails: alerts.getEmails() };
        }
        case "POST /api/mail-account": {
            const result = await alerts.setAccount(body);
            ihm.logAction(user, `Compte d'envoi des alertes : ${result.user}`);
            return { ok: true, account: alerts.accountStatus() };
        }
        case "POST /api/mail-account/delete":
            alerts.clearAccount();
            ihm.logAction(user, "Compte d'envoi des alertes supprimé");
            return { ok: true, account: alerts.accountStatus() };
        case "POST /api/alert-emails/test": {
            const n = await alerts.sendToAll(
                "[TEST] Alerte Ventilation",
                `Mail de test envoyé depuis l'IHM par ${user.name}.\n\n` +
                    "Ces adresses recevront un mail d'alerte à chaque arrêt d'urgence.\n\n" +
                    "-- Message automatique de l'IHM Ventilation Modbus"
            );
            ihm.logAction(user, `Mail de test envoyé à ${n} destinataire(s)`);
            return { ok: true, sent: n };
        }
    }
    throw ihm.httpError(404, "introuvable");
}

handle()
    .then((payload) => node.send(ihm.reply(msg, 200, payload)))
    .catch((err) => node.send(ihm.replyError(msg, err)));
return null;
