// Outils partagés par tous les flux (code « Au démarrage » du bloc).
//
// Rassemble ce que l'IHM garde en mémoire : l'état de l'automate, le journal,
// les sessions et les pages ouvertes (flux temps réel). Les autres
// blocs y accèdent par global.get("ihm").

const mm = global.get("mm");
const crypto = global.get("crypto");
const passwords = global.get("passwords");

const JOURNAL_SIZE = 500;
const COOKIE = "ihm_session";
const SESSION_MS = 8 * 3600 * 1000; // une session dure le temps d'un poste de travail

const USERS = {
    operateur: { role: "operator", password: passwords.operateur },
    admin: { role: "admin", password: passwords.admin },
};
const ROLE_LEVELS = { operator: 1, admin: 2 };

// Erreur renvoyée à la page avec son code HTTP (401 connexion requise, 403 accès insuffisant...).
function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// Comparaison en temps constant, pour ne rien révéler du mot de passe.
function samePassword(a, b) {
    const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();
    return crypto.timingSafeEqual(hash(a), hash(b));
}

const ihm = {
    mm,
    JOURNAL_SIZE,
    SESSION_MS,
    state: { connected: false },
    journal: [], // du plus récent au plus ancien
    startedAt: Date.now(),
    lastRead: 0, // heure de la dernière lecture réussie de l'automate
    lastAlarms: null, // alarmes lues au dernier cycle, pour détecter les changements
    lastEmergencyPress: null, // { user, time } : dernier AU enfoncé depuis l'IHM
    sessions: new Map(), // jeton -> { name, role, expires }
    sseClients: new Set(), // pages ouvertes, qui reçoivent l'état en temps réel

    httpError,

    addJournal(entry) {
        ihm.journal.unshift(entry);
        ihm.journal.length = Math.min(ihm.journal.length, JOURNAL_SIZE);
    },

    // Envoie l'état et le journal à toutes les pages ouvertes.
    broadcast() {
        const data = `data: ${JSON.stringify({ ...ihm.state, journal: ihm.journal })}\n\n`;
        for (const res of ihm.sseClients) res.write(data);
    },

    // Trace une action d'un utilisateur dans le journal.
    logAction(user, label) {
        ihm.addJournal({ time: Date.now(), label, event: "action", user: user ? user.name : "non connecté" });
        ihm.broadcast();
    },

    currentUser(req) {
        const token = req.cookies && req.cookies[COOKIE];
        const session = token && ihm.sessions.get(token);
        if (!session) return null;
        if (session.expires < Date.now()) {
            ihm.sessions.delete(token);
            return null;
        }
        return session;
    },

    // Renvoie l'utilisateur connecté s'il a au moins le niveau demandé.
    requireRole(req, role) {
        const user = ihm.currentUser(req);
        if (!user) throw httpError(401, "connexion requise");
        if (ROLE_LEVELS[user.role] < ROLE_LEVELS[role]) {
            throw httpError(403, role === "admin" ? "commande réservée à l'administrateur" : "accès insuffisant");
        }
        return user;
    },

    // Ouvre une session ; renvoie l'utilisateur et l'en-tête Set-Cookie à envoyer.
    login(username, password) {
        const account = Object.hasOwn(USERS, username) ? USERS[username] : null;
        // On compare même si le compte n'existe pas, pour ne pas révéler les identifiants valides.
        const ok = samePassword(password, account ? account.password : crypto.randomUUID()) && account;
        if (!ok) throw httpError(401, "identifiant ou mot de passe incorrect");
        const token = crypto.randomBytes(32).toString("hex");
        const user = { name: username, role: account.role, expires: Date.now() + SESSION_MS };
        ihm.sessions.set(token, user);
        const cookie = `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
        return { user, cookie };
    },

    logout(req) {
        const token = req.cookies && req.cookies[COOKIE];
        if (token) ihm.sessions.delete(token);
        return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
    },

    sessionInfo: (user) => (user ? { name: user.name, role: user.role } : null),

    // Prépare la réponse JSON au bloc « http response ».
    reply(msg, status, payload, headers = {}) {
        msg.statusCode = status;
        msg.headers = { "Content-Type": "application/json; charset=utf-8", ...headers };
        msg.payload = JSON.stringify(payload);
        return msg;
    },

    replyError(msg, err) {
        return ihm.reply(msg, err.status || 400, { ok: false, error: err.message });
    },
};

global.set("ihm", ihm);
