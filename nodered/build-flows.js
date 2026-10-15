// Génère flows.json : l'IHM de supervision (public/) servie par Node-RED.
//
// Les flux, bloc par bloc :
//   - onglet « Automate » : lectures Modbus, état, journal des alarmes, mail
//     d'arrêt d'urgence, surveillance de la liaison ;
//   - onglet « Commandes » : une entrée HTTP par commande de la page, puis
//     l'écriture Modbus ;
//   - onglet « Pages et accès » : pages, flux temps réel, connexion, rapport
//     PDF, alertes mail.
// Le code des blocs « function » est dans fonctions/ ; les adresses Modbus des
// blocs de lecture viennent de src/ventilation_modbus/modbus_map.py.
//
//   npm run build
// À relancer après un changement de modbus_map.py ou d'un fichier de fonctions/.
// Attention : flows.json est alors entièrement réécrit, les modifications
// faites dans l'éditeur Node-RED depuis la dernière génération sont perdues.

const fs = require("node:fs");
const path = require("node:path");
const { map: mm } = require("./modbus_map");

const code = (file) => fs.readFileSync(path.join(__dirname, "fonctions", file), "utf8").trimEnd();

let next = 0x100;
let y = 0; // position verticale courante, sur l'onglet « Pages et accès »
const id = () => "f0a10000000" + (next++).toString(16).padStart(5, "0");
const nodes = [];
const add = (n) => (nodes.push({ id: id(), ...n }), nodes[nodes.length - 1].id);

const tab = (label, info) => add({ type: "tab", label, disabled: false, info });
const comment = (z, name, x, y, info = "") => add({ type: "comment", z, name, info, x, y, wires: [] });
const fn = (z, name, file, outputs, x, y, wires, extra = {}) => add({
    type: "function", z, name, func: code(file), outputs, timeout: 0, noerr: 0,
    initialize: "", finalize: "", libs: [], x, y, wires, ...extra });
const httpIn = (z, method, url, x, y, wire) => add({
    type: "http in", z, name: "", url, method, upload: false, swaggerDoc: "", x, y, wires: [[wire]] });
const httpOut = (z, x, y) => add({ type: "http response", z, name: "", statusCode: "", headers: {}, x, y, wires: [] });

// --- Liaison Modbus ------------------------------------------------------------
const CLIENT = add({
    type: "modbus-client", name: "Automate ventilation",
    clienttype: "tcp", bufferCommands: true, stateLogEnabled: false, queueLogEnabled: false,
    failureLogEnabled: true, tcpHost: "127.0.0.1", tcpPort: String(mm.PORT), tcpType: "DEFAULT",
    serialPort: "/dev/ttyUSB0", serialType: "RTU-BUFFERD", serialBaudrate: "9600",
    serialDatabits: "8", serialStopbits: "1", serialParity: "none", serialConnectionDelay: "100",
    serialAsciiResponseStartDelimiter: "0x3A", unit_id: String(mm.DEVICE_ID), commandDelay: "1",
    clientTimeout: "1000", reconnectOnTimeout: true, reconnectTimeout: "2000",
    parallelUnitIdsAllowed: true });

