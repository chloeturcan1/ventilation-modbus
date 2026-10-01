// Alertes par mail : compte d'envoi, liste des destinataires et envoi.
//
// Tout se règle depuis l'IHM et est enregistré dans le dossier data/, conservé
// au redémarrage et exclu du dépôt git (adresses personnelles, mot de passe) :
// - data/alert-emails.json : les destinataires ;
// - data/mail-account.json : le compte qui envoie les mails (adresse, mot de
//   passe d'application, serveur SMTP déduit de l'adresse).
//
// Un compte d'envoi est indispensable : les serveurs de messagerie refusent ou
// classent en spam les mails qui ne viennent pas d'un compte authentifié.

const fs = require("node:fs");
const path = require("node:path");
const nodemailer = require("nodemailer");

const DATA_DIR = path.join(__dirname, "data");
const EMAILS_FILE = path.join(DATA_DIR, "alert-emails.json");
const ACCOUNT_FILE = path.join(DATA_DIR, "mail-account.json");
const MAX_EMAILS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Serveur d'envoi des messageries courantes, déduit du domaine de l'adresse.
const PROVIDERS = [
  { domains: ["gmail.com", "googlemail.com"], host: "smtp.gmail.com", port: 465 },
  { domains: ["icloud.com", "me.com", "mac.com"], host: "smtp.mail.me.com", port: 587 },
  { domains: ["yahoo.com", "yahoo.fr"], host: "smtp.mail.yahoo.com", port: 465 },
  { domains: ["outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "live.com", "live.fr"], host: "smtp-mail.outlook.com", port: 587 },
  { domains: ["orange.fr", "wanadoo.fr"], host: "smtp.orange.fr", port: 465 },
  { domains: ["free.fr"], host: "smtp.free.fr", port: 465 },
];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback; // pas encore de fichier, ou fichier illisible
  }
}

// Écriture dans un fichier temporaire puis renommage : un arrêt brutal pendant
// l'écriture ne peut pas laisser un fichier à moitié écrit. Lisible par le seul
// utilisateur de l'ordinateur (le compte d'envoi contient un mot de passe).
function writeJson(file, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function normalize(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw new Error("adresse mail invalide");
  return email;
}

// --- Destinataires -------------------------------------------------------------
let emails = readJson(EMAILS_FILE, []).filter((e) => typeof e === "string");

function getEmails() {
  return [...emails];
}

function addEmail(raw) {
  const email = normalize(raw);
  if (emails.includes(email)) throw new Error("adresse déjà enregistrée");
  if (emails.length >= MAX_EMAILS) throw new Error(`${MAX_EMAILS} adresses au maximum`);
  emails = [...emails, email];
  writeJson(EMAILS_FILE, emails);
  return email;
}

function removeEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!emails.includes(email)) throw new Error("adresse inconnue");
  emails = emails.filter((e) => e !== email);
  writeJson(EMAILS_FILE, emails);
  return email;
}

// --- Compte d'envoi --------------------------------------------------------------
let account = readJson(ACCOUNT_FILE, null);

function providerFor(email) {
  const domain = email.split("@")[1];
  return PROVIDERS.find((p) => p.domains.includes(domain)) || null;
}

function transportFor(acc) {
  return nodemailer.createTransport({
    host: acc.host,
    port: acc.port,
    secure: acc.port === 465, // 465 : TLS direct ; 587 : STARTTLS
    auth: { user: acc.user, pass: acc.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

// Vérifie les identifiants auprès du serveur avant de les enregistrer, pour
// signaler tout de suite un mot de passe refusé.
async function setAccount({ address, password, host, port }) {
  const user = normalize(address);
  const pass = String(password || "").replace(/\s+/g, ""); // Google affiche le code par groupes de 4
  if (!pass) throw new Error("mot de passe manquant");
  const provider = providerFor(user);
  const acc = {
    user,
    pass,
    host: String(host || "").trim() || (provider && provider.host),
    port: Number(port) || (provider && provider.port),
  };
  if (!acc.host || !acc.port) {
    throw new Error("messagerie non reconnue : renseignez le serveur SMTP et son port");
  }
  try {
    await transportFor(acc).verify();
  } catch (err) {
    if (err.code === "EAUTH") {
      throw new Error("identifiants refusés par le serveur (pour Gmail, il faut un mot de passe d'application)");
    }
    throw new Error(`connexion au serveur ${acc.host} impossible : ${err.message}`);
  }
  account = acc;
  writeJson(ACCOUNT_FILE, account);
  return { user: acc.user, host: acc.host };
}

function clearAccount() {
  account = null;
  fs.rmSync(ACCOUNT_FILE, { force: true });
}

// Ce que la page peut afficher : jamais le mot de passe.
function accountStatus() {
  return account ? { configured: true, user: account.user, host: account.host } : { configured: false };
}

// Envoie un mail à tous les destinataires, en copie cachée pour que chacun ne
// voie pas les adresses des autres. Renvoie le nombre de destinataires.
async function sendToAll(subject, text) {
  if (!emails.length) throw new Error("aucun destinataire enregistré");
  if (!account) throw new Error("aucun compte d'envoi configuré dans l'IHM");
  await transportFor(account).sendMail({
    from: `Ventilation <${account.user}>`,
    to: account.user,
    bcc: emails,
    subject,
    text,
  });
  return emails.length;
}

module.exports = { getEmails, addEmail, removeEmail, setAccount, clearAccount, accountStatus, sendToAll };
