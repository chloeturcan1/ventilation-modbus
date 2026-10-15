// GET api/session : utilisateur connecté, ou null.
const ihm = global.get("ihm");
return ihm.reply(msg, 200, { ok: true, user: ihm.sessionInfo(ihm.currentUser(msg.req)) });