// --- Onglet « Automate » -------------------------------------------------------
{
    const z = tab("Automate", "Lit l'automate toutes les 500 ms, tient l'état et le journal des alarmes, " +
        "et les diffuse aux pages ouvertes.");
    comment(z, "IHM : http://localhost:1880/ihm/", 170, 40,
        "Ouvrir l'IHM : [http://localhost:1880/ihm/](http://localhost:1880/ihm/)\n\n" +
        "Ce sont les pages de `nodered/public`, servies par ces flux.");
    add({
        type: "function", z, name: "Outils partagés", outputs: 0, timeout: 0, noerr: 0,
        func: "// Tout le travail est fait au démarrage : voir l'onglet « Au démarrage ».\nreturn null;",
        initialize: code("outils-demarrage.js"), finalize: code("outils-arret.js"), libs: [],
        x: 150, y: 100, wires: [] });

    const journal = fn(z, "Journal des alarmes", "journal.js", 0, 800, 245, []);
    const state = fn(z, "État de l'automate", "etat.js", 1, 560, 245, [[journal]]);
    // Le topic indique à « État de l'automate » de quelle lecture il s'agit.
    const reads = [
        ["Lire commandes (FC1)", "coils", "Coil", mm.COILS_START, mm.COILS_COUNT],
        ["Lire ventilateurs (FC2)", "fans", "Input", mm.DI_FANS_START, mm.DI_FANS_COUNT],
        ["Lire forçages, modes, réglages (FC3)", "holding", "HoldingRegister", 0, mm.HR_SETTINGS_START + mm.HR_SETTINGS_COUNT],
        ["Lire capteurs et alarmes (FC4)", "inputs", "InputRegister", mm.IR_SENSORS_START,
         mm.IR_ALARMS_START + mm.IR_ALARMS_COUNT - mm.IR_SENSORS_START],
    ];
    reads.forEach(([name, topic, dataType, adr, quantity], i) => add({
        type: "modbus-read", z, name, topic, showStatusActivities: false,
        logIOActivities: false, showErrors: false, showWarnings: true, unitid: String(mm.DEVICE_ID),
        dataType, adr: String(adr), quantity: String(quantity), rate: "500", rateUnit: "ms",
        delayOnStart: true, startDelayTime: "1", server: CLIENT, useIOFile: false, ioFile: "",
        useIOForPayload: false, emptyMsgOnFail: false, keepMsgProperties: false,
        x: 230, y: 170 + i * 50, wires: [[state], []] }));

    const watchdog = fn(z, "Surveillance de la liaison", "surveillance.js", 0, 460, 400, []);
    add({ type: "inject", z, name: "chaque seconde", props: [], repeat: "1", crontab: "", once: true,
          onceDelay: "1", topic: "", x: 190, y: 400, wires: [[watchdog]] });
}

// --- Onglet « Commandes » ------------------------------------------------------
{
    const z = tab("Commandes", "Commandes envoyées par la page : vérification des droits et des valeurs, " +
        "puis écriture dans l'automate.");
    const response = httpOut(z, 1180, 400);
    const write = add({
        type: "modbus-flex-write", z, name: "Écrire dans l'automate", showStatusActivities: false,
        showErrors: true, showWarnings: true, server: CLIENT, emptyMsgOnFail: false,
        keepMsgProperties: true, delayOnStart: false, startDelayTime: "", x: 1150, y: 220, wires: [[], []] });
    const writer = fn(z, "Écriture suivante / réponse", "ecriture.js", 2, 870, 300, [[write], [response]]);
    nodes.find((n) => n.id === write).wires = [[writer], []];
    add({ type: "catch", z, name: "Écriture refusée", scope: [write], uncaught: false, x: 860, y: 380, wires: [[writer]] });

    const commands = [
        ["/api/mode", "Mode été / hiver", "cmd-mode.js"],
        ["/api/force", "Forçage des températures", "cmd-force.js"],
        ["/api/fan-mode", "Mode d'un ventilateur", "cmd-fan-mode.js"],
        ["/api/emergency-stop", "Arrêt d'urgence", "cmd-emergency-stop.js"],
        ["/api/ack", "Acquittement", "cmd-ack.js"],
        ["/api/fan-fault", "Panne simulée", "cmd-fan-fault.js"],
        ["/api/settings", "Réglages des seuils", "cmd-settings.js"],
        ["/api/settings/defaults", "Réglages par défaut", "cmd-settings-defaults.js"],
    ];
    commands.forEach(([url, name, file], i) => {
        const y = 60 + i * 60;
        const f = fn(z, name, file, 2, 520, y, [[writer], [response]]);
        httpIn(z, "post", url, 220, y, f);
    });
}

