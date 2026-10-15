// GET api/report.pdf : rapport d'alarmes en PDF (opérateur), produit par
// ihm/report.js comme pour l'IHM web.
const ihm = global.get("ihm");
let user;
try {
    user = ihm.requireRole(msg.req, "operator");
} catch (err) {
    return ihm.replyError(msg, err);
}
const res = msg.res._res;
const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "h");
res.writeHead(200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="rapport-alarmes_${stamp}.pdf"`,
});
global.get("writeReport")(res, {
    state: ihm.state,
    journal: ihm.journal,
    startedAt: ihm.startedAt,
    user,
    journalSize: ihm.JOURNAL_SIZE,
});
return null;
