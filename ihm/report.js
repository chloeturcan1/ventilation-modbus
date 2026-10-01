// Rapport PDF des remontées d'alarmes, généré à la demande depuis l'IHM.
//
// Contenu : état de l'installation et réglages au moment de l'export, état et nombre
// d'apparitions de chaque alarme, puis journal complet (alarmes et actions des
// utilisateurs) dans l'ordre chronologique.
//
// Les polices standard du PDF (Helvetica) ne couvrent que le jeu Latin-1 :
// les accents français passent, mais pas des caractères comme « → » ou « − ».

const PDFDocument = require("pdfkit");

const COLORS = { text: "#1d2330", muted: "#6b7280", border: "#d1d5db", head: "#f3f4f6", err: "#b91c1c", warn: "#b45309", ok: "#15803d" };
const ROLE_NAMES = { operator: "opérateur", admin: "administrateur" };
const FAN_MODE_NAMES = { auto: "auto", on: "manuel marche", off: "manuel arrêt" };

const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "medium" });
const fmtTemp = (v) => `${v.toFixed(1).replace("-0.0", "0.0")} °C`;

// Écrit le rapport dans le flux `out` (la réponse HTTP).
function writeReport(out, { state, journal, startedAt, user, journalSize }) {
  const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true, info: { Title: "Rapport d'alarmes - Ventilation" } });
  doc.pipe(out);
  const now = Date.now();

  doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(18).text("Rapport d'alarmes — Ventilation");
  doc.moveDown(0.3).font("Helvetica").fontSize(10).fillColor(COLORS.muted);
  doc.text(`Généré le ${dateTime.format(now)} par ${user.name} (${ROLE_NAMES[user.role]})`);
  doc.text(`Période couverte : depuis le démarrage de l'IHM, le ${dateTime.format(startedAt)}`);

  section(doc, "État de l'installation au moment de l'export");
  if (!state.connected) {
    doc.fillColor(COLORS.err).text(`Automate injoignable (${state.error || "pas de réponse"}).`);
  } else {
    const forced = (f) => (f ? " (forcée)" : "");
    table(doc, [150, 345], [
      ["Mode", state.summer ? "Été" : "Hiver"],
      ["Température intérieure", fmtTemp(state.t_int) + forced(state.force_int)],
      ["Température extérieure", fmtTemp(state.t_ext) + forced(state.force_ext)],
      ["Arrêt d'urgence", state.emergency_stop ? "ENFONCÉ" : "relâché"],
      ...state.fans.map((on, i) => [
        `Ventilateur V${i + 1}`,
        `${on ? "marche" : "arrêt"} · mode ${FAN_MODE_NAMES[state.fan_modes[i]]}${state.fan_defects[i] ? " · DÉFAUT ROTATION" : ""}`,
      ]),
    ]);
  }

  if (state.connected) {
    const st = state.settings;
    const list = (values) => values.map((v) => v.toFixed(1)).join(" / ") + " °C";
    section(doc, "Réglages en vigueur");
    table(doc, [150, 345], [
      ["Seuils V1 / V2 / V3 été", list(st.summer)],
      ["Seuils V1 / V2 / V3 hiver", list(st.winter)],
      ["Extraction V4 en hiver", `si T_int > ${fmtTemp(st.winter_extract)}`],
      ["Hystérésis", fmtTemp(st.hysteresis)],
      ["Alarme température haute", fmtTemp(st.t_int_high)],
    ]);
  }

  section(doc, "Alarmes");
  if (state.connected) {
    const appearances = (label) => journal.filter((e) => e.label === label && e.event === "apparition").length;
    const rows = state.alarms.map((a) => {
      const st = a.active ? ["ACTIVE", COLORS.err] : a.latched ? ["À ACQUITTER", COLORS.warn] : ["normale", COLORS.ok];
      return [a.label, { text: st[0], color: st[1] }, String(appearances(a.label))];
    });
    table(doc, [250, 145, 100], rows, ["Alarme", "État actuel", "Apparitions"]);
  } else {
    doc.fillColor(COLORS.muted).text("État des alarmes indisponible : automate injoignable.");
  }

  section(doc, "Journal des événements");
  if (journal.length >= journalSize) {
    doc.fillColor(COLORS.muted).text(`Seuls les ${journalSize} événements les plus récents sont conservés.`).moveDown(0.5);
  }
  if (!journal.length) {
    doc.fillColor(COLORS.muted).text("Aucun événement sur la période.");
  } else {
    const rows = [...journal].reverse().map((e) => [
      dateTime.format(e.time),
      e.label,
      { text: e.event, color: e.event === "apparition" ? COLORS.err : e.event === "acquittement" ? COLORS.ok : COLORS.text },
      e.user || "",
    ]);
    table(doc, [110, 210, 95, 80], rows, ["Date et heure", "Alarme ou action", "Événement", "Utilisateur"]);
  }

  // Pied de page sur chaque page, une fois le nombre total connu.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.height - 35;
    doc.page.margins.bottom = 0; // sinon écrire sous la marge ajoute une page
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.muted);
    doc.text(`Ventilation Modbus · rapport du ${dateTime.format(now)}`, 50, bottom, { lineBreak: false });
    doc.text(`Page ${i + 1} / ${range.count}`, 50, bottom, { width: doc.page.width - 100, align: "right" });
  }
  doc.end();
}

function section(doc, title) {
  doc.moveDown(1.2).x = doc.page.margins.left;
  doc.font("Helvetica-Bold").fontSize(12).fillColor(COLORS.text).text(title);
  doc.moveDown(0.4).font("Helvetica").fontSize(9);
}

// Tableau simple. Une cellule est un texte ou { text, color } ; l'en-tête est
// répété en haut de chaque nouvelle page.
function table(doc, widths, rows, header = null) {
  const left = doc.page.margins.left;
  const pad = 4;
  const rowHeight = (cells, font) => {
    doc.font(font);
    return Math.max(...cells.map((c, i) => doc.heightOfString(cellText(c), { width: widths[i] - 2 * pad }))) + 2 * pad;
  };
  const drawRow = (cells, font, fill) => {
    const h = rowHeight(cells, font);
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      if (header && cells !== header) drawRow(header, "Helvetica-Bold", COLORS.head);
    }
    const y = doc.y;
    const total = widths.reduce((a, b) => a + b, 0);
    if (fill) doc.rect(left, y, total, h).fill(fill);
    doc.moveTo(left, y + h).lineTo(left + total, y + h).lineWidth(0.5).strokeColor(COLORS.border).stroke();
    let x = left;
    cells.forEach((c, i) => {
      doc.font(font).fillColor(c.color || COLORS.text).text(cellText(c), x + pad, y + pad, { width: widths[i] - 2 * pad });
      x += widths[i];
    });
    doc.x = left;
    doc.y = y + h;
  };
  doc.fontSize(9);
  if (header) drawRow(header, "Helvetica-Bold", COLORS.head);
  rows.forEach((r) => drawRow(r, "Helvetica"));
}

const cellText = (c) => (typeof c === "string" ? c : c.text);

module.exports = { writeReport };
