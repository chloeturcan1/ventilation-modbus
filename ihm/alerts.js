// Alertes par mail : liste des destinataires et envoi.
//
// - La liste des adresses est enregistrée dans data/alert-emails.json : elle est
//   conservée quand on redémarre l'IHM. Ce dossier n'est pas versionné (adresses
//   personnelles).
// - L'envoi passe par un serveur SMTP (Gmail, Outlook, serveur de l'école...)
//   décrit dans mail.config.json, lui aussi non versionné car il contient un mot
//   de passe. Modèle : mail.config.example.json. Le fichier est relu à chaque
//   envoi : inutile de redémarrer l'IHM après l'avoir modifié.

const fs = require("node:fs");
const path = require("node:path");
const nodemailer = require("nodemailer");

const DATA_DIR = path.join(__dirname, "data");
const EMAILS_FILE = path.join(DATA_DIR, "alert-emails.json");
const CONFIG_FILE = path.join(__dirname, "mail.config.json");
const MAX_EMAILS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function loadEmails() {
  try {
    const list = JSON.parse(fs.readFileSync(EMAILS_FILE, "utf-8"));
    return Array.isArray(list) ? list.filter((e) => typeof e === "string") : [];
  } catch {
    return []; // pas encore de fichier, ou fichier illisible
  }
}

// Écriture dans un fichier temporaire puis renommage : un arrêt brutal pendant
// l'écriture ne peut pas laisser une liste à moitié écrite.
function saveEmails(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = EMAILS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n");
  fs.renameSync(tmp, EMAILS_FILE);
}

let emails = loadEmails();

function getEmails() {
  return [...emails];
}

function addEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) throw new Error("adresse mail invalide");
  if (emails.includes(email)) throw new Error("adresse déjà enregistrée");
  if (emails.length >= MAX_EMAILS) throw new Error(`${MAX_EMAILS} adresses au maximum`);
  emails = [...emails, email];
  saveEmails(emails);
  return email;
}

function removeEmail(raw) {
  const email = String(raw || "").trim().toLowerCase();
  if (!emails.includes(email)) throw new Error("adresse inconnue");
  emails = emails.filter((e) => e !== email);
  saveEmails(emails);
  return email;
}

// Configuration SMTP, ou null si le fichier est absent.
function readConfig() {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`mail.config.json illisible : ${err.message}`);
  }
  for (const key of ["host", "port", "from"]) {
    if (!config[key]) throw new Error(`mail.config.json : champ "${key}" manquant`);
  }
  return config;
}

function mailStatus() {
  try {
    const config = readConfig();
    return config ? { configured: true, host: config.host } : { configured: false };
  } catch (err) {
    return { configured: false, error: err.message };
  }
}

// Envoie un mail à tous les destinataires, en copie cachée pour que chacun ne
// voie pas les adresses des autres. Renvoie le nombre de destinataires.
async function sendToAll(subject, text) {
  if (!emails.length) throw new Error("aucun destinataire enregistré");
  const config = readConfig();
  if (!config) throw new Error("envoi de mails non configuré (ihm/mail.config.json absent)");
  const transport = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port),
    secure: Number(config.port) === 465, // 465 : TLS direct ; 587 : STARTTLS
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  await transport.sendMail({ from: config.from, to: config.from, bcc: emails, subject, text });
  return emails.length;
}

module.exports = { getEmails, addEmail, removeEmail, mailStatus, sendToAll };
