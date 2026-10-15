// Réglages de Node-RED pour l'IHM de l'automate de ventilation.
//
// Lancement : npm start (depuis ce dossier), puis
//   - éditeur des flux : http://localhost:1880
//   - tableau de bord  : http://localhost:1880/dashboard
//
// Node-RED n'écoute que sur la machine elle-même (127.0.0.1) : l'éditeur et le
// tableau de bord n'ont pas de mot de passe, il ne faut donc pas les exposer
// sur le réseau (n'importe qui pourrait déclencher l'arrêt d'urgence).

module.exports = {
    userDir: __dirname,
    flowFile: "flows.json",
    flowFilePretty: true,
    credentialSecret: false,
    uiHost: "127.0.0.1",
    uiPort: 1880,
    logging: { console: { level: "info", metrics: false, audit: false } },
    editorTheme: { projects: { enabled: false } },
};
