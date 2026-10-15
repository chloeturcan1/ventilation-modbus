// Génère flows.json à partir des adresses de src/ventilation_modbus/modbus_map.py.
//
// Le flux Node-RED a besoin des adresses Modbus en dur dans ses blocs : plutôt
// que de les recopier à la main, on les relit dans modbus_map.py (seule source
// de vérité) via l'export de l'IHM, et on régénère flows.json :
//   npm run build
// À relancer après chaque changement de modbus_map.py. Attention : flows.json
// est alors entièrement réécrit, les modifications faites dans l'éditeur
// Node-RED depuis la dernière génération sont perdues.

const fs = require("node:fs");
const path = require("node:path");
const { map: mm } = require("../ihm/modbus_map");

const TAB = "f0a1000000000001";
const CLIENT = "f0a1000000000002";
const BASE = "f0a1000000000003";
const THEME = "f0a1000000000004";
const PAGE = "f0a1000000000005";
const G_FANS = "f0a1000000000006";
const G_TEMPS = "f0a1000000000007";
const G_ALARMS = "f0a1000000000008";
const G_CMDS = "f0a1000000000009";

let next = 0x100;
const id = () => "f0a10000000" + (next++).toString(16).padStart(5, "0");

const nodes = [];
const add = (n) => (nodes.push(n), n.id);

// --- Configuration : liaison Modbus et tableau de bord -----------------------
nodes.push(
    { id: TAB, type: "tab", label: "Ventilation", disabled: false,
      info: "IHM de l'automate de ventilation. Généré par build-flows.js à partir de modbus_map.py." },
    { id: CLIENT, type: "modbus-client", name: "Automate ventilation",
      clienttype: "tcp", bufferCommands: true, stateLogEnabled: false, queueLogEnabled: false,
      failureLogEnabled: true, tcpHost: "127.0.0.1", tcpPort: String(mm.PORT), tcpType: "DEFAULT",
      serialPort: "/dev/ttyUSB0", serialType: "RTU-BUFFERD", serialBaudrate: "9600",
      serialDatabits: "8", serialStopbits: "1", serialParity: "none", serialConnectionDelay: "100",
      serialAsciiResponseStartDelimiter: "0x3A", unit_id: String(mm.DEVICE_ID), commandDelay: "1",
      clientTimeout: "1000", reconnectOnTimeout: true, reconnectTimeout: "2000",
      parallelUnitIdsAllowed: true },
    { id: BASE, type: "ui-base", name: "Ventilation", path: "/dashboard", appIcon: "",
      includeClientData: true, acceptsClientConfig: ["ui-notification", "ui-control"],
      showPathInSidebar: false, headerContent: "page", navigationStyle: "default",
      titleBarStyle: "default", showReconnectNotification: true, notificationDisplayTime: 1,
      showDisconnectNotification: true, allowInstall: false },
    { id: THEME, type: "ui-theme", name: "Thème ventilation",
      colors: { surface: "#fcfcfd", primary: "#0d74ce", bgPage: "#f9f9fb", groupBg: "#ffffff", groupOutline: "#d9d9e0" },
      sizes: { density: "default", pagePadding: "12px", groupGap: "12px", groupBorderRadius: "4px", widgetGap: "12px" } },
    { id: PAGE, type: "ui-page", name: "Supervision", ui: BASE, path: "/supervision", icon: "fan",
      layout: "grid", theme: THEME,
      breakpoints: [{ name: "Default", px: 0, cols: 3 }, { name: "Tablet", px: 576, cols: 6 },
                    { name: "Small Desktop", px: 768, cols: 9 }, { name: "Desktop", px: 1024, cols: 12 }],
      tabs: [], order: 1, className: "", visible: "true", disabled: "false" },
);
const group = (gid, name, order) => nodes.push({
    id: gid, type: "ui-group", name, page: PAGE, width: 6, height: 1, order,
    showTitle: true, className: "", visible: "true", disabled: "false", groupType: "default", tab: "" });
group(G_FANS, "Ventilateurs", 1);
group(G_TEMPS, "Températures", 2);
group(G_ALARMS, "Alarmes", 3);
group(G_CMDS, "Commandes", 4);

// Mémo en tête du flux, visible dans l'éditeur.
nodes.push({ id: "f0a100000000000a", type: "comment", z: TAB,
    name: "IHM : http://localhost:1880/dashboard (onglet Dashboard 2.0 → Open Dashboard)",
    info: "L'IHM s'ouvre depuis la barre latérale de droite : onglet **Dashboard 2.0** " +
          "(icône graphique), bouton **Open Dashboard**.", x: 340, y: 40, wires: [] });

// --- Briques réutilisables ---------------------------------------------------
let y = 60;
const row = () => (y += 60);

const read = (name, dataType, adr, quantity, x, yy, wire) => add({
    id: id(), type: "modbus-read", z: TAB, name, topic: "", showStatusActivities: false,
    logIOActivities: false, showErrors: true, showWarnings: true, unitid: String(mm.DEVICE_ID),
    dataType, adr: String(adr), quantity: String(quantity), rate: "1", rateUnit: "s",
    delayOnStart: true, startDelayTime: "1", server: CLIENT, useIOFile: false, ioFile: "",
    useIOForPayload: false, emptyMsgOnFail: false, keepMsgProperties: false,
    x, y: yy, wires: [[wire], []] });

const write = (name, adr, x, yy) => add({
    id: id(), type: "modbus-write", z: TAB, name, showStatusActivities: false, showErrors: true,
    showWarnings: true, unitid: String(mm.DEVICE_ID), dataType: "Coil", adr: String(adr),
    quantity: "1", server: CLIENT, emptyMsgOnFail: false, keepMsgProperties: false,
    x, y: yy, wires: [[], []] });

