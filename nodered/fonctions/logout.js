// POST api/logout : ferme la session.
const ihm = global.get("ihm");
const user = ihm.currentUser(msg.req);
const cookie = ihm.logout(msg.req);
if (user) ihm.logAction(user, "Déconnexion");
return ihm.reply(msg, 200, { ok: true }, { "Set-Cookie": cookie });
