// POST api/login { username, password } : ouvre une session (cookie).
const ihm = global.get("ihm");
try {
    const { username, password } = msg.payload || {};
    const { user, cookie } = ihm.login(String(username || ""), String(password || ""));
    ihm.logAction(user, "Connexion");
    return ihm.reply(msg, 200, { ok: true, user: ihm.sessionInfo(user) }, { "Set-Cookie": cookie });
} catch (err) {
    return ihm.replyError(msg, err);
}