const fn = (name, func, outputs, x, yy, wires) => add({
    id: id(), type: "function", z: TAB, name, func, outputs, timeout: 0, noerr: 0,
    initialize: "", finalize: "", libs: [], x, y: yy, wires });

const text = (gid, label, order, x, yy) => add({
    id: id(), type: "ui-text", z: TAB, group: gid, order, width: 0, height: 0, name: "",
    label, format: "{{msg.payload}}", layout: "row-spread", style: false, font: "",
    fontSize: 16, color: "#717171", wrapText: false, className: "", value: "payload",
    valueType: "msg", x, y: yy, wires: [] });

// --- Ventilateurs : retours de marche (discrete inputs) ----------------------
{
    const yy = row();
    const labels = ["V1 (extraction)", "V2 (extraction)", "V3 (extraction)", "V4 (insufflation)"];
    const texts = labels.map((l, i) => text(G_FANS, l, i + 1, 760, yy + i * 40));
    const f = fn("Marche / arrêt",
        `return msg.payload.slice(0, ${mm.DI_FANS_COUNT}).map(on => ({ payload: on ? "En marche" : "Arrêt" }));`,
        mm.DI_FANS_COUNT, 480, yy, texts.map((t) => [t]));
    read("Lire ventilateurs (FC2)", "Input", mm.DI_FANS_START, mm.DI_FANS_COUNT, 200, yy, f);
    y = yy + 4 * 40;
}

// --- Capteurs et alarmes (input registers) -----------------------------------
{
    const yy = row();
    const tInt = text(G_TEMPS, "Intérieure", 1, 760, yy);
    const tExt = text(G_TEMPS, "Extérieure", 2, 760, yy + 40);
    const active = text(G_ALARMS, "Actives", 1, 760, yy + 80);
    const latched = text(G_ALARMS, "À acquitter", 2, 760, yy + 120);
    const f = fn("Températures et alarmes", `
// Registres 16 bits signés (complément à deux), en dixièmes de degré.
const SCALE = ${mm.TEMPERATURE_SCALE};
const LABELS = ${JSON.stringify(mm.ALARM_LABELS)};
const temp = (raw) => ((raw >= 0x8000 ? raw - 0x10000 : raw) / SCALE).toFixed(1) + " °C";
const alarms = (word) => LABELS.filter((_, bit) => word & (1 << bit)).join(", ") || "Aucune";
const r = msg.payload;
return [
    { payload: temp(r[${mm.IR_T_INT - mm.IR_SENSORS_START}]) },
    { payload: temp(r[${mm.IR_T_EXT - mm.IR_SENSORS_START}]) },
    { payload: alarms(r[${mm.IR_ALARMS_ACTIVE - mm.IR_SENSORS_START}]) },
    { payload: alarms(r[${mm.IR_ALARMS_LATCHED - mm.IR_SENSORS_START}]) },
];`.trim(), 4, 480, yy, [[tInt], [tExt], [active], [latched]]);
    const count = mm.IR_ALARMS_START + mm.IR_ALARMS_COUNT - mm.IR_SENSORS_START;
    read("Lire capteurs et alarmes (FC4)", "InputRegister", mm.IR_SENSORS_START, count, 200, yy, f);
    y = yy + 4 * 40;
}

// --- Commandes : arrêt d'urgence et acquittement (coils) ---------------------
{
    const yy = row();
    const writeStop = write("Écrire arrêt d'urgence (FC5)", mm.COIL_EMERGENCY_STOP, 1060, yy);
    const stop = add({
        id: id(), type: "ui-switch", z: TAB, name: "", label: "Arrêt d'urgence", group: G_CMDS,
        order: 1, width: 0, height: 0, passthru: false, decouple: false, topic: "topic",
        topicType: "msg", style: "", className: "", layout: "row-spread", clickableArea: "switch",
        onvalue: "true", onvalueType: "bool", onicon: "", oncolor: "red",
        offvalue: "false", offvalueType: "bool", officon: "", offcolor: "",
        x: 780, y: yy, wires: [[writeStop]] });
    // L'interrupteur suit l'état réel de la coil, même si elle est changée ailleurs
    // (IHM web, client Python) : passthru à false pour ne pas la réécrire en retour.
    const f = fn("État arrêt d'urgence",
        `return { payload: msg.payload[${mm.COIL_EMERGENCY_STOP - mm.COILS_START}] };`,
        1, 480, yy, [[stop]]);
    read("Lire commandes (FC1)", "Coil", mm.COILS_START, mm.COILS_COUNT, 200, yy, f);

    const yy2 = yy + 60;
    const writeAck = write("Écrire acquittement (FC5)", mm.COIL_ACK, 1060, yy2);
    add({
        id: id(), type: "ui-button", z: TAB, group: G_CMDS, name: "", label: "Acquitter", order: 2,
        width: 0, height: 0, emulateClick: false, tooltip: "", color: "", bgcolor: "",
        className: "", icon: "check", iconPosition: "left", payload: "true", payloadType: "bool",
        topic: "topic", topicType: "msg", buttonColor: "", textColor: "", iconColor: "",
        enableClick: true, enablePointerdown: false, pointerdownPayload: "",
        pointerdownPayloadType: "str", enablePointerup: false, pointerupPayload: "",
        pointerupPayloadType: "str", x: 780, y: yy2, wires: [[writeAck]] });
}

fs.writeFileSync(path.join(__dirname, "flows.json"), JSON.stringify(nodes, null, 4) + "\n");
console.log(`flows.json écrit (${nodes.length} blocs)`);