// --- Onglet « Pages et accès » -------------------------------------------------
{
    const z = tab("Pages et accès", "Pages de l'IHM (public/), flux temps réel, connexion opérateur / " +
        "administrateur, rapport PDF et alertes mail.");
    const response = httpOut(z, 900, 300);
    y = 60;
    const route = (method, url, name, file) => {
        const f = fn(z, name, file, 1, 600, y, [[response]]);
        httpIn(z, method, url, 220, y, f);
        y += 50;
        return f;
    };
    const pages = route("get", "/", "Pages de l'IHM", "pages.js");
    for (const url of ["/alertes", "/common.css"]) {
        httpIn(z, "get", url, 220, y, pages);
        y += 50;
    }
    // Le flux temps réel garde la connexion ouverte : il n'a pas de bloc « http response ».
    const events = fn(z, "Flux temps réel", "evenements.js", 0, 600, y, []);
    httpIn(z, "get", "/events", 220, y, events);
    y += 50;
    route("get", "/api/session", "Session en cours", "session.js");
    route("post", "/api/login", "Connexion", "login.js");
    route("post", "/api/logout", "Déconnexion", "logout.js");
    route("get", "/api/report.pdf", "Rapport PDF", "rapport.js");
    const alerts = route("get", "/api/alert-emails", "Alertes mail", "alertes.js");
    for (const url of ["/api/alert-emails", "/api/alert-emails/delete", "/api/mail-account",
                       "/api/mail-account/delete", "/api/alert-emails/test"]) {
        httpIn(z, "post", url, 220, y, alerts);
        y += 50;
    }
}

// --- Tableau de bord (Dashboard 2.0) ------------------------------------------
// Une seule page, qui affiche l'IHM en plein écran : le bouton « Open Dashboard »
// de l'onglet Dashboard 2.0 (barre latérale de l'éditeur) ouvre ainsi l'IHM.
{
    const z = nodes.find((n) => n.type === "tab" && n.label === "Pages et accès").id;
    const base = add({
        type: "ui-base", name: "Ventilation", path: "/dashboard", appIcon: "",
        includeClientData: true, acceptsClientConfig: ["ui-notification", "ui-control"],
        showPathInSidebar: false, headerContent: "page", navigationStyle: "none",
        titleBarStyle: "hidden", showReconnectNotification: true, notificationDisplayTime: 1,
        showDisconnectNotification: true, allowInstall: false });
    const theme = add({
        type: "ui-theme", name: "Plein écran",
        colors: { surface: "#ffffff", primary: "#2563eb", bgPage: "#f3f4f6", groupBg: "#f3f4f6", groupOutline: "#f3f4f6" },
        sizes: { density: "default", pagePadding: "0px", groupGap: "0px", groupBorderRadius: "0px", widgetGap: "0px" } });
    const page = add({
        type: "ui-page", name: "IHM", ui: base, path: "/ihm", icon: "fan", layout: "grid", theme,
        breakpoints: [{ name: "Default", px: 0, cols: 3 }, { name: "Tablet", px: 576, cols: 6 },
                      { name: "Small Desktop", px: 768, cols: 9 }, { name: "Desktop", px: 1024, cols: 12 }],
        tabs: [], order: 1, className: "", visible: "true", disabled: "false" });
    const group = add({
        type: "ui-group", name: "IHM", page, width: 12, height: 1, order: 1, showTitle: false,
        className: "", visible: "true", disabled: "false", groupType: "default", tab: "" });
    add({
        type: "ui-template", z, group, page: "", ui: "", name: "IHM dans le tableau de bord", order: 1,
        width: 0, height: 0, head: "",
        format: '<template>\n  <iframe src="/ihm/" title="IHM ventilation"></iframe>\n</template>\n\n' +
            "<style scoped>\niframe { display: block; width: 100%; height: 100vh; border: 0; }\n</style>\n",
        storeOutMessages: true, passthru: false, resendOnRefresh: true, templateScope: "local",
        className: "", x: 640, y, wires: [[]] });
    add({
        type: "ui-template", z, group: "", page: "", ui: base, name: "Sans marges", order: 0,
        width: 0, height: 0, head: "",
        format: ".nrdb-ui-group .v-card-text { padding: 0 !important; }\n" +
            ".nrdb-ui-group > .v-card { border: 0 !important; }\n",
        storeOutMessages: true, passthru: true, resendOnRefresh: true, templateScope: "site:style",
        className: "", x: 610, y: y + 50, wires: [[]] });
}

fs.writeFileSync(path.join(__dirname, "flows.json"), JSON.stringify(nodes, null, 4) + "\n");
console.log(`flows.json écrit (${nodes.length} blocs)`);
