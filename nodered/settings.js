// Réglages de Node-RED pour l'IHM de l'automate de ventilation.
//
// Lancement : npm start (depuis ce dossier), puis
//   - éditeur des flux : http://localhost:1880
//   - IHM              : http://localhost:1880/ihm/
//
// L'IHM est la même que celle du dossier ihm/ : mêmes pages (ihm/public), même
// envoi des mails (ihm/alerts.js) et même rapport PDF (ihm/report.js). Seul le
// serveur change : ici, ce sont les flux Node-RED qui remplacent ihm/server.js.
//
// Node-RED n'écoute que sur la machine elle-même (127.0.0.1) : l'éditeur n'a
// pas de mot de passe, il ne faut donc pas l'exposer sur le réseau.

const path = require("node:path");

const IHM_DIR = path.join(__dirname, "..", "ihm");
const { map, toRegister, fromRegister } = require(path.join(IHM_DIR, "modbus_map"));

module.exports = {
    userDir: __dirname,
    flowFile: "flows.json",
    flowFilePretty: true,
    credentialSecret: false,
    uiHost: "127.0.0.1",
    uiPort: 1880,
    httpNodeRoot: "/ihm",
    logging: { console: { level: "info", metrics: false, audit: false } },
    editorTheme: {
        projects: { enabled: false },
        // Le logo en haut à gauche de l'éditeur ramène à l'IHM.
        header: { title: "Node-RED · retour à l'IHM", url: "/ihm/" },
    },

    // Accessibles dans les blocs « function » par global.get("...").
    functionGlobalContext: {
        mm: map,
        toRegister,
        fromRegister,
        crypto: require("node:crypto"),
        fs: require("node:fs"),
        path,
        publicDir: path.join(IHM_DIR, "public"),
        alerts: require(path.join(IHM_DIR, "alerts")),
        writeReport: require(path.join(IHM_DIR, "report")).writeReport,
        // Mots de passe par défaut à changer, comme pour ihm/server.js, avec les
        // variables d'environnement IHM_OPERATOR_PASSWORD et IHM_ADMIN_PASSWORD.
        passwords: {
            operateur: process.env.IHM_OPERATOR_PASSWORD || "operateur",
            admin: process.env.IHM_ADMIN_PASSWORD || "admin",
        },
    },
};
